/** `https://github.com/o/r(.git)`, `git@github.com:o/r(.git)` or `ssh://git@github.com/o/r(.git)` -> `o/r`. */
export const githubRepoOf = (url: string): string | undefined => {
  const match = url
    .trim()
    .match(/^(?:https:\/\/|ssh:\/\/git@|git@)github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i);
  return match?.[1]?.toLowerCase();
};

/**
 * The git remote that points at `repo` (`owner/name`), read from `git remote -v` output. `origin`
 * wins when it matches; in a fork `origin` may be the upstream project, which Fractory must never
 * push to.
 */
export const remoteFor = (remoteVerbose: string, repo: string): string | undefined => {
  const wanted = repo.toLowerCase();
  const matching = new Set<string>();
  for (const line of remoteVerbose.split('\n')) {
    const [name, url, kind] = line.trim().split(/\s+/);
    if (name && url && kind === '(push)' && githubRepoOf(url) === wanted) matching.add(name);
  }
  return matching.has('origin') ? 'origin' : [...matching][0];
};

/** `https://github.com/o/r/pull/12` -> `o/r`. */
export const repoOfPrUrl = (prUrl: string): string | undefined =>
  prUrl.match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/\d+/i)?.[1];
