import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { type CliEnv, main } from '../src/cli.ts';
import type { AgentRunRequest, SandcastleAdapter } from '../src/runner/types.ts';

const setup = async (repoConfig: Record<string, unknown>, keychain = true) => {
  const root = await mkdtemp(join(tmpdir(), 'fractory-agents-'));
  const repo = join(root, 'repo');
  const other = join(root, 'checkout');
  await mkdir(repo);
  await mkdir(other);
  await writeFile(
    join(repo, '.fractory.json'),
    JSON.stringify({
      ticketSource: { kind: 'github', repo: 'me/app' },
      hasCi: true,
      ...repoConfig,
    }),
  );
  await writeFile(join(root, 'prompt.md'), 'Review this.');
  const registryDir = join(root, 'runs');
  await writeFile(
    join(root, 'config.json'),
    JSON.stringify({
      repos: [repo],
      registryDir,
      logDir: join(root, 'logs'),
      resources: { cpusPerRun: 3 },
    }),
  );
  const requests: AgentRunRequest[] = [];
  const providers: { model: string; env: Record<string, string> }[] = [];
  const sandboxes: { image: string | undefined; cpus: number | undefined }[] = [];
  const keychainReads: string[] = [];
  const sandcastle = {
    sandbox: (image: string | undefined, cpus?: number) => {
      sandboxes.push({ image, cpus });
      return { name: 'docker' };
    },
    claudeCode: (model: string, o: { env?: Record<string, string> }) => {
      const provider = { model, env: o.env ?? {} };
      providers.push(provider);
      return provider;
    },
    run: async (request: AgentRunRequest) => {
      requests.push(request);
      return { stdout: 'FINDINGS', iterations: 2 };
    },
  } as unknown as SandcastleAdapter;
  const out: string[] = [];
  const env = {
    out: (l: string) => out.push(l),
    cwd: root,
    factoryConfigPath: join(root, 'config.json'),
    newId: () => 'id1',
    agents: {
      sandcastle: async () => sandcastle,
      exec: async (file: string, args: string[]) => {
        keychainReads.push(`${file} ${args.join(' ')}`);
        if (!keychain) throw Object.assign(new Error('nope'), { code: 44 });
        return { stdout: 'secret-token\n', stderr: '' };
      },
    },
  } as unknown as CliEnv;
  return {
    root,
    repo,
    other,
    env,
    out,
    requests,
    providers,
    sandboxes,
    keychainReads,
    registryDir,
  };
};

const argv = (s: { repo: string; root: string }, ...extra: string[]) => [
  'errand',
  '--repo',
  s.repo,
  '--prompt-file',
  'prompt.md',
  ...extra,
];

describe('fractory errand', () => {
  it('runs in the given directory, prints the output and uses an absolute prompt path', async () => {
    const s = await setup({ mode: 'work' });
    expect(await main(argv(s, '--cwd', s.other), s.env)).toBe(0);
    expect(s.out).toEqual(['FINDINGS']);
    expect(s.requests[0]?.cwd).toBe(s.other);
    expect(isAbsolute(s.requests[0]?.promptFile ?? '')).toBe(true);
    expect(s.requests[0]?.promptFile).toBe(join(s.root, 'prompt.md'));
  });

  it('defaults the directory to the repository', async () => {
    const s = await setup({ mode: 'work' });
    await main(argv(s), s.env);
    expect(s.requests[0]?.cwd).toBe(s.repo);
  });

  it('puts a Work repository on the work Account, credentials last, whatever the environment says', async () => {
    const s = await setup({ mode: 'work' });
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'personal-from-env');
    try {
      await main(argv(s), s.env);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(s.keychainReads).toEqual(['security find-generic-password -s fractory.claude.work -w']);
    expect(s.providers[0]?.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('secret-token');
  });

  it('puts a Personal repository on the personal Account, and --json says so', async () => {
    const s = await setup({ mode: 'personal' });
    await main(argv(s, '--json', '--model', 'm-1'), s.env);
    expect(s.keychainReads[0]).toContain('fractory.claude.personal');
    const json = JSON.parse(s.out[0] ?? '');
    expect(json).toMatchObject({
      text: 'FINDINGS',
      model: 'm-1',
      account: 'personal',
      sandboxed: false,
      iterations: 2,
    });
    expect(json.logPath).toBe(join(s.root, 'logs', 'agent-id1.log'));
  });

  it('runs in the declared image with the CPU cap, or without a sandbox', async () => {
    const withImage = await setup({ mode: 'work', sandboxImage: 'img:1' });
    await main(argv(withImage), withImage.env);
    expect(withImage.sandboxes).toEqual([{ image: 'img:1', cpus: 3 }]);
    expect(withImage.requests[0]?.sandbox).toBeDefined();
    const without = await setup({ mode: 'work' });
    await main(argv(without), without.env);
    expect(without.sandboxes).toEqual([]);
    expect(without.requests[0]?.sandbox).toBeUndefined();
  });

  it('logs under the log directory and leaves the Run registry alone', async () => {
    const s = await setup({ mode: 'work' });
    await main(argv(s, '--name', 'rev/1'), s.env);
    expect(s.requests[0]?.logPath).toBe(join(s.root, 'logs', 'agent-rev-1-id1.log'));
    expect(s.requests[0]?.name).toBe('rev/1');
    await expect(readdir(s.registryDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses with the fix when the Keychain item is missing', async () => {
    const s = await setup({ mode: 'work' }, false);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await main(argv(s), s.env)).toBe(1);
    expect(err.mock.calls[0]?.[0]).toContain(
      'security add-generic-password -s fractory.claude.work',
    );
    expect(s.requests).toEqual([]);
    err.mockRestore();
  });

  it('refuses an unreadable prompt file before touching the Keychain', async () => {
    const s = await setup({ mode: 'work' });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(
      await main(['errand', '--repo', s.repo, '--prompt-file', 'missing.md'], s.env),
    ).toBe(1);
    expect(s.keychainReads).toEqual([]);
    err.mockRestore();
  });
});
