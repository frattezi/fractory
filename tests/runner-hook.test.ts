import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Exec } from '../src/runner/exec.ts';
import { installPrePushHook, renderPrePushHook } from '../src/runner/hook.ts';

const runHook = (script: string, dir: string, stdin: string) => {
  const file = join(dir, 'hook.sh');
  return writeFile(file, script)
    .then(() => chmod(file, 0o755))
    .then(() => spawnSync('sh', [file, 'origin', 'url'], { input: stdin, encoding: 'utf8' }));
};
const line = (remoteRef: string) => `refs/heads/x abc123 ${remoteRef} 000\n`;

describe('pre-push hook', () => {
  it('refuses pushes to the base branch, main and master', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hook-'));
    const script = renderPrePushHook({ baseBranch: 'develop', repoHookPath: join(dir, 'none') });
    for (const branch of ['develop', 'main', 'master']) {
      const result = await runHook(script, dir, line(`refs/heads/${branch}`));
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(branch);
    }
  });

  it('also refuses pushes to the branch the Run is built on', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hook-'));
    const script = renderPrePushHook({
      baseBranch: 'develop',
      runBaseBranch: 'fractory/4-astro',
      repoHookPath: join(dir, 'none'),
    });
    for (const branch of ['fractory/4-astro', 'develop', 'main', 'master']) {
      const result = await runHook(script, dir, line(`refs/heads/${branch}`));
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(branch);
    }
    expect((await runHook(script, dir, line('refs/heads/fractory/5-law'))).status).toBe(0);
  });

  it('protects only the usual branches when the Run names no base of its own', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hook-'));
    const none = join(dir, 'none');
    expect(
      renderPrePushHook({ baseBranch: 'main', runBaseBranch: undefined, repoHookPath: none }),
    ).toBe(renderPrePushHook({ baseBranch: 'main', repoHookPath: none }));
    expect(
      renderPrePushHook({ baseBranch: 'main', runBaseBranch: 'main', repoHookPath: none }),
    ).toBe(renderPrePushHook({ baseBranch: 'main', repoHookPath: none }));
  });

  it('rejects a Run base branch that is not safe to embed in the script', () => {
    expect(() =>
      renderPrePushHook({ baseBranch: 'main', runBaseBranch: 'x$(id)', repoHookPath: '/x' }),
    ).toThrow();
  });

  it('allows other branches and chains to the repo hook with args and stdin', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hook-'));
    const repoHook = join(dir, 'repo-pre-push');
    await writeFile(
      repoHook,
      `#!/bin/sh\necho "$@" > '${dir}/args'\ncat > '${dir}/stdin'\nexit 3\n`,
    );
    await chmod(repoHook, 0o755);
    const script = renderPrePushHook({ baseBranch: 'main', repoHookPath: repoHook });

    const result = await runHook(script, dir, line('refs/heads/fractory/1'));
    expect(result.status).toBe(3);
    expect((await readFile(join(dir, 'args'), 'utf8')).trim()).toBe('origin url');
    expect((await readFile(join(dir, 'stdin'), 'utf8')).trim()).toBe(
      line('refs/heads/fractory/1').trim(),
    );
  });

  it('passes when there is no repo hook', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hook-'));
    const script = renderPrePushHook({ baseBranch: 'main', repoHookPath: join(dir, 'none') });
    expect((await runHook(script, dir, line('refs/heads/feature'))).status).toBe(0);
  });

  it('rejects branch names that are not safe to embed in the script', () => {
    expect(() => renderPrePushHook({ baseBranch: 'a;rm -rf /', repoHookPath: '/x' })).toThrow();
  });

  it('installs the hook in the worktree git dir and points core.hooksPath at it', async () => {
    const gitDir = await mkdtemp(join(tmpdir(), 'gitdir-'));
    const calls: string[][] = [];
    const exec: Exec = async (_file, args) => {
      calls.push(args);
      if (args[0] === 'rev-parse' && args[1] === '--absolute-git-dir')
        return { stdout: `${gitDir}\n`, stderr: '' };
      if (args[0] === 'rev-parse') return { stdout: '/repo/.git\n', stderr: '' };
      return { stdout: '', stderr: '' };
    };

    const { hooksDir } = await installPrePushHook({
      worktreePath: '/wt',
      baseBranch: 'main',
      exec,
    });

    expect(hooksDir).toBe(join(gitDir, 'fractory-hooks'));
    expect(await readFile(join(hooksDir, 'pre-push'), 'utf8')).toContain(
      "repo_hook='/repo/.git/hooks/pre-push'",
    );
    expect(calls).toContainEqual(['config', '--worktree', 'core.hooksPath', hooksDir]);
  });

  it('installs a hook that protects the Run base branch', async () => {
    const gitDir = await mkdtemp(join(tmpdir(), 'gitdir-'));
    const exec: Exec = async (_file, args) => {
      if (args[0] === 'rev-parse' && args[1] === '--absolute-git-dir')
        return { stdout: `${gitDir}\n`, stderr: '' };
      if (args[0] === 'rev-parse') return { stdout: '/repo/.git\n', stderr: '' };
      return { stdout: '', stderr: '' };
    };
    const { hooksDir } = await installPrePushHook({
      worktreePath: '/wt',
      baseBranch: 'main',
      runBaseBranch: 'fractory/4-astro',
      exec,
    });
    expect(await readFile(join(hooksDir, 'pre-push'), 'utf8')).toContain(
      'refs/heads/main|refs/heads/fractory/4-astro|refs/heads/master)',
    );
  });
  it('writes the shared worktreeConfig flag only once and retries a busy config lock', async () => {
    const gitDir = await mkdtemp(join(tmpdir(), 'gitdir-'));
    const calls: string[][] = [];
    let locked = 2;
    const exec: Exec = async (_file, args) => {
      calls.push(args);
      if (args[0] === 'rev-parse' && args[1] === '--absolute-git-dir')
        return { stdout: `${gitDir}\n`, stderr: '' };
      if (args[0] === 'rev-parse') return { stdout: '/repo/.git\n', stderr: '' };
      if (args.includes('--get')) return { stdout: 'true\n', stderr: '' };
      if (args.includes('--worktree') && locked-- > 0) {
        throw Object.assign(new Error('git failed'), {
          stderr: 'error: could not lock config file .git/config: File exists',
        });
      }
      return { stdout: '', stderr: '' };
    };
    const sleeps: number[] = [];
    await installPrePushHook({
      worktreePath: '/wt',
      baseBranch: 'main',
      exec,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(calls).not.toContainEqual(['config', 'extensions.worktreeConfig', 'true']);
    expect(calls.filter((a) => a.includes('--worktree'))).toHaveLength(3);
    expect(sleeps).toEqual([100, 200]);
  });

  it('does not retry other git config errors', async () => {
    const gitDir = await mkdtemp(join(tmpdir(), 'gitdir-'));
    const exec: Exec = async (_file, args) => {
      if (args[0] === 'rev-parse' && args[1] === '--absolute-git-dir')
        return { stdout: `${gitDir}\n`, stderr: '' };
      if (args[0] === 'rev-parse') return { stdout: '/repo/.git\n', stderr: '' };
      if (args.includes('--get')) throw new Error('unset');
      if (args[0] === 'config')
        throw Object.assign(new Error('boom'), { stderr: 'fatal: bad config' });
      return { stdout: '', stderr: '' };
    };
    await expect(
      installPrePushHook({ worktreePath: '/wt', baseBranch: 'main', exec, sleep: async () => {} }),
    ).rejects.toThrow('boom');
  });

  it('never chains to itself when a Run reuses a worktree whose hooksPath is already ours', async () => {
    const gitDir = await mkdtemp(join(tmpdir(), 'gitdir-'));
    const ours = join(gitDir, 'fractory-hooks');
    const exec: Exec = async (_file, args) => {
      const key = args.join(' ');
      if (key === 'rev-parse --absolute-git-dir') return { stdout: `${gitDir}\n`, stderr: '' };
      if (key.startsWith('rev-parse --path-format=absolute --git-common-dir'))
        return { stdout: '/repo/.git\n', stderr: '' };
      // What `--git-path hooks/pre-push` would wrongly return here; it must not be asked.
      if (key.startsWith('rev-parse --git-path'))
        return { stdout: `${ours}/pre-push\n`, stderr: '' };
      if (key === 'config --local --get core.hooksPath') return { stdout: `${ours}\n`, stderr: '' };
      return { stdout: '', stderr: '' };
    };
    for (let i = 0; i < 2; i++) {
      await installPrePushHook({ worktreePath: '/wt', baseBranch: 'main', exec });
    }
    const script = await readFile(join(ours, 'pre-push'), 'utf8');
    expect(script).toContain("repo_hook=''");
    const result = await runHook(script, gitDir, line('refs/heads/fractory/1'));
    expect(result.status).toBe(0);
  });

  it("chains to the repo's configured hooksPath (e.g. husky), resolved from the worktree", async () => {
    const gitDir = await mkdtemp(join(tmpdir(), 'gitdir-'));
    const exec: Exec = async (_file, args) => {
      const key = args.join(' ');
      if (key === 'rev-parse --absolute-git-dir') return { stdout: `${gitDir}\n`, stderr: '' };
      if (key.startsWith('rev-parse --path-format')) return { stdout: '/repo/.git\n', stderr: '' };
      if (key === 'config --local --get core.hooksPath') return { stdout: '.husky\n', stderr: '' };
      return { stdout: '', stderr: '' };
    };
    const { hooksDir } = await installPrePushHook({
      worktreePath: '/wt',
      baseBranch: 'main',
      exec,
    });
    expect(await readFile(join(hooksDir, 'pre-push'), 'utf8')).toContain(
      "repo_hook='/wt/.husky/pre-push'",
    );
  });
});
