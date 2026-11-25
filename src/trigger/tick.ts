import { join } from 'node:path';
import type { FactoryConfig } from '../contracts/factory-config.ts';
import { type Mode, type RepoConfig, requiresPrGate } from '../contracts/repo-config.ts';
import type { TicketSourceConfig } from '../contracts/repo-config.ts';
import { AM_COMMENT_PREFIX, type RunRecord, type Trigger, runKey } from '../contracts/run.ts';
import type { TicketSource } from '../contracts/ticket.ts';
import { type Gh, feedbackItems, summarizeChecks } from '../github/gh.ts';
import { consumedCommentIds, pendingComments, readRunComments } from '../registry/comments.ts';
import type { RunRegistry } from '../registry/registry.ts';
import { branchFor, queueRun } from './queue.ts';
import { type Logger, type PidState, acquireLock } from './support.ts';

export interface TickDeps {
  factory: FactoryConfig;
  registry: RunRegistry;
  loadRepoConfig(repoPath: string): Promise<RepoConfig>;
  createTicketSource(config: TicketSourceConfig, mode: Mode): TicketSource;
  gh: Gh;
  launchRun(record: RunRecord, config: RepoConfig): Promise<void>;
  checkPid(pid: number): PidState;
  now(): Date;
  newId(): string;
  log: Logger;
  /** Runs after the tick while the lock is still held (worktree cleanup). */
  afterTick?: () => Promise<void>;
}

export interface TickSummary {
  locked: boolean;
  markedDead: string[];
  queued: string[];
  launched: string[];
  merged: string[];
  ticketsDone: string[];
  errors: number;
}

const byCreatedAt = (a: RunRecord, b: RunRecord): number => a.createdAt.localeCompare(b.createdAt);
/** PR number from the newest Run's `.../pull/<n>` URL; reading it needs no network call. */
const prNumberOf = (runs: RunRecord[]): number | undefined => {
  const url = [...runs]
    .sort(byCreatedAt)
    .reverse()
    .find((r) => r.prUrl)?.prUrl;
  const n = url?.match(/\/pull\/(\d+)/)?.[1];
  return n ? Number(n) : undefined;
};
const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const tick = async (deps: TickDeps): Promise<TickSummary> => {
  const summary: TickSummary = {
    locked: false,
    markedDead: [],
    queued: [],
    launched: [],
    merged: [],
    ticketsDone: [],
    errors: 0,
  };
  const { log, registry, factory } = deps;
  const lock = await acquireLock(join(factory.logDir, 'tick.lock'), deps.now);
  if (!lock) {
    summary.locked = true;
    log.info('tick skipped: another tick holds the lock');
    return summary;
  }

  const fail = (what: string, error: unknown): void => {
    summary.errors++;
    log.error(`${what}: ${message(error)}`);
  };

  const repoConfigs = new Map<string, RepoConfig>();

  /** Follow-up Runs reuse the branch of the Ticket's latest Run so the PR branch is continued. */
  const queueFollowUp = async (
    source: TicketSource,
    latest: RunRecord,
    trigger: Trigger,
  ): Promise<void> => {
    const { record, created } = await queueRun(deps, {
      ticketRef: latest.ticketRef,
      repoPath: latest.repoPath,
      trigger,
      branch: latest.branch,
      mode: latest.mode,
      flow: latest.flow,
    });
    if (!created) return;
    summary.queued.push(record.id);
    log.info(`queued ${trigger.kind} Run ${record.id} for ${latest.ticketRef}`);
    await source
      .setStatus(latest.ticketRef, 'in_progress')
      .catch((e) => fail(`status ${latest.ticketRef}`, e));
  };

  const markDead = async (repoPath: string): Promise<void> => {
    for (const run of await registry.list()) {
      if (run.repoPath !== repoPath || run.status !== 'running' || run.pid === undefined) continue;
      try {
        if (deps.checkPid(run.pid) !== 'dead') continue;
        // Re-read: the Run may have finished between our listing and the pid check.
        const fresh = await registry.get(run.id);
        if (!fresh || fresh.status !== 'running' || fresh.pid !== run.pid) continue;
        const stamp = deps.now().toISOString();
        await registry.update(run.id, {
          status: 'failed',
          finishedAt: stamp,
          result: { outcome: 'failed', summary: 'Host process exited without recording a result.' },
        });
        summary.markedDead.push(run.id);
        log.warn(`Run ${run.id} marked failed: pid ${run.pid} is gone`);
      } catch (error) {
        fail(`dead-run check ${run.id}`, error);
      }
    }
  };

  const handlePrs = async (
    repoPath: string,
    config: RepoConfig,
    source: TicketSource,
    me: string | undefined,
  ): Promise<void> => {
    const runs = (await registry.list()).filter((r) => r.repoPath === repoPath);
    // One PR may be shared by many Runs; the Ticket's latest Run with that PR represents it.
    const latestByPr = new Map<string, RunRecord>();
    for (const run of [...runs].sort(byCreatedAt)) {
      if (run.prUrl) latestByPr.set(run.prUrl, run);
    }
    for (const [prUrl, latest] of latestByPr) {
      // A merged or closed PR cannot change: stop reading it.
      if (latest.prState === 'MERGED' || latest.prState === 'CLOSED') continue;
      try {
        const pr = await deps.gh.viewPr(repoPath, prUrl);
        const recordState = async (): Promise<void> => {
          for (const run of runs) {
            if (run.prUrl === prUrl && run.prState !== pr.state) {
              await registry.update(run.id, { prState: pr.state });
            }
          }
        };
        if (pr.state === 'MERGED') {
          const ticket = await source.get(latest.ticketRef);
          if (ticket.status !== 'done') {
            await source.setStatus(latest.ticketRef, 'done');
            summary.ticketsDone.push(latest.ticketRef);
            log.info(`${latest.ticketRef} done: ${prUrl} merged`);
          }
        }
        // Recorded after the Ticket moved: a failure above leaves the PR unrecorded and retried.
        await recordState();
        if (pr.state !== 'OPEN') continue;

        const ticketRuns = (await registry.list()).filter((r) => r.ticketRef === latest.ticketRef);
        if (ticketRuns.some((r) => r.status === 'queued' || r.status === 'running')) continue;
        const ticketLatest = [...ticketRuns].sort(byCreatedAt).at(-1) ?? latest;

        const checks = summarizeChecks(pr.statusCheckRollup);
        if (checks === 'failing') {
          await queueFollowUp(source, ticketLatest, {
            kind: 'ci-failed',
            prNumber: pr.number,
            headSha: pr.headRefOid,
          });
          continue;
        }

        // Without our own login we cannot tell our comments from a human's: wait, don't guess.
        if (me !== undefined) {
          const known = new Set(ticketRuns.map((r) => r.key));
          const comment = feedbackItems(pr).find(
            (f) =>
              f.author !== me &&
              !known.has(
                runKey(latest.ticketRef, {
                  kind: 'review-comment',
                  prNumber: pr.number,
                  commentId: f.id,
                }),
              ),
          );
          if (comment) {
            await queueFollowUp(source, ticketLatest, {
              kind: 'review-comment',
              prNumber: pr.number,
              commentId: comment.id,
            });
            continue;
          }
        }

        const mayMerge =
          !requiresPrGate(config) &&
          checks === 'passing' &&
          pr.mergeable === 'MERGEABLE' &&
          ticketLatest.status === 'done';
        if (mayMerge) {
          await deps.gh.mergeSquash(repoPath, prUrl);
          summary.merged.push(prUrl);
          log.info(`merged ${prUrl}`);
        }
      } catch (error) {
        fail(`PR ${prUrl}`, error);
      }
    }
  };

  /**
   * Review comments Agent Manager wrote for a Run become one batched `review-comment` Trigger per
   * Ticket. Same rule as PR comments: nothing while a Run on the Ticket is active.
   */
  const handleAmComments = async (repoPath: string, source: TicketSource): Promise<void> => {
    const withComments = (await registry.list())
      .filter((r) => r.repoPath === repoPath)
      .sort(byCreatedAt);
    for (const run of withComments) {
      try {
        let comments: Awaited<ReturnType<typeof readRunComments>>;
        try {
          comments = await readRunComments(factory.registryDir, run.id);
        } catch (error) {
          log.warn(`invalid comments file for Run ${run.id}, skipped: ${message(error)}`);
          continue;
        }
        if (!comments) continue;
        const ticketRuns = (await registry.list()).filter((r) => r.ticketRef === run.ticketRef);
        const pending = pendingComments(comments, consumedCommentIds(ticketRuns));
        const newest = pending.at(-1);
        if (!newest) continue;
        if (ticketRuns.some((r) => r.status === 'queued' || r.status === 'running')) continue;
        const prNumber = prNumberOf(ticketRuns);
        if (prNumber === undefined) {
          log.warn(`comments on Run ${run.id} skipped: ${run.ticketRef} has no PR yet`);
          continue;
        }
        const ticketLatest = [...ticketRuns].sort(byCreatedAt).at(-1) ?? run;
        await queueFollowUp(source, ticketLatest, {
          kind: 'review-comment',
          prNumber,
          commentId: `${AM_COMMENT_PREFIX}${newest.id}`,
        });
      } catch (error) {
        fail(`comments of Run ${run.id}`, error);
      }
    }
  };

  const queueReadyTickets = async (
    repoPath: string,
    config: RepoConfig,
    source: TicketSource,
  ): Promise<void> => {
    const ready = await source.listReady();
    for (const ticket of ready) {
      try {
        const branch = branchFor(ticket.ref, ticket.title, config.mode);
        const { record, created } = await queueRun(deps, {
          ticketRef: ticket.ref,
          repoPath,
          trigger: { kind: 'ticket-ready' },
          branch,
          mode: config.mode,
          flow: config.flow,
        });
        if (!created) continue;
        summary.queued.push(record.id);
        log.info(`queued ticket-ready Run ${record.id} for ${ticket.ref}`);
        await source.setStatus(ticket.ref, 'in_progress');
      } catch (error) {
        fail(`ready ticket ${ticket.ref}`, error);
      }
    }
  };

  const startQueued = async (): Promise<void> => {
    const all = await registry.list();
    let running = all.filter((r) => r.status === 'running').length;
    const queued = all
      .filter((r) => r.status === 'queued' && factory.repos.includes(r.repoPath))
      .sort(byCreatedAt);
    for (const run of queued) {
      if (running >= factory.maxConcurrentRuns) break;
      try {
        let config = repoConfigs.get(run.repoPath);
        if (!config) {
          config = await deps.loadRepoConfig(run.repoPath);
          repoConfigs.set(run.repoPath, config);
        }
        await deps.launchRun(run, config);
        running++;
        summary.launched.push(run.id);
        log.info(`launched Run ${run.id}`);
      } catch (error) {
        fail(`launch ${run.id}`, error);
      }
    }
  };

  try {
    let me: string | undefined;
    try {
      me = await deps.gh.currentUser();
    } catch (error) {
      log.warn(
        `could not read the gh user; review comments are skipped this tick: ${message(error)}`,
      );
    }

    for (const repoPath of factory.repos) {
      try {
        const config = await deps.loadRepoConfig(repoPath);
        repoConfigs.set(repoPath, config);
        const source = deps.createTicketSource(config.ticketSource, config.mode);
        await markDead(repoPath);
        await handlePrs(repoPath, config, source, me);
        await handleAmComments(repoPath, source);
        await queueReadyTickets(repoPath, config, source);
      } catch (error) {
        fail(`repo ${repoPath}`, error);
      }
    }
    await startQueued();
    if (deps.afterTick) {
      try {
        await deps.afterTick();
      } catch (error) {
        fail('cleanup', error);
      }
    }
  } finally {
    await lock.release();
  }
  log.info(
    `tick done: dead=${summary.markedDead.length} queued=${summary.queued.length} launched=${summary.launched.length} merged=${summary.merged.length} errors=${summary.errors}`,
  );
  return summary;
};
