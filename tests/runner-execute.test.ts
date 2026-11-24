import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type RepoConfig, RepoConfigSchema } from '../src/contracts/repo-config.ts';
import {
  RUN_RECORD_VERSION,
  type RunRecord,
  type Trigger,
  commentsFilePath,
  runKey,
} from '../src/contracts/run.ts';
import type { Ticket, TicketSource, TicketStatus } from '../src/contracts/ticket.ts';
import { RunRegistry } from '../src/registry/registry.ts';
import type { Exec } from '../src/runner/exec.ts';
import { type ExecuteDeps, executeRun } from '../src/runner/execute.ts';
import type { AgentRunOutcome, AgentRunRequest } from '../src/runner/types.ts';

const ticket = (overrides: Partial<Ticket> = {}): Ticket => ({
  ref: 'github:me/repo#1',
  title: 'Add a thing',
  body: 'Do the thing.',
  url: 'https://github.com/me/repo/issues/1',
  status: 'in_progress',
  updatedAt: new Date().toISOString(),
  ...overrides,
});

const done = '<result>{"outcome":"done","summary":"Added it"}</result>';

interface Setup {
  mode?: RepoConfig['mode'];
  trigger?: Trigger;
  stdout?: string;
  completed?: boolean;
  ticket?: Ticket;
  commitsAhead?: string;
  commitBody?: string;
  existingPr?: string;
  failOn?: (file: string, args: string[]) => boolean;
}

const setup = async (options: Setup = {}) => {
  const dir = await mkdtemp(join(tmpdir(), 'exec-'));
  const gitDir = join(dir, 'gitdir');
  const registry = new RunRegistry(join(dir, 'runs'));
  const now = new Date().toISOString();
  const trigger = options.trigger ?? { kind: 'ticket-ready' };
  const record: RunRecord = {
    version: RUN_RECORD_VERSION,
    id: 'run1',
    key: runKey('github:me/repo#1', trigger),
    ticketRef: 'github:me/repo#1',
    repoPath: join(dir, 'repo'),
    trigger,
    status: 'queued',
    branch: 'fractory/1',
    logPath: join(dir, 'logs', 'run1.log'),
    createdAt: now,
    updatedAt: now,
  };
  await registry.write(record);

  const calls: { file: string; args: string[]; cwd?: string | undefined }[] = [];
  const exec: Exec = async (file, args, opts) => {
    calls.push({ file, args, cwd: opts?.cwd });
    if (options.failOn?.(file, args)) throw new Error(`${file} ${args[0]} failed`);
    const key = `${file} ${args.join(' ')}`;
    const out = (stdout: string) => ({ stdout, stderr: '' });
    if (key.includes('--absolute-git-dir')) return out(gitDir);
    if (key.includes('--git-path')) return out('/repo/.git/hooks/pre-push');
    if (key.includes('rev-list --count')) return out(options.commitsAhead ?? '2');
    if (key.startsWith('git log'))
      return out(`abc\x1f${options.commitBody ?? 'Add the thing'}\x1e`);
    if (key.startsWith('gh pr list'))
      return out(options.existingPr ? JSON.stringify([{ url: options.existingPr }]) : '[]');
    if (key.startsWith('gh pr create')) return out('https://github.com/me/repo/pull/9\n');
    if (key.startsWith('gh run list')) return out('[{"databaseId":55}]');
    if (key.startsWith('gh run view')) return out('FAIL: test x');
    if (key.startsWith('gh api')) return out('{"body":"rename it","path":"a.ts"}');
    return out('');
  };

  const comments: string[] = [];
  const statuses: TicketStatus[] = [];
  const source: TicketSource = {
    listReady: async () => [],
    get: async () => options.ticket ?? ticket(),
    setStatus: async (_ref, status) => {
      statuses.push(status);
    },
    comment: async (_ref, body) => {
      comments.push(body);
    },
  };

  const agentRequests: AgentRunRequest[] = [];
  const config = RepoConfigSchema.parse({
    mode: options.mode ?? 'personal',
    ticketSource: { kind: 'github', repo: 'me/repo' },
    hasCi: true,
    maxIterations: 4,
  });
  const outcome: AgentRunOutcome = {
    stdout: options.stdout ?? done,
    iterations: 1,
    completed: options.completed ?? true,
    sessionId: 'sess-1',
  };
  const deps: ExecuteDeps = {
    ticketSource: source,
    registry,
    exec,
    hostEnv: { CLAUDE_CODE_OAUTH_TOKEN: 'secret-token' },
    pid: 99,
    loadRepoConfig: async () => config,
    readRules: async () => 'RULES',
    sandcastle: {
      prepareWorktree: async () => ({
        path: join(dir, 'wt'),
        runAgent: async (request) => {
          agentRequests.push(request);
          return outcome;
        },
      }),
    },
  };
  return { deps, registry, calls, comments, statuses, agentRequests, record };
};

const pushed = (calls: { file: string; args: string[] }[]) =>
  calls.filter((c) => c.file === 'git' && c.args.includes('push'));

describe('executeRun', () => {
  it('pushes, opens the PR, moves the Ticket to in_review and records everything', async () => {
    const t = await setup();
    const record = await executeRun('run1', t.deps);

    expect(record.status).toBe('done');
    expect(record.prUrl).toBe('https://github.com/me/repo/pull/9');
    expect(record.sessionId).toBe('sess-1');
    expect(record.worktreePath).toMatch(/wt$/);
    expect(record.result).toEqual({ outcome: 'done', summary: 'Added it' });
    expect(record.finishedAt).toBeDefined();
    expect(record.pid).toBe(99);
    expect(t.statuses).toEqual(['in_review']);

    const request = t.agentRequests[0];
    expect(request?.maxIterations).toBe(4);
    expect(request?.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1');
    expect(request?.prompt).toContain('RULES');
    expect(request?.prompt).toContain('Add a thing');

    const push = pushed(t.calls)[0];
    expect(push?.args.slice(0, 2)).toEqual(['-c', expect.stringContaining('core.hooksPath=')]);
    expect(push?.args.slice(-3)).toEqual(['--set-upstream', 'origin', 'fractory/1']);
    expect((await t.registry.get('run1'))?.status).toBe('done');
  });

  it('never logs the credentials', async () => {
    const t = await setup();
    await executeRun('run1', t.deps);
    const log = await readFile(t.record.logPath, 'utf8');
    expect(log).toContain('agent result: done');
    expect(log).not.toContain('secret-token');
  });

  it('reuses the open PR on a follow-up Run and feeds the CI log to the agent', async () => {
    const t = await setup({
      trigger: { kind: 'ci-failed', prNumber: 9, headSha: 'deadbeef' },
      existingPr: 'https://github.com/me/repo/pull/9',
    });
    const record = await executeRun('run1', t.deps);

    expect(record.prUrl).toBe('https://github.com/me/repo/pull/9');
    expect(t.calls.some((c) => c.args.slice(0, 2).join(' ') === 'pr create')).toBe(false);
    expect(t.calls.some((c) => c.args.join(' ') === 'run view 55 --log-failed')).toBe(true);
    expect(t.agentRequests[0]?.prompt).toContain('FAIL: test x');
  });

  it('feeds a review comment to the agent', async () => {
    const t = await setup({ trigger: { kind: 'review-comment', prNumber: 9, commentId: '77' } });
    await executeRun('run1', t.deps);
    expect(t.agentRequests[0]?.prompt).toContain('rename it');
  });

  it('feeds unconsumed Agent Manager comments (path, line, body) to the agent', async () => {
    const t = await setup({ trigger: { kind: 'review-comment', prNumber: 9, commentId: 'am:c3' } });
    const earlier = { ...t.record, id: 'run0', key: 'github:me/repo#1:ticket-ready' };
    await t.registry.write({ ...earlier, trigger: { kind: 'ticket-ready' } });
    await t.registry.write({
      ...earlier,
      id: 'run-mid',
      key: runKey('github:me/repo#1', { kind: 'review-comment', prNumber: 9, commentId: 'am:c1' }),
      trigger: { kind: 'review-comment', prNumber: 9, commentId: 'am:c1' },
    });
    const c = (id: string, minute: number) => ({
      id,
      path: `src/${id}.ts`,
      line: minute,
      body: `body of ${id}`,
      createdAt: `2026-06-01T10:0${minute}:00.000Z`,
    });
    await writeFile(
      commentsFilePath(t.registry.dir, 'run0'),
      JSON.stringify({ version: 1, comments: [c('c1', 1), c('c2', 2), c('c3', 3), c('c4', 4)] }),
    );
    await executeRun('run1', t.deps);
    const prompt = t.agentRequests[0]?.prompt ?? '';
    expect(prompt).toContain('src/c2.ts:2\nbody of c2');
    expect(prompt).toContain('src/c3.ts:3\nbody of c3');
    expect(prompt).not.toContain('body of c1');
    expect(prompt).not.toContain('body of c4');
  });

  it('fails the Run, without pushing, when the result block is missing', async () => {
    const t = await setup({ stdout: 'no result here' });
    const record = await executeRun('run1', t.deps);
    expect(record.status).toBe('failed');
    expect(pushed(t.calls)).toHaveLength(0);
    expect(t.statuses).toEqual([]);
  });

  it('fails the Run when the result block is invalid', async () => {
    const t = await setup({ stdout: '<result>{"outcome":"maybe"}</result>' });
    expect((await executeRun('run1', t.deps)).status).toBe('failed');
  });

  it('stops with needs-human/budget-exhausted when iterations run out', async () => {
    const t = await setup({ stdout: 'still working', completed: false });
    const record = await executeRun('run1', t.deps);
    expect(record.status).toBe('needs-human');
    expect(record.result).toMatchObject({ outcome: 'needs-human', reason: 'budget-exhausted' });
    expect(pushed(t.calls)).toHaveLength(0);
  });

  it('comments the agent question on the Ticket in Personal Mode', async () => {
    const stdout =
      '<result>{"outcome":"needs-human","reason":"ambiguous-spec","question":"Which db?"}</result>';
    const t = await setup({ stdout });
    const record = await executeRun('run1', t.deps);
    expect(record.status).toBe('needs-human');
    expect(t.comments).toHaveLength(1);
    expect(t.comments[0]).toContain('Which db?');
  });

  it('never posts the question to the tracker in Work Mode', async () => {
    const stdout =
      '<result>{"outcome":"needs-human","reason":"needs-access","question":"Need a key"}</result>';
    const t = await setup({ mode: 'work', stdout });
    const record = await executeRun('run1', t.deps);
    expect(record.status).toBe('needs-human');
    expect(t.comments).toEqual([]);
    expect(t.statuses).toEqual([]);
  });

  it('falls back to neutral PR text in Work Mode when the text mentions the AI setup', async () => {
    const t = await setup({
      mode: 'work',
      ticket: ticket({ title: 'Ask Claude to fix it' }),
      stdout: '<result>{"outcome":"done","summary":"Done by the Claude agent"}</result>',
    });
    const record = await executeRun('run1', t.deps);
    expect(record.status).toBe('done');
    const create = t.calls.find((c) => c.args.slice(0, 2).join(' ') === 'pr create');
    const args = create?.args ?? [];
    expect(args[args.indexOf('--title') + 1]).toBe('Work on me/repo#1');
    expect(args[args.indexOf('--body') + 1]).not.toMatch(/claude/i);
  });

  it('refuses to push a Work Mode commit with an attribution trailer', async () => {
    const t = await setup({
      mode: 'work',
      commitBody: 'Add the thing\n\nCo-Authored-By: Claude <noreply@anthropic.com>',
    });
    const record = await executeRun('run1', t.deps);
    expect(record.status).toBe('failed');
    expect(pushed(t.calls)).toHaveLength(0);
    expect(record.result).toMatchObject({ outcome: 'failed' });
  });

  it('fails when the agent says done but made no commits', async () => {
    const t = await setup({ commitsAhead: '0' });
    const record = await executeRun('run1', t.deps);
    expect(record.status).toBe('failed');
    expect(pushed(t.calls)).toHaveLength(0);
  });

  it('keeps the Run done when only the Ticket status update fails', async () => {
    const t = await setup();
    t.deps.ticketSource = {
      listReady: async () => [],
      get: async () => ticket(),
      comment: async () => {},
      setStatus: async () => {
        throw new Error('tracker down');
      },
    };
    const record = await executeRun('run1', t.deps);
    expect(record.status).toBe('done');
    expect(record.prUrl).toBeDefined();
  });

  it('fails the Run when the hook cannot be installed, before starting the agent', async () => {
    const t = await setup({ failOn: (_f, args) => args[0] === 'config' });
    const record = await executeRun('run1', t.deps);
    expect(record.status).toBe('failed');
    expect(t.agentRequests).toHaveLength(0);
  });

  it('does nothing for a Run that already finished', async () => {
    const t = await setup();
    await executeRun('run1', t.deps);
    t.agentRequests.length = 0;
    expect((await executeRun('run1', t.deps)).status).toBe('done');
    expect(t.agentRequests).toHaveLength(0);
  });

  it('throws for an unknown Run', async () => {
    const t = await setup();
    await expect(executeRun('nope', t.deps)).rejects.toThrow(/not found/);
  });
});
