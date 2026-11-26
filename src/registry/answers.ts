import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ANSWER_SUFFIX,
  type AnswerRequest,
  AnswerRequestSchema,
  answerRequestPath,
} from '../contracts/run.ts';

/**
 * Run ids with a valid answer request file in the registry dir, sorted. The files belong to
 * Fractory Manager: they are only read, never modified or deleted. An invalid or half-written
 * file is skipped.
 */
export const listAnswerRequests = async (registryDir: string): Promise<string[]> => {
  let names: string[];
  try {
    names = await readdir(registryDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const ids = await Promise.all(
    names
      .filter((name) => name.endsWith(ANSWER_SUFFIX))
      .map(async (name) => {
        const runId = name.slice(0, -ANSWER_SUFFIX.length);
        return (await readAnswerRequest(registryDir, runId)) ? runId : undefined;
      }),
  );
  return ids.filter((id): id is string => id !== undefined).sort();
};

/** The answer request for Run `runId`, or `undefined` when it is absent, unreadable or invalid. */
export const readAnswerRequest = async (
  registryDir: string,
  runId: string,
): Promise<AnswerRequest | undefined> => {
  try {
    return AnswerRequestSchema.parse(
      JSON.parse(await readFile(answerRequestPath(registryDir, runId), 'utf8')),
    );
  } catch {
    return undefined;
  }
};
