import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  FACTORY_HOME,
  type FactoryConfig,
  FactoryConfigSchema,
} from '../contracts/factory-config.ts';
import {
  REPO_CONFIG_FILE,
  type RepoConfig,
  RepoConfigSchema,
  requiresPrGate,
  requiresTicketGate,
} from '../contracts/repo-config.ts';
import { describeWorkflow } from '../policy/workflow.ts';

export const factoryConfigPath = (home: string = FACTORY_HOME): string => join(home, 'config.json');

const readJson = async (path: string): Promise<unknown> => {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${(error as Error).message}`);
  }
};

/** A missing file means "all defaults"; a present but invalid file is an error, never ignored. */
export const loadFactoryConfig = async (
  path: string = factoryConfigPath(),
): Promise<FactoryConfig> => {
  const raw = await readJson(path);
  const parsed = FactoryConfigSchema.safeParse(raw ?? {});
  if (!parsed.success) throw new Error(`Invalid factory config ${path}: ${parsed.error.message}`);
  return parsed.data;
};

export const loadRepoConfig = async (repoPath: string): Promise<RepoConfig> => {
  const path = join(repoPath, REPO_CONFIG_FILE);
  const raw = await readJson(path);
  if (raw === undefined) throw new Error(`${path} not found (run \`fractory init ${repoPath}\`)`);
  const parsed = RepoConfigSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`Invalid repo config ${path}: ${parsed.error.message}`);
  return parsed.data;
};

/** The merged RepoConfig plus the two derived Gate decisions, for `fractory config show`. */
export const describeRepoConfig = (config: RepoConfig) => ({
  ...config,
  requiresTicketGate: requiresTicketGate(config),
  requiresPrGate: requiresPrGate(config),
  workflow: describeWorkflow(config),
});
