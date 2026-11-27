import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import type { RunRecord } from '../contracts/run.ts';

/**
 * What Runs cost, in tokens (Spec 0006). Joins the Run registry to the agent CLI's transcripts
 * by `sessionId`. No currency: a price table per model is a maintained list an upstream release
 * can change.
 */

export interface TokenUsage {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
}

/** Why a Run has no token count. Never estimated: it is listed and counted instead. */
export type UnmeasuredReason =
  | 'no-session'
  | 'no-transcript'
  | 'agent-keeps-no-transcript'
  | 'transcript-unreadable';

export interface RunTokens {
  runId: string;
  ticketRef: string;
  repoPath: string;
  /** UTC day the Run was created, `YYYY-MM-DD`. */
  day: string;
  createdAt: string;
  status: RunRecord['status'];
  sessionId?: string;
  /** Present when measured. */
  usage?: TokenUsage;
  /** Present when unmeasured. */
  unmeasured?: UnmeasuredReason;
}

export interface TokenRollup {
  /** Repository path or day, depending on the rollup. */
  key: string;
  runs: number;
  measured: number;
  unmeasured: number;
  usage: TokenUsage;
}

export interface TokenReport {
  since?: string;
  repoPath?: string;
  runs: RunTokens[];
  perRepo: TokenRollup[];
  perDay: TokenRollup[];
  total: Omit<TokenRollup, 'key'>;
}

/** Where transcripts are read from. Injected so tests never touch `~/.claude`. */
export interface TranscriptStore {
  /** Every transcript found, by session id. A missing projects directory yields an empty map. */
  index(): Promise<Map<string, string>>;
  /** The transcript's lines, streamed. */
  lines(path: string): AsyncIterable<string>;
}

const JSONL = '.jsonl';

/**
 * Transcripts under `<projectsDir>/*\/<sessionId>.jsonl`. The search is the join: a Run's working
 * directory is a worktree, so its project slug is not derivable from the repository.
 */
export const fileTranscriptStore = (projectsDir: string): TranscriptStore => ({
  async index() {
    const found = new Map<string, string>();
    let projects: string[];
    try {
      projects = (await readdir(projectsDir)).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return found;
      throw error;
    }
    for (const project of projects) {
      let names: string[];
      try {
        names = await readdir(join(projectsDir, project));
      } catch {
        // Not a directory, or unreadable: it holds no transcript we can join.
        continue;
      }
      for (const name of names.sort()) {
        if (!name.endsWith(JSONL)) continue;
        const sessionId = name.slice(0, -JSONL.length);
        if (!found.has(sessionId)) found.set(sessionId, join(projectsDir, project, name));
      }
    }
    return found;
  },
  lines(path) {
    return createInterface({
      input: createReadStream(path, 'utf8'),
      crlfDelay: Number.POSITIVE_INFINITY,
    });
  },
});

const count = z.number().int().nonnegative().optional().catch(undefined);

/** Only what the sum needs; everything else on a line is discarded. */
const UsageLineSchema = z.object({
  message: z.object({
    id: z.string().optional().catch(undefined),
    usage: z.object({
      input_tokens: count,
      output_tokens: count,
      cache_creation_input_tokens: count,
      cache_read_input_tokens: count,
    }),
  }),
});

const zero = (): TokenUsage => ({ input: 0, output: 0, cacheCreation: 0, cacheRead: 0 });

const add = (a: TokenUsage, b: TokenUsage): TokenUsage => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cacheCreation: a.cacheCreation + b.cacheCreation,
  cacheRead: a.cacheRead + b.cacheRead,
});

export const totalTokens = (u: TokenUsage): number =>
  u.input + u.output + u.cacheCreation + u.cacheRead;

/**
 * Sums `message.usage` over a transcript. A malformed line is skipped: the file belongs to
 * another program. The agent CLI writes one line per content block of a message, each repeating
 * that message's usage, so usage is counted once per `message.id` (the last line seen wins).
 */
export const sumTranscript = async (lines: AsyncIterable<string>): Promise<TokenUsage> => {
  const byMessage = new Map<string, TokenUsage>();
  let anonymous = zero();
  for await (const line of lines) {
    if (!line.includes('"usage"')) continue;
    let parsed: z.infer<typeof UsageLineSchema>;
    try {
      const result = UsageLineSchema.safeParse(JSON.parse(line));
      if (!result.success) continue;
      parsed = result.data;
    } catch {
      continue;
    }
    const { usage, id } = parsed.message;
    const u: TokenUsage = {
      input: usage.input_tokens ?? 0,
      output: usage.output_tokens ?? 0,
      cacheCreation: usage.cache_creation_input_tokens ?? 0,
      cacheRead: usage.cache_read_input_tokens ?? 0,
    };
    if (id) byMessage.set(id, u);
    else anonymous = add(anonymous, u);
  }
  return [...byMessage.values()].reduce(add, anonymous);
};

/** A Run whose agents are known and include no Claude ran on an agent that keeps no transcript. */
const keepsTranscript = (run: RunRecord): boolean =>
  run.agents === undefined ||
  run.agents.length === 0 ||
  run.agents.some((a) => a.startsWith('claude@') || a === 'claude');

const rollup = (runs: RunTokens[], keyOf: (r: RunTokens) => string): TokenRollup[] => {
  const groups = new Map<string, TokenRollup>();
  for (const run of runs) {
    const key = keyOf(run);
    const group = groups.get(key) ?? { key, runs: 0, measured: 0, unmeasured: 0, usage: zero() };
    group.runs += 1;
    if (run.usage) {
      group.measured += 1;
      group.usage = add(group.usage, run.usage);
    } else {
      group.unmeasured += 1;
    }
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => a.key.localeCompare(b.key));
};

/** Parses `--since`: a date or datetime. Refuses anything `Date` cannot read. */
export const parseSince = (value: string): Date => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`--since "${value}" is not a date (use YYYY-MM-DD or an ISO datetime)`);
  }
  return date;
};

export const tokenReport = async (input: {
  runs: RunRecord[];
  store: TranscriptStore;
  since?: Date;
  /** Absolute repository path; only its Runs are reported. */
  repoPath?: string;
}): Promise<TokenReport> => {
  const repoPath = input.repoPath ? resolve(input.repoPath) : undefined;
  const selected = input.runs
    .filter((r) => !input.since || new Date(r.createdAt) >= (input.since as Date))
    .filter((r) => !repoPath || resolve(r.repoPath) === repoPath)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));

  const index = selected.some((r) => r.sessionId) ? await input.store.index() : new Map();
  const runs: RunTokens[] = [];
  for (const run of selected) {
    const base: RunTokens = {
      runId: run.id,
      ticketRef: run.ticketRef,
      repoPath: resolve(run.repoPath),
      day: run.createdAt.slice(0, 10),
      createdAt: run.createdAt,
      status: run.status,
      ...(run.sessionId && { sessionId: run.sessionId }),
    };
    const path = run.sessionId ? index.get(run.sessionId) : undefined;
    if (!run.sessionId) {
      runs.push({
        ...base,
        unmeasured: keepsTranscript(run) ? 'no-session' : 'agent-keeps-no-transcript',
      });
    } else if (!path) {
      runs.push({
        ...base,
        unmeasured: keepsTranscript(run) ? 'no-transcript' : 'agent-keeps-no-transcript',
      });
    } else {
      try {
        runs.push({ ...base, usage: await sumTranscript(input.store.lines(path)) });
      } catch {
        // A failed read proves nothing about the Run: report it unmeasured, never as zero.
        runs.push({ ...base, unmeasured: 'transcript-unreadable' });
      }
    }
  }

  const [total] = rollup(runs, () => 'total');
  return {
    ...(input.since && { since: input.since.toISOString() }),
    ...(repoPath && { repoPath }),
    runs,
    perRepo: rollup(runs, (r) => r.repoPath),
    perDay: rollup(runs, (r) => r.day),
    total: total
      ? {
          runs: total.runs,
          measured: total.measured,
          unmeasured: total.unmeasured,
          usage: total.usage,
        }
      : { runs: 0, measured: 0, unmeasured: 0, usage: zero() },
  };
};

const table = (rows: string[][]): string => {
  const widths = rows[0]?.map((_, c) => Math.max(...rows.map((r) => (r[c] ?? '').length))) ?? [];
  return rows
    .map((r) =>
      r
        .map((cell, c) => (c === 0 ? cell.padEnd(widths[c] ?? 0) : cell.padStart(widths[c] ?? 0)))
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
};

const n = (value: number): string => value.toLocaleString('en-US');

const usageCells = (u: TokenUsage): string[] => [
  n(u.input),
  n(u.output),
  n(u.cacheCreation),
  n(u.cacheRead),
  n(totalTokens(u)),
];

const USAGE_HEADER = ['INPUT', 'OUTPUT', 'CACHE-WRITE', 'CACHE-READ', 'TOTAL'];

const rollupTable = (title: string, rollups: TokenRollup[]): string =>
  `${title}\n${table([
    ['', 'RUNS', 'UNMEASURED', ...USAGE_HEADER],
    ...rollups.map((r) => [r.key, String(r.runs), String(r.unmeasured), ...usageCells(r.usage)]),
  ])}`;

export const formatTotal = (total: TokenReport['total']): string => {
  const line = `Total: ${n(totalTokens(total.usage))} tokens over ${total.measured} measured Run${total.measured === 1 ? '' : 's'} (input ${n(total.usage.input)}, output ${n(total.usage.output)}, cache-write ${n(total.usage.cacheCreation)}, cache-read ${n(total.usage.cacheRead)})`;
  return total.unmeasured === 0
    ? `${line}; 0 Runs unmeasured`
    : `${line}; ${total.unmeasured} Run${total.unmeasured === 1 ? '' : 's'} unmeasured`;
};

export const formatTokenReport = (report: TokenReport): string => {
  if (report.runs.length === 0) return `No Runs.\n${formatTotal(report.total)}`;
  const runs = table([
    ['RUN', 'DAY', 'TICKET', ...USAGE_HEADER],
    ...report.runs.map((r) => [
      r.runId,
      r.day,
      r.ticketRef,
      ...(r.usage ? usageCells(r.usage) : ['-', '-', '-', '-', `unmeasured (${r.unmeasured})`]),
    ]),
  ]);
  return [
    runs,
    rollupTable('Per repository', report.perRepo),
    rollupTable('Per day', report.perDay),
    formatTotal(report.total),
  ].join('\n\n');
};
