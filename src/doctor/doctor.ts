import { dirname, resolve } from 'node:path';
import type { Finding } from '../contracts/finding.ts';
import type { HostState } from '../contracts/host-state.ts';
import type { RepoConfig } from '../contracts/repo-config.ts';
import { ACTIVE_STATUSES, type RunRecord } from '../contracts/run.ts';
import type { TicketSource } from '../contracts/ticket.ts';
import { readBlockers, resolveDependencies } from '../policy/dependencies.ts';
import { formatHost, latestPerTicket, repoStatus } from '../status/status.ts';
import { TICK_INTERVAL_SECONDS } from '../trigger/launchd.ts';

/**
 * Everything Doctor reads, injected so tests never touch the machine. Doctor only reads: it
 * performs no git operation that changes anything, starts no Run, writes no file and changes
 * nothing in the tracker.
 */
export interface DoctorReaders {
  /** The configured repository list, `FactoryConfig.repos`. */
  repos: string[];
  /** `~/.fractory/config.json`: its directory names the machine in machine-wide Findings. */
  factoryConfigPath: string;
  staleWorktreeDays: number;
  now: () => Date;
  loadRepoConfig: (repoPath: string) => Promise<RepoConfig>;
  /** Every Run record in the registry. */
  listRuns: () => Promise<RunRecord[]>;
  /** Run ids with an answer request waiting for the next tick. */
  listAnswerRequests: () => Promise<readonly string[]>;
  /** The last tick's host state; `undefined` when none was written or it cannot be read. */
  readHostState: () => Promise<HostState | undefined>;
  /** The repository's tracker, for reads only. */
  ticketSource: (config: RepoConfig) => Pick<TicketSource, 'listReady' | 'get'>;
  /** A read-only `git -C <repoPath> <args>`; resolves with stdout, rejects on failure. */
  git: (repoPath: string, args: string[]) => Promise<string>;
  pathExists: (path: string) => Promise<boolean>;
  /** Whether the launchd tick agent is loaded; `undefined` when that could not be told. */
  launchdLoaded: () => Promise<boolean | undefined>;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Two tick intervals: a state older than this was seen by a tick that should have acted. */
const OVERDUE_MS = 2 * TICK_INTERVAL_SECONDS * 1000;

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Findings about the Runs of one repository, from its `fractory status` view. */
const runFindings = (input: {
  repoPath: string;
  config: RepoConfig;
  repos: string[];
  runs: RunRecord[];
  answeredRunIds: readonly string[];
}): Finding[] => {
  const { repoPath } = input;
  const status = repoStatus({
    repoPath,
    config: input.config,
    factoryRepos: input.repos,
    runs: input.runs,
    answeredRunIds: input.answeredRunIds,
  });
  const findings: Finding[] = [];
  for (const n of status.needsHuman) {
    if (n.reason === 'budget-exhausted') continue;
    findings.push(
      n.answered
        ? {
            kind: 'needs-human',
            repoPath,
            severity: 'informational',
            observed: `${n.ticketRef}: Run ${n.runId} stopped needs-human (${n.reason}) and has been answered: ${n.question}`,
            remedy: 'Nothing to do: the next tick queues the Run that carries the answer.',
          }
        : {
            kind: 'needs-human',
            repoPath,
            severity: 'needs-owner',
            observed: `${n.ticketRef}: Run ${n.runId} stopped needs-human (${n.reason}): ${n.question}`,
            remedy: `Answer the question on Run ${n.runId} in Fractory Manager; the next tick continues ${n.ticketRef} with the answer.`,
          },
    );
  }
  for (const run of latestPerTicket(input.runs, repoPath)) {
    const result = run.result;
    const budget =
      run.status === 'needs-human' &&
      result?.outcome === 'needs-human' &&
      result.reason === 'budget-exhausted';
    if (run.status !== 'failed' && !budget) continue;
    const detail =
      result?.outcome === 'failed'
        ? `: ${result.summary}`
        : result?.outcome === 'needs-human'
          ? `: ${result.question}`
          : '';
    const silence = run.stoppedForSilence;
    const what = budget
      ? 'exhausted its budget'
      : silence
        ? `was stopped for silence after ${silence.idleTimeoutSeconds} seconds`
        : 'failed';
    const raise = budget
      ? ' (or raise maxIterations in .fractory.json)'
      : silence
        ? ' (raise idleTimeoutSeconds in .fractory.json first if a command needs longer)'
        : '';
    findings.push({
      kind: 'run-failed',
      repoPath,
      severity: 'needs-owner',
      observed: `${run.ticketRef}: Run ${run.id} ${what}${detail}`,
      remedy: `Read the log at ${run.logPath}, then \`fractory run ${run.ticketRef}\` to start the Ticket again on ${run.branch}${raise}.`,
    });
  }
  return findings;
};

/** A done Run whose pull request is still open: it waits on a review or a merge. */
const prFindings = (repoPath: string, runs: RunRecord[]): Finding[] =>
  latestPerTicket(runs, repoPath)
    .filter(
      (run) =>
        run.status === 'done' &&
        run.prUrl !== undefined &&
        run.prState !== 'MERGED' &&
        run.prState !== 'CLOSED',
    )
    .map((run) => ({
      kind: 'pr-unmerged',
      repoPath,
      severity: 'needs-owner',
      observed: `${run.ticketRef}: Run ${run.id} is done and its pull request ${run.prUrl} has not merged${run.baseBranch ? ` (it targets ${run.baseBranch})` : ''}.`,
      remedy: `Review it with \`gh pr view ${run.prUrl}\`, then \`gh pr merge ${run.prUrl}\`.`,
    }));

/** Worktrees still on disk more than `staleWorktreeDays` after their latest Run ended. */
const worktreeFindings = async (input: {
  repoPath: string;
  runs: RunRecord[];
  deps: DoctorReaders;
}): Promise<Finding[]> => {
  const { repoPath, deps } = input;
  const byPath = new Map<string, RunRecord[]>();
  for (const run of input.runs) {
    if (!run.worktreePath || resolve(run.repoPath) !== repoPath) continue;
    const path = resolve(run.worktreePath);
    byPath.set(path, [...(byPath.get(path) ?? []), run]);
  }
  const staleMs = deps.staleWorktreeDays * DAY_MS;
  const findings = await Promise.all(
    [...byPath].map(async ([path, group]): Promise<Finding | undefined> => {
      const latest = [...group].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
      if (!latest || latest.cleanedAt || path === repoPath) return;
      if (group.some((r) => ACTIVE_STATUSES.includes(r.status))) return;
      const ended = latest.finishedAt ?? latest.updatedAt;
      const ageMs = deps.now().getTime() - Date.parse(ended);
      if (!(ageMs > staleMs)) return;
      // A failed read proves nothing: a worktree not known to exist is not reported.
      if (!(await deps.pathExists(path).catch(() => false))) return;
      const cleanable = latest.status === 'failed' || latest.prState === 'MERGED';
      return {
        kind: 'stale-worktree',
        repoPath,
        severity: 'informational',
        observed: `${latest.ticketRef}: worktree ${path} of Run ${latest.id} (${latest.status}) is ${Math.floor(ageMs / DAY_MS)} days old, older than staleWorktreeDays (${deps.staleWorktreeDays}).`,
        remedy: cleanable
          ? '`fractory cleanup` removes it.'
          : `\`git -C ${repoPath} worktree remove ${path}\` once nothing on it is still needed.`,
      };
    }),
  );
  return findings.filter((f): f is Finding => f !== undefined);
};

/**
 * Ready Tickets that should have a Run and do not: free to start with no Run at all, or Held by
 * the last tick on blockers that are all satisfied now. Verdicts come from the same dependency
 * policy the tick uses, over the same reads.
 */
const trackerFindings = async (input: {
  repoPath: string;
  config: RepoConfig;
  runs: RunRecord[];
  host: HostState | undefined;
  deps: DoctorReaders;
}): Promise<Finding[]> => {
  const { repoPath, config, runs, host, deps } = input;
  const source = deps.ticketSource(config);
  const ready = await source.listReady();
  const blockers = await readBlockers(ready, config, source);
  const verdicts = resolveDependencies({ ready, blockers, runs, config });
  const held = new Map(
    (host?.heldTickets ?? [])
      .filter((h) => resolve(h.repoPath) === repoPath)
      .map((h) => [h.ticketRef, h]),
  );
  const now = deps.now().getTime();
  const overdue = (since: string): boolean => now - Date.parse(since) > OVERDUE_MS;
  const updatedAt = new Map(ready.map((t) => [t.ref, t.updatedAt]));
  const findings: Finding[] = [];
  for (const verdict of verdicts) {
    if (verdict.kind !== 'start') continue;
    const ref = verdict.ref;
    const hold = held.get(ref);
    if (hold && host) {
      const late = overdue(host.updatedAt);
      findings.push({
        kind: 'held-unblocked',
        repoPath,
        severity: late ? 'needs-owner' : 'informational',
        observed: `${ref}: the tick at ${host.updatedAt} Held it on ${hold.blockers.join(', ')}, and every blocker is now satisfied${late ? ', but no tick has started it since' : ''}.`,
        remedy: late
          ? `\`fractory tick\` starts it, or \`fractory run ${ref}\` to start it now.`
          : 'Nothing to do: the next tick starts it.',
      });
      continue;
    }
    if (runs.some((r) => r.ticketRef === ref)) continue;
    const since = updatedAt.get(ref);
    const late = since === undefined || overdue(since);
    findings.push({
      kind: 'ready-not-started',
      repoPath,
      severity: late ? 'needs-owner' : 'informational',
      observed: `${ref} is Ready${since ? ` since ${since}` : ''} with no Run and no pull request.`,
      remedy: late
        ? `\`fractory tick\` starts it, or \`fractory run ${ref}\` to start it now.`
        : 'Nothing to do: the next tick starts it.',
    });
  }
  return findings;
};

/**
 * Whether `fractory rebuild` would compile something other than `origin/<baseBranch>`: a dirty
 * checkout, or one behind it as of the last fetch. Doctor never fetches. A git read that fails
 * proves nothing and reports nothing.
 */
const rebuildFindings = async (input: {
  repoPath: string;
  repo: string;
  config: RepoConfig;
  deps: DoctorReaders;
}): Promise<Finding[]> => {
  const { repoPath, repo, config, deps } = input;
  if (!config.rebuild || config.rebuild.length === 0) return [];
  const base = `origin/${config.baseBranch}`;
  const [status, behind] = await Promise.all([
    deps.git(repo, ['status', '--porcelain']).catch(() => undefined),
    deps
      .git(repo, ['rev-list', '--count', `HEAD..${base}`])
      .then((out) => Number.parseInt(out.trim(), 10))
      .catch(() => undefined),
  ]);
  const findings: Finding[] = [];
  if (status !== undefined && status.trim() !== '') {
    const files = status.split('\n').filter((l) => l.trim() !== '').length;
    findings.push({
      kind: 'rebuild-stale',
      repoPath,
      severity: 'needs-owner',
      observed: `\`fractory rebuild\` would compile a dirty checkout: ${files} uncommitted change${files === 1 ? '' : 's'} in ${repoPath}.`,
      remedy: `Commit or stash the changes in ${repoPath}, then \`fractory rebuild ${repoPath}\`.`,
    });
  }
  if (behind !== undefined && Number.isFinite(behind) && behind > 0) {
    findings.push({
      kind: 'rebuild-stale',
      repoPath,
      severity: 'needs-owner',
      observed: `\`fractory rebuild\` would compile a checkout ${behind} commit${behind === 1 ? '' : 's'} behind ${base}.`,
      remedy: `\`git -C ${repoPath} pull --ff-only origin ${config.baseBranch}\`, then \`fractory rebuild ${repoPath}\`.`,
    });
  }
  return findings;
};

const unreachable = (repoPath: string, what: string, error: unknown): Finding => ({
  kind: 'unreachable',
  repoPath,
  severity: 'needs-owner',
  observed: `${what} could not be read: ${errorText(error)}`,
  remedy: `Check that ${repoPath} exists and \`fractory config show ${repoPath}\` succeeds, or remove it from ~/.fractory/config.json.`,
});

/** Findings about the whole machine: the queue Held over Host Limits, no tick agent loaded. */
const machineFindings = (input: {
  home: string;
  configPath: string;
  host: HostState | undefined;
  loaded: boolean | undefined;
  now: Date;
}): Finding[] => {
  const { home, host } = input;
  const findings: Finding[] = [];
  if (host?.held) {
    findings.push({
      kind: 'host-held',
      repoPath: home,
      severity: 'needs-owner',
      observed: formatHost(host, input.now).split('\n').join(' '),
      remedy: `Free what the reason names, or raise that limit under "resources" in ${input.configPath}; the next tick reads the host again.`,
    });
  }
  if (input.loaded === false) {
    findings.push({
      kind: 'launchd-not-loaded',
      repoPath: home,
      severity: 'needs-owner',
      observed: 'The launchd tick agent is not loaded: no tick is running at all.',
      remedy: '`fractory launchd install`.',
    });
  }
  return findings;
};

/**
 * One read-only sweep: every configured repository, or only the named ones (each of which must be
 * configured). The registry, the host state and launchd are read once; repositories are gathered
 * in parallel. A repository that throws yields an `unreachable` Finding and never fails the sweep;
 * only a failure of the sweep itself (an unknown repository, an unreadable registry) rejects.
 * Findings come per repository in sweep order, then the machine's.
 */
export const doctor = async (deps: DoctorReaders, only: string[] = []): Promise<Finding[]> => {
  const configured = new Map(deps.repos.map((repo) => [resolve(repo), repo]));
  const targets =
    only.length === 0
      ? deps.repos
      : only.map((path) => {
          const repo = configured.get(resolve(path));
          if (repo === undefined) throw new Error(`${path} is not a configured repo`);
          return repo;
        });

  const [runs, answeredRunIds, host, loaded] = await Promise.all([
    deps.listRuns(),
    deps.listAnswerRequests(),
    deps.readHostState().catch(() => undefined),
    deps.launchdLoaded().catch(() => undefined),
  ]);
  const perRepo = await Promise.all(
    targets.map(async (repo): Promise<Finding[]> => {
      const repoPath = resolve(repo);
      let config: RepoConfig;
      try {
        config = await deps.loadRepoConfig(repo);
      } catch (error) {
        return [unreachable(repoPath, repoPath, error)];
      }
      const [tracker, worktrees, rebuild] = await Promise.all([
        trackerFindings({ repoPath, config, runs, host, deps }).catch((error: unknown) => [
          unreachable(repoPath, `The tracker of ${repoPath}`, error),
        ]),
        worktreeFindings({ repoPath, runs, deps }),
        rebuildFindings({ repoPath, repo, config, deps }),
      ]);
      return [
        ...runFindings({ repoPath, config, repos: deps.repos, runs, answeredRunIds }),
        ...prFindings(repoPath, runs),
        ...tracker,
        ...worktrees,
        ...rebuild,
      ];
    }),
  );
  return [
    ...perRepo.flat(),
    ...machineFindings({
      home: dirname(resolve(deps.factoryConfigPath)),
      configPath: deps.factoryConfigPath,
      host,
      loaded,
      now: deps.now(),
    }),
  ];
};

/** The human rendering: Findings grouped by repository, in sweep order. */
export const formatFindings = (findings: readonly Finding[]): string => {
  if (findings.length === 0) return 'No Findings: nothing needs you.';
  const groups = new Map<string, Finding[]>();
  for (const finding of findings) {
    groups.set(finding.repoPath, [...(groups.get(finding.repoPath) ?? []), finding]);
  }
  const lines: string[] = [];
  for (const [repoPath, group] of groups) {
    if (lines.length > 0) lines.push('');
    lines.push(`${repoPath}:`);
    for (const f of group) {
      lines.push(`  - [${f.severity}] ${f.kind}: ${f.observed}`);
      lines.push(`    Remedy: ${f.remedy}`);
    }
  }
  const owner = findings.filter((f) => f.severity === 'needs-owner').length;
  lines.push(
    '',
    `${findings.length} Finding${findings.length === 1 ? '' : 's'}, ${owner} need${owner === 1 ? 's' : ''} you.`,
  );
  return lines.join('\n');
};

/** The one output function: `--json` prints the same array the human text is made from. */
export const renderFindings = (findings: readonly Finding[], options: { json: boolean }): string =>
  options.json ? JSON.stringify(findings, null, 2) : formatFindings(findings);
