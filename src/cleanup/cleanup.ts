import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { FactoryConfig } from '../contracts/factory-config.ts';
import type { RunRecord } from '../contracts/run.ts';
import type { Exec } from '../github/exec.ts';
import type { Gh } from '../github/gh.ts';
import type { RunRegistry } from '../registry/registry.ts';
import type { Logger } from '../trigger/support.ts';

export interface CleanupDeps {
  factory: FactoryConfig;
  registry: RunRegistry;
  gh: Gh;
  /** Used for `git` only. */
  exec: Exec;
  now(): Date;
  log: Logger;
}

export interface CleanupResult {
  removed: string[];
  skipped: { runId: string; worktreePath: string; reason: string }[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Only branches Fractory named itself are ever deleted. */
const RUN_BRANCH_PREFIX = 'fractory/';

/**
 * After a merged PR's worktree is gone, deletes its Run branch locally and on `origin`. A squash
 * merge leaves the branch unmerged in git's eyes, hence `-D`. Failures only warn: the branch may
 * already be gone, and nothing depends on it.
 */
const deleteRunBranch = async (deps: CleanupDeps, run: RunRecord): Promise<void> => {
  if (!run.branch.startsWith(RUN_BRANCH_PREFIX)) return;
  const steps: [string, string[]][] = [
    ['local', ['-C', run.repoPath, 'branch', '-D', run.branch]],
    ['remote', ['-C', run.repoPath, 'push', 'origin', '--delete', run.branch]],
  ];
  for (const [where, args] of steps) {
    try {
      await deps.exec('git', args);
    } catch (error) {
      deps.log.warn(`could not delete ${where} branch ${run.branch}: ${(error as Error).message}`);
    }
  }
};

const pathExists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

/**
 * Deletes a Run's worktree only when it is clean and its PR is merged, or when the Run failed more
 * than `staleWorktreeDays` ago. Worktrees are matched by the recorded `worktreePath`, never by name.
 * A failed read (PR state, git status) proves nothing, so it skips and tries again next time.
 */
export const cleanup = async (deps: CleanupDeps): Promise<CleanupResult> => {
  const { factory, log } = deps;
  const result: CleanupResult = { removed: [], skipped: [] };
  const runs = await deps.registry.list();
  const staleMs = factory.staleWorktreeDays * DAY_MS;

  const byPath = new Map<string, RunRecord[]>();
  for (const run of runs) {
    if (!run.worktreePath || !factory.repos.includes(run.repoPath)) continue;
    const path = resolve(run.worktreePath);
    byPath.set(path, [...(byPath.get(path) ?? []), run]);
  }

  for (const [path, group] of byPath) {
    const latest = [...group].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
    if (!latest) continue;
    const skip = (reason: string, record = true): void => {
      if (record) {
        result.skipped.push({ runId: latest.id, worktreePath: path, reason });
        log.info(`cleanup skipped ${path}: ${reason}`);
      }
    };
    if (latest.cleanedAt) continue;
    try {
      if (!(await pathExists(path))) {
        skip('already gone', false);
        continue;
      }
      if (path === resolve(latest.repoPath)) {
        skip('worktree path is the main checkout');
        continue;
      }
      if (group.some((r) => r.status === 'queued' || r.status === 'running')) {
        skip('a Run is still active on it');
        continue;
      }

      const failedAndStale =
        latest.status === 'failed' &&
        latest.finishedAt !== undefined &&
        deps.now().getTime() - new Date(latest.finishedAt).getTime() > staleMs;

      let merged = false;
      if (latest.prUrl) {
        try {
          merged = (await deps.gh.viewPr(latest.repoPath, latest.prUrl)).state === 'MERGED';
        } catch (error) {
          if (!failedAndStale) {
            skip(`PR state unreadable: ${(error as Error).message}`);
            continue;
          }
        }
      }

      let force = false;
      if (merged) {
        const status = await deps.exec('git', ['-C', path, 'status', '--porcelain']);
        if (status.trim() !== '') {
          skip('PR merged but the worktree has uncommitted changes');
          continue;
        }
      } else if (failedAndStale) {
        force = true;
      } else {
        skip('PR not merged and Run not stale-failed');
        continue;
      }

      await deps.exec('git', [
        '-C',
        latest.repoPath,
        'worktree',
        'remove',
        ...(force ? ['--force'] : []),
        path,
      ]);
      const stamp = deps.now().toISOString();
      for (const run of group) await deps.registry.update(run.id, { cleanedAt: stamp });
      result.removed.push(path);
      if (merged) await deleteRunBranch(deps, latest);
      log.info(`removed worktree ${path} (${merged ? 'PR merged' : 'stale failed Run'})`);
    } catch (error) {
      skip(`error: ${(error as Error).message}`);
    }
  }

  for (const repo of factory.repos) {
    try {
      await deps.exec('git', ['-C', repo, 'worktree', 'prune']);
    } catch (error) {
      log.warn(`git worktree prune failed in ${repo}: ${(error as Error).message}`);
    }
  }
  return result;
};
