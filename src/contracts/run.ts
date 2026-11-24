import { join } from 'node:path';
import { z } from 'zod';
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
  worktreePath: z.string().optional(),
  prUrl: z.string().url().optional(),
  /** Agent conversation id captured by Sandcastle, for resume/fork. */
  sessionId: z.string().optional(),
  logPath: z.string(),
  /** Host process running the Run, to detect dead Runs. */
  pid: z.number().int().optional(),
  result: RunResultSchema.optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  finishedAt: z.string().datetime().optional(),
});
export type RunRecord = z.infer<typeof RunRecordSchema>;

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

export const commentsFilePath = (registryDir: string, runId: string): string =>
  join(registryDir, `${runId}.comments.json`);

/** `commentId` prefix marking a review-comment Trigger that came from Agent Manager. */
export const AM_COMMENT_PREFIX = 'am:';
