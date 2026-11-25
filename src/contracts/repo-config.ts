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
});
export type RepoConfig = z.infer<typeof RepoConfigSchema>;

/** Work Mode always reviews code; Personal Mode does only when there are no checks to trust. */
export const requiresPrGate = (config: RepoConfig): boolean =>
  config.mode === 'work' || !config.hasCi;

export const requiresTicketGate = (config: RepoConfig): boolean =>
  config.mode === 'work' || config.ticketGate;
