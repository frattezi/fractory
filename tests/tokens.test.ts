import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { main } from '../src/cli.ts';
import { type RunRecord, RunRecordSchema } from '../src/contracts/run.ts';
import { RunRegistry } from '../src/registry/registry.ts';
import {
  type TokenReport,
  type TranscriptStore,
  fileTranscriptStore,
  formatTokenReport,
  parseSince,
  sumTranscript,
  tokenReport,
} from '../src/tokens/tokens.ts';
import { makeRun } from './trigger-helpers.ts';

const fixture = (name: string): string => join(import.meta.dirname, 'fixtures', 'tokens', name);

const fixtureRun = async (): Promise<RunRecord> =>
  RunRecordSchema.parse(JSON.parse(await readFile(fixture('run-record.json'), 'utf8')));

/** The fixture transcript's usage, counted once per message id. */
const FIXTURE_USAGE = { input: 13, output: 100, cacheCreation: 2100, cacheRead: 2000 };

const linesOf = async function* (lines: string[]): AsyncIterable<string> {
  yield* lines;
};

const usageLine = (usage: Record<string, unknown>, id?: string): string =>
  JSON.stringify({ type: 'assistant', message: { ...(id && { id }), usage } });

/** `~/.claude/projects` with one transcript per entry, each in the project directory given. */
const projects = async (files: { project: string; sessionId: string; body: string }[]) => {
  const dir = await mkdtemp(join(tmpdir(), 'fractory-tokens-'));
  for (const f of files) {
    await mkdir(join(dir, f.project), { recursive: true });
    await writeFile(join(dir, f.project, `${f.sessionId}.jsonl`), f.body);
  }
  return dir;
};

describe('sumTranscript', () => {
  it('sums the four token fields and discards everything else', async () => {
    const usage = await sumTranscript(
      linesOf([
        usageLine({
          input_tokens: 1,
          output_tokens: 2,
          cache_creation_input_tokens: 3,
          cache_read_input_tokens: 4,
          service_tier: 'standard',
        }),
        usageLine({
          input_tokens: 10,
          output_tokens: 20,
          cache_creation_input_tokens: 30,
          cache_read_input_tokens: 40,
        }),
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
      ]),
    );
    expect(usage).toEqual({ input: 11, output: 22, cacheCreation: 33, cacheRead: 44 });
  });

  it('skips a malformed line instead of failing', async () => {
    const usage = await sumTranscript(
      linesOf([
        '{"message":{"usage":{"input_tokens":',
        'not json at all "usage"',
        usageLine({ input_tokens: 'many', output_tokens: 7 }),
        usageLine({ input_tokens: 5 }),
      ]),
    );
    expect(usage).toEqual({ input: 5, output: 7, cacheCreation: 0, cacheRead: 0 });
  });

  it('counts a message written over several lines once', async () => {
    const usage = await sumTranscript(
      linesOf([
        usageLine({ input_tokens: 10, output_tokens: 5 }, 'msg_1'),
        usageLine({ input_tokens: 10, output_tokens: 40 }, 'msg_1'),
        usageLine({ input_tokens: 1, output_tokens: 1 }, 'msg_2'),
      ]),
    );
    expect(usage).toEqual({ input: 11, output: 41, cacheCreation: 0, cacheRead: 0 });
  });

  it('reads the fixture transcript', async () => {
    const dir = await projects([]);
    const store = fileTranscriptStore(dir);
    expect(await sumTranscript(store.lines(fixture('transcript.jsonl')))).toEqual(FIXTURE_USAGE);
  });
});

describe('tokenReport', () => {
  it('joins a Run to its transcript whatever project directory holds it', async () => {
    const run = await fixtureRun();
    const dir = await projects([
      {
        project: '-home-me-Work-app',
        sessionId: 'someone-else',
        body: usageLine({ input_tokens: 999 }),
      },
      {
        // The worktree's slug, not the repository's.
        project: '-home-me--fractory-worktrees-app-139',
        sessionId: run.sessionId as string,
        body: await readFile(fixture('transcript.jsonl'), 'utf8'),
      },
    ]);
    const report = await tokenReport({ runs: [run], store: fileTranscriptStore(dir) });
    expect(report.runs).toEqual([
      expect.objectContaining({ runId: run.id, day: '2026-11-20', usage: FIXTURE_USAGE }),
    ]);
    expect(report.total).toEqual({ runs: 1, measured: 1, unmeasured: 0, usage: FIXTURE_USAGE });
  });

  it('reports a missing transcript as unmeasured and counts it in the total', async () => {
    const dir = await projects([
      { project: 'p', sessionId: 's1', body: usageLine({ input_tokens: 4 }) },
    ]);
    const report = await tokenReport({
      runs: [makeRun({ id: 'a', sessionId: 's1' }), makeRun({ id: 'b', sessionId: 'gone' })],
      store: fileTranscriptStore(dir),
    });
    expect(report.runs.find((r) => r.runId === 'b')).toEqual(
      expect.objectContaining({ unmeasured: 'no-transcript' }),
    );
    expect(report.runs.find((r) => r.runId === 'b')?.usage).toBeUndefined();
    expect(report.total).toEqual(expect.objectContaining({ runs: 2, measured: 1, unmeasured: 1 }));
    expect(formatTokenReport(report)).toContain('1 Run unmeasured');
    expect(formatTokenReport(report)).toContain('unmeasured (no-transcript)');
  });

  it('reports a Run with no sessionId as unmeasured', async () => {
    const report = await tokenReport({
      runs: [makeRun({ id: 'a' })],
      store: fileTranscriptStore(await projects([])),
    });
    expect(report.runs[0]?.unmeasured).toBe('no-session');
    expect(report.total.unmeasured).toBe(1);
  });

  it('reports a Run on an agent that keeps no transcript as unmeasured', async () => {
    const report = await tokenReport({
      runs: [makeRun({ id: 'a', sessionId: 'oc-1', agents: ['opencode@personal'] })],
      store: fileTranscriptStore(await projects([])),
    });
    expect(report.runs[0]?.unmeasured).toBe('agent-keeps-no-transcript');
    expect(report.total.unmeasured).toBe(1);
  });

  it('reports an unreadable transcript as unmeasured, never as zero', async () => {
    const store: TranscriptStore = {
      index: async () => new Map([['s1', '/x/s1.jsonl']]),
      lines: () => ({
        [Symbol.asyncIterator]: () => ({
          next: () => Promise.reject(new Error('EACCES')),
        }),
      }),
    };
    const report = await tokenReport({ runs: [makeRun({ sessionId: 's1' })], store });
    expect(report.runs[0]?.unmeasured).toBe('transcript-unreadable');
  });

  it('rolls Runs up per repository and per day', async () => {
    const dir = await projects([
      { project: 'p1', sessionId: 's1', body: usageLine({ input_tokens: 1 }) },
      { project: 'p2', sessionId: 's2', body: usageLine({ output_tokens: 2 }) },
      { project: 'p2', sessionId: 's3', body: usageLine({ cache_read_input_tokens: 4 }) },
    ]);
    const report = await tokenReport({
      runs: [
        makeRun({ id: 'a', sessionId: 's1', createdAt: '2026-11-01T09:00:00.000Z' }),
        makeRun({ id: 'b', sessionId: 's2', createdAt: '2026-11-01T23:00:00.000Z' }),
        makeRun({
          id: 'c',
          sessionId: 's3',
          repoPath: '/repo/lib',
          createdAt: '2026-11-02T01:00:00.000Z',
        }),
        makeRun({ id: 'd', repoPath: '/repo/lib', createdAt: '2026-11-02T02:00:00.000Z' }),
      ],
      store: fileTranscriptStore(dir),
    });
    expect(report.perRepo).toEqual([
      {
        key: '/repo/app',
        runs: 2,
        measured: 2,
        unmeasured: 0,
        usage: { input: 1, output: 2, cacheCreation: 0, cacheRead: 0 },
      },
      {
        key: '/repo/lib',
        runs: 2,
        measured: 1,
        unmeasured: 1,
        usage: { input: 0, output: 0, cacheCreation: 0, cacheRead: 4 },
      },
    ]);
    expect(report.perDay.map((d) => [d.key, d.runs, d.unmeasured])).toEqual([
      ['2026-11-01', 2, 0],
      ['2026-11-02', 2, 1],
    ]);
    expect(report.total).toEqual({
      runs: 4,
      measured: 3,
      unmeasured: 1,
      usage: { input: 1, output: 2, cacheCreation: 0, cacheRead: 4 },
    });
  });

  it('filters by --since and --repo', async () => {
    const runs = [
      makeRun({ id: 'old', createdAt: '2026-10-31T23:59:59.000Z' }),
      makeRun({ id: 'new', createdAt: '2026-11-01T00:00:00.000Z' }),
      makeRun({ id: 'lib', repoPath: '/repo/lib', createdAt: '2026-11-05T00:00:00.000Z' }),
    ];
    const store = fileTranscriptStore(await projects([]));
    const since = await tokenReport({ runs, store, since: parseSince('2026-11-01') });
    expect(since.runs.map((r) => r.runId)).toEqual(['new', 'lib']);
    const repo = await tokenReport({ runs, store, repoPath: '/repo/lib/' });
    expect(repo.runs.map((r) => r.runId)).toEqual(['lib']);
    expect(repo.total.runs).toBe(1);
  });

  it('refuses a --since it cannot read', () => {
    expect(() => parseSince('last tuesday')).toThrow(/not a date/);
  });

  it('treats a missing projects directory as no transcripts', async () => {
    const report = await tokenReport({
      runs: [makeRun({ sessionId: 's1' })],
      store: fileTranscriptStore('/nonexistent/fractory/projects'),
    });
    expect(report.runs[0]?.unmeasured).toBe('no-transcript');
  });
});

describe('fractory tokens', () => {
  const setup = async () => {
    const root = await mkdtemp(join(tmpdir(), 'fractory-tokens-cli-'));
    const registryDir = join(root, 'runs');
    await writeFile(
      join(root, 'config.json'),
      JSON.stringify({
        repos: ['/repo/app'],
        registryDir,
        logDir: join(root, 'logs'),
        hostStatePath: join(root, 'host.json'),
        automationsDir: join(root, 'automations'),
        resources: false,
      }),
    );
    const registry = new RunRegistry(registryDir);
    await registry.write(await fixtureRun());
    await registry.write(makeRun({ id: 'no-session', createdAt: '2026-11-21T08:00:00.000Z' }));
    const project = join(root, '.claude', 'projects', '-wt-app-139');
    await mkdir(project, { recursive: true });
    await writeFile(
      join(project, '5b1f0c7e-2d4a-4e7b-9a1c-0f3e8d2b6a91.jsonl'),
      await readFile(fixture('transcript.jsonl'), 'utf8'),
    );
    const out: string[] = [];
    const env = {
      out: (l: string) => out.push(l),
      cwd: root,
      factoryConfigPath: join(root, 'config.json'),
      home: root,
    } as unknown as Parameters<typeof main>[1];
    return { env, out };
  };

  it('prints Runs, rollups and a total that counts the unmeasured', async () => {
    const { env, out } = await setup();
    expect(await main(['tokens'], env)).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('20261120-101500-139');
    expect(text).toContain('4,213');
    expect(text).toContain('Per repository');
    expect(text).toContain('Per day');
    expect(text).toContain('Total: 4,213 tokens over 1 measured Run');
    expect(text).toContain('1 Run unmeasured');
  });

  it('emits the same report as --json, filtered', async () => {
    const { env, out } = await setup();
    expect(
      await main(['tokens', '--json', '--since', '2026-11-21', '--repo', '/repo/app'], env),
    ).toBe(0);
    const report = JSON.parse(out.join('\n')) as TokenReport;
    expect(report.runs.map((r) => r.runId)).toEqual(['no-session']);
    expect(report.total).toEqual(expect.objectContaining({ runs: 1, unmeasured: 1 }));
  });
});
