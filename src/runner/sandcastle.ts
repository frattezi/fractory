import type { SandcastleAdapter } from './types.ts';

/**
 * The real Sandcastle: one worktree per Run on its own branch, a Docker sandbox, and the agent
 * providers. Imported lazily so tests and tools that never start a Run don't load it.
 */
export const sandcastleAdapter = async (): Promise<SandcastleAdapter> => {
  const sandcastle = await import('@ai-hero/sandcastle');
  const { docker } = await import('@ai-hero/sandcastle/sandboxes/docker');
  const { noSandbox } = await import('@ai-hero/sandcastle/sandboxes/no-sandbox');
  return {
    createWorktree: ({ repoPath, branch, baseRef }) =>
      sandcastle.createWorktree({
        cwd: repoPath,
        branchStrategy: { type: 'branch', branch, baseBranch: baseRef },
      }),
    sandbox: (imageName, cpus, extra) =>
      docker({
        ...(imageName !== undefined && { imageName }),
        ...(cpus !== undefined && { cpus }),
        ...(extra?.mounts !== undefined && { mounts: extra.mounts }),
        ...(extra?.env !== undefined && { env: extra.env }),
      }),
    run: async (request) => {
      const result = await sandcastle.run({
        cwd: request.cwd,
        agent: request.agent,
        promptFile: request.promptFile,
        maxIterations: request.maxIterations,
        completionSignal: request.completionSignal,
        logging: { type: 'file', path: request.logPath },
        sandbox: request.sandbox ?? noSandbox(),
        ...(request.name !== undefined && { name: request.name }),
      });
      return { stdout: result.stdout, iterations: result.iterations.length };
    },
    claudeCode: (model, options) => sandcastle.claudeCode(model, options),
    opencode: (model, options) => sandcastle.opencode(model, options),
  };
};
