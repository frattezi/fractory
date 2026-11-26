import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AUTOMATION_RUN_RECORD_VERSION,
  type AutomationRunRecord,
} from '../src/contracts/automation.ts';
import { AutomationStore } from '../src/registry/automations.ts';
import { defaultAutomationCommand, launchAutomationRun } from '../src/runner/automation.ts';

const NOW = new Date('2026-06-01T03:00:05.000Z');
const queued = (overrides: Partial<AutomationRunRecord> = {}): AutomationRunRecord => ({
  version: AUTOMATION_RUN_RECORD_VERSION,
  id: 'a1-20260601T030000Z',
  automationId: 'a1',
  firedFor: '2026-06-01T03:00:00.000Z',
  status: 'queued',
  startedAt: '2026-06-01T03:00:02.000Z',
  updatedAt: '2026-06-01T03:00:02.000Z',
  logPath: '/automations/a1/a1-20260601T030000Z.log',
  outputPath: '/automations/a1/a1-20260601T030000Z.out',
  ...overrides,
});
const makeStore = async () => new AutomationStore(await mkdtemp(join(tmpdir(), 'auto-launch-')));

describe('launchAutomationRun', () => {
  it('spawns the host command and records pid and running before returning', async () => {
    const store = await makeStore();
    await store.writeRun(queued());
    const spawned: [string[], string][] = [];

    await launchAutomationRun(queued(), {
      store,
      now: () => NOW,
      command: (r) => ({
        command: 'node',
        args: ['automation-exec', r.automationId, r.id],
        cwd: '/',
      }),
      spawnDetached: (command, logPath) => {
        spawned.push([command.args, logPath]);
        return 4321;
      },
    });

    expect(spawned).toEqual([[['automation-exec', 'a1', 'a1-20260601T030000Z'], queued().logPath]]);
    expect(await store.getRun('a1', 'a1-20260601T030000Z')).toEqual({
      ...queued(),
      status: 'running',
      pid: 4321,
      updatedAt: NOW.toISOString(),
    });
  });

  it('marks the Run failed and throws when the process could not be started', async () => {
    const store = await makeStore();
    await store.writeRun(queued());

    await expect(
      launchAutomationRun(queued(), { store, now: () => NOW, spawnDetached: () => undefined }),
    ).rejects.toThrow(/could not be started/);
    expect(await store.getRun('a1', 'a1-20260601T030000Z')).toMatchObject({
      status: 'failed',
      result: { outcome: 'failed' },
    });
  });

  it('refuses a Run that is no longer queued, without spawning', async () => {
    const store = await makeStore();
    await store.writeRun(queued({ status: 'running', pid: 1 }));
    let spawned = false;

    await expect(
      launchAutomationRun(queued(), {
        store,
        spawnDetached: () => {
          spawned = true;
          return 2;
        },
      }),
    ).rejects.toThrow(/is running/);
    expect(spawned).toBe(false);
  });

  it('runs the automation-exec command of the CLI by default', () => {
    const command = defaultAutomationCommand(queued());
    expect(command.args.slice(-3)).toEqual(['automation-exec', 'a1', 'a1-20260601T030000Z']);
  });
});
