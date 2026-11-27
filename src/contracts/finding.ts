import { z } from 'zod';

/**
 * What `fractory doctor` reports (Spec 0006): one observation about one configured repository,
 * with the remedy the owner could apply. Findings are data; rendering is a separate function over
 * the array, so the human output and `--json` cannot disagree. A new kind is one enum entry.
 */
export const FindingKindSchema = z.enum([
  /** The Ticket's latest Run stopped `needs-human` and carries a question for the owner. */
  'needs-human',
  /** The Ticket's latest Run `failed`, or stopped `needs-human` because its budget ran out. */
  'run-failed',
  /** The repository could not be read: its directory or `.fractory.json` is missing or invalid. */
  'unreachable',
  /** The Ticket's latest Run is done and its pull request is still open, not merged. */
  'pr-unmerged',
  /** A Ready Ticket free to start has no Run and no pull request. */
  'ready-not-started',
  /** The last tick Held a Ticket on its blockers, and every one of them is now satisfied. */
  'held-unblocked',
  /** A Run's worktree is still on disk more than `staleWorktreeDays` after the Run ended. */
  'stale-worktree',
  /** The queue is Held over Host Limits; the Finding carries the reading that holds it. */
  'host-held',
  /** `fractory rebuild` would compile a dirty checkout, or one behind `origin/<baseBranch>`. */
  'rebuild-stale',
  /** The launchd agent is not loaded: no tick is running at all. */
  'launchd-not-loaded',
]);
export type FindingKind = z.infer<typeof FindingKindSchema>;

/** Two values only: a third would invite argument about the middle. */
export const FindingSeveritySchema = z.enum(['needs-owner', 'informational']);
export type FindingSeverity = z.infer<typeof FindingSeveritySchema>;

export const FindingSchema = z.object({
  kind: FindingKindSchema,
  /**
   * The repository the Finding concerns. A Finding about the whole machine (`host-held`,
   * `launchd-not-loaded`) names the factory home, `~/.fractory`, instead.
   */
  repoPath: z.string().min(1),
  severity: FindingSeveritySchema,
  /** What was observed, as a sentence. */
  observed: z.string().min(1),
  /** The command or step that would resolve it, as text. Doctor itself never applies it. */
  remedy: z.string().min(1),
});
export type Finding = z.infer<typeof FindingSchema>;
