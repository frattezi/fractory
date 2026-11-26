import { join } from 'node:path';
import type { AutomationRunRecord } from '../contracts/automation.ts';
import type { FactoryConfig } from '../contracts/factory-config.ts';
import { HOST_STATE_VERSION, type HostState } from '../contracts/host-state.ts';
import type { Mode, RepoConfig } from '../contracts/repo-config.ts';
import type { TicketSourceConfig } from '../contracts/repo-config.ts';
import {
  AM_COMMENT_PREFIX,
  type RunRecord,
  type Trigger,
  rerunKey,
  runKey,
} from '../contracts/run.ts';
import type { TicketSource } from '../contracts/ticket.ts';
import { type Gh, feedbackItems, summarizeChecks } from '../github/gh.ts';
import { type HostLoad, checkResources } from '../policy/resources.ts';
import { mayAutoMerge } from '../policy/workflow.ts';
import { AutomationStore } from '../registry/automations.ts';
import { consumedCommentIds, pendingComments, readRunComments } from '../registry/comments.ts';
import { readHostState, writeHostState } from '../registry/host-state.ts';
import type { RunRegistry } from '../registry/registry.ts';
import { listRerunRequests } from '../registry/reruns.ts';
import { pruneAutomationRuns } from './automation-prune.ts';
import { acceptAutomationRequests } from './automations.ts';
import { branchFor, queueRun } from './queue.ts';
import { type Logger, type PidState, acquireLock } from './support.ts';

export interface TickDeps {
  factory: FactoryConfig;
  registry: RunRegistry;
  loadRepoConfig(repoPath: string): Promise<RepoConfig>;
  createTicketSource(config: TicketSourceConfig, mode: Mode): TicketSource;
  gh: Gh;
  launchRun(record: RunRecord, config: RepoConfig): Promise<void>;
  /** Starts a queued Automation Run's host process, recording its pid and `running`. */
  launchAutomationRun(record: AutomationRunRecord): Promise<void>;
  checkPid(pid: number): PidState;
  now(): Date;
  newId(): string;
  log: Logger;
  /** Reads the host before each launch when `factory.resources` is on. */
  hostLoad?: () => Promise<HostLoad>;
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
  /** Why queued Runs were held back this tick by the resource limits. */
  held?: string;
  /** Automation requests read this tick (Spec 0003). */
  automations: {
    queued: string[];
    refused: string[];
    discarded: string[];
    /** Automation Run ids launched this tick. */
    launched: string[];
    /** Automation Run ids marked failed because their host process is gone. */
    markedDead: string[];
    /** Automation Run ids removed, with their logs and outputs, to keep each history's count. */
    pruned: string[];
  };
}

/** Launch priority: what the owner asked for, then follow-ups, then newly Ready Tickets. */
const launchGroup = (run: RunRecord): number => {
  switch (run.trigger.kind) {
    case 'manual':
    case 'answer':
      return 0;
    case 'ci-failed':
    case 'review-comment':
      return 1;
    case 'ticket-ready':
      return 2;
  }
};

type Launchable =
  | { kind: 'run'; run: RunRecord }
  | { kind: 'automation'; run: AutomationRunRecord };

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
    automations: {
      queued: [],
      refused: [],
      discarded: [],
      launched: [],
      markedDead: [],
      pruned: [],
    },
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

  const automationStore = new AutomationStore(factory.automationsDir);

  /** Automation Run records; a failed listing is reported and treated as none this tick. */
  const listAutomationRuns = async (): Promise<AutomationRunRecord[]> => {
    try {
      return await automationStore.listAllRuns();
    } catch (error) {
      fail('Automation Runs', error);
      return [];
    }
  };

  /** Same rule as Runs: only a conclusive `dead` marks an Automation Run failed. */
  const markDeadAutomations = async (): Promise<void> => {
    for (const run of await listAutomationRuns()) {
      if (run.status !== 'running' || run.pid === undefined) continue;
      try {
        if (deps.checkPid(run.pid) !== 'dead') continue;
        // Re-read: the Run may have finished between our listing and the pid check.
        const fresh = await automationStore.getRun(run.automationId, run.id);
        if (!fresh || fresh.status !== 'running' || fresh.pid !== run.pid) continue;
        await automationStore.writeRun({
          ...fresh,
          status: 'failed',
          updatedAt: deps.now().toISOString(),
          result: { outcome: 'failed', summary: 'Host process exited without recording a result.' },
        });
        summary.automations.markedDead.push(run.id);
        log.warn(`Automation Run ${run.id} marked failed: pid ${run.pid} is gone`);
      } catch (error) {
        fail(`dead-run check of Automation Run ${run.id}`, error);
      }
    }
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

        const mayMerge = mayAutoMerge({
          config,
          checks,
          mergeable: pr.mergeable,
          baseBranch: pr.baseRefName,
          latestRunStatus: ticketLatest.status,
        });
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

  /**
   * Re-run requests (`<runId>.rerun.json`, written by Fractory Manager) become a manual Run on the
   * Ticket's branch, keyed `<ticketRef>:rerun:<runId>` so one request yields one Run. The files are
   * never modified or deleted.
   */
  const handleReruns = async (repoPath: string, source: TicketSource): Promise<void> => {
    for (const runId of await listRerunRequests(factory.registryDir)) {
      try {
        const target = await registry.get(runId);
        if (!target || target.repoPath !== repoPath) continue;
        const key = rerunKey(target.ticketRef, runId);
        const all = await registry.list();
        if (all.some((r) => r.key === key)) continue;
        const latest = [...all.filter((r) => r.ticketRef === target.ticketRef)]
          .sort(byCreatedAt)
          .at(-1);
        if (latest?.id !== target.id) {
          log.info(
            `Re-run request for Run ${runId} skipped: it is not the latest Run of its Ticket`,
          );
          continue;
        }
        if (target.status !== 'failed' && target.status !== 'needs-human') {
          log.info(`Re-run request for Run ${runId} skipped: the Run is ${target.status}`);
          continue;
        }
        const { record } = await queueRun(deps, {
          ticketRef: target.ticketRef,
          repoPath,
          trigger: { kind: 'manual' },
          key,
          branch: target.branch,
          mode: target.mode,
          flow: target.flow,
        });
        summary.queued.push(record.id);
        log.info(`queued Re-run ${record.id} of Run ${runId} for ${target.ticketRef}`);
        await source
          .setStatus(target.ticketRef, 'in_progress')
          .catch((e) => fail(`status ${target.ticketRef}`, e));
      } catch (error) {
        fail(`Re-run request ${runId}`, error);
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
        // A Ticket still marked Ready may already have a Run (e.g. `fractory run`): never a second.
        const active = (await registry.list()).find(
          (r) => r.ticketRef === ticket.ref && (r.status === 'queued' || r.status === 'running'),
        );
        if (active) {
          log.info(
            `${ticket.ref} already has ${active.status} Run ${active.id}; not queueing another`,
          );
          await source.setStatus(ticket.ref, 'in_progress');
          continue;
        }
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

  /**
   * Runs and Automation Runs share one launch gate: the Host Limits, the per-tick launch cap and
   * the in-flight limit. Automation Runs go last, behind every Trigger kind, so a chore never
   * delays a Ticket.
   */
  const startQueued = async (): Promise<void> => {
    const all = await registry.list();
    const automationRuns = await listAutomationRuns();
    let running =
      all.filter((r) => r.status === 'running').length +
      automationRuns.filter((r) => r.status === 'running').length;
    const queued: Launchable[] = [
      ...all
        .filter((r) => r.status === 'queued' && factory.repos.includes(r.repoPath))
        .sort((a, b) => launchGroup(a) - launchGroup(b) || byCreatedAt(a, b))
        .map((run) => ({ kind: 'run' as const, run })),
      ...automationRuns
        .filter((r) => r.status === 'queued')
        .sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id))
        .map((run) => ({ kind: 'automation' as const, run })),
    ];
    let launchedCount = 0;
    const limits = factory.resources;
    let readings: HostState['readings'];
    let reason: string | undefined;

    const readHost = async (): Promise<HostLoad> => {
      if (!deps.hostLoad) return {};
      try {
        return await deps.hostLoad();
      } catch (error) {
        // A failed read proves nothing: it never holds the queue.
        log.warn(`could not read the host: ${message(error)}`);
        return {};
      }
    };

    for (const item of queued) {
      if (running >= factory.maxConcurrentRuns) break;
      if (limits) {
        if (launchedCount >= limits.maxLaunchesPerTick) break;
        const load = await readHost();
        readings = {
          ...(load.loadPerCore !== undefined && { loadPerCore: load.loadPerCore }),
          ...(load.hostMemoryFreeGb !== undefined && { hostMemoryFreeGb: load.hostMemoryFreeGb }),
          ...(load.dockerMemoryFreeGb !== undefined && {
            dockerMemoryFreeGb: load.dockerMemoryFreeGb,
          }),
          dockerReachable: load.dockerReachable !== false,
          checkedAt: deps.now().toISOString(),
        };
        const verdict = checkResources(load, limits);
        if (!verdict.ok) {
          reason = verdict.reason;
          summary.held = verdict.reason;
          log.info(`holding ${queued.length - launchedCount} queued Run(s): ${verdict.reason}`);
          break;
        }
      }
      if (item.kind === 'automation') {
        try {
          await deps.launchAutomationRun(item.run);
          running++;
          launchedCount++;
          summary.automations.launched.push(item.run.id);
          log.info(`launched Automation Run ${item.run.id}`);
        } catch (error) {
          fail(`launch of Automation Run ${item.run.id}`, error);
        }
        continue;
      }
      const { run } = item;
      try {
        let config = repoConfigs.get(run.repoPath);
        if (!config) {
          config = await deps.loadRepoConfig(run.repoPath);
          repoConfigs.set(run.repoPath, config);
        }
        await deps.launchRun(run, config);
        running++;
        launchedCount++;
        summary.launched.push(run.id);
        log.info(`launched Run ${run.id}`);
      } catch (error) {
        fail(`launch ${run.id}`, error);
      }
    }
    await recordHostState({
      queued: Math.max(0, queued.length - launchedCount),
      readings,
      reason,
    });
  };

  /** Written every tick, atomically; a write failure never stops the tick. */
  const recordHostState = async (input: {
    queued: number;
    readings: HostState['readings'];
    reason: string | undefined;
  }): Promise<void> => {
    try {
      const stamp = deps.now().toISOString();
      const previous = await readHostState(factory.hostStatePath);
      const held = input.reason !== undefined;
      const heldSince = held ? (previous?.held && previous.heldSince) || stamp : undefined;
      await writeHostState(factory.hostStatePath, {
        version: HOST_STATE_VERSION,
        held,
        ...(input.reason !== undefined && { reason: input.reason }),
        ...(heldSince !== undefined && { heldSince }),
        ...(input.readings && { readings: input.readings }),
        queued: input.queued,
        updatedAt: stamp,
      });
    } catch (error) {
      fail('host state', error);
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
        await handleReruns(repoPath, source);
        await handlePrs(repoPath, config, source, me);
        await handleAmComments(repoPath, source);
        await queueReadyTickets(repoPath, config, source);
      } catch (error) {
        fail(`repo ${repoPath}`, error);
      }
    }
    await markDeadAutomations();
    // After Re-runs, before launches. Automation Runs live apart from the Run registry, so they
    // never set a Ticket status and never reach the pull-request path.
    const { errors, ...automations } = await acceptAutomationRequests(deps);
    summary.errors += errors;
    summary.automations = { ...summary.automations, ...automations };
    await startQueued();
    // Last: Runs that finished since the previous tick, or just now (dead or failed to launch).
    const pruned = await pruneAutomationRuns(deps);
    summary.errors += pruned.errors;
    summary.automations.pruned = pruned.pruned;
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
    `tick done: dead=${summary.markedDead.length} queued=${summary.queued.length} launched=${summary.launched.length} merged=${summary.merged.length} automations=${summary.automations.queued.length} automationsLaunched=${summary.automations.launched.length} automationsPruned=${summary.automations.pruned.length} errors=${summary.errors}`,
  );
  return summary;
};
