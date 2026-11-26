import { appendFile, mkdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { Sandbox, Worktree } from '@ai-hero/sandcastle';
import { type AgentKind, AgentKindSchema, profileFor } from '../contracts/agents.ts';
import type { Automation, AutomationRunRecord } from '../contracts/automation.ts';
import { FactoryConfigSchema } from '../contracts/factory-config.ts';
import { REPO_CONFIG_FILE, type RepoConfig, RepoConfigSchema } from '../contracts/repo-config.ts';
import type { RunResult } from '../contracts/run.ts';
import { AutomationStore } from '../registry/automations.ts';
import { MissingCredentialError, refuseEnvCredentials, resolveCredentials } from './credentials.ts';
import { type Exec, defaultExec } from './exec.ts';
import { BASE_AGENT_ENV } from './prompt.ts';
import { sandcastleAdapter } from './sandcastle.ts';
import type { SandcastleAdapter } from './types.ts';

/** Where the Automation Run's output directory is mounted inside the container. */
export const AUTOMATION_OUTPUT_MOUNT = '/home/agent/output';
/** The env var that tells the work where to write what it produces. */
export const AUTOMATION_OUTPUT_ENV = 'AUTOMATION_OUTPUT_DIR';

export interface ExecuteAutomationDeps {
  store?: AutomationStore;
  sandcastle?: SandcastleAdapter;
  /** Runs `git` and `security` (Keychain reads). */
  exec?: Exec;
  loadRepoConfig?: (repoPath: string) => Promise<RepoConfig>;
  /** CPU cap for the container (`FactoryConfig.resources.cpusPerRun`); none when unset. */
  cpus?: number;
  now?: () => Date;
}

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const defaultLoadRepoConfig = async (repoPath: string): Promise<RepoConfig> =>
  RepoConfigSchema.parse(JSON.parse(await readFile(join(repoPath, REPO_CONFIG_FILE), 'utf8')));

/** One POSIX shell word, so flags and paths reach the CLI verbatim. */
export const shellQuote = (word: string): string => `'${word.replaceAll("'", `'\\''`)}'`;

/** `<cli> <flags...> <entryPoint>`, stderr merged into stdout so the log has everything. */
export const automationCommand = (automation: Automation): string =>
  `${[automation.cli, ...automation.flags, automation.entryPoint].map(shellQuote).join(' ')} 2>&1`;

/** `<cli> <flags...>`, stderr merged into stdout; an agent gets its prompt on stdin. */
export const agentCommand = (automation: Automation): string =>
  `${[automation.cli, ...automation.flags].map(shellQuote).join(' ')} 2>&1`;

/**
 * The agent an Agent Automation's CLI is, so its Mode's credentials can be resolved: the CLI's
 * file name (`claude`, `/usr/local/bin/opencode`). Anything else has no credentials to give it.
 */
export const agentKindOf = (cli: string): AgentKind => {
  const parsed = AgentKindSchema.safeParse(basename(cli));
  if (!parsed.success) {
    throw new Error(
      `Agent CLI ${cli} is not a known agent (${AgentKindSchema.options.join(', ')}); no credentials can be chosen for it`,
    );
  }
  return parsed.data;
};

/** The local branch the Automation Run's worktree is on. Never pushed. */
export const automationBranch = (record: AutomationRunRecord): string => `automation/${record.id}`;

/** How an Automation Run ended. Never `needs-human`: Fractory Manager owns asking the owner. */
type Ended = Extract<RunResult, { outcome: 'done' | 'failed' }>;

interface Executed {
  exitCode: number;
  /** Whether the work printed anything but whitespace (streamed or in the output tail). */
  printed: boolean;
}

/** How one kind of Automation starts its work in the container, and what counts as success. */
interface Work {
  command: string;
  stdin?: string;
  judge(executed: Executed, logPath: string): Ended;
}

/** A script runs its committed entry point; a clean exit is done. */
const scriptWork = (automation: Automation): Work => ({
  command: automationCommand(automation),
  judge: ({ exitCode }) =>
    exitCode === 0
      ? { outcome: 'done', summary: `${automation.entryPoint} exited cleanly` }
      : {
          outcome: 'failed',
          summary: `${automation.entryPoint} exited with code ${exitCode}`,
        },
});

/**
 * An agent gets the committed entry point as its prompt. It produced a usable result when it
 * exited cleanly and printed something; anything else fails the Run (no needs-human, no re-run).
 */
const agentWork = (automation: Automation, prompt: string): Work => ({
  command: agentCommand(automation),
  stdin: prompt,
  judge: ({ exitCode, printed }, logPath) => {
    if (exitCode !== 0) {
      return {
        outcome: 'failed',
        summary: `${automation.cli} exited with code ${exitCode} without a usable result; log: ${logPath}`,
      };
    }
    if (!printed) {
      return {
        outcome: 'failed',
        summary: `${automation.cli} printed nothing: no usable result; log: ${logPath}`,
      };
    }
    return {
      outcome: 'done',
      summary: `${automation.cli} finished the prompt ${automation.entryPoint}`,
    };
  },
});

class AutomationExecutor {
  private readonly store: AutomationStore;
  private readonly exec: Exec;
  private readonly now: () => Date;
  private logQueue: Promise<void> = Promise.resolve();

  constructor(private readonly deps: ExecuteAutomationDeps) {
    this.store = deps.store ?? new AutomationStore(FactoryConfigSchema.parse({}).automationsDir);
    this.exec = deps.exec ?? defaultExec;
    this.now = deps.now ?? (() => new Date());
  }

  /** Appends to the Run's log in call order. Logging must never fail a Run. */
  private append(record: AutomationRunRecord, text: string): Promise<void> {
    this.logQueue = this.logQueue.then(async () => {
      try {
        await mkdir(dirname(record.logPath), { recursive: true });
        await appendFile(record.logPath, text);
      } catch {
        // Ignored: see above.
      }
    });
    return this.logQueue;
  }

  private note(record: AutomationRunRecord, line: string): Promise<void> {
    return this.append(record, `[automation ${this.now().toISOString()}] ${line}\n`);
  }

  private async update(
    record: AutomationRunRecord,
    patch: Partial<AutomationRunRecord>,
  ): Promise<AutomationRunRecord> {
    const fresh = (await this.store.getRun(record.automationId, record.id)) ?? record;
    const next = { ...fresh, ...patch, updatedAt: this.now().toISOString() };
    await this.store.writeRun(next);
    return next;
  }

  async run(automationId: string, runId: string): Promise<AutomationRunRecord> {
    const initial = await this.store.getRun(automationId, runId);
    if (!initial) throw new Error(`Automation Run ${runId} not found`);
    if (!['queued', 'running'].includes(initial.status)) return initial;

    let result: Ended;
    try {
      result = await this.runInner(initial);
    } catch (error) {
      result = { outcome: 'failed', summary: message(error) };
    }
    await this.note(initial, `result: ${result.outcome}: ${result.summary}`);
    await this.logQueue;
    return this.update(initial, {
      status: result.outcome === 'done' ? 'done' : 'failed',
      result,
    });
  }

  private async runInner(initial: AutomationRunRecord): Promise<Ended> {
    const record = await this.update(initial, { status: 'running' });
    const request = await this.store.readRequestCopy(record.automationId, record.id);
    if (!request) {
      throw new Error(`No configuration was kept for Automation Run ${record.id}; it cannot run`);
    }
    const { automation } = request;

    const repoPath = automation.repoPath;
    const config = await (this.deps.loadRepoConfig ?? defaultLoadRepoConfig)(repoPath);
    await refuseEnvCredentials(repoPath);

    let credentials: Record<string, string>;
    try {
      const kind = automation.kind === 'agent' ? agentKindOf(automation.cli) : 'claude';
      credentials = await resolveCredentials(profileFor(kind, automation.mode), this.exec);
    } catch (error) {
      if (error instanceof MissingCredentialError) throw new Error(error.question);
      throw error;
    }

    const sandcastle = this.deps.sandcastle ?? (await sandcastleAdapter());
    const branch = automationBranch(record);
    const worktree = await sandcastle.createWorktree({
      repoPath,
      branch,
      baseRef: config.baseBranch,
    });
    let sandbox: Sandbox | undefined;
    try {
      await this.note(record, `worktree ready at ${worktree.worktreePath} on ${branch}`);
      const entryPoint = await this.assertEntryPoint(worktree, automation.entryPoint);
      const work =
        automation.kind === 'agent'
          ? agentWork(automation, await readFile(entryPoint, 'utf8'))
          : scriptWork(automation);

      await mkdir(record.outputPath, { recursive: true });
      sandbox = await worktree.createSandbox({
        sandbox: sandcastle.sandbox(config.sandboxImage, this.deps.cpus, {
          mounts: [{ hostPath: record.outputPath, sandboxPath: AUTOMATION_OUTPUT_MOUNT }],
          // Credentials last: nothing else can override the account.
          env: {
            ...BASE_AGENT_ENV,
            [AUTOMATION_OUTPUT_ENV]: AUTOMATION_OUTPUT_MOUNT,
            ...credentials,
          },
        }),
      });

      await this.note(record, `running ${work.command}`);
      let printed = false;
      const executed = await sandbox.exec(work.command, {
        onLine: (line) => {
          if (line.trim() !== '') printed = true;
          void this.append(record, `${line}\n`);
        },
        ...(work.stdin !== undefined && { stdin: work.stdin }),
      });
      if (executed.stderr)
        await this.append(
          record,
          executed.stderr.endsWith('\n') ? executed.stderr : `${executed.stderr}\n`,
        );
      return work.judge(
        { exitCode: executed.exitCode, printed: printed || executed.stdout.trim() !== '' },
        record.logPath,
      );
    } finally {
      await this.cleanUp(record, worktree, sandbox, repoPath, branch);
    }
  }

  /**
   * The entry point must be a file inside the repository; anything else fails the Run.
   * Returns its path on the host.
   */
  private async assertEntryPoint(worktree: Worktree, entryPoint: string): Promise<string> {
    const path = resolve(worktree.worktreePath, entryPoint);
    const inside = relative(worktree.worktreePath, path);
    if (isAbsolute(entryPoint) || inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
      throw new Error(`Entry point ${entryPoint} is not a path inside the repository`);
    }
    let isFile: boolean;
    try {
      isFile = (await stat(path)).isFile();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      isFile = false;
    }
    if (!isFile) {
      throw new Error(
        `Entry point ${entryPoint} is missing from the repository: it must be committed on the base branch`,
      );
    }
    return path;
  }

  /** Tears down the container and the worktree; the output directory is outside both. */
  private async cleanUp(
    record: AutomationRunRecord,
    worktree: Worktree,
    sandbox: Sandbox | undefined,
    repoPath: string,
    branch: string,
  ): Promise<void> {
    if (sandbox) {
      try {
        await sandbox.close();
      } catch (error) {
        await this.note(record, `could not close the container: ${message(error)}`);
      }
    }
    try {
      const closed = await worktree.close();
      if (closed.preservedWorktreePath) {
        await this.note(record, `worktree kept at ${closed.preservedWorktreePath}: it has changes`);
        return;
      }
    } catch (error) {
      await this.note(record, `could not remove the worktree: ${message(error)}`);
      return;
    }
    try {
      await this.exec('git', ['branch', '-D', branch], { cwd: repoPath });
    } catch (error) {
      await this.note(record, `could not delete branch ${branch}: ${message(error)}`);
    }
  }
}

/**
 * Entry for `fractory automation-exec <automationId> <runId>`: runs an Automation in a container
 * on a fresh worktree and records how it ended. Both kinds share this path; only how the work
 * starts differs (a script runs its entry point, an agent CLI gets it as its prompt on stdin).
 * It never reads a Ticket, never requires commits and never opens a pull request.
 */
export const executeAutomationRun = (
  automationId: string,
  runId: string,
  deps: ExecuteAutomationDeps = {},
): Promise<AutomationRunRecord> => new AutomationExecutor(deps).run(automationId, runId);
