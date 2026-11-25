import { mkdir, readFile, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ResourceLimitsSchema } from '../src/contracts/factory-config.ts';
import { type Trigger, rerunRequestPath, runKey } from '../src/contracts/run.ts';
import type { HostLoad } from '../src/policy/resources.ts';
import { branchFor } from '../src/trigger/queue.ts';
import { acquireLock } from '../src/trigger/support.ts';
import { tick } from '../src/trigger/tick.ts';
import {
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

  it('uses a feat/ branch in Work Mode and never a fractory-prefixed one', async () => {
    const h = await makeHarness({ config: workRepo });
    h.source.tickets.set('github:me/app#2', makeTicket(2, 'ready', 'Fix login'));
    await tick(h.deps);
    expect((await h.registry.list())[0]?.branch).toBe('feat/2-fix-login');
  });

  it('drops a title that would trip the Work Mode outbound policy', () => {
    expect(branchFor('github:me/app#3', 'Ask Claude to fix it', 'work')).toBe('feat/3');
    expect(branchFor('jira:ABC-12', 'Add login', 'work')).toBe('feat/abc-12-add-login');
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
