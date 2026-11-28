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
  runBaseBranch,
} from '../contracts/run.ts';
import type { Ticket, TicketSource } from '../contracts/ticket.ts';
import { loadFlow } from '../flows/load.ts';
import type { Flow, FlowAgents } from '../flows/types.ts';
import { assertOutboundAllowed, forbiddenMatches } from '../policy/outbound.ts';
import { readAnswerRequest } from '../registry/answers.ts';
import {
  consumedCommentIds,
  formatAmComments,
  pendingComments,
  readRunComments,
} from '../registry/comments.ts';
import { RunRegistry } from '../registry/registry.ts';
import { MissingCredentialError, refuseEnvCredentials, resolveCredentials } from './credentials.ts';
import { type Exec, FRACTORY_ROOT, defaultExec } from './exec.ts';
import { installPrePushHook } from './hook.ts';
import {
  BASE_AGENT_ENV,
  COMPLETION_SIGNAL,
  DEFAULT_CLAUDE_MODEL,
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

  /**
   * The answered Run's question and the owner's answer, both read from the registry. A part that
   * cannot be read is left undefined: the prompt then points the agent at the Ticket's comments.
   */
  private async answerFollowUp(record: RunRecord, runId: string): Promise<FollowUp> {
    const request = await readAnswerRequest(this.registry.dir, runId);
    if (!request) await this.log(record, `could not read the answer request of Run ${runId}`);
    const answered = await this.registry.get(runId).catch(() => undefined);
    const result = answered?.result;
    const asked = result?.outcome === 'needs-human' ? result : undefined;
    if (!asked) await this.log(record, `could not read the needs-human question of Run ${runId}`);
    return {
      kind: 'answer',
      reason: asked?.reason,
      question: asked?.question,
      answer: request?.answer,
    };
  }

  private async followUp(record: RunRecord): Promise<FollowUp | undefined> {
    const { trigger } = record;
    const cwd = record.repoPath;
    if (trigger.kind === 'answer') return this.answerFollowUp(record, trigger.runId);
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

  /**
   * Refuse to open a PR against a base branch the remote does not have: GitHub answers that with
   * a pile of GraphQL errors that never name the branch. Only an answered `ls-remote` with no
   * matching ref proves the branch is missing; a failed read is logged and the PR call goes ahead.
   */
  private async assertBaseOnRemote(
    record: RunRecord,
    worktree: string,
    remote: string,
    base: string,
  ): Promise<void> {
    let refs: string;
    try {
      refs = (
        await this.exec('git', ['ls-remote', '--heads', remote, `refs/heads/${base}`], {
          cwd: worktree,
        })
      ).stdout;
    } catch (error) {
      await this.log(record, `could not list ${base} on ${remote}: ${message(error)}`);
      return;
    }
    if (refs.trim() === '') {
      throw new Error(
        `base branch ${base} is not on remote ${remote}; push it (git push ${remote} ${base}) and re-run the Ticket`,
      );
    }
  }

  /** `-c user.name=… -c user.email=…` of the branch tip's committer, so a rebase keeps it. */
  private async tipCommitter(cwd: string): Promise<string[]> {
    const [name = '', email = ''] = (await this.git(cwd, 'log', '-1', '--format=%cn%x1f%ce')).split(
      '\x1f',
    );
    return name && email ? ['-c', `user.name=${name}`, '-c', `user.email=${email}`] : [];
  }

  /**
   * Why a stacked Run's base is no longer the branch to publish against: the remote no longer has
   * it, or its pull request merged. Undefined when the base still stands or could not be read: a
   * failed read proves nothing, so the recorded base is kept.
   */
  private async baseLanded(
    record: RunRecord,
    worktree: string,
    target: PushTarget,
    base: string,
  ): Promise<string | undefined> {
    const missing = await this.baseMissing(record, worktree, target, base);
    if (missing === undefined) return undefined;
    if (missing) return `${base} is no longer on ${target.remote}`;
    return this.baseMerged(record, worktree, target, base);
  }

  /** True when the remote lists no such branch; undefined when it could not be read. */
  private async baseMissing(
    record: RunRecord,
    worktree: string,
    target: PushTarget,
    base: string,
  ): Promise<boolean | undefined> {
    try {
      const refs = (
        await this.exec('git', ['ls-remote', '--heads', target.remote, `refs/heads/${base}`], {
          cwd: worktree,
        })
      ).stdout;
      return refs.trim() === '';
    } catch (error) {
      await this.log(record, `could not list ${base} on ${target.remote}: ${message(error)}`);
      return undefined;
    }
  }

  private async baseMerged(
    record: RunRecord,
    worktree: string,
    target: PushTarget,
    base: string,
  ): Promise<string | undefined> {
    try {
      const merged = GhPrListSchema.parse(
        JSON.parse(
          (
            await this.exec(
              'gh',
              [
                'pr',
                'list',
                ...(target.repo ? ['--repo', target.repo] : []),
                '--head',
                base,
                '--state',
                'merged',
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
      if (merged[0]) return `the pull request of ${base} merged (${merged[0].url})`;
    } catch (error) {
      await this.log(record, `could not read the pull requests of ${base}: ${message(error)}`);
    }
    return undefined;
  }

  /**
   * The base a finished Run publishes against, read again now rather than trusted from when it was
   * queued: a stacked Run's blocker may have merged while it worked. A blocker that landed leaves
   * the repository's base branch as the Run's base, and only the Run's own commits (those after
   * the recorded `baseSha`) are rebased onto it, so a blocker merged as a squash is not brought
   * back as different commits. A rebase that conflicts is aborted and the branch is pushed as it
   * was, so the work reaches the remote, and publishing fails for the owner.
   */
  private async settleBase(
    record: RunRecord,
    config: RepoConfig,
    worktree: string,
    baseRef: string,
    hooksDir: string,
    target: PushTarget,
  ): Promise<{ record: RunRecord; baseRef: string; base: string; lease?: string; moved: boolean }> {
    const recorded = runBaseBranch(record, config.baseBranch);
    const kept = { record, baseRef, base: recorded, moved: false };
    if (recorded === config.baseBranch) return kept;
    const landed = await this.baseLanded(record, worktree, target, recorded);
    if (landed === undefined) return kept;

    const base = config.baseBranch;
    const { remote } = target;
    const { branch } = record;
    await this.log(record, `${landed}; publishing ${branch} against ${base}`);
    const newRef = await this.resolveBaseRef(record, remote, base);
    const tipSha = await this.git(worktree, 'rev-parse', newRef);
    const ownCommitsFrom =
      record.baseSha === undefined
        ? undefined
        : await this.exec('git', ['merge-base', '--is-ancestor', record.baseSha, 'HEAD'], {
            cwd: worktree,
          }).then(
            () => record.baseSha,
            () => undefined,
          );
    // A branch a follow-up Run already pushed is replaced only if it is still where it was read.
    const pushedSha = await this.exec(
      'git',
      ['ls-remote', '--heads', remote, `refs/heads/${branch}`],
      { cwd: worktree },
    ).then(
      (out) => out.stdout.trim().split(/\s/)[0] || undefined,
      async (error) => {
        await this.log(record, `could not list ${branch} on ${remote}: ${message(error)}`);
        return undefined;
      },
    );
    const identity = await this.tipCommitter(worktree);
    await this.log(record, `rebasing ${branch} onto ${newRef} (${tipSha.slice(0, 8)})`);
    try {
      await this.exec(
        'git',
        [
          ...identity,
          'rebase',
          ...(ownCommitsFrom ? ['--onto', newRef, ownCommitsFrom] : [newRef]),
        ],
        { cwd: worktree },
      );
    } catch (error) {
      const conflicted = await this.git(worktree, 'diff', '--name-only', '--diff-filter=U').catch(
        () => '',
      );
      await this.exec('git', ['rebase', '--abort'], { cwd: worktree }).catch(async (abortError) => {
        await this.log(record, `could not abort the rebase: ${message(abortError)}`);
      });
      const files = conflicted.split('\n').filter(Boolean);
      let left = `${branch} was pushed as it was for the owner`;
      try {
        await this.exec(
          'git',
          ['-c', `core.hooksPath=${hooksDir}`, 'push', '--set-upstream', remote, branch],
          { cwd: worktree },
        );
      } catch (pushError) {
        left = `${branch} could not be pushed (${message(pushError)}) and is left in ${worktree}`;
      }
      throw new Error(
        `${landed}, and rebasing ${branch} onto ${base} (${tipSha.slice(0, 8)}) conflicts${files.length > 0 ? ` in ${files.join(', ')}` : ''}; the rebase was aborted and ${left}. ${message(error)}`,
      );
    }
    const updated = await this.registry.update(record.id, { baseBranch: base, baseSha: tipSha });
    return {
      record: updated,
      baseRef: newRef,
      base,
      moved: true,
      ...(pushedSha === undefined ? {} : { lease: pushedSha }),
    };
  }

  /** The tip of the Run's branch when it already exists locally: an earlier Run left it behind. */
  private async adoptedTip(record: RunRecord): Promise<string | undefined> {
    const sha = await this.git(
      record.repoPath,
      'rev-parse',
      '--verify',
      '--quiet',
      `refs/heads/${record.branch}`,
    ).catch(() => '');
    return sha || undefined;
  }

  /**
   * For a Run that adopts a branch: the base it is built on, inherited from the Ticket's latest
   * earlier Run on that branch when its own record names none (a Re-run or an answer Run is queued
   * without one), and the tips of base branches the Ticket's Runs started from, newest first. A
   * failed read of the registry inherits nothing; the branch is then replayed whole.
   */
  private async adoptionHistory(
    record: RunRecord,
  ): Promise<{ record: RunRecord; forkCandidates: string[] }> {
    let earlier: RunRecord[] = [];
    try {
      earlier = (await this.registry.list())
        .filter(
          (r) =>
            r.ticketRef === record.ticketRef && r.branch === record.branch && r.id !== record.id,
        )
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    } catch (error) {
      await this.log(
        record,
        `could not read the earlier Runs of ${record.ticketRef}: ${message(error)}`,
      );
    }
    const forkCandidates = [
      ...new Set(
        [record, ...[...earlier].reverse()]
          .map((r) => r.baseSha)
          .filter((sha): sha is string => sha !== undefined),
      ),
    ];
    if (record.baseBranch !== undefined) return { record, forkCandidates };
    const built = earlier.findLast((r) => r.baseBranch !== undefined);
    if (built?.baseBranch === undefined) return { record, forkCandidates };
    await this.log(record, `${record.branch} was built on ${built.baseBranch} by Run ${built.id}`);
    const updated = await this.registry.update(record.id, {
      baseBranch: built.baseBranch,
      ...(built.baseSha === undefined ? {} : { baseSha: built.baseSha }),
    });
    return { record: updated, forkCandidates };
  }

  /**
   * Bring an adopted branch up to date with its base before the agent works on it, so the pull
   * request carries only the Ticket's own commits. Those are the commits after the newest recorded
   * base tip still in the branch's history: commits below it are already on the base, even when it
   * landed as a squash. With no such tip the whole branch is replayed, and git drops what the base
   * already has. A rebase that conflicts is aborted, leaving the branch as it was.
   */
  private async bringUpToDate(
    record: RunRecord,
    cwd: string,
    baseRef: string,
    base: string,
    forkCandidates: readonly string[],
    remote: string,
  ): Promise<
    | { record: RunRecord; lease?: string; conflict?: undefined }
    | { conflict: string; record: RunRecord }
  > {
    const { branch } = record;
    const tipSha = await this.git(cwd, 'rev-parse', baseRef);
    const inHistory = (sha: string): Promise<boolean> =>
      this.exec('git', ['merge-base', '--is-ancestor', sha, 'HEAD'], { cwd }).then(
        () => true,
        () => false,
      );
    if (await inHistory(tipSha)) {
      const updated =
        record.baseSha === tipSha
          ? record
          : await this.registry.update(record.id, { baseSha: tipSha });
      return { record: updated };
    }
    let forkPoint: string | undefined;
    for (const sha of forkCandidates) {
      if (await inHistory(sha)) {
        forkPoint = sha;
        break;
      }
    }
    const pushedSha = await this.exec(
      'git',
      ['ls-remote', '--heads', remote, `refs/heads/${branch}`],
      { cwd },
    ).then(
      (out) => out.stdout.trim().split(/\s/)[0] || undefined,
      async (error) => {
        await this.log(record, `could not list ${branch} on ${remote}: ${message(error)}`);
        return undefined;
      },
    );
    const identity = await this.tipCommitter(cwd);
    await this.log(
      record,
      `bringing ${branch} up to date: rebasing ${forkPoint ? `the commits after ${forkPoint.slice(0, 8)}` : 'it'} onto ${baseRef} (${tipSha.slice(0, 8)})`,
    );
    try {
      await this.exec(
        'git',
        [...identity, 'rebase', ...(forkPoint ? ['--onto', baseRef, forkPoint] : [baseRef])],
        { cwd },
      );
    } catch (error) {
      const conflicted = await this.git(cwd, 'diff', '--name-only', '--diff-filter=U').catch(
        () => '',
      );
      await this.exec('git', ['rebase', '--abort'], { cwd }).catch(async (abortError) => {
        await this.log(record, `could not abort the rebase: ${message(abortError)}`);
      });
      const files = conflicted.split('\n').filter(Boolean);
      return {
        record,
        conflict: `Bringing ${branch} up to date with ${base} (${tipSha.slice(0, 8)}) conflicts${files.length > 0 ? ` in ${files.join(', ')}` : ''}; the rebase was aborted, nothing was published and ${branch} is left as it was for the owner. ${message(error)}`,
      };
    }
    const updated = await this.registry.update(record.id, { baseSha: tipSha });
    return { record: updated, ...(pushedSha === undefined ? {} : { lease: pushedSha }) };
  }

  /** Push the branch and open the PR, or reuse the open one. Returns the PR url. */
  private async publish(
    queued: RunRecord,
    config: RepoConfig,
    ticket: Ticket,
    worktree: string,
    queuedBaseRef: string,
    hooksDir: string,
    summary: string,
    target: PushTarget,
    /** Remote tip of the branch before the Run rebased the branch it adopted. */
    adoptedLease?: string,
  ): Promise<string> {
    const repoArgs = target.repo ? ['--repo', target.repo] : [];
    const settled = await this.settleBase(
      queued,
      config,
      worktree,
      queuedBaseRef,
      hooksDir,
      target,
    );
    const { record, baseRef, base, moved } = settled;
    const lease = settled.lease ?? adoptedLease;
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
      [
        '-c',
        `core.hooksPath=${hooksDir}`,
        'push',
        ...(lease === undefined ? [] : [`--force-with-lease=${record.branch}:${lease}`]),
        '--set-upstream',
        target.remote,
        record.branch,
      ],
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
    if (existing[0]) {
      // Pushing the branch updated it; one whose base landed now targets the repository's base.
      if (moved) {
        await this.exec('gh', ['pr', 'edit', existing[0].url, ...repoArgs, '--base', base], {
          cwd: worktree,
        }).catch(async (error) => {
          await this.log(
            record,
            `could not retarget ${existing[0]?.url} to ${base}: ${message(error)}`,
          );
        });
      }
      return existing[0].url;
    }

    await this.assertBaseOnRemote(record, worktree, target.remote, base);

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
        base,
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

  /**
   * A Restack (Spec 0004): rebase the Run's branch onto the new tip of the branch it is stacked on
   * and push it. No agent, no prompt, no pull request. A rebase that conflicts is aborted, so the
   * branch stays exactly as it was pushed, and the Run fails for the owner to decide.
   */
  private async restack(
    initial: RunRecord,
    config: RepoConfig,
    source: TicketSource,
    fromSha: string,
  ): Promise<RunRecord> {
    let record = initial;
    const base = record.baseBranch;
    if (base === undefined) throw new Error('a Restack needs the branch it is stacked on');
    const { branch } = record;
    const target = await this.resolveRemote(record, config);
    const { remote } = target;
    await this.exec('git', ['fetch', remote, base, branch], { cwd: record.repoPath });
    const baseRef = `${remote}/${base}`;
    const branchRef = `${remote}/${branch}`;
    const tipSha = await this.git(record.repoPath, 'rev-parse', baseRef);
    const pushedSha = await this.git(record.repoPath, 'rev-parse', branchRef);

    const sandcastle = this.deps.sandcastle ?? (await sandcastleAdapter());
    // A branch cleanup deleted locally is recreated from the pushed one, never from the base.
    const worktree = await sandcastle.createWorktree({
      repoPath: record.repoPath,
      branch,
      baseRef: branchRef,
    });
    const cwd = worktree.worktreePath;
    record = await this.registry.update(record.id, { worktreePath: cwd });
    const head = await this.git(cwd, 'rev-parse', 'HEAD');
    if (head !== pushedSha) {
      throw new Error(
        `local ${branch} is at ${head.slice(0, 8)} but ${branchRef} is at ${pushedSha.slice(0, 8)}; not restacked, left for the owner`,
      );
    }
    const { hooksDir } = await installPrePushHook({
      worktreePath: cwd,
      baseBranch: config.baseBranch,
      runBaseBranch: base,
      exec: this.exec,
    });

    // Replay only the branch's own commits when the old tip is known: the base may have been
    // rewritten (a restacked blocker), and its old commits must not come along.
    const ownCommitsFrom = await this.exec(
      'git',
      ['merge-base', '--is-ancestor', fromSha, 'HEAD'],
      {
        cwd,
      },
    ).then(
      () => fromSha,
      () => undefined,
    );
    // Rebased commits keep the committer of the branch tip, not whoever runs the host.
    const identity = await this.tipCommitter(cwd);
    await this.log(record, `rebasing ${branch} onto ${baseRef} (${tipSha.slice(0, 8)})`);
    try {
      await this.exec(
        'git',
        [
          ...identity,
          'rebase',
          ...(ownCommitsFrom ? ['--onto', baseRef, ownCommitsFrom] : [baseRef]),
        ],
        { cwd },
      );
    } catch (error) {
      const conflicted = await this.git(cwd, 'diff', '--name-only', '--diff-filter=U').catch(
        () => '',
      );
      await this.exec('git', ['rebase', '--abort'], { cwd }).catch(async (abortError) => {
        await this.log(record, `could not abort the rebase: ${message(abortError)}`);
      });
      const files = conflicted.split('\n').filter(Boolean);
      const summary = `Rebasing ${branch} onto ${base} (${tipSha.slice(0, 8)}) conflicts${files.length > 0 ? ` in ${files.join(', ')}` : ''}; the rebase was aborted and ${branch} is left as it was pushed for the owner. ${message(error)}`;
      await this.log(record, summary);
      return this.finish(record.id, { status: 'failed', result: { outcome: 'failed', summary } });
    }

    await this.exec(
      'git',
      [
        '-c',
        `core.hooksPath=${hooksDir}`,
        'push',
        `--force-with-lease=${branch}:${pushedSha}`,
        remote,
        branch,
      ],
      { cwd },
    );
    const newHead = await this.git(cwd, 'rev-parse', 'HEAD');
    const prUrl = [...(await this.registry.list())]
      .filter((r) => r.ticketRef === record.ticketRef && r.prUrl)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .at(-1)?.prUrl;
    try {
      await source.setStatus(record.ticketRef, 'in_review');
    } catch (error) {
      await this.log(record, `restacked but the Ticket status was not updated: ${message(error)}`);
    }
    return this.finish(record.id, {
      status: 'done',
      baseSha: tipSha,
      ...(prUrl === undefined ? {} : { prUrl }),
      result: {
        outcome: 'done',
        summary: `Rebased ${branch} onto ${base} at ${tipSha.slice(0, 8)} and pushed it (${newHead.slice(0, 8)}).`,
      },
    });
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

    if (record.trigger.kind === 'restack') {
      return this.restack(record, config, source, record.trigger.fromSha);
    }

    const ticket = await source.get(record.ticketRef);
    const rules = await (this.deps.readRules ?? defaultReadRules)();
    const followUp = await this.followUp(record);

    await refuseEnvCredentials(record.repoPath);
    const flow = await (this.deps.loadFlow ?? loadFlow)(config.flow);

    const target = await this.resolveRemote(record, config);
    // A branch an earlier Run left behind is adopted, and brought up to date before it is worked on.
    const adopted = (await this.adoptedTip(record)) !== undefined;
    let forkCandidates: string[] = [];
    if (adopted) {
      const history = await this.adoptionHistory(record);
      record = history.record;
      forkCandidates = history.forkCandidates;
      const recorded = runBaseBranch(record, config.baseBranch);
      if (recorded !== config.baseBranch) {
        const landed = await this.baseLanded(record, record.repoPath, target, recorded);
        if (landed !== undefined) {
          await this.log(record, `${landed}; building ${record.branch} on ${config.baseBranch}`);
          record = await this.registry.update(record.id, { baseBranch: config.baseBranch });
        }
      }
    }
    let startedOnBase = false;
    const stackedOn = runBaseBranch(record, config.baseBranch);
    if (!adopted && stackedOn !== config.baseBranch) {
      // A blocker that merged first has no branch left to build on; its work is on the base branch.
      if ((await this.baseMissing(record, record.repoPath, target, stackedOn)) === true) {
        const merged = await this.baseMerged(record, record.repoPath, target, stackedOn);
        if (merged === undefined) {
          throw new Error(
            `${stackedOn} is no longer on ${target.remote} and its pull request is not known to have merged, so ${record.branch} has nothing to build on`,
          );
        }
        await this.log(record, `${merged}; building ${record.branch} on ${config.baseBranch}`);
        record = await this.registry.update(record.id, { baseBranch: config.baseBranch });
        startedOnBase = true;
      }
    }
    const baseRef = await this.resolveBaseRef(
      record,
      target.remote,
      runBaseBranch(record, config.baseBranch),
    );
    if (
      !adopted &&
      record.baseBranch !== undefined &&
      (record.baseSha === undefined || startedOnBase)
    ) {
      // The tip the stack starts from: a later Restack compares the blocker's branch with it.
      const baseSha = await this.git(record.repoPath, 'rev-parse', baseRef).catch(() => '');
      if (baseSha) record = await this.registry.update(record.id, { baseSha });
    }
    const sandcastle = this.deps.sandcastle ?? (await sandcastleAdapter());
    const worktree = await sandcastle.createWorktree({
      repoPath: record.repoPath,
      branch: record.branch,
      baseRef,
    });
    let adoptedLease: string | undefined;
    if (adopted) {
      const updated = await this.bringUpToDate(
        record,
        worktree.worktreePath,
        baseRef,
        runBaseBranch(record, config.baseBranch),
        forkCandidates,
        target.remote,
      );
      record = await this.registry.update(updated.record.id, {
        worktreePath: worktree.worktreePath,
      });
      if (updated.conflict !== undefined) {
        await this.log(record, updated.conflict);
        return this.finish(record.id, {
          status: 'failed',
          result: { outcome: 'failed', summary: updated.conflict },
        });
      }
      adoptedLease = updated.lease;
    }
    const { hooksDir } = await installPrePushHook({
      worktreePath: worktree.worktreePath,
      baseBranch: config.baseBranch,
      runBaseBranch: record.baseBranch,
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
    const stack =
      record.baseBranch !== undefined && record.baseBranch !== config.baseBranch
        ? { baseBranch: record.baseBranch, repoBaseBranch: config.baseBranch }
        : undefined;
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
        // A stacked Run's prompt says where it stands, whatever the flow passes.
        buildPrompt: stack
          ? (input) => buildPrompt({ ...input, stack: input.stack ?? stack })
          : buildPrompt,
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
        adoptedLease,
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
