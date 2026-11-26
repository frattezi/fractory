import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import type { Exec } from './exec.ts';

const SAFE_BRANCH = /^\w[\w./-]*$/;

/**
 * Branches no Run may ever push to: the repository's base branch, the branch the Run is built on
 * (when it names one), `main` and `master`.
 */
export const protectedBranches = (baseBranch: string, runBaseBranch?: string): string[] => [
  ...new Set([baseBranch, ...(runBaseBranch ? [runBaseBranch] : []), 'main', 'master']),
];

/**
 * A `pre-push` hook that refuses pushes to the protected branches, then hands the
 * same arguments and stdin to the repository's own `pre-push` hook (when it has one).
 */
export const renderPrePushHook = (options: {
  baseBranch: string;
  /** The branch the Run is built on, when it is not the repository's base branch. */
  runBaseBranch?: string | undefined;
  repoHookPath: string;
}): string => {
  const { baseBranch, runBaseBranch, repoHookPath } = options;
  const branches = protectedBranches(baseBranch, runBaseBranch);
  for (const name of branches) {
    // The names are embedded in a shell script: refuse anything that is not a plain branch name.
    if (!SAFE_BRANCH.test(name)) throw new Error(`Unsafe branch name for hook: ${name}`);
  }
  if (repoHookPath.includes("'")) throw new Error(`Unsafe hook path: ${repoHookPath}`);
  const cases = branches.map((name) => `refs/heads/${name}`).join('|');
  return `#!/bin/sh
# Installed for a Run: it must never push to its base branch, main or master.
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

const CONFIG_LOCKED = /could not lock config file/i;

/**
 * Concurrent Runs on one repository share its `.git/config`; git refuses a write while another
 * process holds `config.lock`. The lock is held for milliseconds, so a short retry clears it.
 */
const retryConfigLock = async <T>(
  write: () => Promise<T>,
  sleep: (ms: number) => Promise<void>,
  attempts = 6,
): Promise<T> => {
  for (let attempt = 1; ; attempt++) {
    try {
      return await write();
    } catch (error) {
      const stderr = String((error as { stderr?: unknown }).stderr ?? (error as Error).message);
      if (attempt >= attempts || !CONFIG_LOCKED.test(stderr)) throw error;
      await sleep(100 * attempt);
    }
  }
};

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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
  runBaseBranch?: string | undefined;
  exec: Exec;
  sleep?: (ms: number) => Promise<void>;
}): Promise<InstalledHook> => {
  const { worktreePath, baseBranch, runBaseBranch, exec, sleep = defaultSleep } = options;
  const git = async (...args: string[]): Promise<string> =>
    (await exec('git', args, { cwd: worktreePath })).stdout.trim();

  const gitDir = await git('rev-parse', '--absolute-git-dir');
  const hooksDir = join(gitDir, 'fractory-hooks');
  const hookFile = join(hooksDir, 'pre-push');

  // The repository's own hook, read from the repo config and the shared git dir, never through
  // `--git-path hooks`: once a Run reuses this worktree, that follows the worktree's
  // core.hooksPath to this very hook, which would then call itself until fork() fails.
  const commonDir = await git('rev-parse', '--path-format=absolute', '--git-common-dir');
  const configured = await git('config', '--local', '--get', 'core.hooksPath').catch(() => '');
  const repoHooksDir = configured
    ? isAbsolute(configured)
      ? configured
      : resolve(worktreePath, configured)
    : join(commonDir, 'hooks');
  const candidate = join(repoHooksDir, 'pre-push');
  const repoHookPath = resolve(candidate) === resolve(hookFile) ? '' : candidate;

  await mkdir(hooksDir, { recursive: true });
  await writeFile(hookFile, renderPrePushHook({ baseBranch, runBaseBranch, repoHookPath }));
  await chmod(hookFile, 0o755);

  // Shared by every worktree: write it only once, so parallel Runs rarely touch .git/config.
  const enabled = await git('config', '--get', 'extensions.worktreeConfig').catch(() => '');
  if (enabled !== 'true') {
    await retryConfigLock(() => git('config', 'extensions.worktreeConfig', 'true'), sleep);
  }
  await retryConfigLock(() => git('config', '--worktree', 'core.hooksPath', hooksDir), sleep);
  return { hooksDir };
};
