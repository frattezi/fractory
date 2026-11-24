import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RepoConfigSchema } from '../src/contracts/repo-config.ts';
import { buildRepoConfig, initRepo } from '../src/package/init.ts';

const tmp = () => mkdtemp(join(tmpdir(), 'init-'));

describe('initRepo', () => {
  it('writes a valid github config with defaults applied', async () => {
    const repoPath = await tmp();
    const { path } = await initRepo({
      repoPath,
      mode: 'personal',
      hasCi: true,
      github: 'me/repo',
    });
    const written = RepoConfigSchema.parse(JSON.parse(await readFile(path, 'utf8')));
    expect(written).toMatchObject({
      mode: 'personal',
      ticketSource: { kind: 'github', repo: 'me/repo' },
      baseBranch: 'main',
      maxIterations: 10,
      ticketGate: false,
    });
  });

  it('builds a jira config with statuses and optional fields', () => {
    const config = buildRepoConfig({
      repoPath: '/x',
      mode: 'work',
      hasCi: true,
      jira: {
        baseUrl: 'https://acme.atlassian.net',
        projectKey: 'ABC',
        statuses: { ready: 'Ready', inProgress: 'Doing', inReview: 'Review', done: 'Done' },
      },
      baseBranch: 'develop',
      sandboxImage: 'img:1',
      maxIterations: 5,
    });
    expect(config).toMatchObject({
      baseBranch: 'develop',
      sandboxImage: 'img:1',
      maxIterations: 5,
    });
  });

  it('rejects invalid input and writes nothing', async () => {
    const repoPath = await tmp();
    await expect(
      initRepo({ repoPath, mode: 'personal', hasCi: true, github: 'not-a-repo' }),
    ).rejects.toThrow();
    await expect(initRepo({ repoPath, mode: 'personal', hasCi: true })).rejects.toThrow(
      /exactly one/,
    );
    await expect(
      initRepo({ repoPath, mode: 'personal', hasCi: true, github: 'a/b', maxIterations: 0 }),
    ).rejects.toThrow();
    await expect(readFile(join(repoPath, '.fractory.json'), 'utf8')).rejects.toThrow();
  });

  it('refuses to overwrite unless force is set', async () => {
    const repoPath = await tmp();
    const file = join(repoPath, '.fractory.json');
    await writeFile(file, '{"keep":true}');
    const opts = { repoPath, mode: 'personal', hasCi: false, github: 'a/b' } as const;
    await expect(initRepo(opts)).rejects.toThrow(/already exists/);
    expect(await readFile(file, 'utf8')).toBe('{"keep":true}');
    await initRepo({ ...opts, force: true });
    expect(JSON.parse(await readFile(file, 'utf8')).hasCi).toBe(false);
  });
});
