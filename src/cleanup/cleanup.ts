import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { FactoryConfig } from '../contracts/factory-config.ts';
import type { RunRecord } from '../contracts/run.ts';
import type { Exec } from '../github/exec.ts';
import type { Gh } from '../github/gh.ts';
import type { RunRegistry } from '../registry/registry.ts';
import { remoteFor, repoOfPrUrl } from '../runner/remote.ts';
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
 * After a merged PR's worktree is gone, deletes its Run branch locally and on the remote that
 * points at the PR's repo (in a fork `origin` may be the upstream project). A squash
 * merge leaves the branch unmerged in git's eyes, hence `-D`. Failures only warn: the branch may
 * already be gone, and nothing depends on it.
 */
const OpenPrsSchema = z.array(z.object({ number: z.number().int() }));

/**
 * Points every open PR stacked on `branch` at `base`, because GitHub closes a PR whose base branch
 * is deleted. False when any of them could not be read or retargeted: the branch must then stay.
 */
const retargetStacked = async (
  deps: CleanupDeps,
  run: RunRecord,
  repo: string,
  base: string,
): Promise<boolean> => {
  try {
    const open = OpenPrsSchema.parse(
      JSON.parse(
        await deps.exec('gh', [
          'pr',
          'list',
          '--repo',
          repo,
          '--base',
          run.branch,
          '--state',
          'open',
          '--json',
          'number',
        ]),
      ),
    );
    for (const pr of open) {
      await deps.exec('gh', ['pr', 'edit', String(pr.number), '--repo', repo, '--base', base]);
      deps.log.info(`retargeted PR #${pr.number} from ${run.branch} to ${base}`);
    }
    return true;
  } catch (error) {
    deps.log.warn(
      `could not retarget the PRs stacked on ${run.branch}: ${(error as Error).message}`,
    );
    return false;
  }
};

const deleteRunBranch = async (deps: CleanupDeps, run: RunRecord, base: string): Promise<void> => {
  if (!run.branch.startsWith(RUN_BRANCH_PREFIX)) return;
  const steps: [string, string[]][] = [['local', ['-C', run.repoPath, 'branch', '-D', run.branch]]];
  const repo = run.prUrl ? repoOfPrUrl(run.prUrl) : undefined;
  let remote: string | undefined;
  try {
    remote = repo
      ? remoteFor(await deps.exec('git', ['-C', run.repoPath, 'remote', '-v']), repo)
      : undefined;
  } catch (error) {
    deps.log.warn(`could not list the remotes of ${run.repoPath}: ${(error as Error).message}`);
  }
  if (remote && repo && (await retargetStacked(deps, run, repo, base))) {
    steps.push(['remote', ['-C', run.repoPath, 'push', remote, '--delete', run.branch]]);
  } else if (remote) deps.log.warn(`${run.branch} kept on ${remote}`);
  else deps.log.warn(`no remote points at ${repo ?? 'the PR repo'}; ${run.branch} kept there`);
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
      let mergedBase = '';
      if (latest.prUrl) {
        try {
          const view = await deps.gh.viewPr(latest.repoPath, latest.prUrl);
          merged = view.state === 'MERGED';
          mergedBase = view.baseRefName;
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
      if (merged) await deleteRunBranch(deps, latest, mergedBase);
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
