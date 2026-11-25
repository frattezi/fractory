import { type AgentKind, accountFor, allowedAgents } from '../contracts/agents.ts';
import { type Mode, type RepoConfig, requiresTicketGate } from '../contracts/repo-config.ts';
import type { RunStatus } from '../contracts/run.ts';
import type { ChecksSummary } from '../github/gh.ts';

/**
 * The single place for workflow rules. Everything that decides what a Mode allows, or that
 * explains it to the owner, lives here as pure functions.
 */

export interface AutoMergeInput {
  config: RepoConfig;
  /** `none` means the PR has no checks at all (a repository without CI). */
  checks: ChecksSummary;
  /** GitHub's `mergeable` field: MERGEABLE | CONFLICTING | UNKNOWN. */
  mergeable: string;
  latestRunStatus: RunStatus;
}

/**
 * Personal Mode merges a PR when the Ticket's latest Run is done, GitHub says it is MERGEABLE and
 * checks are passing or absent. Never while checks are pending or failing, never when conflicting
 * or unknown, and never in Work Mode (ADR 0005).
 */
export const mayAutoMerge = ({
  config,
  checks,
  mergeable,
  latestRunStatus,
}: AutoMergeInput): boolean =>
  config.mode === 'personal' &&
  latestRunStatus === 'done' &&
  mergeable === 'MERGEABLE' &&
  (checks === 'passing' || checks === 'none');

export type RuleId =
  | 'mode'
  | 'spec-gate'
  | 'ticket-gate'
  | 'pr-gate'
  | 'auto-merge'
  | 'agents'
  | 'account'
  | 'flow'
  | 'max-iterations'
  | 'concurrency';

export interface WorkflowRule {
  id: RuleId;
  label: string;
  /** Short state, e.g. `on`, `off`, `claude, opencode`. */
  value: string;
  /** Why the rule is what it is for this repository. */
  why: string;
}

export interface WorkflowDescription {
  mode: Mode;
  rules: WorkflowRule[];
  agents: readonly AgentKind[];
  account: 'work' | 'personal';
  flow: string;
  maxIterations: number;
  maxConcurrentRuns?: number;
}

const ticketGateWhy = (config: RepoConfig): string => {
  if (config.mode === 'work') return 'Work Mode always reviews how a Spec is split into Tickets.';
  return config.ticketGate
    ? 'Personal Mode with ticketGate enabled in .fractory.json.'
    : 'Personal Mode default; set ticketGate to opt in.';
};

export const describeWorkflow = (
  config: RepoConfig,
  options: { maxConcurrentRuns?: number } = {},
): WorkflowDescription => {
  const work = config.mode === 'work';
  const agents = allowedAgents(config.mode);
  const account = accountFor(config.mode);
  const ci = config.hasCi ? 'with CI' : 'without CI';
  const rules: WorkflowRule[] = [
    {
      id: 'mode',
      label: 'Mode',
      value: config.mode,
      why: work
        ? 'Shared repository: every change passes human review.'
        : 'Only the owner maintains it: changes merge without human review.',
    },
    {
      id: 'spec-gate',
      label: 'Spec Gate',
      value: 'on',
      why: 'The owner approves every Spec, in every Mode.',
    },
    {
      id: 'ticket-gate',
      label: 'Ticket Gate',
      value: requiresTicketGate(config) ? 'on' : 'off',
      why: ticketGateWhy(config),
    },
    {
      id: 'pr-gate',
      label: 'PR Gate',
      value: work ? 'on' : 'off',
      why: work
        ? 'A human reviews and merges every PR; Fractory never merges.'
        : `Merges are never a Gate in Personal Mode, ${ci} (ADR 0005).`,
    },
    {
      id: 'auto-merge',
      label: 'Auto-merge',
      value: work ? 'never' : 'on',
      why: work
        ? 'Work Mode never auto-merges.'
        : 'Merges when the latest Run is done, the PR is MERGEABLE and checks pass or do not exist; waits while checks are pending, stops for failing ones.',
    },
    {
      id: 'agents',
      label: 'Allowed agents',
      value: agents.join(', '),
      why: work ? 'Work Mode runs Claude only.' : 'Personal Mode may run any supported agent.',
    },
    {
      id: 'account',
      label: 'Account',
      value: account,
      why: 'The account follows the Mode; there is no override.',
    },
    {
      id: 'flow',
      label: 'Flow',
      value: config.flow,
      why: `Runs execute flows/${config.flow}.ts.`,
    },
    {
      id: 'max-iterations',
      label: 'Max iterations',
      value: String(config.maxIterations),
      why: 'A Run stops with budget-exhausted after this many agent iterations.',
    },
  ];
  if (options.maxConcurrentRuns !== undefined) {
    rules.push({
      id: 'concurrency',
      label: 'Concurrency',
      value: String(options.maxConcurrentRuns),
      why: 'Factory-wide limit of Runs executing at once.',
    });
  }
  return {
    mode: config.mode,
    rules,
    agents,
    account,
    flow: config.flow,
    maxIterations: config.maxIterations,
    ...(options.maxConcurrentRuns !== undefined && {
      maxConcurrentRuns: options.maxConcurrentRuns,
    }),
  };
};

export const formatWorkflow = ({ rules }: WorkflowDescription): string => {
  const width = Math.max(...rules.map((r) => r.label.length));
  const valueWidth = Math.max(...rules.map((r) => r.value.length));
  return rules
    .map((r) => `${r.label.padEnd(width)}  ${r.value.padEnd(valueWidth)}  ${r.why}`)
    .join('\n');
};
