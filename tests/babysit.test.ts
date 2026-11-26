import { describe, expect, it } from 'vitest';
import {
  type BabysitDeps,
  babysit,
  formatBabysitSummary,
  unfinishedTickets,
} from '../src/babysit/babysit.ts';
import type { RunRecord } from '../src/contracts/run.ts';
import { makeRun } from './trigger-helpers.ts';

const REPO = '/repo/app';

/**
 * A babysitting harness with no clock and no registry: `states` is the sequence of registry
 * listings the loop sees, one per poll, and `wait` advances a fake clock instead of sleeping.
 */
const harness = (input: {
  states: RunRecord[][];
  queued?: RunRecord;
}): {
  deps: BabysitDeps;
  lines: string[];
  queuedFor: string[];
  polls: () => number;
} => {
  const lines: string[] = [];
  const queuedFor: string[] = [];
  let at = 0;
  let clock = Date.parse('2026-05-31T10:00:00.000Z');
  const deps: BabysitDeps = {
    // One listing per read, so the sequence is exactly what the loop sees, poll by poll.
    listRuns: async () => {
      const state = input.states[Math.min(at, input.states.length - 1)] ?? [];
      at++;
      return state;
    },
    queueManualRun: async (ticketRef) => {
      queuedFor.push(ticketRef);
      return input.queued ?? makeRun({ id: 'queued', ticketRef, status: 'queued' });
    },
    wait: async (ms) => {
      clock += ms;
    },
    now: () => new Date(clock),
    out: (line) => lines.push(line),
  };
  return { deps, lines, queuedFor, polls: () => at };
};

const merged = (over: Partial<RunRecord> = {}): RunRecord =>
  makeRun({
    status: 'done',
    prUrl: 'https://github.com/me/app/pull/1',
    prState: 'MERGED',
    ...over,
  });

describe('unfinishedTickets', () => {
  it('lists Tickets whose newest Run is active, stopped, or done without a merge', () => {
    const runs = [
      merged({ id: 'a', ticketRef: 'github:me/app#1' }),
      makeRun({ id: 'b', ticketRef: 'github:me/app#2', status: 'failed' }),
      makeRun({ id: 'c', ticketRef: 'github:me/app#3', status: 'running' }),
      makeRun({
        id: 'd',
        ticketRef: 'github:me/app#4',
        status: 'done',
        prUrl: 'https://github.com/me/app/pull/4',
        prState: 'OPEN',
      }),
      makeRun({ id: 'e', ticketRef: 'github:me/app#5', status: 'needs-human' }),
    ];
    expect(unfinishedTickets(runs, REPO)).toEqual([
      'github:me/app#2',
      'github:me/app#3',
      'github:me/app#4',
      'github:me/app#5',
    ]);
  });

  it('judges a Ticket by its newest Run only, so an earlier failure is not unfinished work', () => {
    const runs = [
      makeRun({ id: 'old', status: 'failed', createdAt: '2026-05-31T09:00:00.000Z' }),
      merged({ id: 'new', createdAt: '2026-05-31T10:00:00.000Z' }),
    ];
    expect(unfinishedTickets(runs, REPO)).toEqual([]);
  });

  it('ignores other repositories and Tickets whose pull request was closed', () => {
    const runs = [
      makeRun({ id: 'other', ticketRef: 'github:me/other#1', repoPath: '/repo/other' }),
      makeRun({
        id: 'closed',
        ticketRef: 'github:me/app#9',
        status: 'done',
        prUrl: 'https://github.com/me/app/pull/9',
        prState: 'CLOSED',
      }),
    ];
    expect(unfinishedTickets(runs, REPO)).toEqual([]);
  });
});

describe('babysit', () => {
  it('reports nothing to do when every Ticket with a Run has merged', async () => {
    const { deps, lines } = harness({ states: [[merged()]] });
    const summary = await babysit({ repoPath: REPO, pollMs: 1, perTicketMs: 10, deps });
    expect(summary).toEqual({ outcome: 'merged', tickets: [] });
    expect(lines[0]).toMatch(/Nothing to babysit/);
  });

  it('queues a Run for a Ticket whose newest Run failed, then waits for the merge', async () => {
    const failed = makeRun({ id: 'f', status: 'failed' });
    const queued = makeRun({ id: 'q', status: 'queued' });
    const { deps, lines, queuedFor } = harness({
      states: [[failed], [queued], [{ ...queued, status: 'running' }], [merged({ id: 'q' })]],
      queued,
    });
    const summary = await babysit({
      repoPath: REPO,
      tickets: ['github:me/app#1'],
      pollMs: 1,
      perTicketMs: 1_000,
      deps,
    });
    expect(queuedFor).toEqual(['github:me/app#1']);
    expect(summary.outcome).toBe('merged');
    expect(lines).toContain('github:me/app#1: queued Run q');
    expect(lines).toContain('github:me/app#1: merged');
  });

  it('adopts a Run that is already queued instead of starting a second one', async () => {
    const active = makeRun({ id: 'a', status: 'queued' });
    const { deps, lines, queuedFor } = harness({
      states: [[active], [{ ...active, status: 'running' }], [merged({ id: 'a' })]],
    });
    const summary = await babysit({
      repoPath: REPO,
      tickets: ['github:me/app#1'],
      pollMs: 1,
      perTicketMs: 1_000,
      deps,
    });
    expect(queuedFor).toEqual([]);
    expect(summary.outcome).toBe('merged');
    expect(lines).toContain('github:me/app#1: adopting Run a (queued)');
  });

  it('waits for the merge when the Run is already done', async () => {
    const done = makeRun({
      id: 'd',
      status: 'done',
      prUrl: 'https://github.com/me/app/pull/1',
      prState: 'OPEN',
    });
    const { deps, lines, queuedFor } = harness({ states: [[done], [merged({ id: 'd' })]] });
    const summary = await babysit({
      repoPath: REPO,
      tickets: ['github:me/app#1'],
      pollMs: 1,
      perTicketMs: 1_000,
      deps,
    });
    expect(queuedFor).toEqual([]);
    expect(summary.outcome).toBe('merged');
    expect(lines).toContain('github:me/app#1: Run d is done, waiting for the merge');
  });

  it('stops at a Run that needs a human and reports its question', async () => {
    const queued = makeRun({ id: 'q', status: 'queued' });
    const stopped = makeRun({
      id: 'q',
      status: 'needs-human',
      result: { outcome: 'needs-human', reason: 'ambiguous-spec', question: 'Which launcher?' },
    });
    const { deps } = harness({ states: [[queued], [stopped]] });
    const summary = await babysit({
      repoPath: REPO,
      tickets: ['github:me/app#1'],
      pollMs: 1,
      perTicketMs: 1_000,
      deps,
    });
    expect(summary.outcome).toBe('stopped');
    expect(summary.tickets[0]).toMatchObject({
      outcome: 'stopped',
      runId: 'q',
      detail: 'Which launcher?',
    });
    expect(formatBabysitSummary(summary)).toMatch(/needs the owner/);
  });

  it('never builds the next Ticket once one stops, so nothing builds on a stale base', async () => {
    const stopped = makeRun({ id: 's', ticketRef: 'github:me/app#1', status: 'failed' });
    const { deps, queuedFor } = harness({
      states: [[stopped], [{ ...stopped, id: 'q2' }]],
      queued: makeRun({ id: 'q2', ticketRef: 'github:me/app#1', status: 'queued' }),
    });
    const summary = await babysit({
      repoPath: REPO,
      tickets: ['github:me/app#1', 'github:me/app#2'],
      pollMs: 1,
      perTicketMs: 1_000,
      deps,
    });
    expect(summary.outcome).toBe('stopped');
    expect(summary.tickets.map((t) => t.ticketRef)).toEqual(['github:me/app#1']);
    expect(queuedFor).toEqual(['github:me/app#1']);
  });

  it('follows a follow-up Run that takes over the Ticket', async () => {
    const first = makeRun({ id: 'one', status: 'queued' });
    const followUp = makeRun({
      id: 'two',
      status: 'running',
      trigger: { kind: 'ci-failed', prNumber: 1, headSha: 'abc' },
      createdAt: '2026-05-31T11:00:00.000Z',
    });
    const { deps, lines } = harness({
      states: [[first], [first, followUp], [first, merged({ id: 'two' })]],
    });
    const summary = await babysit({
      repoPath: REPO,
      tickets: ['github:me/app#1'],
      pollMs: 1,
      perTicketMs: 1_000,
      deps,
    });
    expect(summary.outcome).toBe('merged');
    expect(lines).toContain('github:me/app#1: ci-failed Run two took over');
  });

  it('times out instead of waiting forever', async () => {
    const queued = makeRun({ id: 'q', status: 'queued' });
    const { deps } = harness({ states: [[queued]] });
    const summary = await babysit({
      repoPath: REPO,
      tickets: ['github:me/app#1'],
      pollMs: 10,
      perTicketMs: 25,
      deps,
    });
    expect(summary).toMatchObject({ outcome: 'timed-out' });
    expect(summary.tickets[0]).toMatchObject({ outcome: 'timed-out', runId: 'q' });
  });

  it('drives several Tickets in the given order, one at a time', async () => {
    const one = merged({ id: 'one', ticketRef: 'github:me/app#1' });
    const twoFailed = makeRun({ id: 'two', ticketRef: 'github:me/app#2', status: 'failed' });
    const twoQueued = makeRun({ id: 'two2', ticketRef: 'github:me/app#2', status: 'queued' });
    const { deps, queuedFor } = harness({
      states: [
        [one, twoFailed],
        [one, twoFailed],
        [one, twoQueued],
        [one, merged({ id: 'two2', ticketRef: 'github:me/app#2' })],
      ],
      queued: twoQueued,
    });
    const summary = await babysit({
      repoPath: REPO,
      tickets: ['github:me/app#1', 'github:me/app#2'],
      pollMs: 1,
      perTicketMs: 1_000,
      deps,
    });
    expect(summary.outcome).toBe('merged');
    expect(summary.tickets.map((t) => t.outcome)).toEqual(['merged', 'merged']);
    expect(queuedFor).toEqual(['github:me/app#2']);
  });
});

describe('babysit discovery', () => {
  it('skips a discovered Ticket the tracker already calls finished', async () => {
    const stale = makeRun({ id: 'x', ticketRef: 'github:me/app#1', status: 'failed' });
    const live = makeRun({ id: 'y', ticketRef: 'github:me/app#2', status: 'failed' });
    const { deps, lines, queuedFor } = harness({
      states: [
        [stale, live],
        [stale, live],
        [stale, live],
        [stale, live],
      ],
      queued: makeRun({ id: 'q', ticketRef: 'github:me/app#2', status: 'needs-human' }),
    });
    const summary = await babysit({
      repoPath: REPO,
      pollMs: 1,
      perTicketMs: 5,
      deps: { ...deps, isTicketFinished: async (ref) => ref === 'github:me/app#1' },
    });
    expect(lines).toContain('github:me/app#1: skipped, the tracker already calls it finished');
    expect(queuedFor).toEqual(['github:me/app#2']);
    expect(summary.tickets.map((t) => t.ticketRef)).toEqual(['github:me/app#2']);
  });

  it('keeps a Ticket whose tracker read fails, because a failed read proves nothing', async () => {
    const live = makeRun({ id: 'y', ticketRef: 'github:me/app#2', status: 'running' });
    const { deps } = harness({ states: [[live]] });
    const summary = await babysit({
      repoPath: REPO,
      pollMs: 1,
      perTicketMs: 1,
      deps: {
        ...deps,
        isTicketFinished: async () => {
          throw new Error('tracker down');
        },
      },
    });
    expect(summary.tickets.map((t) => t.ticketRef)).toEqual(['github:me/app#2']);
  });

  it('never filters Tickets the caller named explicitly', async () => {
    const run = makeRun({ id: 'z', ticketRef: 'github:me/app#1', status: 'running' });
    const { deps, lines } = harness({ states: [[run]] });
    await babysit({
      repoPath: REPO,
      tickets: ['github:me/app#1'],
      pollMs: 1,
      perTicketMs: 1,
      deps: { ...deps, isTicketFinished: async () => true },
    });
    expect(lines.join('\n')).not.toMatch(/skipped/);
  });
});

describe('babysit and a pull request that cannot merge', () => {
  const openPr = (over: Partial<RunRecord> = {}): RunRecord =>
    makeRun({
      id: 'd',
      status: 'done',
      prUrl: 'https://github.com/me/app/pull/1',
      prState: 'OPEN',
      ...over,
    });

  it('stops on a conflicting pull request instead of waiting out the deadline', async () => {
    const { deps, lines } = harness({ states: [[openPr()]] });
    const summary = await babysit({
      repoPath: REPO,
      tickets: ['github:me/app#1'],
      pollMs: 1,
      perTicketMs: 1_000,
      deps: { ...deps, prBlockedReason: async () => 'its pull request conflicts with the base' },
    });
    expect(summary.outcome).toBe('stopped');
    expect(summary.tickets[0]).toMatchObject({
      outcome: 'stopped',
      detail: 'its pull request conflicts with the base',
    });
    expect(lines).toContain('github:me/app#1: its pull request conflicts with the base');
  });

  it('keeps waiting when the pull request read fails, since a failed read proves nothing', async () => {
    const { deps } = harness({ states: [[openPr()], [openPr()], [merged({ id: 'd' })]] });
    const summary = await babysit({
      repoPath: REPO,
      tickets: ['github:me/app#1'],
      pollMs: 1,
      perTicketMs: 1_000,
      deps: {
        ...deps,
        prBlockedReason: async () => {
          throw new Error('gh down');
        },
      },
    });
    expect(summary.outcome).toBe('merged');
  });

  it('never asks about a pull request while the Run is still going', async () => {
    const asked: string[] = [];
    const queued = makeRun({ id: 'q', status: 'queued' });
    const { deps } = harness({ states: [[queued], [queued], [merged({ id: 'q' })]] });
    const summary = await babysit({
      repoPath: REPO,
      tickets: ['github:me/app#1'],
      pollMs: 1,
      perTicketMs: 1_000,
      deps: {
        ...deps,
        prBlockedReason: async (run) => {
          asked.push(run.id);
          return undefined;
        },
      },
    });
    expect(summary.outcome).toBe('merged');
    expect(asked).toEqual([]);
  });
});
