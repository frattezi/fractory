import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { FactoryConfigSchema } from '../contracts/factory-config.ts';
import { REPO_CONFIG_FILE, type RepoConfig, RepoConfigSchema } from '../contracts/repo-config.ts';
import type { RunRecord, RunResult } from '../contracts/run.ts';
import type { Ticket, TicketSource } from '../contracts/ticket.ts';
import { assertOutboundAllowed, forbiddenMatches } from '../policy/outbound.ts';
import { RunRegistry } from '../registry/registry.ts';
import { type Exec, FRACTORY_ROOT, defaultExec } from './exec.ts';
import { installPrePushHook } from './hook.ts';
import {
  COMPLETION_SIGNAL,
  type FollowUp,
  agentEnv,
  buildPrompt,
  formatReviewComment,
  parseRunResult,
} from './prompt.ts';
import { sandcastleAdapter } from './sandcastle.ts';
import type { SandcastleAdapter } from './types.ts';

export interface ExecuteDeps {
  /** The tracker for the repo, or a factory given the repo's config. Part B builds the real one. */
  ticketSource: TicketSource | ((config: RepoConfig) => TicketSource);
  registry?: RunRegistry;
  sandcastle?: SandcastleAdapter;
  /** Runs `git` and `gh`. */
  exec?: Exec;
  loadRepoConfig?: (repoPath: string) => Promise<RepoConfig>;
  /** Contents of `rules/run-agent.md`. */
  readRules?: () => Promise<string>;
  hostEnv?: NodeJS.ProcessEnv;
  pid?: number;
}

const GhPrListSchema = z.array(z.object({ url: z.string().url() }));
const GhRunListSchema = z.array(z.object({ databaseId: z.number().int() }));

const defaultLoadRepoConfig = async (repoPath: string): Promise<RepoConfig> =>
  RepoConfigSchema.parse(JSON.parse(await readFile(join(repoPath, REPO_CONFIG_FILE), 'utf8')));

const defaultReadRules = (): Promise<string> =>
  readFile(join(FRACTORY_ROOT, 'rules', 'run-agent.md'), 'utf8');

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Text that goes to a shared system: the preferred text if allowed in this Mode, else the fallback. */
const outboundText = (preferred: string, fallback: string, mode: RepoConfig['mode']): string => {
  if (forbiddenMatches(preferred).length === 0 || mode !== 'work') return preferred;
  assertOutboundAllowed(fallback, mode);
  return fallback;
};

const ticketKey = (ref: string): string => ref.slice(ref.indexOf(':') + 1);

class Executor {
  private readonly registry: RunRegistry;
  private readonly exec: Exec;
  private readonly sandcastle: SandcastleAdapter;

  constructor(private readonly deps: ExecuteDeps) {
    this.registry = deps.registry ?? new RunRegistry(FactoryConfigSchema.parse({}).registryDir);
    this.exec = deps.exec ?? defaultExec;
    this.sandcastle = deps.sandcastle ?? sandcastleAdapter();
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

  /** `origin/<base>` when it can be fetched, otherwise the local base branch. */
  private async resolveBaseRef(record: RunRecord, base: string): Promise<string> {
    try {
      await this.exec('git', ['fetch', 'origin', base], { cwd: record.repoPath });
      return `origin/${base}`;
    } catch (error) {
      await this.log(
        record,
        `could not fetch origin/${base}, using the local branch: ${message(error)}`,
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
  ): Promise<string> {
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
      ['-c', `core.hooksPath=${hooksDir}`, 'push', '--set-upstream', 'origin', record.branch],
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
    const source =
      typeof this.deps.ticketSource === 'function'
        ? this.deps.ticketSource(config)
        : this.deps.ticketSource;

    const ticket = await source.get(record.ticketRef);
    const rules = await (this.deps.readRules ?? defaultReadRules)();
    const prompt = buildPrompt({ rules, ticket, followUp: await this.followUp(record) });

    const baseRef = await this.resolveBaseRef(record, config.baseBranch);
    const worktree = await this.sandcastle.prepareWorktree({
      repoPath: record.repoPath,
      branch: record.branch,
      baseRef,
      sandboxImage: config.sandboxImage,
    });
    const { hooksDir } = await installPrePushHook({
      worktreePath: worktree.path,
      baseBranch: config.baseBranch,
      exec: this.exec,
    });
    record = await this.registry.update(record.id, { worktreePath: worktree.path });
    await this.log(record, `worktree ready at ${worktree.path}; starting the agent`);

    const outcome = await worktree.runAgent({
      prompt,
      maxIterations: config.maxIterations,
      completionSignal: COMPLETION_SIGNAL,
      env: agentEnv(this.deps.hostEnv ?? process.env),
      logPath: record.logPath,
    });
    if (outcome.sessionId) {
      record = await this.registry.update(record.id, { sessionId: outcome.sessionId });
    }

    const parsed = parseRunResult(outcome.stdout);
    const result: RunResult =
      parsed ??
      (outcome.completed
        ? { outcome: 'failed', summary: 'The agent finished without a valid result block.' }
        : {
            outcome: 'needs-human',
            reason: 'budget-exhausted',
            question: `The agent used all ${config.maxIterations} iterations on ${record.ticketRef} without finishing. Raise maxIterations or split the Ticket?`,
          });
    await this.log(record, `agent result: ${result.outcome}`);

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
        worktree.path,
        baseRef,
        hooksDir,
        result.summary,
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
