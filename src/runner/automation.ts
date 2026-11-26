import { join } from 'node:path';
import type { AutomationRunRecord } from '../contracts/automation.ts';
import { FactoryConfigSchema } from '../contracts/factory-config.ts';
import { AutomationStore } from '../registry/automations.ts';
import { FRACTORY_ROOT } from './exec.ts';
import { type SpawnCommand, defaultSpawnDetached } from './index.ts';

export interface LaunchAutomationDeps {
  store?: AutomationStore;
  /** The host command that runs the Automation Run. Default: `src/cli.ts automation-exec`. */
  command?: (record: AutomationRunRecord) => SpawnCommand;
  /** Starts the command detached with output appended to `logPath`; returns the pid. */
  spawnDetached?: (command: SpawnCommand, logPath: string) => number | undefined;
  now?: () => Date;
}

export const defaultAutomationCommand = (record: AutomationRunRecord): SpawnCommand => ({
  command: process.execPath,
  args: [
    '--import',
    'tsx',
    join(FRACTORY_ROOT, 'src/cli.ts'),
    'automation-exec',
    record.automationId,
    record.id,
  ],
  cwd: FRACTORY_ROOT,
});

/**
 * Starts a queued Automation Run as a detached host process and returns once it is running.
 * The pid and `running` are recorded before returning, so a crash never leaves the Run looking
 * unstarted.
 */
export const launchAutomationRun = async (
  record: AutomationRunRecord,
  deps: LaunchAutomationDeps = {},
): Promise<void> => {
  const store = deps.store ?? new AutomationStore(FactoryConfigSchema.parse({}).automationsDir);
  const now = deps.now ?? (() => new Date());
  const current = (await store.getRun(record.automationId, record.id)) ?? record;
  if (current.status !== 'queued') {
    throw new Error(
      `Automation Run ${record.id} is ${current.status}, only a queued Run can be launched`,
    );
  }
  const pid = (deps.spawnDetached ?? defaultSpawnDetached)(
    (deps.command ?? defaultAutomationCommand)(current),
    current.logPath,
  );
  const stamp = now().toISOString();
  if (pid === undefined) {
    await store.writeRun({
      ...current,
      status: 'failed',
      result: { outcome: 'failed', summary: 'The host process could not be started.' },
      updatedAt: stamp,
    });
    throw new Error(`Automation Run ${record.id}: the host process could not be started`);
  }
  // Merge into the fresh file: the host process may already have written its own fields.
  const fresh = (await store.getRun(record.automationId, record.id)) ?? current;
  await store.writeRun({
    ...fresh,
    status: fresh.status === 'queued' ? 'running' : fresh.status,
    pid,
    updatedAt: stamp,
  });
};
