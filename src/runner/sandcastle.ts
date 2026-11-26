import type { SandcastleAdapter } from './types.ts';

/**
 * The real Sandcastle: one worktree per Run on its own branch, a Docker sandbox, and the agent
 * providers. Imported lazily so tests and tools that never start a Run don't load it.
 */
export const sandcastleAdapter = async (): Promise<SandcastleAdapter> => {
  const sandcastle = await import('@ai-hero/sandcastle');
  const { docker } = await import('@ai-hero/sandcastle/sandboxes/docker');
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
    claudeCode: (model, options) => sandcastle.claudeCode(model, options),
    opencode: (model, options) => sandcastle.opencode(model, options),
  };
};
