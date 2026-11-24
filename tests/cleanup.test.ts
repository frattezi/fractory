import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cleanup } from '../src/cleanup/cleanup.ts';
import type { Exec } from '../src/github/exec.ts';
import { RunRegistry } from '../src/registry/registry.ts';
import { FakeGh, PR_URL, makePr, makeRun, memoryLogger } from './trigger-helpers.ts';

const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), 'fractory-clean-'));
  const worktree = join(root, 'wt');
  await mkdir(worktree);
  const registry = new RunRegistry(join(root, 'runs'));
  const gh = new FakeGh();
  const calls: string[][] = [];
  const dirty = new Set<string>();
  const exec: Exec = async (_cmd, args) => {
    calls.push(args);
    if (args.includes('status')) return dirty.has(args[1] as string) ? ' M file.ts\n' : '';
    return '';
  };
  const now = new Date('2026-06-20T00:00:00.000Z');
  const deps = {
    factory: {
      repos: ['/repo/app'],
      maxConcurrentRuns: 3,
      staleWorktreeDays: 7,
      registryDir: join(root, 'runs'),
      logDir: join(root, 'logs'),
    },
    registry,
    gh,
    exec,
    now: () => now,
    log: memoryLogger(),
  };
  const removals = () => calls.filter((a) => a.includes('remove'));
  return { worktree, registry, gh, calls, dirty, deps, removals };
};

describe('cleanup', () => {
  it('removes the recorded worktree of a merged PR when it is clean, then prunes', async () => {
    const s = await setup();
    await s.registry.write(makeRun({ worktreePath: s.worktree, prUrl: PR_URL }));
    s.gh.prs.set(PR_URL, makePr({ state: 'MERGED' }));
    const result = await cleanup(s.deps);
    expect(result.removed).toEqual([s.worktree]);
    expect(s.removals()).toEqual([['-C', '/repo/app', 'worktree', 'remove', s.worktree]]);
    expect(s.calls.at(-1)).toEqual(['-C', '/repo/app', 'worktree', 'prune']);
  });

  it('keeps a merged PR worktree that has uncommitted changes and records the skip', async () => {
    const s = await setup();
    await s.registry.write(makeRun({ worktreePath: s.worktree, prUrl: PR_URL }));
    s.gh.prs.set(PR_URL, makePr({ state: 'MERGED' }));
    s.dirty.add(s.worktree);
    const result = await cleanup(s.deps);
    expect(result.removed).toEqual([]);
    expect(result.skipped[0]?.reason).toMatch(/uncommitted/);
  });

  it('keeps worktrees of open PRs and of PRs whose state cannot be read', async () => {
    const s = await setup();
    await s.registry.write(makeRun({ worktreePath: s.worktree, prUrl: PR_URL }));
    s.gh.prs.set(PR_URL, makePr({ state: 'OPEN' }));
    expect((await cleanup(s.deps)).removed).toEqual([]);
    s.gh.prs.set(PR_URL, new Error('offline'));
    const result = await cleanup(s.deps);
    expect(result.removed).toEqual([]);
    expect(result.skipped[0]?.reason).toMatch(/unreadable/);
  });

  it('removes a failed Run worktree only after staleWorktreeDays', async () => {
    const s = await setup();
    await s.registry.write(
      makeRun({
        worktreePath: s.worktree,
        status: 'failed',
        finishedAt: '2026-06-18T00:00:00.000Z',
      }),
    );
    expect((await cleanup(s.deps)).removed).toEqual([]);
    await s.registry.update('r1', { finishedAt: '2026-06-01T00:00:00.000Z' });
    expect((await cleanup(s.deps)).removed).toEqual([s.worktree]);
    expect(s.removals()[0]).toContain('--force');
  });

  it('never touches a worktree an active Run is using', async () => {
    const s = await setup();
    await s.registry.write(
      makeRun({ worktreePath: s.worktree, prUrl: PR_URL, createdAt: '2026-06-01T00:00:00.000Z' }),
    );
    await s.registry.write(
      makeRun({ id: 'r2', key: 'k2', worktreePath: s.worktree, status: 'running', pid: 1 }),
    );
    s.gh.prs.set(PR_URL, makePr({ state: 'MERGED' }));
    expect((await cleanup(s.deps)).removed).toEqual([]);
  });

  it('refuses a recorded path that is the main checkout and ignores missing paths', async () => {
    const s = await setup();
    await s.registry.write(
      makeRun({
        worktreePath: s.worktree,
        repoPath: s.worktree,
        status: 'failed',
        finishedAt: '2026-01-01T00:00:00.000Z',
      }),
    );
    s.deps.factory.repos = [s.worktree];
    expect((await cleanup(s.deps)).removed).toEqual([]);
    await s.registry.write(
      makeRun({
        id: 'gone',
        key: 'kg',
        worktreePath: '/does/not/exist',
        status: 'failed',
        finishedAt: '2026-01-01T00:00:00.000Z',
      }),
    );
    expect((await cleanup(s.deps)).removed).toEqual([]);
  });
});
