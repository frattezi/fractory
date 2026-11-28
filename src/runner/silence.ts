/**
 * Sandcastle stops an agent that prints nothing for `idleTimeoutSeconds` with an
 * `AgentIdleTimeoutError`. It does not export the class, and `Effect.runPromise` rethrows it as a
 * `FiberFailure` named `(FiberFailure) AgentIdleTimeoutError`, so it is recognised by its tag,
 * its name or the message Sandcastle gives it.
 */
export const isIdleTimeout = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null) return false;
  const { _tag, name, message } = error as { _tag?: unknown; name?: unknown; message?: unknown };
  return (
    _tag === 'AgentIdleTimeoutError' ||
    (typeof name === 'string' && name.includes('AgentIdleTimeoutError')) ||
    (typeof message === 'string' && /^Agent idle for [\d.]+ seconds/.test(message))
  );
};

/** What a Run stopped for silence left behind, as read from its worktree. */
export interface LeftWork {
  /** `<short sha> <subject>` of each commit on the branch that no remote has. */
  commits: string[];
  /** Paths `git status --porcelain` reports as changed and not committed. */
  uncommitted: string[];
}

export interface SilenceReport {
  idleTimeoutSeconds: number;
  branch: string;
  worktreePath: string;
  /** Undefined when the worktree could not be read: then nothing is claimed about it. */
  left: LeftWork | undefined;
  /** Why the worktree could not be read. */
  readError?: string;
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * The summary of a Run stopped for silence: says it was stopped rather than failed, names the
 * setting to change and states what work was left unpushed and where it is.
 */
export const silenceSummary = ({
  idleTimeoutSeconds,
  branch,
  worktreePath,
  left,
  readError,
}: SilenceReport): string => {
  const parts = [
    `Stopped for silence, not failed: the agent printed nothing for ${idleTimeoutSeconds} seconds, which is usually a long command such as the test suite still running.`,
    `Raise idleTimeoutSeconds in .fractory.json (now ${idleTimeoutSeconds}) if this repository needs longer, then re-run the Ticket.`,
  ];
  if (left === undefined) {
    parts.push(
      `Nothing was pushed, and what the Run left could not be read (${readError ?? 'unknown error'}); look in ${worktreePath} on ${branch}.`,
    );
    return parts.join(' ');
  }
  if (left.commits.length > 0) {
    parts.push(
      `Nothing was pushed: ${plural(left.commits.length, 'commit')} on ${branch} never reached a remote (${left.commits.join('; ')}). They are kept on ${branch} in ${worktreePath}, and a Re-run continues from them.`,
    );
  } else {
    parts.push(
      `Nothing was pushed, and ${branch} has no commits that are not already on a remote.`,
    );
  }
  if (left.uncommitted.length > 0) {
    parts.push(
      `Uncommitted changes to ${plural(left.uncommitted.length, 'file')} are left in ${worktreePath} (${left.uncommitted.join(', ')}).`,
    );
  }
  return parts.join(' ');
};
