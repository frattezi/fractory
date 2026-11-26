import { join } from 'node:path';
import { z } from 'zod';
import { ModeSchema } from './repo-config.ts';
import { TicketRefSchema } from './ticket.ts';

/**
 * The Run registry is the public contract between Fractory (writer) and the
 * Agent Manager fork (reader): one JSON file per Run at `<registryDir>/<id>.json`.
 * Bump RUN_RECORD_VERSION on any breaking change (see ADR 0002).
 */
export const RUN_RECORD_VERSION = 1;

export const TriggerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ticket-ready') }),
  z.object({ kind: z.literal('ci-failed'), prNumber: z.number().int(), headSha: z.string() }),
  z.object({
    kind: z.literal('review-comment'),
    prNumber: z.number().int(),
    commentId: z.string(),
  }),
  z.object({ kind: z.literal('manual') }),
  /** The owner answered the `needs-human` question of Run `runId` (Spec 0005). */
  z.object({ kind: z.literal('answer'), runId: z.string().min(1) }),
]);
export type Trigger = z.infer<typeof TriggerSchema>;

export const NeedsHumanReasonSchema = z.enum([
  'ambiguous-spec',
  'needs-access',
  'destructive-op',
  'budget-exhausted',
]);
export type NeedsHumanReason = z.infer<typeof NeedsHumanReasonSchema>;

/** What the agent must return at the end of a Run (validated as Sandcastle structured output). */
export const RunResultSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('done'), summary: z.string() }),
  z.object({ outcome: z.literal('failed'), summary: z.string() }),
  z.object({
    outcome: z.literal('needs-human'),
    reason: NeedsHumanReasonSchema,
    question: z.string().min(1),
  }),
]);
export type RunResult = z.infer<typeof RunResultSchema>;

export const RunStatusSchema = z.enum(['queued', 'running', 'done', 'failed', 'needs-human']);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const RunRecordSchema = z.object({
  version: z.literal(RUN_RECORD_VERSION),
  id: z.string(),
  /** Idempotency key: the Trigger script never starts two Runs with the same key. */
  key: z.string(),
  ticketRef: TicketRefSchema,
  repoPath: z.string(),
  trigger: TriggerSchema,
  status: RunStatusSchema,
  branch: z.string(),
  /**
   * Branch the Run is built on: its worktree is created from it, its PR targets it and its
   * pre-push hook refuses it. Absent means the repository's base branch. Optional: still version 1.
   */
  baseBranch: z.string().min(1).optional(),
  /** Tip sha of `baseBranch` the Run started from. Optional: still version 1. */
  baseSha: z.string().min(1).optional(),
  worktreePath: z.string().optional(),
  prUrl: z.string().url().optional(),
  /** Agent conversation id captured by Sandcastle, for resume/fork. */
  sessionId: z.string().optional(),
  logPath: z.string(),
  /** Snapshot of the repo's Mode and flow when the Run was queued, so readers need no config. */
  mode: ModeSchema.optional(),
  flow: z.string().optional(),
  /** Agent profiles the flow used, as `kind@account` labels (e.g. `claude@personal`). */
  agents: z.array(z.string()).optional(),
  /** Host process running the Run, to detect dead Runs. */
  pid: z.number().int().optional(),
  result: RunResultSchema.optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  finishedAt: z.string().datetime().optional(),
  /** Last PR state `tick` read; MERGED/CLOSED PRs are never read again. Optional: still version 1. */
  prState: z.enum(['OPEN', 'MERGED', 'CLOSED']).optional(),
  /** When cleanup removed the worktree; cleanup skips Runs that have it. Optional: still version 1. */
  cleanedAt: z.string().datetime().optional(),
});
export type RunRecord = z.infer<typeof RunRecordSchema>;

/** The branch a Run is built on: its own base, or the repository's when it names none. */
export const runBaseBranch = (
  record: Pick<RunRecord, 'baseBranch'>,
  repoBaseBranch: string,
): string => record.baseBranch ?? repoBaseBranch;

export const ACTIVE_STATUSES: readonly RunStatus[] = ['queued', 'running'];

export const runKey = (ticketRef: string, trigger: Trigger): string => {
  switch (trigger.kind) {
    case 'ticket-ready':
      return `${ticketRef}:ticket-ready`;
    case 'ci-failed':
      return `${ticketRef}:ci-failed:${trigger.headSha}`;
    case 'review-comment':
      return `${ticketRef}:review-comment:${trigger.commentId}`;
    case 'manual':
      return `${ticketRef}:manual:${Date.now()}`;
    case 'answer':
      return answerKey(ticketRef, trigger.runId);
  }
};

/**
 * Review comments written by the Agent Manager fork at `<registryDir>/<runId>.comments.json`
 * (atomic write). Fractory only reads this file; Agent Manager owns it. Consumption is derived
 * from existing Run keys (`am:<comment id>`), so the file is never rewritten.
 */
export const RUN_COMMENTS_VERSION = 1;

export const RunCommentSchema = z.object({
  id: z.string().min(1),
  path: z.string(),
  line: z.number().int(),
  body: z.string(),
  createdAt: z.string().datetime(),
});
export type RunComment = z.infer<typeof RunCommentSchema>;

export const RunCommentsFileSchema = z.object({
  version: z.literal(RUN_COMMENTS_VERSION),
  comments: z.array(RunCommentSchema),
});
export type RunCommentsFile = z.infer<typeof RunCommentsFileSchema>;

/**
 * Re-run requests written by Fractory Manager at `<registryDir>/<runId>.rerun.json` (atomic
 * write). Fractory only reads them and never modifies or deletes one. The Run a request creates
 * has key `<ticketRef>:rerun:<runId>`, so one request yields one Run.
 */
export const RERUN_REQUEST_VERSION = 1;

export const RerunRequestSchema = z.object({
  version: z.literal(RERUN_REQUEST_VERSION),
  requestedAt: z.string().datetime(),
});
export type RerunRequest = z.infer<typeof RerunRequestSchema>;

export const RERUN_SUFFIX = '.rerun.json';

export const rerunRequestPath = (registryDir: string, runId: string): string =>
  join(registryDir, `${runId}${RERUN_SUFFIX}`);

export const rerunKey = (ticketRef: string, runId: string): string => `${ticketRef}:rerun:${runId}`;

/**
 * Answer requests written by Fractory Manager at `<registryDir>/<runId>.answer.json` (atomic
 * write): the owner's answer to the `needs-human` question of Run `runId`. Fractory only reads
 * them and never modifies or deletes one. The Run an answer creates has key
 * `<ticketRef>:answer:<runId>`, so one answer yields one Run.
 */
export const ANSWER_REQUEST_VERSION = 1;

export const AnswerRequestSchema = z.object({
  version: z.literal(ANSWER_REQUEST_VERSION),
  answeredAt: z.string().datetime(),
  answer: z.string().min(1),
});
export type AnswerRequest = z.infer<typeof AnswerRequestSchema>;

export const ANSWER_SUFFIX = '.answer.json';

export const answerRequestPath = (registryDir: string, runId: string): string =>
  join(registryDir, `${runId}${ANSWER_SUFFIX}`);

export const answerKey = (ticketRef: string, runId: string): string =>
  `${ticketRef}:answer:${runId}`;

export const commentsFilePath = (registryDir: string, runId: string): string =>
  join(registryDir, `${runId}.comments.json`);

/** `commentId` prefix marking a review-comment Trigger that came from Agent Manager. */
export const AM_COMMENT_PREFIX = 'am:';
