import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

/** Machine-level config at `~/.fractory/config.json` (not committed anywhere). */
export const FACTORY_HOME = process.env.FRACTORY_HOME ?? join(homedir(), '.fractory');

/**
 * Host limits checked before each Run starts. Off when absent; `{}` turns them on with defaults.
 * Runs wait in the queue while the host is over a limit.
 */
export const ResourceLimitsSchema = z.object({
  /** Hold new Runs while the 1-minute load average per core is above this. */
  maxLoadPerCore: z.number().positive().default(0.75),
  /** Hold new Runs while the memory available to new work is below this percentage. */
  minMemoryAvailablePercent: z.number().min(0).max(100).default(25),
  /** Runs started per tick, so each one shows up in the readings before the next starts. */
  maxLaunchesPerTick: z.number().int().positive().default(1),
});
export type ResourceLimits = z.infer<typeof ResourceLimitsSchema>;

export const FactoryConfigSchema = z.object({
  /** Absolute paths of the repositories the factory works on; each has a `.fractory.json`. */
  repos: z.array(z.string()).default([]),
  maxConcurrentRuns: z.number().int().positive().default(3),
  /** Worktrees of failed or abandoned Runs older than this are deleted. */
  staleWorktreeDays: z.number().int().positive().default(7),
  registryDir: z.string().default(join(FACTORY_HOME, 'runs')),
  logDir: z.string().default(join(FACTORY_HOME, 'logs')),
  resources: ResourceLimitsSchema.optional(),
});
export type FactoryConfig = z.infer<typeof FactoryConfigSchema>;
