import { describe, expect, it } from 'vitest';
import { createBranchTip } from '../src/github/branch.ts';
import type { Exec } from '../src/github/exec.ts';
import { createGh, feedbackItems, summarizeChecks } from '../src/github/gh.ts';
import { makePr } from './trigger-helpers.ts';

describe('summarizeChecks', () => {
  it('classifies check runs and legacy statuses', () => {
    expect(summarizeChecks([])).toBe('none');
    expect(
      summarizeChecks([{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { state: 'SUCCESS' }]),
    ).toBe('passing');
    expect(summarizeChecks([{ status: 'COMPLETED', conclusion: 'SKIPPED' }])).toBe('passing');
    expect(summarizeChecks([{ status: 'IN_PROGRESS', conclusion: '' }])).toBe('pending');
    expect(summarizeChecks([{ state: 'PENDING' }])).toBe('pending');
    expect(summarizeChecks([{ status: 'COMPLETED', conclusion: 'TIMED_OUT' }])).toBe('failing');
    expect(summarizeChecks([{ state: 'ERROR' }])).toBe('failing');
  });

  it('failing wins over pending', () => {
    expect(
      summarizeChecks([
        { status: 'QUEUED', conclusion: null },
        { status: 'COMPLETED', conclusion: 'FAILURE' },
      ]),
    ).toBe('failing');
  });
});

describe('feedbackItems', () => {
  it('keeps comments and commented/changes-requested reviews, drops approvals and empty bodies', () => {
    const pr = makePr({
      reviews: [
        { id: 'r1', author: { login: 'a' }, body: 'looks off', state: 'COMMENTED' },
        { id: 'r2', author: { login: 'a' }, body: '', state: 'APPROVED' },
        { id: 'r3', author: { login: 'a' }, body: '', state: 'CHANGES_REQUESTED' },
        { id: 'r4', author: { login: 'a' }, body: '', state: 'COMMENTED' },
      ],
      comments: [
        { id: 'c1', author: { login: 'b' }, body: 'hi' },
        { id: 'c2', author: null, body: '  ' },
      ],
    });
    expect(feedbackItems(pr).map((f) => f.id)).toEqual(['r1', 'r3', 'c1']);
  });
});

describe('createGh', () => {
  it('parses gh pr view output and runs the documented commands', async () => {
    const calls: { cmd: string; args: string[]; cwd?: string | undefined }[] = [];
    const exec: Exec = async (cmd, args, options) => {
      calls.push({ cmd, args, cwd: options?.cwd });
      if (args[0] === 'pr' && args[1] === 'view') {
        return JSON.stringify({
          number: 7,
          state: 'OPEN',
          mergeable: 'MERGEABLE',
          baseRefName: 'main',
          headRefOid: 'abc',
          statusCheckRollup: null,
          reviews: [],
          comments: [],
        });
      }
      if (args[0] === 'api') return 'factory-bot\n';
      return '';
    };
    const gh = createGh(exec);
    const pr = await gh.viewPr('/repo', 'https://github.com/me/app/pull/7');
    expect(pr).toMatchObject({ number: 7, baseRefName: 'main', statusCheckRollup: [] });
    expect(await gh.currentUser()).toBe('factory-bot');
    await gh.mergeSquash('/repo', 'https://github.com/me/app/pull/7');
    expect(calls.at(-1)).toEqual({
      cmd: 'gh',
      args: ['pr', 'merge', 'https://github.com/me/app/pull/7', '--squash'],
      cwd: '/repo',
    });
    expect(calls[0]?.args).toContain(
      'number,state,mergeable,baseRefName,statusCheckRollup,reviews,comments,headRefOid',
    );
  });

  it('rejects a PR view without its base branch instead of guessing', async () => {
    const gh = createGh(async () =>
      JSON.stringify({ number: 7, state: 'OPEN', mergeable: 'MERGEABLE', headRefOid: 'abc' }),
    );
    await expect(gh.viewPr('/r', 'u')).rejects.toThrow();
  });

  it('rejects malformed gh output instead of guessing', async () => {
    const gh = createGh(async () => JSON.stringify({ number: 'x' }));
    await expect(gh.viewPr('/r', 'u')).rejects.toThrow();
  });
});

describe('createBranchTip', () => {
  const github = { ticketSource: { kind: 'github' as const, repo: 'me/app' } };
  const remotes =
    'upstream\thttps://github.com/other/app.git (push)\nmine\tgit@github.com:me/app.git (push)\n';
  const fake = (lsRemote: string | Error) => {
    const calls: string[] = [];
    const exec: Exec = async (cmd, args, options) => {
      calls.push(`${options?.cwd} ${cmd} ${args.join(' ')}`);
      if (args[0] === 'remote') return remotes;
      if (lsRemote instanceof Error) throw lsRemote;
      return lsRemote;
    };
    return { exec, calls };
  };

  it('reads the tip on the remote that points at the GitHub repo', async () => {
    const { exec, calls } = fake('abc1234def\trefs/heads/fractory/4-astro\n');
    expect(await createBranchTip(exec)('/repo', github, 'fractory/4-astro')).toBe('abc1234def');
    expect(calls).toContain('/repo git ls-remote --heads mine refs/heads/fractory/4-astro');
  });

  it('uses origin for a Jira repository', async () => {
    const { exec, calls } = fake('abc1234def\trefs/heads/feat/abc-1\n');
    const jira = { ticketSource: { kind: 'jira' as const, site: 's', projectKey: 'ABC' } };
    await createBranchTip(exec)('/repo', jira as never, 'feat/abc-1');
    expect(calls).toEqual(['/repo git ls-remote --heads origin refs/heads/feat/abc-1']);
  });

  it('answers undefined only when the remote has no such branch, and rejects a failed read', async () => {
    expect(await createBranchTip(fake('').exec)('/repo', github, 'gone')).toBeUndefined();
    await expect(
      createBranchTip(fake(new Error('offline')).exec)('/repo', github, 'b'),
    ).rejects.toThrow('offline');
    await expect(
      createBranchTip(fake('nonsense\trefs/heads/b\n').exec)('/repo', github, 'b'),
    ).rejects.toThrow('no sha');
  });
});
