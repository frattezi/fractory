import { z } from 'zod';

/**
 * Host state written by every tick to `FactoryConfig.hostStatePath` (`<FACTORY_HOME>/host.json`,
 * atomic write); Fractory Manager and `fractory status` read it. Bump HOST_STATE_VERSION on any
 * breaking change. Readings are taken only on ticks with a queued Run; `held` is false whenever
 * nothing is queued.
 */
export const HOST_STATE_VERSION = 1;

export const HostStateSchema = z.object({
  version: z.literal(HOST_STATE_VERSION),
  held: z.boolean(),
  /** Why the queue is Held, e.g. "Docker memory 0.8 GB free < 1 GB". */
  reason: z.string().optional(),
  /** When the current hold began. */
  heldSince: z.string().datetime().optional(),
  readings: z
    .object({
      loadPerCore: z.number().optional(),
      hostMemoryFreeGb: z.number().optional(),
      dockerMemoryFreeGb: z.number().optional(),
      dockerReachable: z.boolean(),
      checkedAt: z.string().datetime(),
    })
    .optional(),
  /** Runs waiting to start when the tick read the host. */
  queued: z.number().int().min(0),
  updatedAt: z.string().datetime(),
});
export type HostState = z.infer<typeof HostStateSchema>;
