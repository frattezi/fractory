import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { FactoryConfigSchema } from '../contracts/factory-config.ts';
import type { RepoConfig } from '../contracts/repo-config.ts';
import type { RunRecord } from '../contracts/run.ts';
import { RunRegistry } from '../registry/registry.ts';
import { FRACTORY_ROOT } from './exec.ts';

export { executeRun, type ExecuteDeps } from './execute.ts';

export interface SpawnCommand {
  command: string;
  args: string[];
  cwd: string;
}

export interface LaunchDeps {
  registry?: RunRegistry;
  /** The host command that runs the Run. Default: node + tsx + `src/cli.ts run-exec <id>`. */
  command?: (record: RunRecord) => SpawnCommand;
  /** Starts the command detached with output appended to `logPath`; returns the pid. */
  spawnDetached?: (command: SpawnCommand, logPath: string) => number | undefined;
}

export const defaultCommand = (record: RunRecord): SpawnCommand => ({
  command: process.execPath,
  args: ['--import', 'tsx', join(FRACTORY_ROOT, 'src/cli.ts'), 'run-exec', record.id],
  cwd: FRACTORY_ROOT,
});

const defaultSpawnDetached = (command: SpawnCommand, logPath: string): number | undefined => {
  mkdirSync(dirname(logPath), { recursive: true });
  const fd = openSync(logPath, 'a');
  try {
    const child = spawn(command.command, command.args, {
      cwd: command.cwd,
      detached: true,
      stdio: ['ignore', fd, fd],
    });
    child.on('error', () => {}); // a failed spawn shows up as a missing pid
    child.unref();
    return child.pid;
  } finally {
    closeSync(fd);
  }
};

/**
 * Starts a queued Run as a detached host process and returns once it is running.
 * The attempt (pid + `running`) is recorded before returning: a crash must never leave a Run
 * that looks unstarted, or the Trigger would relaunch it forever.
 */
export const launchRun = async (
  record: RunRecord,
  _config: RepoConfig,
  deps: LaunchDeps = {},
): Promise<void> => {
  const registry = deps.registry ?? new RunRegistry(FactoryConfigSchema.parse({}).registryDir);
  const current = (await registry.get(record.id)) ?? record;
  if (current.status !== 'queued') {
    throw new Error(`Run ${record.id} is ${current.status}, only a queued Run can be launched`);
  }

  const pid = (deps.spawnDetached ?? defaultSpawnDetached)(
    (deps.command ?? defaultCommand)(current),
    current.logPath,
  );
  if (pid === undefined) {
    await registry.write({
      ...current,
      status: 'failed',
      result: { outcome: 'failed', summary: 'The host process could not be started.' },
      updatedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    });
    throw new Error(`Run ${record.id}: the host process could not be started`);
  }
  const started = { status: 'running' as const, pid };
  // Merge into the fresh file: the host process may already have written its own fields.
  if (await registry.get(record.id)) await registry.update(record.id, started);
  else await registry.write({ ...current, ...started, updatedAt: new Date().toISOString() });
};
