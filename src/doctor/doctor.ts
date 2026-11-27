import { resolve } from 'node:path';
import type { Finding } from '../contracts/finding.ts';
import type { RepoConfig } from '../contracts/repo-config.ts';
import type { RunRecord } from '../contracts/run.ts';
import { latestPerTicket, repoStatus } from '../status/status.ts';

/**
 * Everything Doctor reads, injected so tests never touch the machine. Doctor only reads: it
 * performs no git operation, starts no Run and writes no file.
 */
export interface DoctorReaders {
  /** The configured repository list, `FactoryConfig.repos`. */
  repos: string[];
  loadRepoConfig: (repoPath: string) => Promise<RepoConfig>;
  /** Every Run record in the registry. */
  listRuns: () => Promise<RunRecord[]>;
  /** Run ids with an answer request waiting for the next tick. */
  listAnswerRequests: () => Promise<readonly string[]>;
}

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
    findings.push({
      kind: 'run-failed',
      repoPath,
      severity: 'needs-owner',
      observed: `${run.ticketRef}: Run ${run.id} ${budget ? 'exhausted its budget' : 'failed'}${detail}`,
      remedy: `Read the log at ${run.logPath}, then \`fractory run ${run.ticketRef}\` to start the Ticket again on ${run.branch}${budget ? ' (or raise maxIterations in .fractory.json)' : ''}.`,
    });
  }
  return findings;
};

/**
 * One read-only sweep: every configured repository, or only the named ones (each of which must be
 * configured). The registry is read once; repositories are gathered in parallel. A repository
 * that throws yields an `unreachable` Finding and never fails the sweep; only a failure of the
 * sweep itself (an unknown repository, an unreadable registry) rejects.
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

  const [runs, answeredRunIds] = await Promise.all([deps.listRuns(), deps.listAnswerRequests()]);
  const perRepo = await Promise.all(
    targets.map(async (repo): Promise<Finding[]> => {
      const repoPath = resolve(repo);
      try {
        const config = await deps.loadRepoConfig(repo);
        return runFindings({ repoPath, config, repos: deps.repos, runs, answeredRunIds });
      } catch (error) {
        return [
          {
            kind: 'unreachable',
            repoPath,
            severity: 'needs-owner',
            observed: `${repoPath} could not be read: ${errorText(error)}`,
            remedy: `Check that ${repoPath} exists and \`fractory config show ${repoPath}\` succeeds, or remove it from ~/.fractory/config.json.`,
          },
        ];
      }
    }),
  );
  return perRepo.flat();
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
