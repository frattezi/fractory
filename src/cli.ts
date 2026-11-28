#!/usr/bin/env -S npx tsx
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, readFile, realpath, stat } from 'node:fs/promises';
import { cpus, homedir, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  type CreatedTicket,
  type NewTicket,
  createTicket,
  createTicketSource,
} from './adapters/index.ts';
import { babysit, formatBabysitSummary } from './babysit/babysit.ts';
import { cleanup } from './cleanup/cleanup.ts';
import {
  describeRepoConfig,
  factoryConfigPath,
  loadFactoryConfig,
  loadRepoConfig,
} from './config/index.ts';
import type { AutomationRunRecord } from './contracts/automation.ts';
import type { FactoryConfig } from './contracts/factory-config.ts';
import {
  type Mode,
  type RepoConfig,
  type TicketSourceConfig,
  requiresTicketGate,
} from './contracts/repo-config.ts';
import type { RunRecord } from './contracts/run.ts';
import { type TicketRef, TicketRefSchema, type TicketSource } from './contracts/ticket.ts';
import { doctor, renderFindings } from './doctor/doctor.ts';
import { createBranchTip } from './github/branch.ts';
import { type Exec, defaultExec } from './github/exec.ts';
import { type Gh, createGh } from './github/gh.ts';
import { formatLimits, readLimits } from './limits/limits.ts';
import { type Machine, formatLimitChanges, setLimits } from './limits/set.ts';
import { type InitOptions, initRepo } from './package/init.ts';
import { installSkills } from './package/install.ts';
import { readHostLoad } from './policy/resources.ts';
import { describeWorkflow, formatWorkflow } from './policy/workflow.ts';
import { type RunShell, defaultRunShell, rebuild } from './rebuild/rebuild.ts';
import { listAnswerRequests } from './registry/answers.ts';
import { AutomationStore } from './registry/automations.ts';
import { readHostState } from './registry/host-state.ts';
import { RunRegistry } from './registry/registry.ts';
import { agentLogPath, runAgent } from './runner/agent.ts';
import { launchAutomationRun } from './runner/automation.ts';
import { type Exec as RunnerExec, defaultExec as defaultRunnerExec } from './runner/exec.ts';
import { launchRun } from './runner/index.ts';
import type { SandcastleAdapter } from './runner/types.ts';
import { formatHost, formatStatus, repoStatus } from './status/status.ts';
import {
  fileTranscriptStore,
  formatTokenReport,
  parseSince,
  tokenReport,
} from './tokens/tokens.ts';
import { newestFirst } from './trigger/automation-prune.ts';
import {
  type Launchctl,
  installLaunchd,
  launchdLoaded,
  resolveBin,
  uninstallLaunchd,
} from './trigger/launchd.ts';
import { branchFor, queueRun, readBlockedBy } from './trigger/queue.ts';
import { type Logger, checkPid, createFileLogger } from './trigger/support.ts';
import { tick } from './trigger/tick.ts';

export interface CliEnv {
  out: (line: string) => void;
  cwd: string;
  factoryConfigPath: string;
  rootDir: string;
  home: string;
  launchAgentsDir: string;
  uid: number;
  exec: Exec;
  runShell: RunShell;
  gh: Gh;
  launchctl: Launchctl;
  resolveBin: (name: string) => string | undefined;
  createTicketSource: (config: TicketSourceConfig, mode: Mode) => TicketSource;
  createTicket: (
    config: TicketSourceConfig,
    input: NewTicket,
    options: { mode: Mode },
  ) => Promise<CreatedTicket>;
  launchRun: (record: RunRecord, config: RepoConfig) => Promise<void>;
  launchAutomationRun: (record: AutomationRunRecord, factory: FactoryConfig) => Promise<void>;
  makeLogger: (factory: FactoryConfig) => Logger;
  /** What `errand` starts an agent with: Sandcastle (lazy) and the runner's command runner. */
  agents: { sandcastle: () => Promise<SandcastleAdapter>; exec: RunnerExec };
  now: () => Date;
  newId: () => string;
  /** The core count and total memory that derive the maximum of some limits. */
  machine: () => Machine;
}

const realLaunchctl: Launchctl = (args) =>
  new Promise((done, fail) => {
    execFile('launchctl', args, (error, _stdout, stderr) =>
      error ? fail(new Error(stderr.trim() || error.message)) : done(),
    );
  });

export const defaultEnv = (): CliEnv => {
  const home = homedir();
  return {
    out: (line) => console.log(line),
    cwd: process.cwd(),
    factoryConfigPath: factoryConfigPath(),
    rootDir: fileURLToPath(new URL('..', import.meta.url)),
    home,
    launchAgentsDir: join(home, 'Library', 'LaunchAgents'),
    uid: process.getuid?.() ?? 0,
    exec: defaultExec,
    runShell: defaultRunShell,
    gh: createGh(defaultExec),
    launchctl: realLaunchctl,
    resolveBin: (name) => resolveBin(name),
    createTicketSource: (config, mode) => createTicketSource(config, { mode }),
    createTicket,
    launchRun,
    launchAutomationRun: (record, factory) =>
      launchAutomationRun(record, { store: new AutomationStore(factory.automationsDir) }),
    makeLogger: (factory) => createFileLogger(join(factory.logDir, 'tick.log')),
    agents: {
      sandcastle: async () => (await import('./runner/sandcastle.ts')).sandcastleAdapter(),
      exec: defaultRunnerExec,
    },
    now: () => new Date(),
    newId: () => randomUUID(),
    machine: () => ({
      cores: cpus().length,
      memoryGb: Math.floor((totalmem() / 1024 ** 3) * 10) / 10,
    }),
  };
};

export interface CliArgs {
  positionals: string[];
  flags: Record<string, string | boolean | string[]>;
}

const BOOLEAN_FLAGS = new Set(['ci', 'no-ci', 'ticket-gate', 'force', 'json']);
const REPEATABLE_FLAGS = new Set(['blocked-by', 'ticket']);

export const parseArgs = (argv: string[]): CliArgs => {
  const args: CliArgs = { positionals: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (!arg.startsWith('--')) {
      args.positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const name = arg.slice(2, eq === -1 ? undefined : eq);
    if (BOOLEAN_FLAGS.has(name)) {
      args.flags[name] = true;
      continue;
    }
    const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
    if (value === undefined) throw new Error(`Flag --${name} needs a value`);
    if (REPEATABLE_FLAGS.has(name)) {
      args.flags[name] = [...((args.flags[name] as string[] | undefined) ?? []), value];
    } else {
      args.flags[name] = value;
    }
  }
  return args;
};

const flag = (args: CliArgs, name: string): string | undefined => {
  const value = args.flags[name];
  return typeof value === 'string' ? value : undefined;
};

const HELP_NAMES = new Set(['help', '--help', '-h']);

const HELP = `Usage: fractory <command>
  tick | cleanup | runs | run <ticketRef> | run-exec <id>
  automations [--json]
  automation-exec <automationId> <runId>
  status [repoPath] [--json]
  limits [--json]
  limits set <key>=<value>... [--json]
  babysit [repoPath] [--ticket <ref>]... [--poll <seconds>] [--timeout-min <minutes>]
  config show [repoPath]
  rebuild [repoPath...]
  doctor [repoPath...] [--json]
  rules [repoPath] [--json]
  errand --repo <path> --prompt-file <path> [--model <id>] [--cwd <dir>] [--name <label>]
         [--max-iterations <n>] [--json]
  tokens [--since <date>] [--repo <path>] [--json]
  launchd install|uninstall
  init <repoPath> --mode work|personal --ci|--no-ci (--github owner/name | --jira-url ...) [--force]
  install [--target <dir>]
  tickets create --title <t> --body-file <path> --status backlog|ready [--blocked-by <ref>]... [--parent <ref>]`;

const loadFactory = (env: CliEnv): Promise<FactoryConfig> =>
  loadFactoryConfig(env.factoryConfigPath);

const formatTable = (rows: string[][]): string => {
  const widths =
    rows[0]?.map((_, col) => Math.max(...rows.map((r) => (r[col] ?? '').length))) ?? [];
  return rows
    .map((r) =>
      r
        .map((cell, col) => cell.padEnd(widths[col] ?? 0))
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
};

/** How long a finished Automation Run took, from its record; `undefined` while it is in flight. */
const automationRunDurationMs = (record: AutomationRunRecord): number | undefined =>
  record.status === 'done' || record.status === 'failed'
    ? Math.max(0, new Date(record.updatedAt).getTime() - new Date(record.startedAt).getTime())
    : undefined;

const formatDuration = (ms: number | undefined): string => {
  if (ms === undefined) return '-';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`;
};

const findRepoForTicket = async (
  env: CliEnv,
  factory: FactoryConfig,
  ref: TicketRef,
): Promise<{ repoPath: string; config: RepoConfig }> => {
  for (const repoPath of factory.repos) {
    const config = await loadRepoConfig(repoPath);
    const source = config.ticketSource;
    const matches =
      source.kind === 'github'
        ? ref.startsWith(`github:${source.repo}#`)
        : ref.startsWith(`jira:${source.projectKey}-`);
    if (matches) return { repoPath, config };
  }
  throw new Error(`No configured repo owns ${ref}`);
};

/**
 * Queues a manual Run for a Ticket, continuing on the branch its earlier Runs used so the Run
 * updates the Ticket's pull request instead of opening a second one. Shared by `run` and `babysit`.
 */
const queueManualRun = async (
  env: CliEnv,
  factory: FactoryConfig,
  ref: TicketRef,
): Promise<RunRecord> => {
  const { repoPath, config } = await findRepoForTicket(env, factory, ref);
  const registry = new RunRegistry(factory.registryDir);
  const previous = (await registry.list())
    .filter((r) => r.ticketRef === ref)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .at(-1);
  const source = env.createTicketSource(config.ticketSource, config.mode);
  const branch = previous?.branch ?? branchFor(ref, (await source.get(ref)).title, config.mode);
  const { record } = await queueRun(
    { registry, factory, now: env.now, newId: env.newId },
    {
      ticketRef: ref,
      repoPath,
      trigger: { kind: 'manual' },
      branch,
      blockedBy: await readBlockedBy(source, ref),
      mode: config.mode,
      flow: config.flow,
    },
  );
  // Out of Ready, so the tick does not queue a ticket-ready Run next to this one.
  await source.setStatus(ref, 'in_progress');
  return record;
};

const commands: Record<string, (args: CliArgs, env: CliEnv) => Promise<void>> = {
  async tick(_args, env) {
    const factory = await loadFactory(env);
    const log = env.makeLogger(factory);
    const registry = new RunRegistry(factory.registryDir);
    const summary = await tick({
      factory,
      registry,
      loadRepoConfig,
      createTicketSource: env.createTicketSource,
      gh: env.gh,
      branchTip: createBranchTip(env.exec),
      launchRun: env.launchRun,
      launchAutomationRun: (record) => env.launchAutomationRun(record, factory),
      checkPid,
      now: env.now,
      newId: env.newId,
      log,
      hostLoad: () =>
        readHostLoad({
          sysctl: (name) => env.exec('sysctl', ['-n', name]),
          docker: (dockerArgs) => env.exec('docker', dockerArgs),
        }),
      afterTick: async () => {
        await cleanup({ factory, registry, gh: env.gh, exec: env.exec, now: env.now, log });
      },
    });
    env.out(JSON.stringify(summary));
  },

  async cleanup(_args, env) {
    const factory = await loadFactory(env);
    const result = await cleanup({
      factory,
      registry: new RunRegistry(factory.registryDir),
      gh: env.gh,
      exec: env.exec,
      now: env.now,
      log: env.makeLogger(factory),
    });
    env.out(JSON.stringify(result, null, 2));
  },

  async runs(_args, env) {
    const factory = await loadFactory(env);
    const runs = (await new RunRegistry(factory.registryDir).list()).sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );
    if (runs.length === 0) return env.out('No Runs.');
    env.out(
      formatTable([
        ['ID', 'STATUS', 'MODE', 'FLOW', 'AGENTS', 'TICKET', 'TRIGGER', 'BRANCH', 'PR', 'UPDATED'],
        ...runs.map((r) => [
          r.id,
          r.status,
          r.mode ?? '-',
          r.flow ?? '-',
          r.agents?.join(',') || '-',
          r.ticketRef,
          r.trigger.kind,
          r.branch,
          r.prUrl ?? '-',
          r.updatedAt,
        ]),
      ]),
    );
  },

  /** What Runs cost in tokens, joined to the agent's transcripts by `sessionId` (Spec 0006). */
  async tokens(args, env) {
    const factory = await loadFactory(env);
    const since = flag(args, 'since');
    const repo = flag(args, 'repo');
    const report = await tokenReport({
      runs: await new RunRegistry(factory.registryDir).list(),
      store: fileTranscriptStore(join(env.home, '.claude', 'projects')),
      ...(since !== undefined && { since: parseSince(since) }),
      ...(repo !== undefined && { repoPath: resolve(env.cwd, repo) }),
    });
    env.out(args.flags.json === true ? JSON.stringify(report, null, 2) : formatTokenReport(report));
  },

  /** Automation Runs newest first. Records this release cannot read are left out. */
  async automations(args, env) {
    const factory = await loadFactory(env);
    const records = (await new AutomationStore(factory.automationsDir).listAllRuns()).sort(
      newestFirst,
    );
    const rows = records.map((r) => ({
      id: r.id,
      automationId: r.automationId,
      firedFor: r.firedFor,
      status: r.status,
      startedAt: r.startedAt,
      updatedAt: r.updatedAt,
      durationMs: automationRunDurationMs(r) ?? null,
      logPath: r.logPath,
      outputPath: r.outputPath,
    }));
    if (args.flags.json === true) return env.out(JSON.stringify(rows, null, 2));
    if (rows.length === 0) return env.out('No Automation Runs.');
    env.out(
      formatTable([
        ['AUTOMATION', 'FIRED FOR', 'STATUS', 'DURATION', 'LOG', 'OUTPUT'],
        ...rows.map((r) => [
          r.automationId,
          r.firedFor,
          r.status,
          formatDuration(r.durationMs ?? undefined),
          r.logPath,
          r.outputPath,
        ]),
      ]),
    );
  },

  async run(args, env) {
    const ref = TicketRefSchema.parse(args.positionals[0]);
    const factory = await loadFactory(env);
    const record = await queueManualRun(env, factory, ref);
    env.out(`Queued Run ${record.id} on ${record.branch}; the next tick starts it.`);
  },

  /**
   * Drives this repository's unfinished Tickets to merged, one at a time: queue a Run where one is
   * missing, wait for it, wait for the merge, then the next Ticket. Stops at the first Run that
   * needs the owner. Reads the registry only; the tick refreshes pull request state.
   */
  async babysit(args, env) {
    const factory = await loadFactory(env);
    const repoPath = resolve(env.cwd, args.positionals[0] ?? '.');
    const registry = new RunRegistry(factory.registryDir);
    const tickets = ((args.flags.ticket as string[] | string | undefined) ?? []) as
      | string[]
      | string;
    const summary = await babysit({
      repoPath,
      tickets: (Array.isArray(tickets) ? tickets : [tickets]).map((t) => TicketRefSchema.parse(t)),
      pollMs: Number(args.flags.poll ?? 30) * 1_000,
      perTicketMs: Number(args.flags['timeout-min'] ?? 120) * 60_000,
      deps: {
        listRuns: () => registry.list(),
        queueManualRun: (ref) => queueManualRun(env, factory, TicketRefSchema.parse(ref)),
        wait: (ms) => new Promise((done) => setTimeout(done, ms)),
        now: env.now,
        out: env.out,
        prBlockedReason: async (record) => {
          if (!record.prUrl) return undefined;
          const pr = await env.gh.viewPr(record.repoPath, record.prUrl);
          if (pr.state === 'CLOSED') return 'its pull request was closed without merging';
          if (pr.mergeable === 'CONFLICTING') {
            return `its pull request conflicts with the base branch (${record.prUrl})`;
          }
          return undefined;
        },
        isTicketFinished: async (ref) => {
          const parsed = TicketRefSchema.parse(ref);
          const { config } = await findRepoForTicket(env, factory, parsed);
          const source = env.createTicketSource(config.ticketSource, config.mode);
          return (await source.get(parsed)).status === 'done';
        },
      },
    });
    env.out(formatBabysitSummary(summary));
    if (summary.outcome !== 'merged') throw new Error(`babysitting ${summary.outcome}`);
  },

  async 'run-exec'(args, env) {
    const id = args.positionals[0];
    if (!id) throw new Error('Usage: fractory run-exec <id>');
    // Imported lazily: only run-exec needs the sandbox stack.
    const { executeRun } = await import('./runner/execute.ts');
    const { resources } = await loadFactory(env);
    await executeRun(id, {
      ...(resources && { cpus: resources.cpusPerRun }),
      ticketSource: (repoConfig) =>
        env.createTicketSource(repoConfig.ticketSource, repoConfig.mode),
    });
  },

  /** The host process of a launched Automation Run: runs it to completion and records the end. */
  /** An Errand: one agent on the repository's Account, outside a Run; nothing is recorded. */
  async errand(args, env) {
    const repo = flag(args, 'repo');
    const promptFile = flag(args, 'prompt-file');
    if (!repo || !promptFile) throw new Error('errand needs --repo and --prompt-file');
    const repoPath = resolve(env.cwd, repo);
    const maxIterations = flag(args, 'max-iterations');
    const name = flag(args, 'name');
    const model = flag(args, 'model');
    const cwd = flag(args, 'cwd');
    if (maxIterations && !/^[1-9]\d*$/.test(maxIterations)) {
      throw new Error('--max-iterations must be a positive integer');
    }
    const factory = await loadFactory(env);
    if (!factory.repos.some((r) => resolve(r) === repoPath)) {
      throw new Error(`the factory does not know the repository ${repoPath}`);
    }
    const config = await loadRepoConfig(repoPath);
    const agentCwd = cwd ? resolve(env.cwd, cwd) : repoPath;
    if (
      !(await stat(agentCwd).then(
        (s) => s.isDirectory(),
        () => false,
      ))
    ) {
      throw new Error(`${agentCwd} is not a directory`);
    }
    const output = await runAgent(
      {
        config,
        repoPath,
        // Absolute: Sandcastle resolves it against the process working directory, not the agent's.
        promptFile: resolve(env.cwd, promptFile),
        cwd: agentCwd,
        ...(model && { model }),
        ...(name && { name }),
        ...(maxIterations && { maxIterations: Number(maxIterations) }),
        ...(factory.resources && { cpus: factory.resources.cpusPerRun }),
        logPath: agentLogPath(factory.logDir, env.newId(), name),
      },
      { sandcastle: await env.agents.sandcastle(), exec: env.agents.exec },
    );
    env.out(args.flags.json === true ? JSON.stringify(output, null, 2) : output.text);
  },

  async 'automation-exec'(args, env) {
    const [automationId, runId] = args.positionals;
    if (!automationId || !runId) {
      throw new Error('Usage: fractory automation-exec <automationId> <runId>');
    }
    // Imported lazily: only automation-exec needs the sandbox stack.
    const { executeAutomationRun } = await import('./runner/automation-execute.ts');
    const factory = await loadFactory(env);
    await executeAutomationRun(automationId, runId, {
      store: new AutomationStore(factory.automationsDir),
      ...(factory.resources && { cpus: factory.resources.cpusPerRun }),
    });
  },

  async config(args, env) {
    if (args.positionals[0] !== 'show') throw new Error('Usage: fractory config show [repoPath]');
    const given = args.positionals[1];
    if (given) {
      return env.out(
        JSON.stringify(describeRepoConfig(await loadRepoConfig(resolve(env.cwd, given))), null, 2),
      );
    }
    // No path: the repo in the current directory, else every configured repo.
    try {
      return env.out(JSON.stringify(describeRepoConfig(await loadRepoConfig(env.cwd)), null, 2));
    } catch (error) {
      const factory = await loadFactory(env);
      if (factory.repos.length === 0) throw error;
      const all: Record<string, unknown> = {};
      for (const repoPath of factory.repos)
        all[repoPath] = describeRepoConfig(await loadRepoConfig(repoPath));
      env.out(JSON.stringify(all, null, 2));
    }
  },

  /** Runs each configured repo's `rebuild` list, or only the named repos'. Never touches git. */
  async rebuild(args, env) {
    const factory = await loadFactory(env);
    await rebuild(
      { repos: factory.repos, loadRepoConfig, runShell: env.runShell, out: env.out },
      args.positionals.map((p) => resolve(env.cwd, p)),
    );
  },

  /**
   * Read-only sweep of every configured repo, or only the named ones: what needs the owner.
   * Exits 0 whenever the sweep completed, however much it found.
   */
  async doctor(args, env) {
    const factory = await loadFactory(env);
    const registry = new RunRegistry(factory.registryDir);
    const findings = await doctor(
      {
        repos: factory.repos,
        factoryConfigPath: env.factoryConfigPath,
        staleWorktreeDays: factory.staleWorktreeDays,
        now: env.now,
        loadRepoConfig,
        listRuns: () => registry.list(),
        listAnswerRequests: () => listAnswerRequests(factory.registryDir),
        readHostState: () => readHostState(factory.hostStatePath),
        ticketSource: (config) => {
          // Reads only: doctor never moves a Ticket or comments on one.
          const source = env.createTicketSource(config.ticketSource, config.mode);
          return { listReady: () => source.listReady(), get: (ref) => source.get(ref) };
        },
        git: (repo, gitArgs) => env.exec('git', ['-C', repo, ...gitArgs]),
        pathExists: (path) =>
          access(path).then(
            () => true,
            () => false,
          ),
        launchdLoaded: () => launchdLoaded(env.launchctl, env.uid),
      },
      args.positionals.map((p) => resolve(env.cwd, p)),
    );
    env.out(renderFindings(findings, { json: args.flags.json === true }));
  },

  /** What an interactive agent checks before working in a repo: Mode, Runs, hands-off branches. */
  async status(args, env) {
    const factory = await loadFactory(env);
    const given = args.positionals[0];
    let repoPath = resolve(env.cwd, given ?? '.');
    if (!given) {
      try {
        const top = (
          await env.exec('git', ['-C', repoPath, 'rev-parse', '--show-toplevel'])
        ).trim();
        if (top) repoPath = top;
      } catch {
        // Not a git checkout: use the directory as given.
      }
    }
    // A missing .fractory.json means "not a Fractory repo"; an invalid one is an error.
    const config = (await readFile(join(repoPath, '.fractory.json')).then(
      () => true,
      () => false,
    ))
      ? await loadRepoConfig(repoPath)
      : undefined;
    const host = await readHostState(factory.hostStatePath);
    const status = repoStatus({
      repoPath,
      config,
      factoryRepos: factory.repos,
      runs: await new RunRegistry(factory.registryDir).list(),
      heldTickets: host?.heldTickets,
      answeredRunIds: await listAnswerRequests(factory.registryDir),
    });
    env.out(
      args.flags.json === true
        ? JSON.stringify({ ...status, host: host ?? null }, null, 2)
        : `${formatStatus(status)}\n${formatHost(host, env.now())}`,
    );
  },

  /** Read-only: each Host Limit beside the current reading it is checked against. */
  async limits(args, env) {
    const [sub, ...pairs] = args.positionals;
    if (sub === 'set') {
      const changes = await setLimits(pairs, {
        path: env.factoryConfigPath,
        machine: env.machine(),
      });
      env.out(
        args.flags.json === true
          ? JSON.stringify({ changes }, null, 2)
          : formatLimitChanges(changes),
      );
      return;
    }
    if (sub !== undefined) throw new Error(`Unknown limits subcommand: ${sub}`);
    const factory = await loadFactory(env);
    const report = await readLimits(
      {
        hostLoad: () =>
          readHostLoad({
            sysctl: (name) => env.exec('sysctl', ['-n', name]),
            docker: (dockerArgs) => env.exec('docker', dockerArgs),
          }),
        hostState: () => readHostState(factory.hostStatePath),
        running: async () => {
          const [runs, automationRuns] = await Promise.all([
            new RunRegistry(factory.registryDir).list(),
            new AutomationStore(factory.automationsDir).listAllRuns(),
          ]);
          return [...runs, ...automationRuns].filter((r) => r.status === 'running').length;
        },
      },
      factory,
    );
    env.out(
      args.flags.json === true ? JSON.stringify(report, null, 2) : formatLimits(report, env.now()),
    );
  },

  async rules(args, env) {
    const factory = await loadFactory(env);
    const options = { maxConcurrentRuns: factory.maxConcurrentRuns };
    const given = args.positionals[0];
    const config = await loadRepoConfig(given ? resolve(env.cwd, given) : env.cwd);
    const description = describeWorkflow(config, options);
    env.out(
      args.flags.json === true ? JSON.stringify(description, null, 2) : formatWorkflow(description),
    );
  },

  async launchd(args, env) {
    const factory = await loadFactory(env);
    const deps = {
      rootDir: env.rootDir,
      launchAgentsDir: env.launchAgentsDir,
      home: env.home,
      uid: env.uid,
      logDir: factory.logDir,
      nodePath: process.execPath,
      resolveBin: env.resolveBin,
      launchctl: env.launchctl,
      exec: env.exec,
      out: env.out,
    };
    const action = args.positionals[0];
    if (action === 'install') env.out(`Installed ${await installLaunchd(deps)}`);
    else if (action === 'uninstall') env.out(`Removed ${await uninstallLaunchd(deps)}`);
    else throw new Error('Usage: fractory launchd install|uninstall');
  },

  async init(args, env) {
    const repoPath = resolve(env.cwd, args.positionals[0] ?? '.');
    const jiraUrl = flag(args, 'jira-url');
    const num = (name: string): number | undefined => {
      const v = flag(args, name);
      return v === undefined ? undefined : Number(v);
    };
    const ci = args.flags.ci === true ? true : args.flags['no-ci'] === true ? false : undefined;
    const options = {
      repoPath,
      mode: flag(args, 'mode'),
      ...(ci !== undefined && { hasCi: ci }),
      ...(flag(args, 'github') && { github: flag(args, 'github') }),
      ...(jiraUrl && {
        jira: {
          baseUrl: jiraUrl,
          projectKey: flag(args, 'jira-project'),
          statuses: {
            ready: flag(args, 'jira-status-ready'),
            inProgress: flag(args, 'jira-status-in-progress'),
            inReview: flag(args, 'jira-status-in-review'),
            done: flag(args, 'jira-status-done'),
          },
        },
      }),
      ...(args.flags['ticket-gate'] === true && { ticketGate: true }),
      ...(flag(args, 'base-branch') && { baseBranch: flag(args, 'base-branch') }),
      ...(flag(args, 'sandbox-image') && { sandboxImage: flag(args, 'sandbox-image') }),
      ...(num('max-iterations') !== undefined && { maxIterations: num('max-iterations') }),
      force: args.flags.force === true,
    };
    // Flags are untyped strings; InitOptionsSchema inside initRepo is the validation boundary.
    const { path } = await initRepo(options as InitOptions);
    env.out(`Wrote ${path}`);
  },

  async install(args, env) {
    const targetDir = flag(args, 'target');
    const result = await installSkills(targetDir ? { targetDir } : {});
    env.out(JSON.stringify(result, null, 2));
  },

  async tickets(args, env) {
    if (args.positionals[0] !== 'create') throw new Error('Usage: fractory tickets create ...');
    const title = flag(args, 'title');
    const bodyFile = flag(args, 'body-file');
    const status = flag(args, 'status');
    if (!title || !bodyFile || (status !== 'backlog' && status !== 'ready')) {
      throw new Error('tickets create needs --title, --body-file and --status backlog|ready');
    }
    const config = await loadRepoConfig(env.cwd);
    // A Ticket becoming Ready starts a Run, so with the Ticket Gate on only the owner makes it Ready.
    if (status === 'ready' && requiresTicketGate(config)) {
      throw new Error(
        'the Ticket Gate is on for this repo: create the Ticket as backlog; the owner moves it to Ready',
      );
    }
    const parent = flag(args, 'parent');
    const input: NewTicket = {
      title,
      body: await readFile(resolve(env.cwd, bodyFile), 'utf8'),
      status,
      blockedBy: ((args.flags['blocked-by'] as string[] | undefined) ?? []).map((r) =>
        TicketRefSchema.parse(r),
      ),
      ...(parent && { parent: TicketRefSchema.parse(parent) }),
    };
    const created = await env.createTicket(config.ticketSource, input, { mode: config.mode });
    env.out(JSON.stringify({ ref: created.ref, url: created.url }));
  },
};

export const main = async (argv: string[], env: CliEnv = defaultEnv()): Promise<number> => {
  const [name, ...rest] = argv;
  if (name === undefined || HELP_NAMES.has(name)) {
    env.out(HELP);
    return 0;
  }
  const handler = name ? commands[name] : undefined;
  if (!handler) {
    env.out(HELP);
    return 1;
  }
  try {
    await handler(parseArgs(rest), env);
    return 0;
  } catch (error) {
    console.error(`fractory ${name}: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
};

const isEntrypoint = async (): Promise<boolean> => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(await realpath(entry)).href === import.meta.url;
  } catch {
    return false;
  }
};

if (await isEntrypoint()) {
  process.exitCode = await main(process.argv.slice(2));
}
