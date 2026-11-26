import type {
  AgentProvider,
  ClaudeCodeOptions,
  MountConfig,
  OpenCodeOptions,
  SandboxProvider,
  Worktree,
} from '@ai-hero/sandcastle';

export interface SandboxExtras {
  mounts?: readonly MountConfig[];
  env?: Record<string, string>;
}

/** The slice of Sandcastle the executor uses; tests replace it, no Docker needed. */
export interface SandcastleAdapter {
  createWorktree(options: {
    repoPath: string;
    branch: string;
    /** Ref a new branch forks from (ignored when the branch already exists). */
    baseRef: string;
  }): Promise<Worktree>;
  /**
   * Docker sandbox provider for the repository's image (Sandcastle's default image when unset),
   * its container capped at `cpus` CPUs when given, with extra host directories mounted and env
   * set at container start (never baked into the image).
   */
  sandbox(imageName: string | undefined, cpus?: number, extra?: SandboxExtras): SandboxProvider;
  claudeCode(model: string, options: ClaudeCodeOptions): AgentProvider;
  opencode(model: string, options: OpenCodeOptions): AgentProvider;
}
