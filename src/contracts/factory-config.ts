import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

/** Machine-level config at `~/.fractory/config.json` (not committed anywhere). */
export const FACTORY_HOME = process.env.FRACTORY_HOME ?? join(homedir(), '.fractory');

/**
 * Host limits checked before each Run starts (Spec 0002). On by default; `resources: false`
 * turns them off. Runs wait in the queue while the host is over a limit.
 */
export const ResourceLimitsSchema = z.object({
  /** Hold new Runs while the 1-minute load average per core is above this. */
  maxLoadPerCore: z.number().positive().default(0.75),
  /** Hold new Runs while the computer has less free memory than this, in GB. */
  minHostMemoryFreeGb: z.number().min(0).default(2),
  /** Hold new Runs while the Docker VM has less free memory than this, in GB. */
  minDockerMemoryFreeGb: z.number().min(0).default(1),
  /** Runs started per tick, so each one shows up in the readings before the next starts. */
  maxLaunchesPerTick: z.number().int().positive().default(1),
  /** CPUs each Run's container may use (`docker run --cpus`). */
  cpusPerRun: z.number().positive().default(4),
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
  /** `false` turns Host Limits off; absent or partial means defaults. */
  resources: z
    .union([z.literal(false), ResourceLimitsSchema])
    .default(() => ResourceLimitsSchema.parse({})),
  /** Host state written by every tick, read by Fractory Manager and `fractory status`. */
  hostStatePath: z.string().default(join(FACTORY_HOME, 'host.json')),
  /**
   * Automation state (Spec 0003): Fractory Manager drops requests in `requests/`; Fractory writes
   * each Automation Run's record, log and output under `<automationId>/`, and refused requests
   * under `refused/`.
   */
  automationsDir: z.string().default(join(FACTORY_HOME, 'automations')),
});
export type FactoryConfig = z.infer<typeof FactoryConfigSchema>;
