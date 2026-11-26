import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import type { RepoConfig } from '../contracts/repo-config.ts';

/** Runs one command through a shell in `cwd`, output streamed; resolves with the exit code. */
export type RunShell = (command: string, cwd: string) => Promise<number>;

export const defaultRunShell: RunShell = (command, cwd) =>
  new Promise((done, fail) => {
    const child = spawn(command, { cwd, shell: true, stdio: 'inherit' });
    child.on('error', fail);
    child.on('close', (code, signal) => done(code ?? (signal ? 1 : 0)));
  });

export interface RebuildDeps {
  repos: string[];
  loadRepoConfig: (repoPath: string) => Promise<RepoConfig>;
  runShell: RunShell;
  out: (line: string) => void;
}

/**
 * Runs each repo's `rebuild` commands in order from the repo root. With `only`, just those repos,
 * each of which must be configured and declare a list. Stops at the first failing command.
 * Performs no git operation: whatever is checked out is built as it stands.
 */
export const rebuild = async (deps: RebuildDeps, only: string[] = []): Promise<void> => {
  const configured = new Map(deps.repos.map((repo) => [resolve(repo), repo]));
  let targets: string[];
  if (only.length === 0) {
    targets = deps.repos;
  } else {
    targets = only.map((path) => {
      const repo = configured.get(resolve(path));
      if (repo === undefined) throw new Error(`${path} is not a configured repo`);
      return repo;
    });
  }

  const plan: { repo: string; commands: string[] }[] = [];
  for (const repo of targets) {
    const commands = (await deps.loadRepoConfig(repo)).rebuild;
    if (commands === undefined || commands.length === 0) {
      if (only.length > 0) throw new Error(`${repo} declares no rebuild list in .fractory.json`);
      continue;
    }
    plan.push({ repo, commands });
  }

  for (const { repo, commands } of plan) {
    deps.out(`==> Rebuilding ${repo}`);
    for (const command of commands) {
      deps.out(`$ ${command}`);
      const code = await deps.runShell(command, repo);
      if (code !== 0) throw new Error(`${repo}: \`${command}\` exited with status ${code}`);
    }
  }
};
