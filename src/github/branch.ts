import type { RepoConfig } from '../contracts/repo-config.ts';
import { remoteFor } from '../runner/remote.ts';
import { type Exec, defaultExec } from './exec.ts';

/**
 * Reads the tip sha of `branch` on the repository's remote. Resolves `undefined` only when the
 * remote answered that it has no such branch; any failed read rejects, because it proves nothing.
 */
export type BranchTip = (
  repoPath: string,
  config: Pick<RepoConfig, 'ticketSource'>,
  branch: string,
) => Promise<string | undefined>;

const SHA = /^[0-9a-f]{7,64}$/i;

/** `git ls-remote` on the remote a Run pushes to: the one pointing at the GitHub repo, or `origin`. */
export const createBranchTip =
  (exec: Exec = defaultExec): BranchTip =>
  async (repoPath, config, branch) => {
    let remote = 'origin';
    if (config.ticketSource.kind === 'github') {
      const { repo } = config.ticketSource;
      const found = remoteFor(await exec('git', ['remote', '-v'], { cwd: repoPath }), repo);
      if (!found) throw new Error(`no git remote of ${repoPath} points at ${repo}`);
      remote = found;
    }
    const ref = `refs/heads/${branch}`;
    const out = await exec('git', ['ls-remote', '--heads', remote, ref], { cwd: repoPath });
    for (const line of out.split('\n')) {
      const [sha, name] = line.trim().split(/\s+/);
      if (name !== ref) continue;
      if (!sha || !SHA.test(sha)) throw new Error(`git ls-remote returned no sha for ${branch}`);
      return sha;
    }
    return undefined;
  };
