import { execFile } from 'node:child_process';
import type { Mode } from '../contracts/repo-config.ts';
import type { TicketRef } from '../contracts/ticket.ts';

/** Runs a command without a shell and resolves with stdout. Rejects with stderr in the message. */
export type ExecFn = (cmd: string, args: string[]) => Promise<string>;
export type FetchFn = typeof fetch;
export type SleepFn = (ms: number) => Promise<void>;

export interface AdapterOptions {
  /** The repository's Mode. Required for Jira; GitHub falls back to 'personal'. */
  mode?: Mode;
  exec?: ExecFn;
  fetch?: FetchFn;
  sleep?: SleepFn;
  /** Where Jira credentials are read from. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Jira issue type used by `createTicket`. Defaults to `Task`. */
  jiraIssueType?: string;
}

export const MAX_ATTEMPTS = 4;
const BASE_DELAY_MS = 500;

export const defaultExec: ExecFn = (cmd, args) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(
          new Error(`${cmd} ${args.slice(0, 3).join(' ')} failed: ${stderr || error.message}`),
        );
        return;
      }
      resolve(stdout);
    });
  });

export const defaultSleep: SleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class RetryableError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

/** Exponential backoff (500ms, 1s, 2s) for errors flagged retryable; everything else throws at once. */
export const withRetry = async <T>(
  sleep: SleepFn,
  isRetryable: (error: unknown) => RetryableError | undefined,
  fn: () => Promise<T>,
): Promise<T> => {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const retryable = isRetryable(error);
      if (!retryable || attempt >= MAX_ATTEMPTS) throw error;
      await sleep(retryable.retryAfterMs ?? BASE_DELAY_MS * 2 ** (attempt - 1));
    }
  }
};

export interface NewTicket {
  title: string;
  body: string;
  /** `ready` makes the next tick pick the Ticket up. */
  status: 'backlog' | 'ready';
  blockedBy?: TicketRef[] | undefined;
  parent?: TicketRef | undefined;
}

/** What `createTicket` returns: enough for the caller to reference the Ticket. */
export interface CreatedTicket {
  ref: TicketRef;
  url: string;
}

/** Relations are rendered as plain lines at the end of the body, readable in any tracker. */
export const bodyWithRelations = (input: NewTicket, label: (ref: TicketRef) => string): string => {
  const lines = [
    ...(input.parent ? [`Parent: ${label(input.parent)}`] : []),
    ...(input.blockedBy ?? []).map((ref) => `Blocked by ${label(ref)}`),
  ];
  return lines.length > 0 ? `${input.body.trimEnd()}\n\n${lines.join('\n')}` : input.body;
};
