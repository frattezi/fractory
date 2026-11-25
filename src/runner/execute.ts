import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Worktree } from '@ai-hero/sandcastle';
import { z } from 'zod';
import { type AgentKind, profileFor, profileLabel } from '../contracts/agents.ts';
import { FactoryConfigSchema } from '../contracts/factory-config.ts';
import { REPO_CONFIG_FILE, type RepoConfig, RepoConfigSchema } from '../contracts/repo-config.ts';
import {
  AM_COMMENT_PREFIX,
  type RunRecord,
  type RunResult,
  RunResultSchema,
} from '../contracts/run.ts';
import type { Ticket, TicketSource } from '../contracts/ticket.ts';
import { loadFlow } from '../flows/load.ts';
import type { Flow, FlowAgents } from '../flows/types.ts';
import { assertOutboundAllowed, forbiddenMatches } from '../policy/outbound.ts';
import {
  consumedCommentIds,
  formatAmComments,
  pendingComments,
  readRunComments,
} from '../registry/comments.ts';
import { RunRegistry } from '../registry/registry.ts';
import { MissingCredentialError, credentialKeysIn, resolveCredentials } from './credentials.ts';
import { type Exec, FRACTORY_ROOT, defaultExec } from './exec.ts';
import { installPrePushHook } from './hook.ts';
import {
  BASE_AGENT_ENV,
  COMPLETION_SIGNAL,
  type FollowUp,
  buildPrompt,
  formatReviewComment,
  parseRunResult,
} from './prompt.ts';
import { remoteFor } from './remote.ts';
import { sandcastleAdapter } from './sandcastle.ts';
import type { SandcastleAdapter } from './types.ts';

export interface ExecuteDeps {
  /** The tracker for the repo, or a factory given the repo's config. Part B builds the real one. */
  ticketSource: TicketSource | ((config: RepoConfig) => TicketSource);
  registry?: RunRegistry;
  sandcastle?: SandcastleAdapter;
  /** Replaces the flow loader (tests). */
  loadFlow?: (name: string) => Promise<Flow>;
  /** Runs `git`, `gh` and `security` (Keychain reads). */
  exec?: Exec;
  loadRepoConfig?: (repoPath: string) => Promise<RepoConfig>;
  /** Contents of `rules/run-agent.md`. */
  readRules?: () => Promise<string>;
  pid?: number;
  /** CPU cap for the Run's container (`FactoryConfig.resources.cpusPerRun`); none when unset. */
  cpus?: number;
}

const GhPrListSchema = z.array(z.object({ url: z.string().url() }));
const GhRunListSchema = z.array(z.object({ databaseId: z.number().int() }));

const defaultLoadRepoConfig = async (repoPath: string): Promise<RepoConfig> =>
  RepoConfigSchema.parse(JSON.parse(await readFile(join(repoPath, REPO_CONFIG_FILE), 'utf8')));

const defaultReadRules = (): Promise<string> =>
  readFile(join(FRACTORY_ROOT, 'rules', 'run-agent.md'), 'utf8');

const DEFAULT_CLAUDE_MODEL = 'claude-opus-5-5';
const DEFAULT_OPENCODE_MODEL = 'opencode-go/kimi-k3';

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Text that goes to a shared system: the preferred text if allowed in this Mode, else the fallback. */
const outboundText = (preferred: string, fallback: string, mode: RepoConfig['mode']): string => {
  if (forbiddenMatches(preferred).length === 0 || mode !== 'work') return preferred;
  assertOutboundAllowed(fallback, mode);
  return fallback;
};

/** The real worktree, except `run` also reports the agent session id of the latest iteration. */
const trackSessions = (worktree: Worktree, onSession: (id: string) => void): Worktree =>
  new Proxy(worktree, {
    get(target, prop) {
      if (prop === 'run') {
        return async (options: Parameters<Worktree['run']>[0]) => {
          const result = await target.run(options);
          const id = [...result.iterations].reverse().find((i) => i.sessionId)?.sessionId;
          if (id) onSession(id);
          return result;
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

const ticketKey = (ref: string): string => ref.slice(ref.indexOf(':') + 1);

/** Where a Run's branch goes: the git remote, and the GitHub repo when Tickets live on GitHub. */
interface PushTarget {
  remote: string;
  repo?: string;
}

class Executor {
  private readonly registry: RunRegistry;
  private readonly exec: Exec;

  constructor(private readonly deps: ExecuteDeps) {
    this.registry = deps.registry ?? new RunRegistry(FactoryConfigSchema.parse({}).registryDir);
    this.exec = deps.exec ?? defaultExec;
  }

  private async log(record: RunRecord, line: string): Promise<void> {
    try {
      await mkdir(dirname(record.logPath), { recursive: true });
      await appendFile(record.logPath, `[fractory ${new Date().toISOString()}] ${line}\n`);
    } catch {
      // Logging must never fail a Run.
    }
  }

  private async git(cwd: string, ...args: string[]): Promise<string> {
    return (await this.exec('git', args, { cwd })).stdout.trim();
  }

  /** The comments this Run was queued for: those up to `newestId` no earlier Run consumed. */
  private async amComments(record: RunRecord, newestId: string): Promise<string | undefined> {
    try {
      const ticketRuns = (await this.registry.list()).filter(
        (r) => r.ticketRef === record.ticketRef && r.id !== record.id,
      );
      for (const run of ticketRuns) {
        const comments = await readRunComments(this.registry.dir, run.id).catch(() => undefined);
        if (!comments?.some((c) => c.id === newestId)) continue;
        const pending = pendingComments(comments, consumedCommentIds(ticketRuns), newestId);
        return pending.length > 0 ? formatAmComments(pending) : undefined;
      }
    } catch {
      // Falls through: the prompt tells the agent the comments could not be read.
    }
    return undefined;
  }

  private async followUp(record: RunRecord): Promise<FollowUp | undefined> {
    const { trigger } = record;
    const cwd = record.repoPath;
    if (trigger.kind === 'ci-failed') {
      try {
        const list = GhRunListSchema.parse(
          JSON.parse(
            (
              await this.exec(
                'gh',
                [
                  'run',
                  'list',
                  '--commit',
                  trigger.headSha,
                  '--json',
                  'databaseId',
                  '--limit',
                  '1',
                ],
                { cwd },
              )
            ).stdout,
          ),
        );
        const id = list[0]?.databaseId;
        if (id === undefined) throw new Error('no workflow run for that commit');
        const log = (await this.exec('gh', ['run', 'view', String(id), '--log-failed'], { cwd }))
          .stdout;
        return { kind: 'ci-failed', prNumber: trigger.prNumber, log };
      } catch (error) {
        await this.log(record, `could not fetch the CI log: ${message(error)}`);
        return { kind: 'ci-failed', prNumber: trigger.prNumber, log: undefined };
      }
    }
    if (trigger.kind === 'review-comment' && trigger.commentId.startsWith(AM_COMMENT_PREFIX)) {
      const comment = await this.amComments(
        record,
        trigger.commentId.slice(AM_COMMENT_PREFIX.length),
      );
      if (!comment) await this.log(record, 'could not read the Agent Manager comments');
      return { kind: 'review-comment', prNumber: trigger.prNumber, comment };
    }
    if (trigger.kind === 'review-comment') {
      for (const kind of ['pulls', 'issues']) {
        try {
          const json = (
            await this.exec(
              'gh',
              ['api', `repos/{owner}/{repo}/${kind}/comments/${trigger.commentId}`],
              {
                cwd,
              },
            )
          ).stdout;
          const comment = formatReviewComment(json);
          if (comment) return { kind: 'review-comment', prNumber: trigger.prNumber, comment };
        } catch {
          // Try the other comment kind.
        }
      }
      await this.log(record, 'could not fetch the review comment');
      return { kind: 'review-comment', prNumber: trigger.prNumber, comment: undefined };
    }
    return undefined;
  }

  /**
   * The remote a Run fetches from and pushes to. With GitHub Tickets it must point at the
   * configured repo: in a fork `origin` may be the upstream project, so a Run refuses to start
   * rather than fail at the push after all its work.
   */
  private async resolveRemote(record: RunRecord, config: RepoConfig): Promise<PushTarget> {
    if (config.ticketSource.kind !== 'github') return { remote: 'origin' };
    const { repo } = config.ticketSource;
    const remotes = await this.git(record.repoPath, 'remote', '-v');
    const remote = remoteFor(remotes, repo);
    if (!remote) {
      throw new Error(
        `no git remote of ${record.repoPath} points at ${repo}; add one with: git remote add origin https://github.com/${repo}.git`,
      );
    }
    return { remote, repo };
  }

  /** `<remote>/<base>` when it can be fetched, otherwise the local base branch. */
  private async resolveBaseRef(record: RunRecord, remote: string, base: string): Promise<string> {
    try {
      await this.exec('git', ['fetch', remote, base], { cwd: record.repoPath });
      return `${remote}/${base}`;
    } catch (error) {
      await this.log(
        record,
        `could not fetch ${remote}/${base}, using the local branch: ${message(error)}`,
      );
      return base;
    }
  }

  private async commitMessages(
    worktree: string,
    baseRef: string,
    branch: string,
  ): Promise<string[]> {
    const out = await this.git(worktree, 'log', '--format=%H%x1f%B%x1e', `${baseRef}..${branch}`);
    return out
      .split('\x1e')
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  /** Push the branch and open the PR, or reuse the open one. Returns the PR url. */
  private async publish(
    record: RunRecord,
    config: RepoConfig,
    ticket: Ticket,
    worktree: string,
    baseRef: string,
    hooksDir: string,
    summary: string,
    target: PushTarget,
  ): Promise<string> {
    const repoArgs = target.repo ? ['--repo', target.repo] : [];
    const ahead = Number(
      await this.git(worktree, 'rev-list', '--count', `${baseRef}..${record.branch}`),
    );
    if (!(ahead > 0)) throw new Error('the agent reported done but made no commits');

    if (config.mode === 'work') {
      for (const entry of await this.commitMessages(worktree, baseRef, record.branch)) {
        const [sha = '', body = ''] = entry.split('\x1f');
        const matches = forbiddenMatches(body);
        if (matches.length > 0) {
          throw new Error(
            `commit ${sha.slice(0, 8)} message is not allowed in Work Mode (${matches.join(', ')}); not pushed`,
          );
        }
      }
    }

    await this.exec(
      'git',
      ['-c', `core.hooksPath=${hooksDir}`, 'push', '--set-upstream', target.remote, record.branch],
      { cwd: worktree },
    );

    const existing = GhPrListSchema.parse(
      JSON.parse(
        (
          await this.exec(
            'gh',
            [
              'pr',
              'list',
              ...repoArgs,
              '--head',
              record.branch,
              '--state',
              'open',
              '--json',
              'url',
              '--limit',
              '1',
            ],
            { cwd: worktree },
          )
        ).stdout,
      ),
    );
    if (existing[0]) return existing[0].url; // pushing the branch updated it

    const key = ticketKey(ticket.ref);
    const title = outboundText(ticket.title, `Work on ${key}`, config.mode);
    const header = `Ticket: ${ticket.url}`;
    const body = outboundText(`${header}\n\n${summary}`, header, config.mode);
    assertOutboundAllowed(title, config.mode);
    assertOutboundAllowed(body, config.mode);
    const created = await this.exec(
      'gh',
      [
        'pr',
        'create',
        ...repoArgs,
        '--base',
        config.baseBranch,
        '--head',
        record.branch,
        '--title',
        title,
        '--body',
        body,
      ],
      { cwd: worktree },
    );
    const url = created.stdout.trim().split('\n').at(-1) ?? '';
    return z.string().url().parse(url);
  }

  /**
   * Sandcastle merges `.sandcastle/.env` under the agent provider's env, but a credential key
   * defined there and not set by us (e.g. ANTHROPIC_API_KEY next to a Claude OAuth token) would
   * still reach the sandbox and could pick the wrong account. So a Run refuses to start.
   */
  private async refuseEnvCredentials(repoPath: string): Promise<void> {
    let content: string;
    try {
      content = await readFile(join(repoPath, '.sandcastle', '.env'), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw new Error(`could not read .sandcastle/.env: ${message(error)}`);
    }
    const keys = credentialKeysIn(content);
    if (keys.length > 0) {
      throw new Error(
        `.sandcastle/.env defines ${keys.join(', ')}; remove it: the account comes from the Keychain per Mode`,
      );
    }
  }

  private agents(sandcastle: SandcastleAdapter, config: RepoConfig, used: Set<string>): FlowAgents {
    const wire = async <O extends { env?: Record<string, string> | undefined }>(
      kind: AgentKind,
      options: O | undefined,
      build: (env: Record<string, string>) => ReturnType<FlowAgents['claude']>,
    ) => {
      const profile = profileFor(kind, config.mode);
      const credentials = await resolveCredentials(profile, this.exec);
      // Credentials last: a flow cannot override the account.
      const provider = await build({ ...BASE_AGENT_ENV, ...options?.env, ...credentials });
      used.add(profileLabel(profile));
      return provider;
    };
    return {
      claude: (model, options) =>
        wire('claude', options, async (env) =>
          sandcastle.claudeCode(model ?? process.env.FRACTORY_MODEL ?? DEFAULT_CLAUDE_MODEL, {
            ...options,
            env,
          }),
        ),
      opencode: (model, options) =>
        wire('opencode', options, async (env) =>
          sandcastle.opencode(
            model ?? process.env.FRACTORY_OPENCODE_MODEL ?? DEFAULT_OPENCODE_MODEL,
            { ...options, env },
          ),
        ),
    };
  }

  async run(runId: string): Promise<RunRecord> {
    const initial = await this.registry.get(runId);
    if (!initial) throw new Error(`Run ${runId} not found`);
    if (!['queued', 'running'].includes(initial.status)) return initial;

    try {
      return await this.runInner(initial);
    } catch (error) {
      await this.log(initial, `run failed: ${message(error)}`);
      return this.finish(initial.id, {
        status: 'failed',
        result: { outcome: 'failed', summary: message(error) },
      });
    }
  }

  private finish(id: string, patch: Partial<RunRecord>): Promise<RunRecord> {
    return this.registry.update(id, { ...patch, finishedAt: new Date().toISOString() });
  }

  private async runInner(initial: RunRecord): Promise<RunRecord> {
    let record = await this.registry.update(initial.id, {
      status: 'running',
      pid: this.deps.pid ?? process.pid,
    });
    const config = await (this.deps.loadRepoConfig ?? defaultLoadRepoConfig)(record.repoPath);
    record = await this.registry.update(record.id, { mode: config.mode, flow: config.flow });
    const source =
      typeof this.deps.ticketSource === 'function'
        ? this.deps.ticketSource(config)
        : this.deps.ticketSource;

    const ticket = await source.get(record.ticketRef);
    const rules = await (this.deps.readRules ?? defaultReadRules)();
    const followUp = await this.followUp(record);

    await this.refuseEnvCredentials(record.repoPath);
    const flow = await (this.deps.loadFlow ?? loadFlow)(config.flow);

    const target = await this.resolveRemote(record, config);
    const baseRef = await this.resolveBaseRef(record, target.remote, config.baseBranch);
    const sandcastle = this.deps.sandcastle ?? (await sandcastleAdapter());
    const worktree = await sandcastle.createWorktree({
      repoPath: record.repoPath,
      branch: record.branch,
      baseRef,
    });
    const { hooksDir } = await installPrePushHook({
      worktreePath: worktree.worktreePath,
      baseBranch: config.baseBranch,
      exec: this.exec,
    });
    record = await this.registry.update(record.id, { worktreePath: worktree.worktreePath });
    await this.log(
      record,
      `worktree ready at ${worktree.worktreePath}; running flow ${config.flow}`,
    );

    const usedAgents = new Set<string>();
    let sessionId: string | undefined;
    const tracked = trackSessions(worktree, (id) => {
      sessionId = id;
    });
    let flowResult: unknown;
    try {
      flowResult = await flow({
        ticket,
        repoConfig: config,
        followUp,
        rules,
        worktree: tracked,
        sandbox: sandcastle.sandbox(config.sandboxImage, this.deps.cpus),
        agents: this.agents(sandcastle, config, usedAgents),
        logPath: record.logPath,
        maxIterations: config.maxIterations,
        completionSignal: COMPLETION_SIGNAL,
        buildPrompt,
        parseRunResult,
      });
    } catch (error) {
      flowResult =
        error instanceof MissingCredentialError
          ? { outcome: 'needs-human', reason: 'needs-access', question: error.question }
          : {
              outcome: 'failed',
              summary: `The flow "${config.flow}" failed: ${message(error)}`,
            };
    }
    record = await this.registry.update(record.id, {
      ...(usedAgents.size > 0 ? { agents: [...usedAgents] } : {}),
      ...(sessionId === undefined ? {} : { sessionId }),
    });

    const validated = RunResultSchema.safeParse(flowResult);
    const result: RunResult = validated.success
      ? validated.data
      : {
          outcome: 'failed',
          summary: `The flow "${config.flow}" returned an invalid result: ${validated.error.message}`,
        };
    await this.log(record, `flow result: ${result.outcome}`);

    if (result.outcome === 'needs-human') {
      if (config.mode === 'personal') {
        try {
          const body = `Needs a human (${result.reason}): ${result.question}`;
          assertOutboundAllowed(body, config.mode);
          await source.comment(record.ticketRef, body);
        } catch (error) {
          await this.log(record, `could not comment on the Ticket: ${message(error)}`);
        }
      }
      return this.finish(record.id, { status: 'needs-human', result });
    }
    if (result.outcome === 'failed') {
      return this.finish(record.id, { status: 'failed', result });
    }

    try {
      const prUrl = await this.publish(
        record,
        config,
        ticket,
        worktree.worktreePath,
        baseRef,
        hooksDir,
        result.summary,
        target,
      );
      record = await this.registry.update(record.id, { prUrl });
      try {
        await source.setStatus(record.ticketRef, 'in_review');
      } catch (error) {
        await this.log(
          record,
          `PR is open but the Ticket status was not updated: ${message(error)}`,
        );
      }
      return this.finish(record.id, { status: 'done', result });
    } catch (error) {
      await this.log(record, `publishing failed: ${message(error)}`);
      return this.finish(record.id, {
        status: 'failed',
        result: { outcome: 'failed', summary: `Publishing failed: ${message(error)}` },
      });
    }
  }
}

/** Entry for `fractory run-exec <id>`: runs the Run to completion and records its final state. */
export const executeRun = (runId: string, deps: ExecuteDeps): Promise<RunRecord> =>
  new Executor(deps).run(runId);
