import type { RepoConfig, TicketSourceConfig } from '../contracts/repo-config.ts';
import { ACTIVE_STATUSES, type RunRecord, type RunStatus } from '../contracts/run.ts';
import {
  type Ticket,
  TicketNotFoundError,
  type TicketRef,
  type TicketSource,
  type TicketStatus,
} from '../contracts/ticket.ts';

/**
 * Which Ready Ticket may start (Spec 0004). Every rule lives here, pure: the tick reads the
 * Tickets, the blockers and the Run records, asks for verdicts and only acts on them.
 */

/** What a Ticket must carry for its dependencies to be decided. */
export type DependencyTicket = Pick<Ticket, 'ref' | 'status' | 'blockedBy' | 'relationErrors'>;

/** What reading a blocker that is not itself Ready gave. */
export type BlockerLookup =
  | { kind: 'found'; ticket: DependencyTicket }
  /** The tracker answered that the Ticket does not exist. */
  | { kind: 'missing' }
  /** The read failed: that proves nothing, so the blocker is not known to be done. */
  | { kind: 'unreadable' };

export interface DependencyInput {
  /** The repository's Ready Tickets, in any order. */
  ready: readonly DependencyTicket[];
  /**
   * Blockers read from the tracker, by ref. A blocker that is neither Ready nor in this map was
   * not read and holds like an unreadable one.
   */
  blockers: ReadonlyMap<TicketRef, BlockerLookup>;
  runs: readonly RunRecord[];
  config: Pick<RepoConfig, 'ticketSource' | 'baseBranch'>;
}

/** Why one blocker holds a Ticket. */
export type HoldReason =
  /**
   * `pr` is the latest Run's pull request when it is no longer open: a done Run whose pull request
   * merged or closed is not a branch to build on.
   */
  | { kind: 'not-done'; status: TicketStatus; run?: RunStatus; pr?: 'MERGED' | 'CLOSED' }
  /** The Ticket and this blocker sit in one cycle; `cycle` lists every Ticket in it. */
  | { kind: 'cycle'; cycle: TicketRef[] }
  /** The blocker sits in a cycle, or depends on a Ticket that does. */
  | { kind: 'depends-on-cycle' }
  | { kind: 'other-repository' }
  | { kind: 'missing' }
  | { kind: 'unreadable' }
  /** A relation in the body that is not a Ticket ref; `blocker` is the relation as reported. */
  | { kind: 'malformed' };

export interface Hold {
  /** The blocker's ref, or the relation as reported when it is not a ref. */
  blocker: string;
  reason: HoldReason;
}

export type Verdict =
  /**
   * `stackedOn` names the one blocker whose branch `baseBranch` is; absent, `baseBranch` is the
   * repository's base branch.
   */
  | { kind: 'start'; ref: TicketRef; baseBranch: string; stackedOn?: TicketRef }
  | { kind: 'hold'; ref: TicketRef; holds: Hold[] }
  /** Already has a queued or running Run: never a second one. */
  | { kind: 'active'; ref: TicketRef; run: RunRecord };

/** Whether a repository's ticket source is the one a ref lives in. */
export const ownsRef = (source: TicketSourceConfig, ref: TicketRef): boolean => {
  if (source.kind === 'github') {
    const repo = ref.match(/^github:([\w.-]+\/[\w.-]+)#\d+$/)?.[1];
    return repo !== undefined && repo.toLowerCase() === source.repo.toLowerCase();
  }
  const project = ref.match(/^jira:([A-Z][A-Z0-9]+)-\d+$/)?.[1];
  return project !== undefined && project === source.projectKey;
};

/**
 * Ticket order: Tickets of one project by ascending number (`#2` before `#10`), projects by name.
 * Trackers list Tickets in their own order (GitHub newest first), so it breaks every tie.
 */
export const byTicketOrder = (a: { ref: TicketRef }, b: { ref: TicketRef }): number => {
  const split = (ref: TicketRef): [string, number] => {
    const match = ref.match(/^(.*?)[#-](\d+)$/);
    return match ? [match[1] ?? ref, Number(match[2])] : [ref, 0];
  };
  const [projectA, numberA] = split(a.ref);
  const [projectB, numberB] = split(b.ref);
  if (projectA !== projectB) return projectA < projectB ? -1 : 1;
  return numberA - numberB;
};

const compareRefs = (a: TicketRef, b: TicketRef): number => byTicketOrder({ ref: a }, { ref: b });

const latestRun = (runs: readonly RunRecord[], ref: TicketRef): RunRecord | undefined =>
  runs
    .filter((r) => r.ticketRef === ref)
    .reduce<RunRecord | undefined>((a, r) => (!a || a.createdAt < r.createdAt ? r : a), undefined);

/**
 * Strongly connected components of the not-done Tickets (Tarjan). A component of two or more, or
 * a Ticket blocking itself, is a cycle. Returns each Ticket's component.
 */
const components = (graph: ReadonlyMap<TicketRef, readonly TicketRef[]>) => {
  const index = new Map<TicketRef, number>();
  const low = new Map<TicketRef, number>();
  const stack: TicketRef[] = [];
  const onStack = new Set<TicketRef>();
  const componentOf = new Map<TicketRef, TicketRef[]>();
  let next = 0;
  const visit = (v: TicketRef): void => {
    index.set(v, next);
    low.set(v, next);
    next++;
    stack.push(v);
    onStack.add(v);
    for (const w of graph.get(v) ?? []) {
      if (!graph.has(w)) continue;
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v) as number, low.get(w) as number));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v) as number, index.get(w) as number));
      }
    }
    if (low.get(v) === index.get(v)) {
      const component: TicketRef[] = [];
      let w: TicketRef | undefined;
      do {
        w = stack.pop() as TicketRef;
        onStack.delete(w);
        component.push(w);
      } while (w !== v);
      component.sort(compareRefs);
      for (const member of component) componentOf.set(member, component);
    }
  };
  for (const v of [...graph.keys()].sort(compareRefs)) if (!index.has(v)) visit(v);
  return componentOf;
};

/**
 * One verdict per Ready Ticket. A Ticket starts on the repository's base branch when every
 * blocker is done, and on its blocker's branch when it has exactly one blocker, not done, whose
 * latest Run is done with its pull request open; it is held while any blocker is not done, when it sits in a dependency cycle or
 * depends on a Ticket that does, and when a blocker is in another repository, does not exist,
 * could not be read or is not a Ticket ref. Verdicts come blockers first, ties in Ticket order.
 */
export const resolveDependencies = (input: DependencyInput): Verdict[] => {
  const { config, runs } = input;
  const ready = new Map(input.ready.map((t) => [t.ref, t]));
  const ticketOf = (ref: TicketRef): DependencyTicket | undefined => {
    const readyTicket = ready.get(ref);
    if (readyTicket) return readyTicket;
    const lookup = input.blockers.get(ref);
    return lookup?.kind === 'found' ? lookup.ticket : undefined;
  };
  const inRepo = (ref: TicketRef): boolean => ownsRef(config.ticketSource, ref);

  // The graph of every known Ticket of this repo that is not done: a done Ticket waits on nothing.
  const graph = new Map<TicketRef, TicketRef[]>();
  const known = [
    ...input.ready,
    ...[...input.blockers.values()].flatMap((l) => (l.kind === 'found' ? [l.ticket] : [])),
  ];
  for (const ticket of known) {
    if (ticket.status === 'done' || !inRepo(ticket.ref) || graph.has(ticket.ref)) continue;
    graph.set(ticket.ref, (ticket.blockedBy ?? []).filter(inRepo));
  }
  const componentOf = components(graph);
  const inCycle = (ref: TicketRef): boolean => {
    const component = componentOf.get(ref);
    return component !== undefined && (component.length > 1 || !!graph.get(ref)?.includes(ref));
  };
  /** Sits in a cycle or depends, through not-done Tickets, on one that does. */
  const tainted = new Map<TicketRef, boolean>();
  const reachesCycle = (ref: TicketRef): boolean => {
    const seen = tainted.get(ref);
    if (seen !== undefined) return seen;
    tainted.set(ref, inCycle(ref));
    if (inCycle(ref)) return true;
    const result = (graph.get(ref) ?? []).some((b) => graph.has(b) && reachesCycle(b));
    tainted.set(ref, result);
    return result;
  };

  const holdsOf = (ticket: DependencyTicket): Hold[] => {
    const holds: Hold[] = (ticket.relationErrors ?? []).map((relation) => ({
      blocker: relation,
      reason: { kind: 'malformed' },
    }));
    for (const blocker of ticket.blockedBy ?? []) {
      const hold = (reason: HoldReason): void => {
        holds.push({ blocker, reason });
      };
      if (!inRepo(blocker)) {
        hold({ kind: 'other-repository' });
        continue;
      }
      const component = componentOf.get(ticket.ref);
      if (component && inCycle(ticket.ref) && component.includes(blocker)) {
        hold({ kind: 'cycle', cycle: component });
        continue;
      }
      if (graph.has(blocker) && reachesCycle(blocker)) {
        hold({ kind: 'depends-on-cycle' });
        continue;
      }
      const found = ticketOf(blocker);
      if (found) {
        if (found.status === 'done') continue;
        const run = latestRun(runs, blocker);
        const pr = run?.prState === 'MERGED' || run?.prState === 'CLOSED' ? run.prState : undefined;
        hold({
          kind: 'not-done',
          status: found.status,
          ...(run && { run: run.status }),
          ...(pr && { pr }),
        });
        continue;
      }
      hold({ kind: input.blockers.get(blocker)?.kind === 'missing' ? 'missing' : 'unreadable' });
    }
    return holds;
  };

  const verdictOf = (ticket: DependencyTicket): Verdict => {
    const active = runs.find(
      (r) => r.ticketRef === ticket.ref && ACTIVE_STATUSES.includes(r.status),
    );
    if (active) return { kind: 'active', ref: ticket.ref, run: active };
    const holds = holdsOf(ticket);
    if (holds.length === 0)
      return { kind: 'start', ref: ticket.ref, baseBranch: config.baseBranch };
    const stack = stackBase(ticket, holds);
    return stack
      ? { kind: 'start', ref: ticket.ref, baseBranch: stack.branch, stackedOn: stack.blocker }
      : { kind: 'hold', ref: ticket.ref, holds };
  };

  /**
   * A Ticket with exactly one blocker, held only because that blocker is not done, stacks on the
   * blocker's branch once the blocker's latest Run is done and its pull request still open. Two or
   * more blockers never stack: a branch has one parent.
   */
  const stackBase = (
    ticket: DependencyTicket,
    holds: readonly Hold[],
  ): { blocker: TicketRef; branch: string } | undefined => {
    const [blocker, ...others] = ticket.blockedBy ?? [];
    const [hold, ...otherHolds] = holds;
    if (blocker === undefined || others.length > 0 || !hold || otherHolds.length > 0) return;
    if (hold.blocker !== blocker || hold.reason.kind !== 'not-done') return;
    if (hold.reason.run !== 'done' || hold.reason.pr !== undefined) return;
    const run = latestRun(runs, blocker);
    return run && { blocker, branch: run.branch };
  };

  // Blockers first: Kahn's order over the Ready Tickets, the lowest Ticket first among the free.
  const order: DependencyTicket[] = [];
  const waitingOn = new Map(
    input.ready.map((t) => [
      t.ref,
      new Set((t.blockedBy ?? []).filter((b) => b !== t.ref && ready.has(b))),
    ]),
  );
  const pending = [...ready.values()].sort(byTicketOrder);
  while (pending.length > 0) {
    const i = pending.findIndex((t) => waitingOn.get(t.ref)?.size === 0);
    // A cycle among Ready Tickets frees none of them: take the rest in Ticket order.
    const [ticket] = pending.splice(i === -1 ? 0 : i, 1) as [DependencyTicket];
    order.push(ticket);
    for (const blockers of waitingOn.values()) blockers.delete(ticket.ref);
  }
  return order.map(verdictOf);
};

const STATUS_TEXT: Record<TicketStatus, string> = {
  backlog: 'in the backlog',
  ready: 'ready',
  in_progress: 'in progress',
  in_review: 'in review',
  done: 'done',
};

/** A hold that waiting never clears: a cycle, or a blocker that is not a Ticket of this repo. */
export const ownerMustFix = ({ reason }: Hold): boolean =>
  reason.kind !== 'not-done' && reason.kind !== 'unreadable';

/** One line saying why a blocker holds a Ticket, for logs and `fractory status`. */
export const describeHold = ({ reason }: Hold): string => {
  switch (reason.kind) {
    case 'not-done':
      return `not done: ${STATUS_TEXT[reason.status]}, ${reason.run ? `its latest Run ${reason.run}` : 'no Run yet'}${reason.pr ? `, its pull request ${reason.pr.toLowerCase()}` : ''}`;
    case 'cycle':
      return reason.cycle.length === 1
        ? 'the Ticket blocks itself'
        : `dependency cycle: ${reason.cycle.join(', ')}`;
    case 'depends-on-cycle':
      return 'depends on a dependency cycle';
    case 'other-repository':
      return 'in another repository';
    case 'missing':
      return 'does not exist';
    case 'unreadable':
      return 'could not be read';
    case 'malformed':
      return 'relation could not be read';
  }
};

/** The refs of blockers not Ready that must be read so their state and their own blockers are known. */
export const blockersToRead = (
  tickets: readonly DependencyTicket[],
  config: Pick<RepoConfig, 'ticketSource'>,
  known: ReadonlySet<TicketRef>,
): TicketRef[] => {
  const refs = new Set<TicketRef>();
  for (const t of tickets) {
    if (t.status === 'done') continue;
    for (const b of t.blockedBy ?? []) {
      if (!known.has(b) && ownsRef(config.ticketSource, b)) refs.add(b);
    }
  }
  return [...refs].sort(compareRefs);
};

/** Blockers read per repo per sweep, at most: a runaway graph holds the rest as unreadable. */
const MAX_BLOCKER_READS = 100;

/**
 * Reads the blockers of the Ready Tickets that are not Ready themselves, and theirs in turn while
 * they are not done, so a cycle through Tickets in progress is seen too. Only blockers in this
 * repository are read: one in another repository holds its Ticket without a read. A read that
 * fails other than with `TicketNotFoundError` proves nothing: it is `unreadable` and holds.
 */
export const readBlockers = async (
  ready: readonly DependencyTicket[],
  config: Pick<RepoConfig, 'ticketSource'>,
  source: Pick<TicketSource, 'get'>,
  onUnreadable: (ref: TicketRef, error: unknown) => void = () => {},
): Promise<Map<TicketRef, BlockerLookup>> => {
  const readyRefs = ready.map((t) => t.ref);
  const lookups = new Map<TicketRef, BlockerLookup>();
  let frontier = blockersToRead(ready, config, new Set(readyRefs));
  while (frontier.length > 0 && lookups.size < MAX_BLOCKER_READS) {
    for (const ref of frontier.slice(0, MAX_BLOCKER_READS - lookups.size)) {
      try {
        lookups.set(ref, { kind: 'found', ticket: await source.get(ref) });
      } catch (error) {
        if (error instanceof TicketNotFoundError) {
          lookups.set(ref, { kind: 'missing' });
        } else {
          onUnreadable(ref, error);
          lookups.set(ref, { kind: 'unreadable' });
        }
      }
    }
    const found = [...lookups.values()].flatMap((l) => (l.kind === 'found' ? [l.ticket] : []));
    frontier = blockersToRead(found, config, new Set([...readyRefs, ...lookups.keys()]));
  }
  return lookups;
};
