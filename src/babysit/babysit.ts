import type { RunRecord } from '../contracts/run.ts';

/**
 * Babysitting: drive a repository's unfinished Tickets to merged, one at a time.
 *
 * The factory starts Runs but never retries one that failed or stopped for a human, and a Ticket
 * whose Run failed is left out of Ready, so nothing queues it again. Babysitting closes that loop:
 * for each Ticket in turn it queues a Run when there is none, waits for the Run to end, waits for
 * its change to merge, and only then moves to the next Ticket — so a Ticket is never built on a
 * base that is missing the Ticket before it.
 *
 * It reads state from the Run registry only. The tick refreshes a Run's `prState` every few
 * minutes, so no network call is needed here and the whole loop is testable with a fake clock.
 */

export type BabysitOutcome =
  /** Every Ticket reached a merged pull request. */
  | 'merged'
  /** A Run ended `failed` or `needs-human`: the owner decides what happens next. */
  | 'stopped'
  /** The deadline passed while waiting for a Run or a merge. */
  | 'timed-out';

export interface BabysitTicketResult {
  ticketRef: string;
  outcome: BabysitOutcome;
  runId?: string;
  /** The Run's summary or question when it stopped. */
  detail?: string;
}

export interface BabysitSummary {
  outcome: BabysitOutcome;
  tickets: BabysitTicketResult[];
}

export interface BabysitDeps {
  /** Every Run in the registry, re-read on each poll. */
  listRuns: () => Promise<RunRecord[]>;
  /** Queues a manual Run on the Ticket's branch and returns it. */
  queueManualRun: (ticketRef: string) => Promise<RunRecord>;
  /** Resolves after the given delay; injected so tests need no real clock. */
  wait: (ms: number) => Promise<void>;
  now: () => Date;
  /** One line per state change, for the owner watching a terminal. */
  out: (line: string) => void;
  /**
   * Whether the tracker already considers the Ticket finished. Used only when discovering the
   * Tickets to drive: a Ticket closed by hand, or finished by work that landed another way, has a
   * failed Run as its newest and would otherwise be re-queued for nothing. Tickets the caller
   * named explicitly are never filtered. A read that fails proves nothing, so the Ticket stays.
   */
  isTicketFinished?: (ticketRef: string) => Promise<boolean>;
  /**
   * Why the Run's pull request cannot merge, or undefined when nothing blocks it. Conflicts with
   * the base branch are the case that matters: no Trigger starts a Run for them, so the pull
   * request would sit open until the deadline. A read that fails returns undefined, because a
   * failed read of external state proves nothing.
   */
  prBlockedReason?: (run: RunRecord) => Promise<string | undefined>;
}

export interface BabysitInput {
  /** Resolved repository path, as Run records carry it. */
  repoPath: string;
  /** The Tickets to drive, in the order they must be built. Empty means every unfinished Ticket. */
  tickets?: string[];
  pollMs: number;
  /** Deadline for one Ticket: from queueing its Run to its change merging. */
  perTicketMs: number;
  deps: BabysitDeps;
}

const byCreatedAt = (a: RunRecord, b: RunRecord): number => a.createdAt.localeCompare(b.createdAt);

const ACTIVE = new Set(['queued', 'running']);
const STOPPED = new Set(['failed', 'needs-human']);

/** The Ticket's newest Run in this repository, or undefined when it has none. */
export const latestRun = (
  runs: RunRecord[],
  repoPath: string,
  ticketRef: string,
): RunRecord | undefined =>
  runs
    .filter((r) => r.repoPath === repoPath && r.ticketRef === ticketRef)
    .sort(byCreatedAt)
    .at(-1);

/** A Ticket is settled once its newest Run is `done` and that Run's pull request has merged. */
export const isSettled = (run: RunRecord | undefined): boolean =>
  run?.status === 'done' && run.prState === 'MERGED';

/**
 * Tickets this repository has not finished, oldest Run first: the newest Run is active, stopped, or
 * done with a pull request that has not merged. A Ticket whose newest Run is `done` and merged is
 * left out, and so is one with no Run at all — babysitting never starts work the factory has not
 * been asked for.
 */
export const unfinishedTickets = (runs: RunRecord[], repoPath: string): string[] => {
  const latest = new Map<string, RunRecord>();
  for (const run of runs.filter((r) => r.repoPath === repoPath).sort(byCreatedAt)) {
    latest.set(run.ticketRef, run);
  }
  return [...latest.values()]
    .filter((run) => !isSettled(run) && run.prState !== 'CLOSED')
    .sort(byCreatedAt)
    .map((run) => run.ticketRef);
};

const detailOf = (run: RunRecord): string | undefined => {
  const result = run.result;
  if (!result) return undefined;
  const text = result.outcome === 'needs-human' ? result.question : result.summary;
  return text.replace(/\s+/g, ' ').trim() || undefined;
};

const short = (id: string): string => id.slice(0, 8);

/**
 * Drives one Ticket: adopt or queue its Run, wait for the Run to end, then wait for the merge.
 * Returns as soon as the Ticket is settled, a Run stops, or the deadline passes.
 */
const babysitTicket = async (
  input: BabysitInput,
  ticketRef: string,
): Promise<BabysitTicketResult> => {
  const { deps, repoPath, pollMs, perTicketMs } = input;
  const deadline = deps.now().getTime() + perTicketMs;

  let run = latestRun(await deps.listRuns(), repoPath, ticketRef);
  if (isSettled(run)) {
    deps.out(`${ticketRef}: already merged`);
    return { ticketRef, outcome: 'merged', ...(run && { runId: run.id }) };
  }

  if (run && ACTIVE.has(run.status)) {
    deps.out(`${ticketRef}: adopting Run ${short(run.id)} (${run.status})`);
  } else if (!run || STOPPED.has(run.status)) {
    // A Run that stopped is never retried by the factory: ask for a new one on the same branch.
    run = await deps.queueManualRun(ticketRef);
    deps.out(`${ticketRef}: queued Run ${short(run.id)}`);
  } else {
    deps.out(`${ticketRef}: Run ${short(run.id)} is done, waiting for the merge`);
  }

  const runId = run.id;
  while (deps.now().getTime() < deadline) {
    const current = latestRun(await deps.listRuns(), repoPath, ticketRef);
    if (current && current.id !== runId && ACTIVE.has(current.status)) {
      // A follow-up Run (red checks, a review comment) took over: that is the one to wait for.
      deps.out(`${ticketRef}: ${current.trigger.kind} Run ${short(current.id)} took over`);
      return babysitTicket(
        { ...input, perTicketMs: Math.max(0, deadline - deps.now().getTime()) },
        ticketRef,
      );
    }
    if (current && STOPPED.has(current.status)) {
      deps.out(`${ticketRef}: Run ${short(current.id)} ${current.status}`);
      const detail = detailOf(current);
      return {
        ticketRef,
        outcome: 'stopped',
        runId: current.id,
        ...(detail !== undefined && { detail }),
      };
    }
    if (isSettled(current)) {
      deps.out(`${ticketRef}: merged`);
      return { ticketRef, outcome: 'merged', runId: current?.id ?? runId };
    }
    if (current?.status === 'done' && current.prUrl && deps.prBlockedReason) {
      const reason = await deps.prBlockedReason(current).catch(() => undefined);
      if (reason !== undefined) {
        deps.out(`${ticketRef}: ${reason}`);
        return { ticketRef, outcome: 'stopped', runId: current.id, detail: reason };
      }
    }
    await deps.wait(pollMs);
  }
  deps.out(`${ticketRef}: still unfinished at the deadline`);
  return { ticketRef, outcome: 'timed-out', runId };
};

/** The unfinished Tickets of a repository, minus the ones the tracker already calls finished. */
const discover = async (repoPath: string, deps: BabysitDeps): Promise<string[]> => {
  const candidates = unfinishedTickets(await deps.listRuns(), repoPath);
  const { isTicketFinished } = deps;
  if (!isTicketFinished) return candidates;
  const kept: string[] = [];
  for (const ticketRef of candidates) {
    // A failed read proves nothing: keep the Ticket rather than assume it is finished.
    const finished = await isTicketFinished(ticketRef).catch(() => false);
    if (finished) {
      deps.out(`${ticketRef}: skipped, the tracker already calls it finished`);
      continue;
    }
    kept.push(ticketRef);
  }
  return kept;
};

/**
 * Babysits the given Tickets in order, stopping at the first one that needs the owner: the next
 * Ticket would be built on a base without this one's change, which is how a batch of dependent
 * Tickets fails together.
 */
export const babysit = async (input: BabysitInput): Promise<BabysitSummary> => {
  const { deps, repoPath } = input;
  const tickets = input.tickets?.length ? input.tickets : await discover(repoPath, deps);
  if (tickets.length === 0) {
    deps.out('Nothing to babysit: every Ticket with a Run has merged.');
    return { outcome: 'merged', tickets: [] };
  }
  deps.out(`Babysitting ${tickets.length} Ticket(s): ${tickets.join(', ')}`);

  const results: BabysitTicketResult[] = [];
  for (const ticketRef of tickets) {
    const result = await babysitTicket(input, ticketRef);
    results.push(result);
    if (result.outcome !== 'merged') return { outcome: result.outcome, tickets: results };
  }
  deps.out('All Tickets merged.');
  return { outcome: 'merged', tickets: results };
};

export const formatBabysitSummary = (summary: BabysitSummary): string => {
  const lines = summary.tickets.map((t) => {
    const parts = [`${t.ticketRef}: ${t.outcome}`];
    if (t.runId) parts.push(`Run ${short(t.runId)}`);
    if (t.detail) parts.push(t.detail);
    return `  - ${parts.join(' · ')}`;
  });
  const head =
    summary.outcome === 'merged'
      ? `Babysitting finished: ${summary.tickets.length} Ticket(s) merged.`
      : `Babysitting ${summary.outcome === 'stopped' ? 'stopped: a Run needs the owner.' : 'timed out.'}`;
  return [head, ...lines].join('\n');
};
