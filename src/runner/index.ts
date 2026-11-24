import type { RepoConfig } from '../contracts/repo-config.ts';
import type { RunRecord } from '../contracts/run.ts';

/**
 * Starts a queued Run as a detached host process and returns once it is running.
 * Implemented in spec part C.
 */
export const launchRun = async (_record: RunRecord, _config: RepoConfig): Promise<void> => {
  throw new Error('not implemented');
};
