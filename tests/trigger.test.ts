import { mkdir, readFile, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseRelations } from '../src/adapters/relations.ts';
import { ResourceLimitsSchema } from '../src/contracts/factory-config.ts';
import type { RepoConfig } from '../src/contracts/repo-config.ts';
import { type Trigger, answerRequestPath, rerunRequestPath, runKey } from '../src/contracts/run.ts';
import type { Ticket } from '../src/contracts/ticket.ts';
import type { HostLoad } from '../src/policy/resources.ts';
import { branchFor, byTicketOrder } from '../src/trigger/queue.ts';
import { acquireLock } from '../src/trigger/support.ts';
import { tick } from '../src/trigger/tick.ts';
import {
  FakeSource,
  PR_URL,
  makeHarness,
  makePr,
  makeRun,
  makeTicket,
  personalRepo,
  workRepo,
  writeJson,
} from './trigger-helpers.ts';

describe('ticket-ready Trigger', () => {
  it('queues a Run, moves the Ticket to in_progress and launches it', async () => {
    const h = await makeHarness();
    h.source.tickets.set('github:me/app#1', makeTicket(1));
    const summary = await tick(h.deps);

    const runs = await h.registry.list();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      ticketRef: 'github:me/app#1',
      trigger: { kind: 'ticket-ready' },
      branch: 'fractory/1-add-thing-1',
      status: 'running',
      mode: 'personal',
      flow: 'build',
    });
    expect(h.source.statusCalls).toEqual([['github:me/app#1', 'in_progress']]);
    expect(summary.launched).toHaveLength(1);
  });

  it('is idempotent: two ticks never create a duplicate Run, even if the tracker still says ready', async () => {
    const h = await makeHarness();
    h.source.stickyReady = true;
    h.source.tickets.set('github:me/app#1', makeTicket(1));
    await tick(h.deps);
    await tick(h.deps);
    expect(await h.registry.list()).toHaveLength(1);
    expect(h.launched).toHaveLength(1);
  });

  it('never queues a ticket-ready Run next to a queued manual Run of the same Ticket', async () => {
    const h = await makeHarness({ maxConcurrentRuns: 0 });
    h.source.tickets.set('github:me/app#1', makeTicket(1));
    await h.registry.write(
      makeRun({ id: 'manual', status: 'queued', trigger: { kind: 'manual' } }),
    );
    await tick(h.deps);
    const runs = await h.registry.list();
    expect(runs.map((r) => r.id)).toEqual(['manual']);
    expect(h.source.statusCalls).toEqual([['github:me/app#1', 'in_progress']]);
  });

  it('uses a feat/ branch in Work Mode and never a fractory-prefixed one', async () => {
    const h = await makeHarness({ config: workRepo });
    h.source.tickets.set('github:me/app#2', makeTicket(2, 'ready', 'Fix login'));
    await tick(h.deps);
    expect((await h.registry.list())[0]?.branch).toBe('feat/2-fix-login');
  });

  it('queues Ready Tickets in Ticket order, whatever order the source lists them in', async () => {
    const h = await makeHarness({ maxConcurrentRuns: 0 });
    // Like the GitHub source: newest first.
    for (const n of [10, 9, 3, 2, 1]) h.source.tickets.set(`github:me/app#${n}`, makeTicket(n));
    await tick(h.deps);
    const runs = (await h.registry.list()).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    expect(runs.map((r) => r.ticketRef)).toEqual([
      'github:me/app#1',
      'github:me/app#2',
      'github:me/app#3',
      'github:me/app#9',
      'github:me/app#10',
    ]);
    expect(h.source.statusCalls.map(([ref]) => ref)).toEqual(runs.map((r) => r.ticketRef));
  });

  it('orders Jira and GitHub refs by number, not as text', () => {
    const refs = ['jira:ABC-10', 'jira:ABC-9', 'jira:ABC-100', 'jira:AB-2'] as const;
    const sorted = refs.map((ref) => ({ ref })).sort(byTicketOrder);
    expect(sorted.map((t) => t.ref)).toEqual([
      'jira:AB-2',
      'jira:ABC-9',
      'jira:ABC-10',
      'jira:ABC-100',
    ]);
    const gh = ['github:me/my-app#12', 'github:me/my-app#3'].map((ref) => ({ ref }));
    expect(gh.sort(byTicketOrder).map((t) => t.ref)).toEqual([
      'github:me/my-app#3',
      'github:me/my-app#12',
    ]);
  });

  it('drops a title that would trip the Work Mode outbound policy', () => {
    expect(branchFor('github:me/app#3', 'Ask Claude to fix it', 'work')).toBe('feat/3');
    expect(branchFor('jira:ABC-12', 'Add login', 'work')).toBe('feat/abc-12-add-login');
  });
});

describe('blockers hold a Ready Ticket', () => {
  const blocked = (n: number, ...blockers: string[]) => {
    const base = makeTicket(n);
    const body = `What to build\n\n${blockers.map((b) => `Blocked by ${b}`).join('\n')}`;
    // The adapters parse the Relations a body declares; the fake source stands in for them.
    const { errors, ...relations } = parseRelations(body, base.ref);
    return { ...base, body, ...relations, relationErrors: errors };
  };
  const readHost = async (path: string) => JSON.parse(await readFile(path, 'utf8'));
  const heldRefs = (summary: { heldTickets: { ticketRef: string }[] }) =>
    summary.heldTickets.map((t) => t.ticketRef);

  it('starts a Ticket that records no blocker as before', async () => {
    const h = await makeHarness();
    h.source.tickets.set('github:me/app#1', makeTicket(1));
    const summary = await tick(h.deps);
    expect(summary.launched).toHaveLength(1);
    expect(summary.heldTickets).toEqual([]);
    expect((await readHost(h.factory.hostStatePath)).heldTickets).toBeUndefined();
  });

  it('holds a Ticket while a blocker is not done: no Run, still Ready, nothing written', async () => {
    const h = await makeHarness();
    h.source.tickets.set('github:me/app#4', makeTicket(4, 'in_progress'));
    h.source.tickets.set('github:me/app#5', blocked(5, '#4'));
    const summary = await tick(h.deps);

    expect(await h.registry.list()).toEqual([]);
    expect(h.source.statusCalls).toEqual([]);
    expect(h.source.comments).toEqual([]);
    expect(h.source.tickets.get('github:me/app#5')?.status).toBe('ready');
    expect(summary.heldTickets).toEqual([
      {
        repoPath: '/repo/app',
        ticketRef: 'github:me/app#5',
        blockers: ['github:me/app#4'],
        holds: [{ blocker: 'github:me/app#4', reason: 'not done: in progress, no Run yet' }],
      },
    ]);
    expect(h.log.lines).toContain(
      'INFO holding github:me/app#5: waiting on github:me/app#4 (not done: in progress, no Run yet)',
    );
    expect((await readHost(h.factory.hostStatePath)).heldTickets).toEqual(summary.heldTickets);
  });

  it('names the state of the blocker Run it waits on', async () => {
    const h = await makeHarness();
    await h.registry.write(
      makeRun({ id: 'r4', ticketRef: 'github:me/app#4', status: 'needs-human' }),
    );
    h.source.tickets.set('github:me/app#4', makeTicket(4, 'in_progress'));
    h.source.tickets.set('github:me/app#5', blocked(5, '#4'));
    const summary = await tick(h.deps);
    expect(summary.heldTickets[0]?.holds).toEqual([
      { blocker: 'github:me/app#4', reason: 'not done: in progress, its latest Run needs-human' },
    ]);
  });

  it('holds while any blocker is not done and starts on the next tick once all are', async () => {
    const h = await makeHarness();
    h.source.tickets.set('github:me/app#3', makeTicket(3, 'done'));
    h.source.tickets.set('github:me/app#4', makeTicket(4, 'in_review'));
    h.source.tickets.set('github:me/app#5', blocked(5, '#3', '#4'));
    const first = await tick(h.deps);
    expect(first.heldTickets[0]?.blockers).toEqual(['github:me/app#4']);
    expect(h.launched).toEqual([]);

    h.source.tickets.set('github:me/app#4', makeTicket(4, 'done'));
    const second = await tick(h.deps);
    expect(second.heldTickets).toEqual([]);
    expect(second.launched).toHaveLength(1);
    expect((await h.registry.list())[0]?.ticketRef).toBe('github:me/app#5');
    expect(h.source.statusCalls).toEqual([['github:me/app#5', 'in_progress']]);
  });

  it('works a chain created Ready together one at a time, in order', async () => {
    const h = await makeHarness();
    // GitHub lists newest first: the chain arrives backwards.
    for (const n of [4, 3, 2]) h.source.tickets.set(`github:me/app#${n}`, blocked(n, `#${n - 1}`));
    h.source.tickets.set('github:me/app#1', makeTicket(1));

    const started: string[] = [];
    for (let step = 1; step <= 4; step++) {
      const summary = await tick(h.deps);
      expect(summary.queued).toHaveLength(1);
      const run = (await h.registry.list()).find((r) => r.id === summary.queued[0]);
      started.push(run?.ticketRef ?? '');
      expect(heldRefs(summary)).toEqual(
        [2, 3, 4].filter((n) => n > step).map((n) => `github:me/app#${n}`),
      );
      // Nothing else starts while the current Ticket is not done.
      const idle = await tick(h.deps);
      expect(idle.queued).toEqual([]);
      // The Run finishes and its pull request merges: the Ticket is done.
      if (run) await h.registry.update(run.id, { status: 'done' });
      const ref = `github:me/app#${step}`;
      h.source.tickets.set(ref, { ...(h.source.tickets.get(ref) as Ticket), status: 'done' });
    }
    expect(started).toEqual([1, 2, 3, 4].map((n) => `github:me/app#${n}`));
  });

  /** The Runs as `<ticket number> on <base branch or the repository's>`, oldest first. */
  const queuedOn = async (h: Awaited<ReturnType<typeof makeHarness>>) =>
    (await h.registry.list())
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((r) => `${r.ticketRef.replace('github:me/app', '')} on ${r.baseBranch ?? 'base'}`);

  it("stacks a Ticket with one blocker on that blocker's branch once its latest Run is done", async () => {
    const h = await makeHarness();
    await h.registry.write(
      makeRun({ id: 'r4', ticketRef: 'github:me/app#4', branch: 'fractory/4-add-thing-4' }),
    );
    h.source.tickets.set('github:me/app#4', makeTicket(4, 'in_review'));
    h.source.tickets.set('github:me/app#5', blocked(5, '#4'));
    const summary = await tick(h.deps);

    expect(summary.heldTickets).toEqual([]);
    expect(summary.launched).toHaveLength(1);
    const run = (await h.registry.list()).find((r) => r.ticketRef === 'github:me/app#5');
    expect(run).toMatchObject({
      branch: 'fractory/5-add-thing-5',
      baseBranch: 'fractory/4-add-thing-4',
      trigger: { kind: 'ticket-ready' },
    });
    expect(h.source.statusCalls).toEqual([['github:me/app#5', 'in_progress']]);
    expect(h.log.lines).toContain(
      `INFO queued ticket-ready Run ${run?.id} for github:me/app#5 on fractory/4-add-thing-4, the branch of github:me/app#4`,
    );
  });

  for (const status of ['queued', 'running', 'failed', 'needs-human'] as const) {
    it(`holds a Ticket whose one blocker's latest Run is ${status}`, async () => {
      const h = await makeHarness();
      await h.registry.write(
        makeRun({
          id: 'r4-done',
          ticketRef: 'github:me/app#4',
          createdAt: '2026-05-30T10:00:00.000Z',
        }),
      );
      await h.registry.write(
        makeRun({
          id: 'r4-latest',
          ticketRef: 'github:me/app#4',
          trigger: { kind: 'ci-failed', prNumber: 7, headSha: 'sha1' },
          status,
          ...(status === 'running' && { pid: 4999 }),
        }),
      );
      h.source.tickets.set('github:me/app#4', makeTicket(4, 'in_progress'));
      h.source.tickets.set('github:me/app#5', blocked(5, '#4'));
      const summary = await tick(h.deps);

      expect((await h.registry.list()).filter((r) => r.ticketRef === 'github:me/app#5')).toEqual(
        [],
      );
      expect(summary.heldTickets[0]?.holds).toEqual([
        { blocker: 'github:me/app#4', reason: `not done: in progress, its latest Run ${status}` },
      ]);
      expect(h.source.statusCalls).not.toContainEqual(['github:me/app#5', 'in_progress']);
    });
  }

  it('never stacks a Ticket with two blockers: it starts on the base branch once both are done', async () => {
    const h = await makeHarness();
    await h.registry.write(
      makeRun({ id: 'r3', ticketRef: 'github:me/app#3', branch: 'fractory/3-add-thing-3' }),
    );
    await h.registry.write(
      makeRun({ id: 'r4', ticketRef: 'github:me/app#4', branch: 'fractory/4-add-thing-4' }),
    );
    h.source.tickets.set('github:me/app#3', makeTicket(3, 'in_review'));
    h.source.tickets.set('github:me/app#4', makeTicket(4, 'in_review'));
    h.source.tickets.set('github:me/app#5', blocked(5, '#3', '#4'));
    const first = await tick(h.deps);
    expect(first.heldTickets[0]?.blockers).toEqual(['github:me/app#3', 'github:me/app#4']);
    expect(first.queued).toEqual([]);

    h.source.tickets.set('github:me/app#3', makeTicket(3, 'done'));
    const second = await tick(h.deps);
    expect(second.heldTickets[0]?.blockers).toEqual(['github:me/app#4']);
    expect(second.queued).toEqual([]);

    h.source.tickets.set('github:me/app#4', makeTicket(4, 'done'));
    const third = await tick(h.deps);
    expect(third.queued).toHaveLength(1);
    const run = (await h.registry.list()).find((r) => r.ticketRef === 'github:me/app#5');
    expect(run?.baseBranch).toBeUndefined();
  });

  it('stacks a chain created Ready together: each Run overlaps the last, built on its branch', async () => {
    const h = await makeHarness();
    // GitHub lists newest first: the chain arrives backwards.
    for (const n of [4, 3, 2]) h.source.tickets.set(`github:me/app#${n}`, blocked(n, `#${n - 1}`));
    h.source.tickets.set('github:me/app#1', makeTicket(1));

    for (let step = 1; step <= 4; step++) {
      const summary = await tick(h.deps);
      expect(summary.queued).toHaveLength(1);
      expect(heldRefs(summary)).toEqual(
        [2, 3, 4].filter((n) => n > step).map((n) => `github:me/app#${n}`),
      );
      // Nothing is built on a Run that is still running.
      const idle = await tick(h.deps);
      expect(idle.queued).toEqual([]);
      // The Run finishes and opens its pull request; its Ticket is in review, never done.
      await h.registry.update(summary.queued[0] as string, { status: 'done' });
    }

    const runs = (await h.registry.list()).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    expect(await queuedOn(h)).toEqual([
      '#1 on base',
      '#2 on fractory/1-add-thing-1',
      '#3 on fractory/2-add-thing-2',
      '#4 on fractory/3-add-thing-3',
    ]);
    expect(runs.map((r) => r.branch)).toEqual(
      [1, 2, 3, 4].map((n) => `fractory/${n}-add-thing-${n}`),
    );
    for (const n of [1, 2, 3]) {
      expect(h.source.tickets.get(`github:me/app#${n}`)?.status).not.toBe('done');
    }
  });

  it('queues unblocked Tickets blockers first, whatever order the tracker lists them in', async () => {
    const h = await makeHarness({ maxConcurrentRuns: 5 });
    h.source.tickets.set('github:me/app#9', makeTicket(9));
    h.source.tickets.set('github:me/app#2', blocked(2, '#1'));
    h.source.tickets.set('github:me/app#1', makeTicket(1, 'done'));
    h.source.tickets.set('github:me/app#3', makeTicket(3));
    const summary = await tick(h.deps);
    const refs = (await h.registry.list())
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((r) => r.ticketRef);
    expect(refs).toEqual(['github:me/app#2', 'github:me/app#3', 'github:me/app#9']);
    expect(summary.heldTickets).toEqual([]);
  });

  it('holds every Ticket in a cycle and those depending on it, queues nothing, reports it', async () => {
    const h = await makeHarness();
    h.source.tickets.set('github:me/app#4', blocked(4, '#5'));
    h.source.tickets.set('github:me/app#5', blocked(5, '#4'));
    h.source.tickets.set('github:me/app#6', blocked(6, '#5'));
    h.source.tickets.set('github:me/app#7', blocked(7, '#7'));
    const summary = await tick(h.deps);

    expect(await h.registry.list()).toEqual([]);
    expect(h.source.statusCalls).toEqual([]);
    expect(summary.heldTickets.map(({ ticketRef, holds }) => [ticketRef, holds])).toEqual([
      ['github:me/app#7', [{ blocker: 'github:me/app#7', reason: 'the Ticket blocks itself' }]],
      [
        'github:me/app#4',
        [
          {
            blocker: 'github:me/app#5',
            reason: 'dependency cycle: github:me/app#4, github:me/app#5',
          },
        ],
      ],
      [
        'github:me/app#5',
        [
          {
            blocker: 'github:me/app#4',
            reason: 'dependency cycle: github:me/app#4, github:me/app#5',
          },
        ],
      ],
      [
        'github:me/app#6',
        [{ blocker: 'github:me/app#5', reason: 'depends on a dependency cycle' }],
      ],
    ]);
    expect(h.log.lines).toContain(
      'WARN holding github:me/app#6: waiting on github:me/app#5 (depends on a dependency cycle)',
    );
  });

  it('sees a cycle through a blocker that is no longer Ready', async () => {
    const h = await makeHarness();
    h.source.tickets.set('github:me/app#4', { ...blocked(4, '#3'), status: 'in_progress' });
    h.source.tickets.set('github:me/app#3', { ...blocked(3, '#4'), status: 'backlog' });
    h.source.tickets.set('github:me/app#5', blocked(5, '#4'));
    const summary = await tick(h.deps);
    expect(summary.heldTickets[0]?.holds).toEqual([
      { blocker: 'github:me/app#4', reason: 'depends on a dependency cycle' },
    ]);
  });

  it('takes no launch slot: the next candidate starts under the cap', async () => {
    const h = await makeHarness({ maxConcurrentRuns: 1 });
    h.source.tickets.set('github:me/app#4', makeTicket(4, 'backlog'));
    h.source.tickets.set('github:me/app#5', blocked(5, '#4'));
    h.source.tickets.set('github:me/app#6', makeTicket(6));
    const summary = await tick(h.deps);
    expect(heldRefs(summary)).toEqual(['github:me/app#5']);
    expect((await h.registry.list()).map((r) => r.ticketRef)).toEqual(['github:me/app#6']);
    expect(h.launched).toHaveLength(1);
  });

  it('holds on a blocker in another repository without reading it, even a configured one', async () => {
    const h = await makeHarness({ repos: ['/repo/app', '/repo/lib'] });
    const lib: RepoConfig = { ...personalRepo, ticketSource: { kind: 'github', repo: 'me/lib' } };
    h.configs.set('/repo/lib', lib);
    const libSource = new FakeSource([{ ...makeTicket(9, 'done'), ref: 'github:me/lib#9' }]);
    h.deps.createTicketSource = (config) =>
      config.kind === 'github' && config.repo === 'me/lib' ? libSource : h.source;
    h.source.tickets.set('github:me/app#5', blocked(5, 'me/lib#9', 'XYZ-3'));
    h.source.tickets.set('github:me/app#6', makeTicket(6));
    const summary = await tick(h.deps);
    expect(summary.errors).toBe(0);
    expect(summary.heldTickets[0]?.holds).toEqual([
      { blocker: 'github:me/lib#9', reason: 'in another repository' },
      { blocker: 'jira:XYZ-3', reason: 'in another repository' },
    ]);
    expect([...h.source.gets, ...libSource.gets]).toEqual([]);
    expect(h.log.lines).toContain(
      'WARN holding github:me/app#5: waiting on github:me/lib#9 (in another repository), jira:XYZ-3 (in another repository)',
    );
    expect((await h.registry.list()).map((r) => r.ticketRef)).toEqual(['github:me/app#6']);
  });

  it('holds on a blocker that does not exist and reports it', async () => {
    const h = await makeHarness();
    h.source.missing.add('github:me/app#40');
    h.source.tickets.set('github:me/app#5', blocked(5, '#40'));
    const summary = await tick(h.deps);
    expect(summary.heldTickets[0]?.holds).toEqual([
      { blocker: 'github:me/app#40', reason: 'does not exist' },
    ]);
    expect(h.log.lines).toContain(
      'WARN holding github:me/app#5: waiting on github:me/app#40 (does not exist)',
    );
    expect(h.launched).toEqual([]);
  });

  it('holds when a blocker cannot be read: a failed read proves nothing', async () => {
    const h = await makeHarness();
    h.source.tickets.set('github:me/app#5', blocked(5, '#4'));
    const summary = await tick(h.deps);
    expect(summary.heldTickets[0]?.holds).toEqual([
      { blocker: 'github:me/app#4', reason: 'could not be read' },
    ]);
    expect(
      h.log.lines.some((l) => l.startsWith('WARN could not read blocker github:me/app#4')),
    ).toBe(true);
    expect(h.launched).toEqual([]);
  });

  it('reads a blocker shared by many Tickets once', async () => {
    const h = await makeHarness();
    h.source.tickets.set('github:me/app#4', makeTicket(4, 'in_progress'));
    h.source.tickets.set('github:me/app#5', blocked(5, '#4'));
    h.source.tickets.set('github:me/app#6', blocked(6, '#4'));
    await tick(h.deps);
    expect(h.source.gets.filter((r) => r === 'github:me/app#4')).toHaveLength(1);
  });
});

describe('concurrency cap', () => {
  it('starts only into free slots, oldest first, and never exceeds the cap across ticks', async () => {
    const h = await makeHarness({ maxConcurrentRuns: 2 });
    for (let n = 1; n <= 4; n++) h.source.tickets.set(`github:me/app#${n}`, makeTicket(n));
    await tick(h.deps);
    expect(h.launched).toEqual(['run-1', 'run-2']);

    await tick(h.deps);
    expect(h.launched).toHaveLength(2);
    expect((await h.registry.list()).filter((r) => r.status === 'queued')).toHaveLength(2);

    await h.registry.update('run-1', { status: 'done' });
    await tick(h.deps);
    expect(h.launched).toEqual(['run-1', 'run-2', 'run-3']);
  });
});

describe('resource limits', () => {
  const limits = ResourceLimitsSchema.parse({});
  const roomy: HostLoad = {
    loadPerCore: 0.2,
    hostMemoryFreeGb: 8,
    dockerMemoryFreeGb: 4,
    dockerReachable: true,
  };
  const withLimits = async (load: () => Promise<HostLoad> | HostLoad = () => roomy) => {
    const h = await makeHarness();
    h.deps.factory.resources = limits;
    h.deps.hostLoad = async () => load();
    return h;
  };
  const addTickets = (h: Awaited<ReturnType<typeof makeHarness>>, count: number) => {
    for (let n = 1; n <= count; n++) h.source.tickets.set(`github:me/app#${n}`, makeTicket(n));
  };

  it('starts one Run per tick while the host has room', async () => {
    const h = await withLimits();
    addTickets(h, 3);
    await tick(h.deps);
    expect(h.launched).toEqual(['run-1']);
    await tick(h.deps);
    expect(h.launched).toEqual(['run-1', 'run-2']);
  });

  it.each([
    ['CPU load', { loadPerCore: 0.92 }, 'CPU load 0.92 per core > 0.75'],
    ['host memory', { hostMemoryFreeGb: 1.5 }, 'host memory 1.5 GB free < 2 GB'],
    ['Docker memory', { dockerMemoryFreeGb: 0.8 }, 'Docker memory 0.8 GB free < 1 GB'],
    ['Docker reachability', { dockerReachable: false }, 'Docker is not reachable'],
  ])('holds the queue on %s and releases it when the host recovers', async (_n, over, reason) => {
    let load: HostLoad = { ...roomy, ...over };
    const h = await withLimits(() => load);
    addTickets(h, 1);
    const summary = await tick(h.deps);
    expect(h.launched).toEqual([]);
    expect(summary.held).toBe(reason);
    expect((await h.registry.list())[0]?.status).toBe('queued');

    load = roomy;
    expect((await tick(h.deps)).held).toBeUndefined();
    expect(h.launched).toEqual(['run-1']);
  });

  it('never holds for a reading that could not be taken', async () => {
    const unread = await withLimits(() => ({}));
    addTickets(unread, 1);
    await tick(unread.deps);
    expect(unread.launched).toEqual(['run-1']);

    const failing = await withLimits(() => {
      throw new Error('boom');
    });
    addTickets(failing, 1);
    await tick(failing.deps);
    expect(failing.launched).toEqual(['run-1']);
  });

  it('never reads the host when resources are off, or when nothing is queued', async () => {
    const off = await makeHarness();
    off.deps.hostLoad = async () => {
      throw new Error('must not be read');
    };
    addTickets(off, 2);
    await tick(off.deps);
    expect(off.launched).toEqual(['run-1', 'run-2']);

    let reads = 0;
    const idle = await withLimits(() => {
      reads++;
      return roomy;
    });
    await tick(idle.deps);
    expect(reads).toBe(0);
  });

  it('honours maxLaunchesPerTick above one', async () => {
    const h = await withLimits();
    h.deps.factory.resources = { ...limits, maxLaunchesPerTick: 2 };
    addTickets(h, 3);
    await tick(h.deps);
    expect(h.launched).toEqual(['run-1', 'run-2']);
  });

  it('launches manual Runs, then follow-ups, then new Tickets, oldest first', async () => {
    const h = await withLimits();
    h.deps.factory.resources = { ...limits, maxLaunchesPerTick: 10 };
    const queued = (id: string, n: number, trigger: Trigger, createdAt: string) =>
      h.registry.write(
        makeRun({
          id,
          ticketRef: `github:me/app#${n}`,
          trigger,
          key: `k-${id}`,
          status: 'queued',
          createdAt,
          updatedAt: createdAt,
        }),
      );
    await queued('ready-old', 1, { kind: 'ticket-ready' }, '2026-05-31T01:00:00.000Z');
    await queued(
      'comment',
      2,
      { kind: 'review-comment', prNumber: 7, commentId: 'c' },
      '2026-05-31T03:00:00.000Z',
    );
    await queued('manual-new', 3, { kind: 'manual' }, '2026-05-31T05:00:00.000Z');
    await queued(
      'ci',
      4,
      { kind: 'ci-failed', prNumber: 7, headSha: 's' },
      '2026-05-31T02:00:00.000Z',
    );
    await queued('manual-old', 5, { kind: 'manual' }, '2026-05-31T04:00:00.000Z');
    await queued('ready-new', 6, { kind: 'ticket-ready' }, '2026-05-31T06:00:00.000Z');
    h.deps.factory.maxConcurrentRuns = 10;
    await tick(h.deps);
    expect(h.launched).toEqual([
      'manual-old',
      'manual-new',
      'ci',
      'comment',
      'ready-old',
      'ready-new',
    ]);
  });

  describe('host.json', () => {
    const state = async (h: Awaited<ReturnType<typeof makeHarness>>) =>
      JSON.parse(await readFile(h.factory.hostStatePath, 'utf8'));

    it('is written every tick, not held and without readings when nothing is queued', async () => {
      const h = await withLimits();
      await tick(h.deps);
      expect(await state(h)).toEqual({
        version: 1,
        held: false,
        queued: 0,
        updatedAt: expect.any(String),
      });
      const off = await makeHarness();
      await tick(off.deps);
      expect(await state(off)).toMatchObject({ version: 1, held: false, queued: 0 });
    });

    it('records the readings and the Runs left waiting after a launch', async () => {
      const h = await withLimits();
      addTickets(h, 3);
      await tick(h.deps);
      expect(await state(h)).toEqual({
        version: 1,
        held: false,
        readings: { ...roomy, checkedAt: expect.any(String) },
        queued: 2,
        updatedAt: expect.any(String),
      });
    });

    it('keeps heldSince across held ticks and drops the hold when released', async () => {
      let load: HostLoad = { ...roomy, dockerMemoryFreeGb: 0.8 };
      const h = await withLimits(() => load);
      addTickets(h, 1);
      await tick(h.deps);
      const first = await state(h);
      expect(first).toMatchObject({
        held: true,
        reason: 'Docker memory 0.8 GB free < 1 GB',
        queued: 1,
        readings: { dockerMemoryFreeGb: 0.8, dockerReachable: true },
      });
      expect(first.heldSince).toBeDefined();

      h.setNow(new Date('2026-06-01T10:30:00.000Z'));
      await tick(h.deps);
      const second = await state(h);
      expect(second.heldSince).toBe(first.heldSince);
      expect(second.updatedAt > first.updatedAt).toBe(true);

      load = roomy;
      await tick(h.deps);
      const released = await state(h);
      expect(released.held).toBe(false);
      expect(released.reason).toBeUndefined();
      expect(released.heldSince).toBeUndefined();
    });

    it('starts a new hold with a fresh heldSince', async () => {
      let load: HostLoad = { ...roomy, loadPerCore: 2 };
      const h = await withLimits(() => load);
      addTickets(h, 2);
      await tick(h.deps);
      const first = await state(h);
      load = roomy;
      await tick(h.deps);
      load = { ...roomy, loadPerCore: 2 };
      h.setNow(new Date('2026-06-02T10:00:00.000Z'));
      await tick(h.deps);
      expect((await state(h)).heldSince > first.heldSince).toBe(true);
    });
  });
});

describe('Re-run requests', () => {
  const request = (h: Awaited<ReturnType<typeof makeHarness>>, runId: string) =>
    writeJson(rerunRequestPath(h.factory.registryDir, runId), {
      version: 1,
      requestedAt: '2026-06-01T09:00:00.000Z',
    });
  const seed = async (
    h: Awaited<ReturnType<typeof makeHarness>>,
    overrides: Parameters<typeof makeRun>[0] = {},
  ) => {
    await h.registry.write(makeRun({ id: 'failed-1', status: 'failed', ...overrides }));
    h.source.tickets.set('github:me/app#1', makeTicket(1, 'in_progress'));
  };

  it('queues a manual Run on the Ticket branch with the Re-run key, once', async () => {
    const h = await makeHarness();
    await seed(h, { branch: 'fractory/1-kept', mode: 'personal', flow: 'build' });
    await request(h, 'failed-1');
    const summary = await tick(h.deps);
    expect(summary.queued).toEqual(['run-1']);
    const rerun = await h.registry.get('run-1');
    expect(rerun).toMatchObject({
      key: 'github:me/app#1:rerun:failed-1',
      trigger: { kind: 'manual' },
      branch: 'fractory/1-kept',
      ticketRef: 'github:me/app#1',
      flow: 'build',
    });
    expect(h.launched).toEqual(['run-1']);
    expect(h.source.statusCalls).toContainEqual(['github:me/app#1', 'in_progress']);

    await h.registry.update('run-1', { status: 'done' });
    const again = await tick(h.deps);
    expect(again.queued).toEqual([]);
    expect(await h.registry.list()).toHaveLength(2);
  });

  it('accepts a needs-human Run and leaves the request file untouched', async () => {
    const h = await makeHarness();
    await seed(h, {
      status: 'needs-human',
      result: { outcome: 'needs-human', reason: 'ambiguous-spec', question: 'Which?' },
    });
    await request(h, 'failed-1');
    const path = rerunRequestPath(h.factory.registryDir, 'failed-1');
    const before = await readFile(path, 'utf8');
    await tick(h.deps);
    expect(await h.registry.get('run-1')).toBeDefined();
    expect(await readFile(path, 'utf8')).toBe(before);
  });

  it('skips a Run that is not the latest of its Ticket', async () => {
    const h = await makeHarness();
    await seed(h);
    await h.registry.write(
      makeRun({
        id: 'newer',
        key: 'other',
        status: 'done',
        createdAt: '2026-05-31T12:00:00.000Z',
        updatedAt: '2026-05-31T12:00:00.000Z',
      }),
    );
    await request(h, 'failed-1');
    expect((await tick(h.deps)).queued).toEqual([]);
    expect(h.log.lines.join('\n')).toMatch(/not the latest/);
  });

  it.each(['done', 'running', 'queued'] as const)('skips a %s Run', async (status) => {
    const h = await makeHarness();
    await seed(h, { status });
    await request(h, 'failed-1');
    const summary = await tick(h.deps);
    expect(summary.queued).toEqual([]);
    expect(h.log.lines.join('\n')).toMatch(/Re-run request for Run failed-1 skipped/);
  });

  it('ignores a request for an unknown Run and an invalid request file', async () => {
    const h = await makeHarness();
    await seed(h);
    await request(h, 'ghost');
    await writeJson(rerunRequestPath(h.factory.registryDir, 'failed-1'), { version: 2 });
    const summary = await tick(h.deps);
    expect(summary.queued).toEqual([]);
    expect(summary.errors).toBe(0);
  });

  it('is not listed as a Run by the registry', async () => {
    const h = await makeHarness();
    await seed(h);
    await request(h, 'failed-1');
    expect((await h.registry.list()).map((r) => r.id)).toEqual(['failed-1']);
  });
});

describe('Answer requests', () => {
  type H = Awaited<ReturnType<typeof makeHarness>>;
  const answer = (h: H, runId: string, text = 'Use the second reading.') =>
    writeJson(answerRequestPath(h.factory.registryDir, runId), {
      version: 1,
      answeredAt: '2026-06-01T09:00:00.000Z',
      answer: text,
    });
  const seed = async (h: H, overrides: Parameters<typeof makeRun>[0] = {}) => {
    await h.registry.write(
      makeRun({
        id: 'asked-1',
        status: 'needs-human',
        branch: 'fractory/1-kept',
        mode: 'personal',
        flow: 'build',
        result: { outcome: 'needs-human', reason: 'ambiguous-spec', question: 'Which reading?' },
        ...overrides,
      }),
    );
    h.source.tickets.set('github:me/app#1', makeTicket(1, 'in_progress'));
  };

  it('queues one answer Run on the Ticket branch with the Answer key and moves the Ticket', async () => {
    const h = await makeHarness();
    await seed(h);
    await answer(h, 'asked-1');
    const summary = await tick(h.deps);
    expect(summary.queued).toEqual(['run-1']);
    expect(await h.registry.get('run-1')).toMatchObject({
      key: 'github:me/app#1:answer:asked-1',
      trigger: { kind: 'answer', runId: 'asked-1' },
      branch: 'fractory/1-kept',
      ticketRef: 'github:me/app#1',
      mode: 'personal',
      flow: 'build',
    });
    expect(h.launched).toEqual(['run-1']);
    expect(h.source.statusCalls).toContainEqual(['github:me/app#1', 'in_progress']);
    expect(h.source.comments).toEqual([
      ['github:me/app#1', 'Answer to "Which reading?":\n\nUse the second reading.'],
    ]);
  });

  it('queues nothing and posts nothing on a second tick over the same request', async () => {
    const h = await makeHarness();
    await seed(h);
    await answer(h, 'asked-1');
    await tick(h.deps);
    await h.registry.update('run-1', { status: 'done' });
    const again = await tick(h.deps);
    expect(again.queued).toEqual([]);
    expect(await h.registry.list()).toHaveLength(2);
    expect(h.source.comments).toHaveLength(1);
    expect(h.log.lines.join('\n')).toMatch(/answer for Run asked-1 skipped: .* already exists/);
  });

  it('skips a Run that is not the latest of its Ticket, and logs why', async () => {
    const h = await makeHarness();
    await seed(h);
    await h.registry.write(
      makeRun({
        id: 'newer',
        key: 'other',
        status: 'done',
        createdAt: '2026-05-31T12:00:00.000Z',
        updatedAt: '2026-05-31T12:00:00.000Z',
      }),
    );
    await answer(h, 'asked-1');
    expect((await tick(h.deps)).queued).toEqual([]);
    expect(h.source.comments).toEqual([]);
    expect(h.log.lines.join('\n')).toMatch(
      /answer for Run asked-1 skipped: it is not the latest Run/,
    );
  });

  it.each(['done', 'failed'] as const)('skips a %s Run, and logs why', async (status) => {
    const h = await makeHarness();
    await seed(h, { status, result: { outcome: 'failed', summary: 'x' } });
    await answer(h, 'asked-1');
    expect((await tick(h.deps)).queued).toEqual([]);
    expect(h.source.comments).toEqual([]);
    expect(h.log.lines.join('\n')).toMatch(
      new RegExp(`answer for Run asked-1 skipped: the Run is ${status}`),
    );
  });

  it('waits silently while a Run on the Ticket is active, then queues once it is idle', async () => {
    const h = await makeHarness();
    await seed(h);
    await h.registry.write(
      makeRun({
        id: 'busy',
        key: 'busy',
        status: 'running',
        pid: 900,
        createdAt: '2026-05-30T10:00:00.000Z',
        updatedAt: '2026-05-30T10:00:00.000Z',
      }),
    );
    await answer(h, 'asked-1');
    const first = await tick(h.deps);
    expect(first.queued).toEqual([]);
    expect(h.source.comments).toEqual([]);
    expect(h.log.lines.join('\n')).not.toMatch(/answer for Run asked-1/);

    await h.registry.update('busy', { status: 'done' });
    const second = await tick(h.deps);
    expect(second.queued).toEqual(['run-1']);
    expect((await h.registry.get('run-1'))?.trigger).toEqual({ kind: 'answer', runId: 'asked-1' });
  });

  it('never posts rejected text in Work Mode, and still queues the Run', async () => {
    const h = await makeHarness({ config: workRepo });
    await seed(h, { mode: 'work', branch: 'feat/1-kept' });
    await answer(h, 'asked-1', 'Let Claude pick the second reading.');
    const summary = await tick(h.deps);
    expect(h.source.comments).toEqual([]);
    expect(summary.queued).toEqual(['run-1']);
    expect(h.log.lines.join('\n')).toMatch(/could not post the answer for Run asked-1/);
  });

  it('posts an allowed answer in Work Mode', async () => {
    const h = await makeHarness({ config: workRepo });
    await seed(h, { mode: 'work', branch: 'feat/1-kept' });
    await answer(h, 'asked-1');
    await tick(h.deps);
    expect(h.source.comments).toHaveLength(1);
  });

  it('logs a failing tracker comment and still queues the Run', async () => {
    const h = await makeHarness();
    await seed(h);
    h.source.commentError = new Error('tracker down');
    await answer(h, 'asked-1');
    const summary = await tick(h.deps);
    expect(summary.queued).toEqual(['run-1']);
    expect(summary.errors).toBe(0);
    expect(h.log.lines.join('\n')).toMatch(/could not post the answer .*tracker down/);
  });

  it('skips an invalid answer file and an unknown Run without stopping the tick', async () => {
    const h = await makeHarness();
    await seed(h);
    await writeJson(answerRequestPath(h.factory.registryDir, 'asked-1'), {
      version: 1,
      answeredAt: '2026-06-01T09:00:00.000Z',
      answer: '',
    });
    await writeFile(join(h.factory.registryDir, 'half.answer.json'), '{"version":');
    await answer(h, 'ghost');
    h.source.tickets.set('github:me/app#2', makeTicket(2));
    const summary = await tick(h.deps);
    expect(summary.errors).toBe(0);
    expect(summary.queued).toEqual(['run-1']);
    expect((await h.registry.get('run-1'))?.trigger).toEqual({ kind: 'ticket-ready' });
  });

  it('launches answer Runs before follow-ups and newly Ready Tickets', async () => {
    const h = await makeHarness({ maxConcurrentRuns: 1 });
    await seed(h);
    await answer(h, 'asked-1');
    await h.registry.write(
      makeRun({
        id: 'ci',
        ticketRef: 'github:me/app#2',
        key: 'k-ci',
        trigger: { kind: 'ci-failed', prNumber: 7, headSha: 's' },
        status: 'queued',
      }),
    );
    await h.registry.write(
      makeRun({ id: 'ready', ticketRef: 'github:me/app#3', key: 'k-ready', status: 'queued' }),
    );
    h.source.tickets.set('github:me/app#4', makeTicket(4));
    await tick(h.deps);
    expect(h.launched).toEqual(['run-1']);
    expect((await h.registry.get('run-1'))?.trigger.kind).toBe('answer');
  });

  it('never modifies or deletes the answer file, and the registry does not list it', async () => {
    const h = await makeHarness();
    await seed(h);
    await answer(h, 'asked-1');
    const path = answerRequestPath(h.factory.registryDir, 'asked-1');
    const before = await readFile(path, 'utf8');
    await tick(h.deps);
    await tick(h.deps);
    expect(await readFile(path, 'utf8')).toBe(before);
    expect((await h.registry.list()).map((r) => r.id).sort()).toEqual(['asked-1', 'run-1']);
  });
});

describe('dead Run detection', () => {
  it('marks a running Run whose pid is gone as failed', async () => {
    const h = await makeHarness();
    await h.registry.write(makeRun({ id: 'dead', status: 'running', pid: 111 }));
    h.pids.set(111, 'dead');
    const summary = await tick(h.deps);
    expect(summary.markedDead).toEqual(['dead']);
    const run = await h.registry.get('dead');
    expect(run?.status).toBe('failed');
    expect(run?.finishedAt).toBeDefined();
  });

  it('leaves Runs alone when the pid check proves nothing', async () => {
    const h = await makeHarness();
    await h.registry.write(makeRun({ id: 'a', status: 'running', pid: 111 }));
    await h.registry.write(makeRun({ id: 'b', status: 'running', pid: 112, key: 'k2' }));
    h.pids.set(111, 'unknown');
    h.pids.set(112, 'alive');
    await tick(h.deps);
    expect((await h.registry.get('a'))?.status).toBe('running');
    expect((await h.registry.get('b'))?.status).toBe('running');
  });
});

describe('PR handling', () => {
  const withPr = async (config = personalRepo) => {
    const h = await makeHarness({ config });
    await h.registry.write(makeRun({ prUrl: PR_URL, status: 'done' }));
    h.source.tickets.set('github:me/app#1', makeTicket(1, 'in_review'));
    return h;
  };

  it('marks the Ticket done when the PR is merged, once', async () => {
    const h = await withPr();
    h.gh.prs.set(PR_URL, makePr({ state: 'MERGED' }));
    await tick(h.deps);
    await tick(h.deps);
    expect(h.source.statusCalls).toEqual([['github:me/app#1', 'done']]);
    expect(await h.registry.list()).toHaveLength(1);
  });

  it('queues a ci-failed follow-up on the PR branch, keyed by sha', async () => {
    const h = await withPr();
    h.gh.prs.set(
      PR_URL,
      makePr({
        headRefOid: 'abc',
        statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'FAILURE' }],
      }),
    );
    await tick(h.deps);
    await tick(h.deps);
    const runs = await h.registry.list();
    const followUps = runs.filter((r) => r.trigger.kind === 'ci-failed');
    expect(followUps).toHaveLength(1);
    expect(followUps[0]).toMatchObject({
      branch: 'fractory/1-add-thing-1',
      key: runKey('github:me/app#1', { kind: 'ci-failed', prNumber: 7, headSha: 'abc' }),
    });
    expect(h.gh.merges).toEqual([]);
  });

  it('triggers on a review comment from someone else and ignores the factory user', async () => {
    const h = await withPr();
    h.gh.prs.set(
      PR_URL,
      makePr({
        comments: [
          { id: 'c-own', author: { login: 'factory-bot' }, body: 'Pushed a fix' },
          { id: 'c-human', author: { login: 'pedro' }, body: 'rename this' },
        ],
      }),
    );
    await tick(h.deps);
    const followUps = (await h.registry.list()).filter((r) => r.trigger.kind === 'review-comment');
    expect(followUps).toHaveLength(1);
    expect(followUps[0]?.trigger).toMatchObject({ commentId: 'c-human' });
  });

  it('does nothing about comments when the gh user cannot be read', async () => {
    const h = await withPr();
    h.gh.user = new Error('network');
    h.gh.prs.set(PR_URL, makePr({ comments: [{ id: 'c1', author: { login: 'x' }, body: 'hi' }] }));
    await tick(h.deps);
    expect((await h.registry.list()).filter((r) => r.trigger.kind === 'review-comment')).toEqual(
      [],
    );
  });

  it('does not stack follow-ups while a Run on the Ticket is active', async () => {
    const h = await withPr();
    await h.registry.write(
      makeRun({
        id: 'live',
        key: 'k-live',
        status: 'running',
        pid: 5,
        createdAt: '2026-06-01T00:00:00.000Z',
      }),
    );
    h.gh.prs.set(
      PR_URL,
      makePr({ statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'FAILURE' }] }),
    );
    await tick(h.deps);
    expect(await h.registry.list()).toHaveLength(2);
  });

  it('a failed PR read proves nothing: no state change, other work continues', async () => {
    const h = await withPr();
    h.gh.prs.set(PR_URL, new Error('gh: timeout'));
    h.source.tickets.set('github:me/app#9', makeTicket(9));
    const summary = await tick(h.deps);
    expect(h.source.statusCalls.filter(([, s]) => s === 'done')).toEqual([]);
    expect(summary.errors).toBe(1);
    expect(summary.queued).toHaveLength(1);
  });

  describe('merge rules', () => {
    const cases: {
      name: string;
      config: typeof personalRepo;
      pr: Record<string, unknown>;
      merges: boolean;
    }[] = [
      { name: 'Personal + CI + green + MERGEABLE', config: personalRepo, pr: {}, merges: true },
      { name: 'Work Mode never auto-merges', config: workRepo, pr: {}, merges: false },
      {
        name: 'Personal without CI merges (merges are never a Gate)',
        config: { ...personalRepo, hasCi: false },
        pr: { statusCheckRollup: [] },
        merges: true,
      },
      {
        name: 'CONFLICTING is never merged',
        config: personalRepo,
        pr: { mergeable: 'CONFLICTING' },
        merges: false,
      },
      {
        name: 'UNKNOWN mergeability waits',
        config: personalRepo,
        pr: { mergeable: 'UNKNOWN' },
        merges: false,
      },
      {
        name: 'a PR based on another branch is never merged',
        config: personalRepo,
        pr: { baseRefName: 'fractory/1-blocker' },
        merges: false,
      },
      {
        name: 'pending checks wait',
        config: personalRepo,
        pr: { statusCheckRollup: [{ status: 'IN_PROGRESS', conclusion: null }] },
        merges: false,
      },
    ];
    for (const c of cases) {
      it(c.name, async () => {
        const h = await withPr(c.config);
        h.gh.prs.set(PR_URL, makePr(c.pr));
        await tick(h.deps);
        expect(h.gh.merges).toEqual(c.merges ? [PR_URL] : []);
      });
    }

    it('does not merge when the latest Run did not finish done', async () => {
      const h = await makeHarness();
      await h.registry.write(makeRun({ prUrl: PR_URL, status: 'needs-human' }));
      h.gh.prs.set(PR_URL, makePr());
      await tick(h.deps);
      expect(h.gh.merges).toEqual([]);
    });
  });
});

describe('isolation and locking', () => {
  it('one broken repo does not stop the others', async () => {
    const h = await makeHarness({ repos: ['/repo/a', '/repo/b'] });
    h.configs.set('/repo/a', new Error('bad config'));
    h.source.tickets.set('github:me/app#1', makeTicket(1));
    const summary = await tick(h.deps);
    expect(summary.errors).toBe(1);
    expect(summary.queued).toHaveLength(1);
    expect(h.log.lines.some((l) => l.includes('/repo/a'))).toBe(true);
  });

  it('skips the whole tick while another holds a fresh lock', async () => {
    const h = await makeHarness();
    h.source.tickets.set('github:me/app#1', makeTicket(1));
    await mkdir(h.factory.logDir, { recursive: true });
    await writeFile(join(h.factory.logDir, 'tick.lock'), '999\n');
    // The harness clock is fixed in 2026; the lock file's mtime is "now" in real time, so
    // pin the clock to real time for this case.
    h.deps.now = () => new Date();
    const summary = await tick(h.deps);
    expect(summary.locked).toBe(true);
    expect(await h.registry.list()).toEqual([]);
  });

  it('takes over a lock older than 15 minutes and releases its own', async () => {
    const dir = join((await makeHarness()).factory.logDir);
    await mkdir(dir, { recursive: true });
    const path = join(dir, 'x.lock');
    await writeFile(path, '999\n');
    const old = new Date(Date.now() - 20 * 60 * 1000);
    await utimes(path, old, old);
    const lock = await acquireLock(path);
    expect(lock).toBeDefined();
    expect(await acquireLock(path)).toBeUndefined();
    await lock?.release();
    expect(await acquireLock(path)).toBeDefined();
  });
});

describe('PR state memory', () => {
  it('records prState and stops reading merged and closed PRs', async () => {
    const h = await makeHarness();
    h.source.tickets.set('github:me/app#1', makeTicket(1, 'in_review'));
    await h.registry.write(makeRun({ id: 'r1', prUrl: PR_URL }));
    h.gh.prs.set(PR_URL, makePr({ state: 'OPEN' }));
    await tick(h.deps);
    expect((await h.registry.get('r1'))?.prState).toBe('OPEN');

    h.gh.prs.set(PR_URL, makePr({ state: 'MERGED' }));
    await tick(h.deps);
    expect((await h.registry.get('r1'))?.prState).toBe('MERGED');
    expect(h.source.tickets.get('github:me/app#1')?.status).toBe('done');

    h.gh.prs.set(PR_URL, new Error('must not be read'));
    const summary = await tick(h.deps);
    expect(summary.errors).toBe(0);
  });

  it('does not record the state when marking the Ticket done failed, so the next tick retries', async () => {
    const h = await makeHarness();
    h.source.tickets.set('github:me/app#1', makeTicket(1, 'in_review'));
    await h.registry.write(makeRun({ id: 'r1', prUrl: PR_URL }));
    h.gh.prs.set(PR_URL, makePr({ state: 'MERGED' }));
    h.source.setStatus = async () => {
      throw new Error('tracker down');
    };
    expect((await tick(h.deps)).errors).toBe(1);
    expect((await h.registry.get('r1'))?.prState).toBeUndefined();
  });

  it('skips a Run whose prState is CLOSED without calling gh', async () => {
    const h = await makeHarness();
    await h.registry.write(makeRun({ id: 'r1', prUrl: PR_URL, prState: 'CLOSED' }));
    const summary = await tick(h.deps);
    expect(summary.errors).toBe(0);
  });
});

describe('Restack', () => {
  const BELOW = 'fractory/4-add-thing-4';
  const ABOVE = 'fractory/5-add-thing-5';
  const PR4 = 'https://github.com/me/app/pull/4';
  const PR5 = 'https://github.com/me/app/pull/5';
  // Checks still running: nothing merges, nothing is followed up.
  const pending = [{ status: 'IN_PROGRESS', conclusion: null }];

  /** #5 is stacked on #4's branch at `tip-a`; both Runs are done with their pull requests open. */
  const stacked = async (options: { maxConcurrentRuns?: number } = {}) => {
    const h = await makeHarness(options);
    await h.registry.write(
      makeRun({ id: 'r4', ticketRef: 'github:me/app#4', branch: BELOW, prUrl: PR4 }),
    );
    await h.registry.write(
      makeRun({
        id: 'r5',
        ticketRef: 'github:me/app#5',
        branch: ABOVE,
        baseBranch: BELOW,
        baseSha: 'tip-a',
        prUrl: PR5,
        createdAt: '2026-05-31T11:00:00.000Z',
      }),
    );
    h.source.tickets.set('github:me/app#4', makeTicket(4, 'in_review'));
    h.source.tickets.set('github:me/app#5', makeTicket(5, 'in_review'));
    h.gh.prs.set(PR4, makePr({ number: 4, statusCheckRollup: pending }));
    h.gh.prs.set(
      PR5,
      makePr({ number: 5, baseRefName: BELOW, headRefOid: 'h5', statusCheckRollup: pending }),
    );
    h.tips.set(BELOW, 'tip-a');
    return h;
  };
  const restacks = async (h: Awaited<ReturnType<typeof makeHarness>>) =>
    (await h.registry.list()).filter((r) => r.trigger.kind === 'restack');

  it('queues nothing while the tip of the branch below is unchanged', async () => {
    const h = await stacked();
    for (let i = 0; i < 3; i++) {
      const summary = await tick(h.deps);
      expect(summary.queued).toEqual([]);
      expect(summary.errors).toBe(0);
    }
    expect(h.tipReads).toContain(BELOW);
    expect(await restacks(h)).toEqual([]);
  });

  it('queues exactly one Restack for a moved tip, however many ticks pass', async () => {
    const h = await stacked();
    h.tips.set(BELOW, 'tip-b');
    const first = await tick(h.deps);
    expect(first.queued).toHaveLength(1);
    expect(first.launched).toEqual(first.queued);
    const [run] = await restacks(h);
    expect(run).toMatchObject({
      key: 'github:me/app#5:restack:tip-b',
      ticketRef: 'github:me/app#5',
      trigger: { kind: 'restack', fromSha: 'tip-a', tipSha: 'tip-b' },
      branch: ABOVE,
      baseBranch: BELOW,
      baseSha: 'tip-a',
    });
    expect(h.source.statusCalls).toEqual([['github:me/app#5', 'in_progress']]);

    // Running, then failed for the owner, then done without moving: never a second one for tip-b.
    expect((await tick(h.deps)).queued).toEqual([]);
    await h.registry.update(run?.id as string, { status: 'failed' });
    expect((await tick(h.deps)).queued).toEqual([]);
    await h.registry.update(run?.id as string, { status: 'done' });
    expect((await tick(h.deps)).queued).toEqual([]);
    expect(await restacks(h)).toHaveLength(1);
  });

  it('restacks again when the tip moves again after a Restack is done', async () => {
    const h = await stacked();
    h.tips.set(BELOW, 'tip-b');
    const first = await tick(h.deps);
    // The Run rebased onto tip-b and recorded it.
    await h.registry.update(first.queued[0] as string, { status: 'done', baseSha: 'tip-b' });
    expect((await tick(h.deps)).queued).toEqual([]);
    h.tips.set(BELOW, 'tip-c');
    const third = await tick(h.deps);
    expect(third.queued).toHaveLength(1);
    expect((await h.registry.get(third.queued[0] as string))?.trigger).toEqual({
      kind: 'restack',
      fromSha: 'tip-b',
      tipSha: 'tip-c',
    });
  });

  it('a follow-up Run on the branch below is followed by one Restack once it is done', async () => {
    const h = await stacked();
    // A failing check on #4 starts a follow-up Run on its branch.
    h.gh.prs.set(
      PR4,
      makePr({ number: 4, headRefOid: 'tip-a', statusCheckRollup: [{ state: 'FAILURE' }] }),
    );
    const first = await tick(h.deps);
    expect(first.queued).toHaveLength(1);
    expect((await h.registry.get(first.queued[0] as string))?.trigger.kind).toBe('ci-failed');
    // While it runs and pushes, the stack above waits.
    h.tips.set(BELOW, 'tip-b');
    expect((await tick(h.deps)).queued).toEqual([]);
    await h.registry.update(first.queued[0] as string, { status: 'done', prUrl: PR4 });
    h.gh.prs.set(PR4, makePr({ number: 4, headRefOid: 'tip-b', statusCheckRollup: pending }));
    const third = await tick(h.deps);
    expect(third.queued).toHaveLength(1);
    expect((await restacks(h)).map((r) => r.ticketRef)).toEqual(['github:me/app#5']);
  });

  it('launches a Restack ahead of Runs started by a Ticket becoming Ready', async () => {
    const h = await stacked({ maxConcurrentRuns: 1 });
    await h.registry.write(
      makeRun({
        id: 'ready',
        ticketRef: 'github:me/app#9',
        key: 'k-ready',
        status: 'queued',
        createdAt: '2026-05-01T00:00:00.000Z',
      }),
    );
    h.source.tickets.set('github:me/app#8', makeTicket(8));
    h.tips.set(BELOW, 'tip-b');
    await tick(h.deps);
    expect(h.launched).toHaveLength(1);
    expect((await h.registry.get(h.launched[0] as string))?.trigger.kind).toBe('restack');
  });

  it('obeys the Host Limits: a full host holds a Restack queued', async () => {
    const h = await stacked();
    h.deps.factory.resources = ResourceLimitsSchema.parse({});
    h.deps.hostLoad = async () => ({ loadPerCore: 0.92, dockerReachable: true });
    h.tips.set(BELOW, 'tip-b');
    const summary = await tick(h.deps);
    expect(summary.held).toBe('CPU load 0.92 per core > 0.75');
    expect(h.launched).toEqual([]);
    expect((await restacks(h)).map((r) => r.status)).toEqual(['queued']);

    h.deps.hostLoad = async () => ({ loadPerCore: 0.1, dockerReachable: true });
    await tick(h.deps);
    expect(h.launched).toEqual(summary.queued);
  });

  it('a tip that cannot be read proves nothing, and a branch gone from the remote restacks nothing', async () => {
    const h = await stacked();
    h.tips.set(BELOW, new Error('network down'));
    const summary = await tick(h.deps);
    expect(summary.queued).toEqual([]);
    expect(h.log.lines.some((l) => l.startsWith(`WARN could not read the tip of ${BELOW}`))).toBe(
      true,
    );
    h.tips.delete(BELOW);
    expect((await tick(h.deps)).queued).toEqual([]);
    expect(await restacks(h)).toEqual([]);
  });

  it('leaves a stack alone while its own Run is active or failed, or its pull request is closed', async () => {
    for (const patch of [
      { status: 'failed' as const },
      { status: 'needs-human' as const },
      { prState: 'CLOSED' as const },
    ]) {
      const h = await stacked();
      await h.registry.update('r5', patch);
      h.tips.set(BELOW, 'tip-b');
      expect((await tick(h.deps)).queued).toEqual([]);
      expect(await restacks(h)).toEqual([]);
    }
  });

  it('never restacks onto a branch whose pull request merged', async () => {
    const h = await stacked();
    await h.registry.update('r4', { prState: 'MERGED' });
    h.tips.set(BELOW, 'tip-b');
    await tick(h.deps);
    expect(await restacks(h)).toEqual([]);
  });

  it('never restacks a Run built on the repository base branch', async () => {
    const h = await stacked();
    await h.registry.update('r5', { baseBranch: 'main' });
    h.tips.set('main', 'tip-b');
    await tick(h.deps);
    expect(await restacks(h)).toEqual([]);
  });

  it('a stacked Run records the tip of the branch it is built on when queued', async () => {
    const h = await makeHarness();
    await h.registry.write(makeRun({ id: 'r4', ticketRef: 'github:me/app#4', branch: BELOW }));
    h.source.tickets.set('github:me/app#4', makeTicket(4, 'in_review'));
    h.source.tickets.set('github:me/app#5', {
      ...makeTicket(5),
      blockedBy: ['github:me/app#4'],
    });
    h.tips.set(BELOW, 'tip-a');
    await tick(h.deps);
    const run = (await h.registry.list()).find((r) => r.ticketRef === 'github:me/app#5');
    expect(run).toMatchObject({ baseBranch: BELOW, baseSha: 'tip-a' });
  });
});
