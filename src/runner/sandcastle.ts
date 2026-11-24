import type { AgentRunOutcome, SandcastleAdapter } from './types.ts';

const DEFAULT_MODEL = 'claude-opus-4-8';

/**
 * The real Sandcastle: Docker sandbox, Claude Code agent, one worktree per Run on its own branch.
 * Imported lazily so tests and tools that never start a Run don't load it.
 */
export const sandcastleAdapter = (
  model = process.env.FRACTORY_MODEL ?? DEFAULT_MODEL,
): SandcastleAdapter => ({
  prepareWorktree: async ({ repoPath, branch, baseRef, sandboxImage }) => {
    const { createWorktree, claudeCode } = await import('@ai-hero/sandcastle');
    const { docker } = await import('@ai-hero/sandcastle/sandboxes/docker');
    const worktree = await createWorktree({
      cwd: repoPath,
      branchStrategy: { type: 'branch', branch, baseBranch: baseRef },
    });
    return {
      path: worktree.worktreePath,
      runAgent: async (request): Promise<AgentRunOutcome> => {
        const result = await worktree.run({
          agent: claudeCode(model, { env: request.env }),
          sandbox: docker(sandboxImage === undefined ? {} : { imageName: sandboxImage }),
          prompt: request.prompt,
          maxIterations: request.maxIterations,
          completionSignal: request.completionSignal,
          env: request.env,
          logging: { type: 'file', path: request.logPath },
        });
        const sessionId = [...result.iterations].reverse().find((i) => i.sessionId)?.sessionId;
        return {
          stdout: result.stdout,
          iterations: result.iterations.length,
          completed: result.completionSignal !== undefined,
          ...(sessionId === undefined ? {} : { sessionId }),
        };
      },
    };
  },
});
