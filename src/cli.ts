#!/usr/bin/env -S npx tsx
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  type CreatedTicket,
  type NewTicket,
  createTicket,
  createTicketSource,
} from './adapters/index.ts';
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
import { type Exec, defaultExec } from './github/exec.ts';
import { type Gh, createGh } from './github/gh.ts';
import { type InitOptions, initRepo } from './package/init.ts';
import { installSkills } from './package/install.ts';
import { readHostLoad } from './policy/resources.ts';
import { describeWorkflow, formatWorkflow } from './policy/workflow.ts';
import { type RunShell, defaultRunShell, rebuild } from './rebuild/rebuild.ts';
import { AutomationStore } from './registry/automations.ts';
import { readHostState } from './registry/host-state.ts';
import { RunRegistry } from './registry/registry.ts';
import { launchAutomationRun } from './runner/automation.ts';
import { launchRun } from './runner/index.ts';
import { formatHost, formatStatus, repoStatus } from './status/status.ts';
import { newestFirst } from './trigger/automation-prune.ts';
import { type Launchctl, installLaunchd, resolveBin, uninstallLaunchd } from './trigger/launchd.ts';
import { branchFor, queueRun } from './trigger/queue.ts';
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
  now: () => Date;
  newId: () => string;
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
    now: () => new Date(),
    newId: () => randomUUID(),
  };
};

export interface CliArgs {
  positionals: string[];
  flags: Record<string, string | boolean | string[]>;
}

const BOOLEAN_FLAGS = new Set(['ci', 'no-ci', 'ticket-gate', 'force', 'json']);
const REPEATABLE_FLAGS = new Set(['blocked-by']);

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
  config show [repoPath]
  rebuild [repoPath...]
  rules [repoPath] [--json]
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
    const { repoPath, config } = await findRepoForTicket(env, factory, ref);
    const registry = new RunRegistry(factory.registryDir);
    // Reuse the Ticket's branch when it already has Runs, so a manual Run continues the PR.
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
        mode: config.mode,
        flow: config.flow,
      },
    );
    // Out of Ready, so the tick does not queue a ticket-ready Run next to this one.
    await source.setStatus(ref, 'in_progress');
    env.out(`Queued Run ${record.id} on ${record.branch}; the next tick starts it.`);
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
    const status = repoStatus({
      repoPath,
      config,
      factoryRepos: factory.repos,
      runs: await new RunRegistry(factory.registryDir).list(),
    });
    const host = await readHostState(factory.hostStatePath);
    env.out(
      args.flags.json === true
        ? JSON.stringify({ ...status, host: host ?? null }, null, 2)
        : `${formatStatus(status)}\n${formatHost(host, env.now())}`,
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
