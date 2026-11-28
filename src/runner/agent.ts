import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type Account, profileFor } from '../contracts/agents.ts';
import type { RepoConfig } from '../contracts/repo-config.ts';
import { MissingCredentialError, refuseEnvCredentials, resolveCredentials } from './credentials.ts';
import type { Exec } from './exec.ts';
import { BASE_AGENT_ENV, COMPLETION_SIGNAL, DEFAULT_CLAUDE_MODEL } from './prompt.ts';
import type { SandcastleAdapter } from './types.ts';

export interface AgentRunInput {
  config: RepoConfig;
  repoPath: string;
  /** Absolute path of the prompt file. */
  promptFile: string;
  /** Absolute directory the agent runs in. */
  cwd: string;
  model?: string;
  name?: string;
  maxIterations?: number;
  /** CPU cap for the container; none when unset. */
  cpus?: number;
  logPath: string;
}

export interface AgentRunOutput {
  text: string;
  model: string;
  account: Account;
  sandboxed: boolean;
  logPath: string;
  iterations: number;
}

/**
 * One agent on the repository's Account, outside a Run: no Run record, Ticket, branch, worktree
 * or push. The Account follows the Mode only (credentials last in the env), the sandbox follows
 * `sandboxImage`, and what the agent printed comes back untouched.
 */
export const runAgent = async (
  input: AgentRunInput,
  deps: { sandcastle: SandcastleAdapter; exec: Exec },
): Promise<AgentRunOutput> => {
  const { config } = input;
  // Read first so an unreadable prompt is refused before a Keychain or container is touched.
  await readFile(input.promptFile).catch((error: unknown) => {
    throw new Error(
      `could not read the prompt file ${input.promptFile}: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
  const profile = profileFor('claude', config.mode);
  await refuseEnvCredentials(input.repoPath);
  if (input.cwd !== input.repoPath) await refuseEnvCredentials(input.cwd);
  const credentials = await resolveCredentials(profile, deps.exec).catch((error: unknown) => {
    throw error instanceof MissingCredentialError ? new Error(error.question) : error;
  });
  const model = input.model ?? process.env.FRACTORY_MODEL ?? DEFAULT_CLAUDE_MODEL;
  const agent = deps.sandcastle.claudeCode(model, {
    env: { ...BASE_AGENT_ENV, ...credentials },
  });
  const sandboxed = config.sandboxImage !== undefined;
  const result = await deps.sandcastle.run({
    cwd: input.cwd,
    agent,
    promptFile: input.promptFile,
    sandbox: sandboxed ? deps.sandcastle.sandbox(config.sandboxImage, input.cpus) : undefined,
    maxIterations: input.maxIterations ?? config.maxIterations,
    completionSignal: COMPLETION_SIGNAL,
    logPath: input.logPath,
    ...(input.name !== undefined && { name: input.name }),
  });
  return {
    text: result.stdout,
    model,
    account: profile.account,
    sandboxed,
    logPath: input.logPath,
    iterations: result.iterations,
  };
};

/** Log file of one call: unique per call, under the usual log directory. */
export const agentLogPath = (logDir: string, id: string, name?: string): string =>
  join(logDir, `agent-${name ? `${name.replace(/[^A-Za-z0-9._-]/g, '-')}-` : ''}${id}.log`);
