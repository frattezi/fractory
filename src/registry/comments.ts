import { readFile } from 'node:fs/promises';
import {
  AM_COMMENT_PREFIX,
  type RunComment,
  RunCommentsFileSchema,
  type RunRecord,
  commentsFilePath,
} from '../contracts/run.ts';

/**
 * Reads a Run's comments file. `undefined` = no file (nothing to do); a thrown error = unreadable
 * or invalid, which callers log and skip.
 */
export const readRunComments = async (
  registryDir: string,
  runId: string,
): Promise<RunComment[] | undefined> => {
  let raw: string;
  try {
    raw = await readFile(commentsFilePath(registryDir, runId), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const { comments } = RunCommentsFileSchema.parse(JSON.parse(raw));
  return [...comments].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
};

/** Agent Manager comment ids already handed to a Run of this Ticket, from the Runs' Triggers. */
export const consumedCommentIds = (runs: RunRecord[]): Set<string> => {
  const ids = new Set<string>();
  for (const run of runs) {
    const t = run.trigger;
    if (t.kind === 'review-comment' && t.commentId.startsWith(AM_COMMENT_PREFIX)) {
      ids.add(t.commentId.slice(AM_COMMENT_PREFIX.length));
    }
  }
  return ids;
};

/**
 * Comments not yet consumed. A Run that consumed comment N consumed everything up to N, so the
 * boundary is the newest consumed comment. With `upTo`, only Runs older than that comment count
 * and the result ends at it (what that Run was queued for).
 */
export const pendingComments = (
  comments: RunComment[],
  consumed: Set<string>,
  upTo?: string,
): RunComment[] => {
  const end = upTo === undefined ? comments.length - 1 : comments.findIndex((c) => c.id === upTo);
  if (end < 0) return [];
  let boundary = -1;
  comments.forEach((c, i) => {
    if (i < end + (upTo === undefined ? 1 : 0) && consumed.has(c.id)) boundary = i;
  });
  return comments.slice(boundary + 1, end + 1);
};

export const formatAmComments = (comments: RunComment[]): string =>
  comments.map((c) => `File: ${c.path}:${c.line}\n${c.body}`).join('\n\n---\n\n');
