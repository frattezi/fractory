import type {
  AgentProvider,
  ClaudeCodeOptions,
  OpenCodeOptions,
  SandboxProvider,
  Worktree,
} from '@ai-hero/sandcastle';
import type { RepoConfig } from '../contracts/repo-config.ts';
import type { RunResult } from '../contracts/run.ts';
import type { Ticket } from '../contracts/ticket.ts';
import type { FollowUp, buildPrompt, parseRunResult } from '../runner/prompt.ts';

/**
 * Agent providers already wired with the account of the repository's Mode. Flows get credentials
 * only through these: they must never read the Keychain or the environment themselves.
 * Asking for an agent the Mode does not allow (OpenCode in Work Mode) throws
 * `AgentNotAllowedError`; a missing Keychain item ends the Run as `needs-human` / `needs-access`.
 */
export interface FlowAgents {
  claude(model?: string, options?: ClaudeCodeOptions): Promise<AgentProvider>;
  opencode(model?: string, options?: OpenCodeOptions): Promise<AgentProvider>;
}

export interface FlowContext {
  ticket: Ticket;
  repoConfig: RepoConfig;
  /** CI log or review comments of a follow-up Run, already loaded; undefined for a fresh Run. */
  followUp: FollowUp | undefined;
  /** Text of `rules/run-agent.md`. */
  rules: string;
  /** The Run's Sandcastle worktree, created by Fractory. Call `worktree.run(...)` on it. */
  worktree: Worktree;
  /** Docker sandbox provider configured for the repository's image. Pass it as `sandbox`. */
  sandbox: SandboxProvider;
  agents: FlowAgents;
  /** Pass as `logging: { type: 'file', path: ctx.logPath }`. */
  logPath: string;
  maxIterations: number;
  /**
   * Pass as `idleTimeoutSeconds`: the repository's limit on how long the agent may print nothing.
   * `worktree.run` gets it anyway when a flow leaves it out.
   */
  idleTimeoutSeconds: number;
  /** Pass as `completionSignal`; the prompt from `buildPrompt` asks the agent to print it. */
  completionSignal: string;
  buildPrompt: typeof buildPrompt;
  /** The last valid `<result>` block of the agent's output, or undefined. */
  parseRunResult: typeof parseRunResult;
}

/**
 * A flow decides how agents work on one Ticket and returns the Run's outcome. It never pushes,
 * opens PRs or touches the tracker: Fractory does that from the returned `RunResult`.
 */
export type Flow = (ctx: FlowContext) => Promise<RunResult>;
