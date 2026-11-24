import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RepoConfigSchema } from '../src/contracts/repo-config.ts';
import { RUN_RECORD_VERSION, type RunRecord, runKey } from '../src/contracts/run.ts';
import { RunRegistry } from '../src/registry/registry.ts';
import { defaultCommand, launchRun } from '../src/runner/index.ts';

const now = new Date().toISOString();
const queued = (overrides: Partial<RunRecord> = {}): RunRecord => ({
  version: RUN_RECORD_VERSION,
  id: 'run1',
  key: runKey('github:me/repo#1', { kind: 'ticket-ready' }),
  ticketRef: 'github:me/repo#1',
  repoPath: '/repo',
  trigger: { kind: 'ticket-ready' },
  status: 'queued',
  branch: 'fractory/1',
  logPath: '/logs/run1.log',
  createdAt: now,
  updatedAt: now,
  ...overrides,
});
const config = RepoConfigSchema.parse({
  mode: 'personal',
  ticketSource: { kind: 'github', repo: 'me/repo' },
  hasCi: true,
});

describe('launchRun', () => {
  it('records pid and running in the registry before returning', async () => {
    const registry = new RunRegistry(await mkdtemp(join(tmpdir(), 'launch-')));
    await registry.write(queued());
    const spawned: string[][] = [];

    await launchRun(queued(), config, {
      registry,
      command: (r) => ({ command: 'node', args: ['run-exec', r.id], cwd: '/' }),
      spawnDetached: (command, logPath) => {
        spawned.push([command.command, ...command.args, logPath]);
        return 4242;
      },
    });

    expect(spawned).toEqual([['node', 'run-exec', 'run1', '/logs/run1.log']]);
    const saved = await registry.get('run1');
    expect(saved?.status).toBe('running');
    expect(saved?.pid).toBe(4242);
  });

  it('marks the Run failed when the process cannot be started', async () => {
    const registry = new RunRegistry(await mkdtemp(join(tmpdir(), 'launch-')));
    await registry.write(queued());
    await expect(
      launchRun(queued(), config, {
        registry,
        command: () => ({ command: 'nope', args: [], cwd: '/' }),
        spawnDetached: () => undefined,
      }),
    ).rejects.toThrow(/could not be started/);
    expect((await registry.get('run1'))?.status).toBe('failed');
  });

  it('refuses to launch a Run that is not queued', async () => {
    const registry = new RunRegistry(await mkdtemp(join(tmpdir(), 'launch-')));
    await registry.write(queued({ status: 'running', pid: 1 }));
    await expect(launchRun(queued(), config, { registry, spawnDetached: () => 9 })).rejects.toThrow(
      /only a queued Run/,
    );
  });

  it('builds a tsx command for `src/cli.ts run-exec <id>` with the current node', () => {
    const command = defaultCommand(queued());
    expect(command.command).toBe(process.execPath);
    expect(command.args.slice(-2)).toEqual(['run-exec', 'run1']);
    expect(command.args[0]).toBe('--import');
    expect(command.args[2]).toMatch(/src\/cli\.ts$/);
  });
});
