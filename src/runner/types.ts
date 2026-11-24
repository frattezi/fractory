export interface AgentRunRequest {
  prompt: string;
  maxIterations: number;
  completionSignal: string;
  env: Record<string, string>;
  logPath: string;
}

export interface AgentRunOutcome {
  /** Everything the agent printed. */
  stdout: string;
  iterations: number;
  /** The agent printed the completion signal before iterations ran out. */
  completed: boolean;
  /** Claude Code conversation id captured by Sandcastle. */
  sessionId?: string;
}

export interface PreparedWorktree {
  /** Host path of the Run's worktree. */
  path: string;
  runAgent(request: AgentRunRequest): Promise<AgentRunOutcome>;
}

/** The slice of Sandcastle the executor uses; tests replace it, no Docker needed. */
export interface SandcastleAdapter {
  prepareWorktree(options: {
    repoPath: string;
    branch: string;
    /** Ref a new branch forks from (ignored when the branch already exists). */
    baseRef: string;
    sandboxImage: string | undefined;
  }): Promise<PreparedWorktree>;
}
