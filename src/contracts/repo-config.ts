import { z } from 'zod';

/** Committed at `<repo>/.fractory.json`. The Mode belongs to the repository, never to a session. */
export const REPO_CONFIG_FILE = '.fractory.json';

export const ModeSchema = z.enum(['work', 'personal']);
export type Mode = z.infer<typeof ModeSchema>;

export const TicketSourceConfigSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('github'),
    /** `owner/name` */
    repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  }),
  z.object({
    kind: z.literal('jira'),
    /** e.g. `https://acme.atlassian.net` */
    baseUrl: z.string().url(),
    projectKey: z.string().min(1),
    /** Jira status names mapped to Fractory Ticket statuses. */
    statuses: z.object({
      ready: z.string(),
      inProgress: z.string(),
      inReview: z.string(),
      done: z.string(),
    }),
  }),
]);
export type TicketSourceConfig = z.infer<typeof TicketSourceConfigSchema>;

/**
 * Seconds a Run's agent may print nothing before Sandcastle stops it. Long enough for a quiet test
 * suite, a `-race` run or a container build to finish; Sandcastle's own 600 is not.
 */
export const DEFAULT_IDLE_TIMEOUT_SECONDS = 1800;
/** A day: anything longer is a hung Run, not a slow suite. */
export const MAX_IDLE_TIMEOUT_SECONDS = 86_400;

export const RepoConfigSchema = z.object({
  mode: ModeSchema,
  ticketSource: TicketSourceConfigSchema,
  /** Whether the repository has automated checks on pull requests. */
  hasCi: z.boolean(),
  /** Personal Mode only: opt into the Ticket Gate. Ignored in Work Mode, where it is always on. */
  ticketGate: z.boolean().default(false),
  baseBranch: z.string().default('main'),
  /** Docker image the Run's sandbox uses. */
  sandboxImage: z.string().optional(),
  /** Agent iterations before a Run stops with `budget-exhausted`. */
  maxIterations: z.number().int().positive().default(10),
  /**
   * Seconds the agent may be silent (no output at all, e.g. while it waits on the test suite)
   * before the Run is stopped for silence. Passed to Sandcastle as `idleTimeoutSeconds`.
   */
  idleTimeoutSeconds: z
    .number()
    .int()
    .positive()
    .max(MAX_IDLE_TIMEOUT_SECONDS)
    .default(DEFAULT_IDLE_TIMEOUT_SECONDS),
  /** The flow a Run executes: a file `flows/<flow>.ts` in Fractory. */
  flow: z
    .string()
    .regex(/^[a-z][a-z0-9-]*$/)
    .default('build'),
  /** `fractory rebuild`: shell commands run in order from the repo root. Absent means none. */
  rebuild: z.array(z.string().min(1)).optional(),
});
export type RepoConfig = z.infer<typeof RepoConfigSchema>;

/**
 * Work Mode always reviews code. Personal Mode never does: the owner decided merges are not a
 * Gate for personal projects, with or without CI (ADR 0005).
 */
export const requiresPrGate = (config: RepoConfig): boolean => config.mode === 'work';

export const requiresTicketGate = (config: RepoConfig): boolean =>
  config.mode === 'work' || config.ticketGate;
