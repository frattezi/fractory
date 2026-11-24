import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import type { Exec } from './exec.ts';

const SAFE_BRANCH = /^\w[\w./-]*$/;

/** Branches no Run may ever push to, whatever the repository's base branch is. */
export const protectedBranches = (baseBranch: string): string[] => [
  ...new Set([baseBranch, 'main', 'master']),
];

/**
 * A `pre-push` hook that refuses pushes to the base branch, `main` and `master`, then hands the
 * same arguments and stdin to the repository's own `pre-push` hook (when it has one).
 */
export const renderPrePushHook = (options: {
  baseBranch: string;
  repoHookPath: string;
}): string => {
  const { baseBranch, repoHookPath } = options;
  for (const name of protectedBranches(baseBranch)) {
    // The names are embedded in a shell script: refuse anything that is not a plain branch name.
    if (!SAFE_BRANCH.test(name)) throw new Error(`Unsafe branch name for hook: ${name}`);
  }
  if (repoHookPath.includes("'")) throw new Error(`Unsafe hook path: ${repoHookPath}`);
  const cases = protectedBranches(baseBranch)
    .map((name) => `refs/heads/${name}`)
    .join('|');
  return `#!/bin/sh
# Installed for a Run: it must never push to the base branch, main or master.
input=$(cat)
while read -r local_ref local_sha remote_ref remote_sha; do
  case "$remote_ref" in
    ${cases})
      echo "pre-push: refusing to push to \${remote_ref#refs/heads/}" >&2
      exit 1
      ;;
  esac
done <<EOF_FRACTORY
$input
EOF_FRACTORY
repo_hook='${repoHookPath}'
if [ -x "$repo_hook" ]; then
  printf '%s\\n' "$input" | "$repo_hook" "$@"
  exit $?
fi
exit 0
`;
};

export interface InstalledHook {
  /** Directory used as `core.hooksPath` for the worktree. */
  hooksDir: string;
}

/**
 * Installs the hook in the worktree's private git dir and points the worktree's
 * `core.hooksPath` at it, so the repository's own hooks directory is left untouched.
 */
export const installPrePushHook = async (options: {
  worktreePath: string;
  baseBranch: string;
  exec: Exec;
}): Promise<InstalledHook> => {
  const { worktreePath, baseBranch, exec } = options;
  const git = async (...args: string[]): Promise<string> =>
    (await exec('git', args, { cwd: worktreePath })).stdout.trim();

  const gitDir = await git('rev-parse', '--absolute-git-dir');
  const ownHook = await git('rev-parse', '--git-path', 'hooks/pre-push');
  const repoHookPath = isAbsolute(ownHook) ? ownHook : resolve(worktreePath, ownHook);

  const hooksDir = join(gitDir, 'fractory-hooks');
  await mkdir(hooksDir, { recursive: true });
  const hookFile = join(hooksDir, 'pre-push');
  await writeFile(hookFile, renderPrePushHook({ baseBranch, repoHookPath }));
  await chmod(hookFile, 0o755);

  await git('config', 'extensions.worktreeConfig', 'true');
  await git('config', '--worktree', 'core.hooksPath', hooksDir);
  return { hooksDir };
};
