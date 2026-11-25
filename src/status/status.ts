import { resolve } from 'node:path';
import type { Mode, RepoConfig } from '../contracts/repo-config.ts';
import { requiresPrGate, requiresTicketGate } from '../contracts/repo-config.ts';
import { ACTIVE_STATUSES, type NeedsHumanReason, type RunRecord } from '../contracts/run.ts';

/**
 * What an interactive agent (Claude Code, OpenCode) needs to know before working in a repository:
 * whether Fractory runs it, its Mode, and which branches belong to the factory right now. Pure, so
 * the answer comes from code, not from the agent reading the registry.
 */
export interface RepoStatus {
  repoPath: string;
  /** `.fractory.json` exists and the repo is listed in `~/.fractory/config.json`. */
  managed: boolean;
  /** `.fractory.json` exists but the repo is not in the factory config: no tick ever runs it. */
  configuredOnly: boolean;
  mode?: Mode;
  ticketGate?: boolean;
  prGate?: boolean;
  autoMerge?: boolean;
  activeRuns: {
    id: string;
    status: string;
    ticketRef: string;
    branch: string;
    worktreePath?: string;
  }[];
  /** Open PRs Fractory made: a review comment or red CI starts a follow-up Run on that branch. */
  openPrs: { ticketRef: string; branch: string; prUrl: string }[];
  needsHuman: { ticketRef: string; reason: NeedsHumanReason; question: string; runId: string }[];
  /** Every branch an agent must not commit to, push to, check out or rebase by hand. */
  factoryBranches: string[];
}

/** Latest Run per Ticket, for one repository. */
const latestPerTicket = (runs: RunRecord[], repoPath: string): RunRecord[] => {
  const latest = new Map<string, RunRecord>();
  for (const run of runs) {
    if (resolve(run.repoPath) !== repoPath) continue;
    const seen = latest.get(run.ticketRef);
    if (!seen || seen.createdAt < run.createdAt) latest.set(run.ticketRef, run);
  }
  return [...latest.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
};

export const repoStatus = (input: {
  repoPath: string;
  config: RepoConfig | undefined;
  factoryRepos: string[];
  runs: RunRecord[];
}): RepoStatus => {
  const repoPath = resolve(input.repoPath);
  const listed = input.factoryRepos.some((r) => resolve(r) === repoPath);
  const { config } = input;
  const status: RepoStatus = {
    repoPath,
    managed: config !== undefined && listed,
    configuredOnly: config !== undefined && !listed,
    activeRuns: [],
    openPrs: [],
    needsHuman: [],
    factoryBranches: [],
  };
  if (!config) return status;
  status.mode = config.mode;
  status.ticketGate = requiresTicketGate(config);
  status.prGate = requiresPrGate(config);
  status.autoMerge = config.mode === 'personal';

  const branches = new Set<string>();
  for (const run of latestPerTicket(input.runs, repoPath)) {
    if (ACTIVE_STATUSES.includes(run.status)) {
      status.activeRuns.push({
        id: run.id,
        status: run.status,
        ticketRef: run.ticketRef,
        branch: run.branch,
        ...(run.worktreePath && { worktreePath: run.worktreePath }),
      });
      branches.add(run.branch);
      continue;
    }
    const prOpen = run.prUrl && run.prState !== 'MERGED' && run.prState !== 'CLOSED';
    if (prOpen && run.prUrl) {
      status.openPrs.push({ ticketRef: run.ticketRef, branch: run.branch, prUrl: run.prUrl });
      branches.add(run.branch);
    }
    if (run.status === 'needs-human' && run.result?.outcome === 'needs-human') {
      status.needsHuman.push({
        ticketRef: run.ticketRef,
        reason: run.result.reason,
        question: run.result.question,
        runId: run.id,
      });
    }
  }
  status.factoryBranches = [...branches].sort();
  return status;
};

export const formatStatus = (s: RepoStatus): string => {
  if (!s.managed && !s.configuredOnly) return `${s.repoPath}: not a Fractory repository.`;
  const lines = [
    `${s.repoPath}: ${s.managed ? 'managed by Fractory' : 'has .fractory.json but is not in ~/.fractory/config.json (no tick runs it)'}`,
    `Mode: ${s.mode}. Ticket Gate ${s.ticketGate ? 'on' : 'off'}, PR Gate ${s.prGate ? 'on' : 'off'}, auto-merge ${s.autoMerge ? 'on' : 'off'}.`,
  ];
  const section = (title: string, items: string[]): void => {
    lines.push(`${title}: ${items.length === 0 ? 'none' : ''}`);
    for (const item of items) lines.push(`  - ${item}`);
  };
  section(
    'Active Runs',
    s.activeRuns.map((r) => `${r.ticketRef} ${r.status} on ${r.branch}`),
  );
  section(
    'Open factory PRs',
    s.openPrs.map((p) => `${p.ticketRef} ${p.prUrl} (${p.branch})`),
  );
  section(
    'Waiting on the owner',
    s.needsHuman.map((n) => `${n.ticketRef} ${n.reason}: ${n.question}`),
  );
  section('Hands-off branches', s.factoryBranches);
  return lines.join('\n');
};
