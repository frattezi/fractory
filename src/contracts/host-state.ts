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
  /**
   * Held Tickets: Ready Tickets the tick did not queue because of their blockers. Each names its
   * repository and the blockers holding it (refs, or the relation as written when it is not a
   * ref); `holds` says why each blocker holds it. Optional: still version 1.
   */
  heldTickets: z
    .array(
      z.object({
        repoPath: z.string(),
        ticketRef: z.string(),
        blockers: z.array(z.string()).min(1),
        holds: z
          .array(z.object({ blocker: z.string(), reason: z.string().min(1) }))
          .min(1)
          .optional(),
      }),
    )
    .optional(),
  /** Runs still waiting to start when the tick ended. */
  queued: z.number().int().min(0),
  updatedAt: z.string().datetime(),
});
export type HostState = z.infer<typeof HostStateSchema>;
