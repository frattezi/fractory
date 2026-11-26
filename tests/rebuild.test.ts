import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type CliEnv, main } from '../src/cli.ts';
import { loadRepoConfig } from '../src/config/index.ts';
import { RepoConfigSchema } from '../src/contracts/repo-config.ts';
import { rebuild } from '../src/rebuild/rebuild.ts';

const base = { mode: 'personal', ticketSource: { kind: 'github', repo: 'me/app' }, hasCi: false };

const setup = async (repos: Record<string, string[] | undefined>, exitCodes: number[] = []) => {
  const root = await mkdtemp(join(tmpdir(), 'fractory-rebuild-'));
  const paths: Record<string, string> = {};
  for (const [name, list] of Object.entries(repos)) {
    const path = join(root, name);
    await mkdir(path);
    await writeFile(
      join(path, '.fractory.json'),
      JSON.stringify({ ...base, ...(list && { rebuild: list }) }),
    );
    paths[name] = path;
  }
  const calls: { command: string; cwd: string }[] = [];
  const out: string[] = [];
  const codes = [...exitCodes];
  const deps = {
    repos: Object.values(paths),
    loadRepoConfig,
    runShell: async (command: string, cwd: string) => {
      calls.push({ command, cwd });
      return codes.shift() ?? 0;
    },
    out: (line: string) => out.push(line),
  };
  return { root, paths, calls, out, deps };
};

describe('rebuild contract', () => {
  it('is optional, absent by default, and rejects empty commands', () => {
    expect(RepoConfigSchema.parse(base).rebuild).toBeUndefined();
    expect(RepoConfigSchema.parse({ ...base, rebuild: ['make'] }).rebuild).toEqual(['make']);
    expect(RepoConfigSchema.safeParse({ ...base, rebuild: [''] }).success).toBe(false);
  });
});

describe('rebuild', () => {
  it('runs every repo with a list in config order, from its root, and skips the rest', async () => {
    const { paths, calls, out, deps } = await setup({
      a: ['pnpm install', 'pnpm typecheck'],
      b: undefined,
      c: ['make build', 'install -m 755 x ~/.local/bin/x'],
    });
    await rebuild(deps);
    expect(calls).toEqual([
      { command: 'pnpm install', cwd: paths.a },
      { command: 'pnpm typecheck', cwd: paths.a },
      { command: 'make build', cwd: paths.c },
      { command: 'install -m 755 x ~/.local/bin/x', cwd: paths.c },
    ]);
    expect(out.filter((l) => l.startsWith('==>'))).toEqual([
      `==> Rebuilding ${paths.a}`,
      `==> Rebuilding ${paths.c}`,
    ]);
  });

  it('runs only the named repos', async () => {
    const { paths, calls, deps } = await setup({ a: ['one'], b: ['two'] });
    await rebuild(deps, [paths.b as string]);
    expect(calls).toEqual([{ command: 'two', cwd: paths.b }]);
  });

  it('fails before running anything when a named path is not configured or has no list', async () => {
    const { root, paths, calls, deps } = await setup({ a: ['one'], b: undefined });
    await expect(rebuild(deps, [paths.a as string, join(root, 'nope')])).rejects.toThrow(
      /nope is not a configured repo/,
    );
    await expect(rebuild(deps, [paths.a as string, paths.b as string])).rejects.toThrow(
      /declares no rebuild list/,
    );
    expect(calls).toEqual([]);
  });

  it('stops at the first failing command, names it, and leaves later repos untouched', async () => {
    const { paths, calls, deps } = await setup({ a: ['ok', 'bad', 'never'], b: ['later'] }, [0, 2]);
    await expect(rebuild(deps)).rejects.toThrow(`${paths.a}: \`bad\` exited with status 2`);
    expect(calls.map((c) => c.command)).toEqual(['ok', 'bad']);
  });
});

describe('fractory rebuild CLI', () => {
  const cliEnv = async (repos: Record<string, string[] | undefined>, exitCodes: number[] = []) => {
    const ctx = await setup(repos, exitCodes);
    const configPath = join(ctx.root, 'config.json');
    await writeFile(configPath, JSON.stringify({ repos: ctx.deps.repos, resources: false }));
    const fail = () => {
      throw new Error('not used by rebuild');
    };
    const execCalls: string[] = [];
    const env = {
      out: ctx.deps.out,
      cwd: ctx.root,
      factoryConfigPath: configPath,
      runShell: ctx.deps.runShell,
      exec: async (cmd: string) => {
        execCalls.push(cmd);
        return '';
      },
      gh: fail,
    } as unknown as CliEnv;
    return { ...ctx, env, execCalls };
  };

  it('resolves relative paths, exits 0, and runs no git', async () => {
    const { calls, env, paths, execCalls } = await cliEnv({ a: ['one'], b: ['two'] });
    expect(await main(['rebuild', 'b'], env)).toBe(0);
    expect(calls).toEqual([{ command: 'two', cwd: paths.b }]);
    expect(execCalls).toEqual([]);
  });

  it('exits non-zero on an unknown path and on a failing command', async () => {
    const { env } = await cliEnv({ a: ['one'] }, [1]);
    expect(await main(['rebuild', 'missing'], env)).toBe(1);
    expect(await main(['rebuild'], env)).toBe(1);
  });

  it('is listed in the help and reported by config show', async () => {
    const { env, out, paths } = await cliEnv({ a: ['one'] });
    expect(await main(['help'], env)).toBe(0);
    expect(out[0]).toContain('rebuild [repoPath...]');
    expect(await main(['config', 'show', paths.a as string], env)).toBe(0);
    expect(JSON.parse(out[1] as string).rebuild).toEqual(['one']);
  });
});
