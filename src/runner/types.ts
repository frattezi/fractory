import type {
  AgentProvider,
  ClaudeCodeOptions,
  OpenCodeOptions,
  SandboxProvider,
  Worktree,
} from '@ai-hero/sandcastle';

/** The slice of Sandcastle the executor uses; tests replace it, no Docker needed. */
export interface SandcastleAdapter {
  createWorktree(options: {
    repoPath: string;
    branch: string;
    /** Ref a new branch forks from (ignored when the branch already exists). */
    baseRef: string;
  }): Promise<Worktree>;
  /** Docker sandbox provider for the repository's image (Sandcastle's default image when unset). */
  sandbox(imageName: string | undefined): SandboxProvider;
  claudeCode(model: string, options: ClaudeCodeOptions): AgentProvider;
  opencode(model: string, options: OpenCodeOptions): AgentProvider;
}
