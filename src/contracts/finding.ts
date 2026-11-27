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
]);
export type FindingKind = z.infer<typeof FindingKindSchema>;

/** Two values only: a third would invite argument about the middle. */
export const FindingSeveritySchema = z.enum(['needs-owner', 'informational']);
export type FindingSeverity = z.infer<typeof FindingSeveritySchema>;

export const FindingSchema = z.object({
  kind: FindingKindSchema,
  repoPath: z.string().min(1),
  severity: FindingSeveritySchema,
  /** What was observed, as a sentence. */
  observed: z.string().min(1),
  /** The command or step that would resolve it, as text. Doctor itself never applies it. */
  remedy: z.string().min(1),
});
export type Finding = z.infer<typeof FindingSchema>;
