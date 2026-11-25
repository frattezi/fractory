import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

/** Machine-level config at `~/.fractory/config.json` (not committed anywhere). */
export const FACTORY_HOME = process.env.FRACTORY_HOME ?? join(homedir(), '.fractory');

export const FactoryConfigSchema = z.object({
  /** Absolute paths of the repositories the factory works on; each has a `.fractory.json`. */
  repos: z.array(z.string()).default([]),
  maxConcurrentRuns: z.number().int().positive().default(3),
  /** Worktrees of failed or abandoned Runs older than this are deleted. */
  staleWorktreeDays: z.number().int().positive().default(7),
  registryDir: z.string().default(join(FACTORY_HOME, 'runs')),
  logDir: z.string().default(join(FACTORY_HOME, 'logs')),
});
export type FactoryConfig = z.infer<typeof FactoryConfigSchema>;
