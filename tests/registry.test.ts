import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RUN_RECORD_VERSION, type RunRecord, runKey } from '../src/contracts/run.ts';
import { RunRegistry, isActive } from '../src/registry/registry.ts';

const now = new Date().toISOString();
const record = (id: string, overrides: Partial<RunRecord> = {}): RunRecord => ({
  version: RUN_RECORD_VERSION,
  id,
  key: runKey('github:me/repo#1', { kind: 'ticket-ready' }),
  ticketRef: 'github:me/repo#1',
  repoPath: '/repo',
  trigger: { kind: 'ticket-ready' },
  status: 'queued',
  branch: 'fractory/1',
  logPath: '/logs/x.log',
  createdAt: now,
  updatedAt: now,
  ...overrides,
});

describe('RunRegistry', () => {
  it('writes, reads, updates and lists records', async () => {
    const registry = new RunRegistry(await mkdtemp(join(tmpdir(), 'reg-')));
    await registry.write(record('a'));
    await registry.write(record('b', { status: 'done' }));
    await registry.update('a', { status: 'running', pid: 42 });

    expect((await registry.get('a'))?.status).toBe('running');
    expect((await registry.list()).filter(isActive).map((r) => r.id)).toEqual(['a']);
  });

  it('returns nothing for a missing directory or record', async () => {
    const registry = new RunRegistry(join(tmpdir(), 'does-not-exist-fractory'));
    expect(await registry.list()).toEqual([]);
    expect(await registry.get('nope')).toBeUndefined();
  });

  it('skips corrupt files instead of failing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'reg-'));
    const registry = new RunRegistry(dir);
    await registry.write(record('ok'));
    await writeFile(join(dir, 'broken.json'), '{not json');
    expect((await registry.list()).map((r) => r.id)).toEqual(['ok']);
  });

  it('rejects invalid records', async () => {
    const registry = new RunRegistry(await mkdtemp(join(tmpdir(), 'reg-')));
    await expect(registry.write({ ...record('x'), status: 'weird' } as never)).rejects.toThrow();
  });
});

describe('runKey', () => {
  it('is stable per trigger occurrence', () => {
    const ref = 'jira:ABC-1';
    expect(runKey(ref, { kind: 'ci-failed', prNumber: 3, headSha: 's1' })).toBe(
      runKey(ref, { kind: 'ci-failed', prNumber: 3, headSha: 's1' }),
    );
    expect(runKey(ref, { kind: 'ci-failed', prNumber: 3, headSha: 's1' })).not.toBe(
      runKey(ref, { kind: 'ci-failed', prNumber: 3, headSha: 's2' }),
    );
  });
});
