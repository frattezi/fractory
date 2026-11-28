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

/** One agent started outside a Run: Sandcastle's top-level `run`, anchored on a directory. */
export interface AgentRunRequest {
  /** Directory the agent runs in; no branch and no worktree are created for it. */
  cwd: string;
  agent: AgentProvider;
  /** Absolute: Sandcastle resolves it against the process working directory, not `cwd`. */
  promptFile: string;
  /** Docker sandbox; none means the agent runs on the host. */
  sandbox: SandboxProvider | undefined;
  maxIterations: number;
  completionSignal: string;
  logPath: string;
  name?: string;
}

export interface AgentRunResult {
  stdout: string;
  iterations: number;
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
  /** Runs one agent in `cwd` and returns what it produced. */
  run(request: AgentRunRequest): Promise<AgentRunResult>;
  claudeCode(model: string, options: ClaudeCodeOptions): AgentProvider;
  opencode(model: string, options: OpenCodeOptions): AgentProvider;
}
