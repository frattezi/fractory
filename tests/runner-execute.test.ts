import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { type RepoConfig, RepoConfigSchema } from '../src/contracts/repo-config.ts';
import {
  RUN_RECORD_VERSION,
  type RunRecord,
  type Trigger,
  answerRequestPath,
  commentsFilePath,
  runKey,
} from '../src/contracts/run.ts';
import type { Ticket, TicketSource, TicketStatus } from '../src/contracts/ticket.ts';
import type { Flow } from '../src/flows/types.ts';
import { RunRegistry } from '../src/registry/registry.ts';
import type { Exec } from '../src/runner/exec.ts';
import { type ExecuteDeps, executeRun } from '../src/runner/execute.ts';
import type { SandcastleAdapter } from '../src/runner/types.ts';

const ticket = (overrides: Partial<Ticket> = {}): Ticket => ({
  ref: 'github:me/repo#1',
  title: 'Add a thing',
  body: 'Do the thing.',
  url: 'https://github.com/me/repo/issues/1',
  status: 'in_progress',
  updatedAt: new Date().toISOString(),
  blockedBy: [],
  relationErrors: [],
  ...overrides,
});

const DEFAULT_KEYCHAIN: Record<string, string> = {
  'fractory.claude.work': 'work-token',
  'fractory.claude.personal': 'personal-token',
  'fractory.opencode.personal': 'oc-key',
};

const done = '<result>{"outcome":"done","summary":"Added it"}</result>';

interface AgentRequest {
  prompt: string;
  maxIterations: number;
  completionSignal: string;
  logging: { type: string; path: string };
  agent: { name: string; env: Record<string, string> };
  sandbox: unknown;
}

interface Setup {
  /** `git remote -v` output; default: origin is me/repo. */
  remotes?: string;
  mode?: RepoConfig['mode'];
  trigger?: Trigger;
  stdout?: string;
  completed?: boolean;
  ticket?: Ticket;
  commitsAhead?: string;
  commitBody?: string;
  existingPr?: string;
  /** Whether `git ls-remote` finds the base branch on the remote. Default: yes. */
  baseOnRemote?: boolean;
  failOn?: (file: string, args: string[]) => boolean;
  /** Keychain items present, by service. Default: the Claude items for both accounts. */
  keychain?: Record<string, string>;
  sandcastleEnv?: string;
  flow?: string;
  /** Overrides on the queued Run record, e.g. its own base branch. */
  run?: Partial<RunRecord>;
  /** Answers a `git` call before the defaults do, when it returns a string. */
  git?: (args: string[]) => string | undefined;
  /** Answers a `gh` call before the defaults do, when it returns a string. */
  gh?: (args: string[]) => string | undefined;
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
    ...options.run,
  };
  await registry.write(record);

  const calls: { file: string; args: string[]; cwd?: string | undefined }[] = [];
  const exec: Exec = async (file, args, opts) => {
    calls.push({ file, args, cwd: opts?.cwd });
    if (options.failOn?.(file, args)) throw new Error(`${file} ${args[0]} failed`);
    const key = `${file} ${args.join(' ')}`;
    if (file === 'security') {
      const service = args[args.indexOf('-s') + 1] ?? '';
      const secret = (options.keychain ?? DEFAULT_KEYCHAIN)[service];
      if (secret === undefined) throw Object.assign(new Error('security failed'), { code: 44 });
      return { stdout: `${secret}\n`, stderr: '' };
    }
    const out = (stdout: string) => ({ stdout, stderr: '' });
    const custom =
      file === 'git' ? options.git?.(args) : file === 'gh' ? options.gh?.(args) : undefined;
    if (custom !== undefined) return out(custom);
    if (key.includes('--absolute-git-dir')) return out(gitDir);
    if (key.includes('--git-path')) return out('/repo/.git/hooks/pre-push');
    if (key === 'git remote -v')
      return out(
        options.remotes ??
          'origin\thttps://github.com/me/repo.git (fetch)\norigin\thttps://github.com/me/repo.git (push)\n',
      );
    if (key.includes('rev-list --count')) return out(options.commitsAhead ?? '2');
    if (key.startsWith('git log'))
      return out(`abc\x1f${options.commitBody ?? 'Add the thing'}\x1e`);
    if (key.startsWith('git ls-remote'))
      return out(options.baseOnRemote === false ? '' : `abc123\t${args.at(-1)}\n`);
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

  const agentRequests: AgentRequest[] = [];
  const providers: { name: string; model: string; env: Record<string, string> }[] = [];
  const config = RepoConfigSchema.parse({
    mode: options.mode ?? 'personal',
    ticketSource: { kind: 'github', repo: 'me/repo' },
    hasCi: true,
    maxIterations: 4,
    ...(options.flow ? { flow: options.flow } : {}),
  });
  const worktree = {
    branch: 'fractory/1',
    worktreePath: join(dir, 'wt'),
    run: async (request: AgentRequest) => {
      agentRequests.push(request);
      return {
        stdout: options.stdout ?? done,
        iterations: [{ sessionId: 'sess-1' }],
        commits: [],
        branch: 'fractory/1',
        ...(options.completed === false ? {} : { completionSignal: '<promise>COMPLETE</promise>' }),
      };
    },
  };
  const worktreeRequests: { repoPath: string; branch: string; baseRef: string }[] = [];
  const sandcastle = {
    createWorktree: async (request: { repoPath: string; branch: string; baseRef: string }) => {
      worktreeRequests.push(request);
      return worktree;
    },
    sandbox: (image: string | undefined, cpus?: number) => ({ name: 'docker', image, cpus }),
    claudeCode: (model: string, o: { env?: Record<string, string> }) => {
      const provider = { name: 'claude', model, env: o.env ?? {} };
      providers.push(provider);
      return provider;
    },
    opencode: (model: string, o: { env?: Record<string, string> }) => {
      const provider = { name: 'opencode', model, env: o.env ?? {} };
      providers.push(provider);
      return provider;
    },
  } as unknown as SandcastleAdapter;
  if (options.sandcastleEnv !== undefined) {
    await mkdir(join(dir, 'repo', '.sandcastle'), { recursive: true });
    await writeFile(join(dir, 'repo', '.sandcastle', '.env'), options.sandcastleEnv);
  }
  const deps: ExecuteDeps = {
    ticketSource: source,
    registry,
    exec,
    pid: 99,
    loadRepoConfig: async () => config,
    readRules: async () => 'RULES',
    sandcastle,
  };
  const hookScript = () => readFile(join(gitDir, 'fractory-hooks', 'pre-push'), 'utf8');
  return {
    deps,
    registry,
    calls,
    comments,
    statuses,
    agentRequests,
    providers,
    record,
    dir,
    worktreeRequests,
    hookScript,
  };
};

const pushed = (calls: { file: string; args: string[] }[]) =>
  calls.filter((c) => c.file === 'git' && c.args.includes('push'));

describe('executeRun', () => {
  it('caps the sandbox CPUs only when asked to', async () => {
    const capped = await setup();
    await executeRun('run1', { ...capped.deps, cpus: 4 });
    expect(capped.agentRequests[0]?.sandbox).toMatchObject({ name: 'docker', cpus: 4 });
    const open = await setup();
    await executeRun('run1', open.deps);
    expect(open.agentRequests[0]?.sandbox).toMatchObject({ cpus: undefined });
  });

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
    expect(request?.completionSignal).toBe('<promise>COMPLETE</promise>');
    expect(request?.logging).toEqual({ type: 'file', path: t.record.logPath });
    expect(request?.agent.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1');
    expect(request?.prompt).toContain('RULES');
    expect(request?.prompt).toContain('Add a thing');

    const push = pushed(t.calls)[0];
    expect(push?.args.slice(0, 2)).toEqual(['-c', expect.stringContaining('core.hooksPath=')]);
    expect(push?.args.slice(-3)).toEqual(['--set-upstream', 'origin', 'fractory/1']);
    expect((await t.registry.get('run1'))?.status).toBe('done');
  });

  it('in a fork, fetches from, pushes to and opens the PR on the remote that points at the repo', async () => {
    const t = await setup({
      remotes:
        'origin\thttps://github.com/upstream/repo.git (push)\nmine\tgit@github.com:Me/Repo.git (push)\n',
    });
    expect((await executeRun('run1', t.deps)).status).toBe('done');
    expect(t.calls.some((c) => c.args.join(' ') === 'fetch mine main')).toBe(true);
    expect(pushed(t.calls)[0]?.args.slice(-3)).toEqual(['--set-upstream', 'mine', 'fractory/1']);
    const create = t.calls.find((c) => c.args.slice(0, 2).join(' ') === 'pr create');
    expect(create?.args.slice(2, 4)).toEqual(['--repo', 'me/repo']);
  });

  it('builds a Run with no base of its own on the repository base branch', async () => {
    const t = await setup();
    expect((await executeRun('run1', t.deps)).status).toBe('done');
    expect(t.calls.some((c) => c.args.join(' ') === 'fetch origin main')).toBe(true);
    expect(t.worktreeRequests.map((r) => r.baseRef)).toEqual(['origin/main']);
    const create = t.calls.find((c) => c.args.slice(0, 2).join(' ') === 'pr create');
    expect(create?.args[create.args.indexOf('--base') + 1]).toBe('main');
    const hook = await t.hookScript();
    expect(hook).toContain('refs/heads/main|refs/heads/master)');
  });

  it('branches a Run that names a base from it, opens its PR against it and protects it', async () => {
    const t = await setup({ run: { baseBranch: 'fractory/4-astro', baseSha: 'abc123' } });
    const record = await executeRun('run1', t.deps);
    expect(record.status).toBe('done');
    expect(record.baseBranch).toBe('fractory/4-astro');
    expect(record.baseSha).toBe('abc123');

    expect(t.calls.some((c) => c.args.join(' ') === 'fetch origin fractory/4-astro')).toBe(true);
    expect(t.calls.some((c) => c.args.join(' ') === 'fetch origin main')).toBe(false);
    expect(t.worktreeRequests.map((r) => r.baseRef)).toEqual(['origin/fractory/4-astro']);
    expect(
      t.calls.some((c) =>
        c.args.join(' ').startsWith('rev-list --count origin/fractory/4-astro..'),
      ),
    ).toBe(true);
    // Read again at publish time, then checked before the PR call; it is still there, unmerged.
    expect(
      new Set(t.calls.filter((c) => c.args[0] === 'ls-remote').map((c) => c.args.join(' '))),
    ).toEqual(new Set(['ls-remote --heads origin refs/heads/fractory/4-astro']));
    expect(t.calls.some((c) => c.args.includes('rebase'))).toBe(false);
    const create = t.calls.find((c) => c.args.slice(0, 2).join(' ') === 'pr create');
    expect(create?.args[create.args.indexOf('--base') + 1]).toBe('fractory/4-astro');

    const hook = await t.hookScript();
    expect(hook).toContain('refs/heads/main|refs/heads/fractory/4-astro|refs/heads/master)');
  });

  it("tells a stacked Run's agent the branch it is built on and that its blocker's work is there", async () => {
    const t = await setup({ run: { baseBranch: 'fractory/4-astro' } });
    await executeRun('run1', t.deps);
    const prompt = t.agentRequests[0]?.prompt ?? '';
    expect(prompt).toContain('## Built on `fractory/4-astro`');
    expect(prompt).toContain('not from `main`');
    expect(prompt).toContain("That Ticket's work is already in the tree");
    expect(prompt.indexOf('Add a thing')).toBeLessThan(prompt.indexOf('## Built on'));
  });

  it('says nothing about a stack for a Run on the base branch', async () => {
    const t = await setup({ run: { baseBranch: 'main' } });
    await executeRun('run1', t.deps);
    expect(t.agentRequests[0]?.prompt).not.toContain('## Built on');
  });

  it('checks the base branch on the push remote once, then opens the PR', async () => {
    const t = await setup({
      remotes:
        'origin\thttps://github.com/upstream/repo.git (push)\nmine\tgit@github.com:Me/Repo.git (push)\n',
    });
    expect((await executeRun('run1', t.deps)).status).toBe('done');
    const checks = t.calls.filter((c) => c.args[0] === 'ls-remote');
    expect(checks.map((c) => c.args)).toEqual([
      ['ls-remote', '--heads', 'mine', 'refs/heads/main'],
    ]);
    const order = t.calls.map((c) => `${c.file} ${c.args.slice(0, 2).join(' ')}`);
    expect(order.indexOf('git ls-remote --heads')).toBeLessThan(order.indexOf('gh pr create'));
    expect(t.calls.some((c) => c.args.slice(0, 2).join(' ') === 'pr create')).toBe(true);
  });

  it('fails naming the base branch and remote, without a PR call, when the base is not on the remote', async () => {
    const t = await setup({ baseOnRemote: false });
    const record = await executeRun('run1', t.deps);
    expect(record.status).toBe('failed');
    expect(record.prUrl).toBeUndefined();
    const summary = record.result?.outcome === 'failed' ? record.result.summary : '';
    expect(summary).toContain('base branch main is not on remote origin');
    expect(summary).toContain('push it');
    expect(summary).not.toContain('GraphQL');
    expect(t.calls.some((c) => c.args.slice(0, 2).join(' ') === 'pr create')).toBe(false);
    // The Run's branch was pushed and nothing deleted or rewrote it.
    expect(pushed(t.calls)).toHaveLength(1);
    expect(t.calls.some((c) => c.args.includes('--delete') || c.args.includes('-D'))).toBe(false);
    expect(t.statuses).toEqual([]);
  });

  it('opens the PR on a Re-run once the base branch is pushed', async () => {
    const missing = await setup({ baseOnRemote: false });
    expect((await executeRun('run1', missing.deps)).status).toBe('failed');
    const present = await setup({ baseOnRemote: true });
    const record = await executeRun('run1', present.deps);
    expect(record.status).toBe('done');
    expect(record.prUrl).toBe('https://github.com/me/repo/pull/9');
  });

  it('does not treat a failed ls-remote as a missing base branch', async () => {
    const t = await setup({ failOn: (file, args) => file === 'git' && args[0] === 'ls-remote' });
    expect((await executeRun('run1', t.deps)).status).toBe('done');
  });

  it('fails before any work when no remote points at the repo', async () => {
    const t = await setup({ remotes: 'origin\thttps://github.com/upstream/repo.git (push)\n' });
    const record = await executeRun('run1', t.deps);
    expect(record.status).toBe('failed');
    expect(record.result).toMatchObject({ summary: expect.stringContaining('no git remote') });
    expect(t.agentRequests).toHaveLength(0);
    expect(pushed(t.calls)).toHaveLength(0);
  });

  it('never logs the credentials', async () => {
    const t = await setup();
    await executeRun('run1', t.deps);
    const log = await readFile(t.record.logPath, 'utf8');
    expect(log).toContain('flow result: done');
    expect(log).not.toContain('personal-token');
    expect(JSON.stringify(await t.registry.get('run1'))).not.toContain('personal-token');
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

  it('builds an answer follow-up from the answer file and the answered Run result', async () => {
    const t = await setup({ trigger: { kind: 'answer', runId: 'run0' } });
    await t.registry.write({
      ...t.record,
      id: 'run0',
      key: 'github:me/repo#1:ticket-ready',
      trigger: { kind: 'ticket-ready' },
      status: 'needs-human',
      result: { outcome: 'needs-human', reason: 'ambiguous-spec', question: 'Seconds or ms?' },
    });
    await writeFile(
      answerRequestPath(t.registry.dir, 'run0'),
      JSON.stringify({ version: 1, answeredAt: new Date().toISOString(), answer: 'Use ms.' }),
    );
    const record = await executeRun('run1', t.deps);
    const prompt = t.agentRequests[0]?.prompt ?? '';
    expect(record.status).toBe('done');
    expect(prompt).toContain('`ambiguous-spec`');
    expect(prompt).toContain('<question>\nSeconds or ms?\n</question>');
    expect(prompt).toContain('<owner-answer>\nUse ms.\n</owner-answer>');
    expect(prompt).not.toContain('could not be read');
  });

  it('runs an answer Run whose answer file and answered Run are missing', async () => {
    const t = await setup({ trigger: { kind: 'answer', runId: 'gone' } });
    const record = await executeRun('run1', t.deps);
    const prompt = t.agentRequests[0]?.prompt ?? '';
    expect(record.status).toBe('done');
    expect(prompt).toContain("The owner's answer could not be read");
    expect(prompt).toContain('question the earlier Run stopped with could not be read');
    expect(prompt).toContain("Ticket's comments");
  });

  it('records a follow-up Run as done when the agent named the result tag in prose', async () => {
    const t = await setup({
      trigger: { kind: 'review-comment', prNumber: 9, commentId: '77' },
      existingPr: 'https://github.com/me/repo/pull/9',
      stdout:
        'Renamed it. I did not touch the <result> contract.\n<result>{"outcome":"done","summary":"Renamed"}</result>\n<promise>COMPLETE</promise>',
    });
    const record = await executeRun('run1', t.deps);
    expect(record.status).toBe('done');
    expect(record.result).toEqual({ outcome: 'done', summary: 'Renamed' });
  });

  it('fails the Run when the agent prints only a malformed result block', async () => {
    const t = await setup({ stdout: 'see <result> below\n<result>{"outcome":"done"</result>' });
    const record = await executeRun('run1', t.deps);
    expect(record.status).toBe('failed');
    expect(pushed(t.calls)).toHaveLength(0);
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

const flowOf = (flow: Flow) => async () => flow;

describe('flows, accounts and the executor shell', () => {
  it('records mode, flow and the agent profile the flow used', async () => {
    const t = await setup({ mode: 'work' });
    const record = await executeRun('run1', t.deps);
    expect(record).toMatchObject({ mode: 'work', flow: 'build', agents: ['claude@work'] });
    expect(t.providers[0]?.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('work-token');
  });

  it('uses the personal account in Personal Mode', async () => {
    const t = await setup();
    const record = await executeRun('run1', t.deps);
    expect(record.agents).toEqual(['claude@personal']);
    expect(t.providers[0]?.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('personal-token');
  });

  it('ignores credentials in the host environment', async () => {
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'host-token');
    vi.stubEnv('ANTHROPIC_API_KEY', 'host-key');
    try {
      const t = await setup();
      await executeRun('run1', t.deps);
      expect(t.providers[0]?.env).toEqual({
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
        CLAUDE_CODE_OAUTH_TOKEN: 'personal-token',
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('lets a flow use OpenCode in Personal Mode and records both profiles', async () => {
    const t = await setup();
    t.deps.loadFlow = flowOf(async (ctx) => {
      await ctx.agents.claude();
      const agent = await ctx.agents.opencode('opencode-go/some-model');
      await ctx.worktree.run({ agent, sandbox: ctx.sandbox, prompt: 'x' });
      return { outcome: 'done', summary: 'ok' };
    });
    const record = await executeRun('run1', t.deps);
    expect(record.status).toBe('done');
    expect(record.agents).toEqual(['claude@personal', 'opencode@personal']);
    expect(t.providers[1]).toMatchObject({
      name: 'opencode',
      model: 'opencode-go/some-model',
      env: { OPENCODE_API_KEY: 'oc-key' },
    });
    expect(record.sessionId).toBe('sess-1');
  });

  it('rejects OpenCode in Work Mode and never reads its Keychain item', async () => {
    const t = await setup({ mode: 'work' });
    t.deps.loadFlow = flowOf(async (ctx) => {
      await ctx.agents.opencode();
      return { outcome: 'done', summary: 'ok' };
    });
    const record = await executeRun('run1', t.deps);
    expect(record.status).toBe('failed');
    expect(record.result).toMatchObject({ outcome: 'failed' });
    expect(JSON.stringify(record.result)).toContain('not allowed in work Mode');
    expect(t.calls.some((c) => c.file === 'security')).toBe(false);
    expect(pushed(t.calls)).toHaveLength(0);
  });

  it('ends needs-human/needs-access naming the Keychain service when the item is missing', async () => {
    const t = await setup({ mode: 'work', keychain: {} });
    const record = await executeRun('run1', t.deps);
    expect(record.status).toBe('needs-human');
    expect(record.result).toMatchObject({ outcome: 'needs-human', reason: 'needs-access' });
    expect(JSON.stringify(record.result)).toContain('fractory.claude.work');
    expect(record.agents).toBeUndefined();
    expect(t.comments).toEqual([]);
  });

  it('fails the Run for an unknown flow before creating the worktree', async () => {
    const t = await setup({ flow: 'ghost' });
    const record = await executeRun('run1', t.deps);
    expect(record.status).toBe('failed');
    expect(record.result).toMatchObject({
      summary: expect.stringContaining('Unknown flow "ghost"'),
    });
    expect(t.agentRequests).toHaveLength(0);
  });

  it('fails the Run when the flow returns something that is not a RunResult', async () => {
    const t = await setup();
    t.deps.loadFlow = flowOf((async () => ({ outcome: 'maybe' })) as unknown as Flow);
    const record = await executeRun('run1', t.deps);
    expect(record.status).toBe('failed');
    expect(pushed(t.calls)).toHaveLength(0);
  });

  it('fails the Run when the flow throws', async () => {
    const t = await setup();
    t.deps.loadFlow = flowOf(async () => {
      throw new Error('kaboom');
    });
    const record = await executeRun('run1', t.deps);
    expect(record.status).toBe('failed');
    expect(JSON.stringify(record.result)).toContain('kaboom');
    expect(pushed(t.calls)).toHaveLength(0);
  });

  it('does not let a flow override the account through agent options', async () => {
    const t = await setup();
    t.deps.loadFlow = flowOf(async (ctx) => {
      await ctx.agents.claude(undefined, { env: { CLAUDE_CODE_OAUTH_TOKEN: 'sneaky' } });
      return { outcome: 'failed', summary: 'x' };
    });
    await executeRun('run1', t.deps);
    expect(t.providers[0]?.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('personal-token');
  });

  it.each(['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'])(
    'refuses to run when .sandcastle/.env defines %s',
    async (key) => {
      const t = await setup({ sandcastleEnv: `GH_TOKEN=x\n${key}=abc\n` });
      const record = await executeRun('run1', t.deps);
      expect(record.status).toBe('failed');
      expect(JSON.stringify(record.result)).toContain(key);
      expect(t.agentRequests).toHaveLength(0);
      expect(JSON.stringify(record)).not.toContain('abc');
    },
  );

  it('runs when .sandcastle/.env has only unrelated keys', async () => {
    const t = await setup({ sandcastleEnv: 'GH_TOKEN=x\n' });
    expect((await executeRun('run1', t.deps)).status).toBe('done');
  });
});

describe('executeRun: Restack', () => {
  const BELOW = 'fractory/4-astro';
  const restack: Trigger = { kind: 'restack', fromSha: 'old-tip', tipSha: 'new-tip' };
  /** `git rev-parse` answers: the new tip below, the pushed branch, and HEAD before and after. */
  const shas = (heads: string[] = ['pushed', 'rebased']) => {
    const queue = [...heads];
    return (args: string[]): string | undefined => {
      if (args[0] !== 'rev-parse') return undefined;
      if (args[1] === `origin/${BELOW}`) return 'new-tip-sha';
      if (args[1] === 'origin/fractory/1') return 'pushed';
      if (args[1] === 'HEAD') return queue.shift() ?? 'rebased';
      return undefined;
    };
  };
  const restackSetup = (options: Setup = {}) => {
    const rev = shas();
    return setup({
      trigger: restack,
      run: { baseBranch: BELOW, baseSha: 'old-tip' },
      git: (args) =>
        args.join(' ') === 'log -1 --format=%cn%x1f%ce' ? 'Dev\x1fdev@example.com' : rev(args),
      ...options,
    });
  };
  const gitCalls = (t: Awaited<ReturnType<typeof setup>>) =>
    t.calls.filter((c) => c.file === 'git').map((c) => c.args.join(' '));

  it('rebases the branch onto the new tip, pushes it and opens no pull request', async () => {
    const t = await restackSetup();
    await t.registry.write({
      ...t.record,
      id: 'earlier',
      key: 'k-earlier',
      trigger: { kind: 'ticket-ready' },
      status: 'done',
      prUrl: 'https://github.com/me/repo/pull/9',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const record = await executeRun('run1', t.deps);

    expect(record.status).toBe('done');
    expect(record.result).toEqual({
      outcome: 'done',
      summary: `Rebased fractory/1 onto ${BELOW} at new-tip- and pushed it (rebased).`,
    });
    expect(record.baseSha).toBe('new-tip-sha');
    expect(record.prUrl).toBe('https://github.com/me/repo/pull/9');
    const git = gitCalls(t);
    expect(git).toContain(`fetch origin ${BELOW} fractory/1`);
    expect(git).toContain('merge-base --is-ancestor old-tip HEAD');
    expect(git).toContain(
      `-c user.name=Dev -c user.email=dev@example.com rebase --onto origin/${BELOW} old-tip`,
    );
    const push = pushed(t.calls);
    expect(push).toHaveLength(1);
    expect(push[0]?.args.slice(2)).toEqual([
      'push',
      '--force-with-lease=fractory/1:pushed',
      'origin',
      'fractory/1',
    ]);
    // A branch cleanup deleted is recreated from the pushed branch, never from the base.
    expect(t.worktreeRequests.map((r) => r.baseRef)).toEqual(['origin/fractory/1']);
    expect(await t.hookScript()).toContain(`refs/heads/${BELOW}`);
    expect(t.agentRequests).toEqual([]);
    expect(t.providers).toEqual([]);
    expect(t.calls.some((c) => c.file === 'gh')).toBe(false);
    expect(t.calls.some((c) => c.file === 'security')).toBe(false);
    expect(t.statuses).toEqual(['in_review']);
  });

  it('replays the whole branch when the old tip is not in its history', async () => {
    const t = await restackSetup({
      failOn: (file, args) => file === 'git' && args[0] === 'merge-base',
    });
    expect((await executeRun('run1', t.deps)).status).toBe('done');
    expect(gitCalls(t)).toContain(
      `-c user.name=Dev -c user.email=dev@example.com rebase origin/${BELOW}`,
    );
  });

  it('a rebase that conflicts is aborted, pushes nothing and fails the Run naming the conflict', async () => {
    const t = await restackSetup({
      failOn: (file, args) =>
        file === 'git' && args.includes('rebase') && !args.includes('--abort'),
      git: (args) =>
        args.join(' ') === 'diff --name-only --diff-filter=U'
          ? 'src/a.ts\nsrc/b.ts\n'
          : shas()(args),
    });
    const record = await executeRun('run1', t.deps);
    expect(record.status).toBe('failed');
    expect(record.result?.outcome).toBe('failed');
    const summary = record.result?.outcome === 'failed' ? record.result.summary : '';
    expect(summary).toContain(
      `Rebasing fractory/1 onto ${BELOW} (new-tip-) conflicts in src/a.ts, src/b.ts`,
    );
    expect(summary).toContain('left as it was pushed for the owner');
    expect(gitCalls(t)).toContain('rebase --abort');
    expect(pushed(t.calls)).toEqual([]);
    expect(record.baseSha).toBe('old-tip');
    expect(t.statuses).toEqual([]);
  });

  it('never rewrites a local branch that differs from the pushed one', async () => {
    const t = await restackSetup({ git: shas(['local-only']) });
    const record = await executeRun('run1', t.deps);
    expect(record.status).toBe('failed');
    expect(record.result?.outcome === 'failed' && record.result.summary).toContain(
      'left for the owner',
    );
    expect(gitCalls(t).some((c) => c.includes('rebase'))).toBe(false);
    expect(pushed(t.calls)).toEqual([]);
  });

  it('a fetch that fails fails the Run without touching the branch', async () => {
    const t = await restackSetup({ failOn: (file, args) => file === 'git' && args[0] === 'fetch' });
    expect((await executeRun('run1', t.deps)).status).toBe('failed');
    expect(t.worktreeRequests).toEqual([]);
    expect(pushed(t.calls)).toEqual([]);
  });
});

describe('executeRun: a stacked Run with no recorded tip', () => {
  it('records the tip of the base it branched from', async () => {
    const t = await setup({
      run: { baseBranch: 'fractory/4-astro' },
      git: (args) => (args.join(' ') === 'rev-parse origin/fractory/4-astro' ? 'tip-a' : undefined),
    });
    expect((await executeRun('run1', t.deps)).baseSha).toBe('tip-a');
  });
});

describe('executeRun: a stacked Run whose blocker landed while it worked', () => {
  const BELOW = 'fractory/135-doc';
  const stacked = (options: Setup & { belowOnRemote?: boolean; belowMerged?: boolean } = {}) => {
    const { belowOnRemote = true, belowMerged = false, ...rest } = options;
    return setup({
      run: { baseBranch: BELOW, baseSha: 'blocker-tip' },
      ...rest,
      git: (args) => {
        const custom = rest.git?.(args);
        if (custom !== undefined) return custom;
        const line = args.join(' ');
        if (line === `ls-remote --heads origin refs/heads/${BELOW}`)
          return belowOnRemote ? `bbb\trefs/heads/${BELOW}\n` : '';
        // The Run's own branch was never pushed.
        if (line === 'ls-remote --heads origin refs/heads/fractory/1') return '';
        if (line === 'rev-parse origin/main') return 'main-tip-sha';
        if (line === 'log -1 --format=%cn%x1f%ce') return 'Dev\x1fdev@example.com';
        return undefined;
      },
      gh: (args) =>
        args.join(' ').startsWith(`pr list --repo me/repo --head ${BELOW} --state merged`)
          ? belowMerged
            ? '[{"url":"https://github.com/me/repo/pull/135"}]'
            : '[]'
          : undefined,
    });
  };
  const gitCalls = (t: Awaited<ReturnType<typeof setup>>) =>
    t.calls.filter((c) => c.file === 'git').map((c) => c.args.join(' '));
  const prBase = (t: Awaited<ReturnType<typeof setup>>) => {
    const create = t.calls.find((c) => c.args.slice(0, 2).join(' ') === 'pr create');
    return create?.args[create.args.indexOf('--base') + 1];
  };

  it('publishes against the repository base branch when the recorded base no longer resolves', async () => {
    const t = await stacked({ belowOnRemote: false });
    const record = await executeRun('run1', t.deps);

    expect(record.status).toBe('done');
    expect(record.result).toEqual({ outcome: 'done', summary: 'Added it' });
    expect(record.prUrl).toBe('https://github.com/me/repo/pull/9');
    expect(record.baseBranch).toBe('main');
    expect(record.baseSha).toBe('main-tip-sha');
    const git = gitCalls(t);
    expect(git).toContain('fetch origin main');
    expect(git).toContain(
      '-c user.name=Dev -c user.email=dev@example.com rebase --onto origin/main blocker-tip',
    );
    expect(git).toContain('rev-list --count origin/main..fractory/1');
    expect(git.some((c) => c.includes(`origin/${BELOW}..`))).toBe(false);
    expect(pushed(t.calls)[0]?.args.slice(2)).toEqual([
      'push',
      '--set-upstream',
      'origin',
      'fractory/1',
    ]);
    expect(prBase(t)).toBe('main');
    expect(t.statuses).toEqual(['in_review']);
  });

  it('publishes a Stack whose base merged as a squash without bringing back its commits', async () => {
    const t = await stacked({ belowMerged: true });
    const record = await executeRun('run1', t.deps);

    expect(record.status).toBe('done');
    expect(record.baseBranch).toBe('main');
    const git = gitCalls(t);
    // Only the commits after the blocker's tip are replayed onto main.
    expect(git).toContain('merge-base --is-ancestor blocker-tip HEAD');
    const rebases = git.filter((c) => c.includes(' rebase '));
    expect(rebases).toEqual([
      '-c user.name=Dev -c user.email=dev@example.com rebase --onto origin/main blocker-tip',
    ]);
    expect(git.indexOf(rebases[0] ?? '')).toBeLessThan(
      git.indexOf('rev-list --count origin/main..fractory/1'),
    );
    expect(git.indexOf(rebases[0] ?? '')).toBeLessThan(git.findIndex((c) => c.includes(' push ')));
    expect(prBase(t)).toBe('main');
  });

  it('retargets the open pull request of a follow-up Run and replaces only the branch it read', async () => {
    const t = await stacked({
      belowMerged: true,
      existingPr: 'https://github.com/me/repo/pull/9',
      git: (args) =>
        args.join(' ') === 'ls-remote --heads origin refs/heads/fractory/1'
          ? 'pushed-sha\trefs/heads/fractory/1\n'
          : undefined,
    });
    expect((await executeRun('run1', t.deps)).status).toBe('done');
    expect(pushed(t.calls)[0]?.args.slice(2)).toEqual([
      'push',
      '--force-with-lease=fractory/1:pushed-sha',
      '--set-upstream',
      'origin',
      'fractory/1',
    ]);
    const edit = t.calls.find((c) => c.file === 'gh' && c.args.slice(0, 2).join(' ') === 'pr edit');
    expect(edit?.args).toEqual([
      'pr',
      'edit',
      'https://github.com/me/repo/pull/9',
      '--repo',
      'me/repo',
      '--base',
      'main',
    ]);
  });

  it('replays the whole branch when the recorded tip is not in its history', async () => {
    const t = await stacked({
      belowOnRemote: false,
      failOn: (file, args) => file === 'git' && args[0] === 'merge-base',
    });
    expect((await executeRun('run1', t.deps)).status).toBe('done');
    expect(gitCalls(t)).toContain(
      '-c user.name=Dev -c user.email=dev@example.com rebase origin/main',
    );
  });

  it('still fails with "made no commits" when the Run made none', async () => {
    const t = await stacked({ belowOnRemote: false, commitsAhead: '0' });
    const record = await executeRun('run1', t.deps);
    expect(record.status).toBe('failed');
    expect(record.result?.outcome === 'failed' && record.result.summary).toContain(
      'made no commits',
    );
    expect(pushed(t.calls)).toEqual([]);
  });

  it('a rebase that conflicts is aborted, the branch is pushed as it was and publishing fails', async () => {
    const t = await stacked({
      belowOnRemote: false,
      failOn: (file, args) =>
        file === 'git' && args.includes('rebase') && !args.includes('--abort'),
      git: (args) =>
        args.join(' ') === 'diff --name-only --diff-filter=U' ? 'src/a.ts\n' : undefined,
    });
    const record = await executeRun('run1', t.deps);
    expect(record.status).toBe('failed');
    const summary = record.result?.outcome === 'failed' ? record.result.summary : '';
    expect(summary).toContain(`${BELOW} is no longer on origin`);
    expect(summary).toContain('conflicts in src/a.ts');
    expect(summary).toContain('fractory/1 was pushed as it was for the owner');
    expect(gitCalls(t)).toContain('rebase --abort');
    expect(pushed(t.calls)).toHaveLength(1);
    expect(t.calls.some((c) => c.args.slice(0, 2).join(' ') === 'pr create')).toBe(false);
  });

  it('keeps the recorded base when the remote cannot be read', async () => {
    const t = await stacked({
      failOn: (file, args) => file === 'git' && args[0] === 'ls-remote',
    });
    const record = await executeRun('run1', t.deps);
    expect(record.status).toBe('done');
    expect(record.baseBranch).toBe(BELOW);
    expect(gitCalls(t).some((c) => c.includes('rebase'))).toBe(false);
    expect(prBase(t)).toBe(BELOW);
  });

  it('leaves an ordinary Run on the base branch alone', async () => {
    const t = await setup();
    expect((await executeRun('run1', t.deps)).status).toBe('done');
    expect(gitCalls(t).some((c) => c.includes('rebase'))).toBe(false);
    expect(t.calls.some((c) => c.args.includes('merged'))).toBe(false);
    expect(t.calls.filter((c) => c.args[0] === 'ls-remote')).toHaveLength(1);
    expect(gitCalls(t)).toContain('rev-list --count origin/main..fractory/1');
  });
});
