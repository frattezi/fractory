import { mkdir, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runKey } from '../src/contracts/run.ts';
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
      makePr({ headRefOid: 'abc', statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'FAILURE' }] }),
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
    expect((await h.registry.list()).filter((r) => r.trigger.kind === 'review-comment')).toEqual([]);
  });

  it('does not stack follow-ups while a Run on the Ticket is active', async () => {
    const h = await withPr();
    await h.registry.write(makeRun({ id: 'live', key: 'k-live', status: 'running', pid: 5, createdAt: '2026-06-01T00:00:00.000Z' }));
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
        name: 'Personal without CI waits for the PR Gate',
        config: { ...personalRepo, hasCi: false },
        pr: { statusCheckRollup: [] },
        merges: false,
      },
      { name: 'CONFLICTING is never merged', config: personalRepo, pr: { mergeable: 'CONFLICTING' }, merges: false },
      { name: 'UNKNOWN mergeability waits', config: personalRepo, pr: { mergeable: 'UNKNOWN' }, merges: false },
      {
        name: 'pending checks wait',
        config: personalRepo,
        pr: { statusCheckRollup: [{ status: 'IN_PROGRESS', conclusion: null }] },
        merges: false,
      },
      {
        name: 'empty check rollup is not green',
        config: personalRepo,
        pr: { statusCheckRollup: [] },
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
