import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type AgentProfile, profileLabel } from '../contracts/agents.ts';
import type { Exec } from './exec.ts';

/**
 * Where each agent profile's credential lives in the macOS Keychain, and the env var the agent CLI
 * reads it from inside the sandbox. The account comes from the Mode only: nothing in the host
 * environment can pick or override it.
 */
const CREDENTIALS: Record<string, { service: string; envVar: string }> = {
  'claude@work': { service: 'fractory.claude.work', envVar: 'CLAUDE_CODE_OAUTH_TOKEN' },
  'claude@personal': { service: 'fractory.claude.personal', envVar: 'CLAUDE_CODE_OAUTH_TOKEN' },
  'opencode@personal': { service: 'fractory.opencode.personal', envVar: 'OPENCODE_API_KEY' },
};

/** Env keys that carry an agent credential. `.sandcastle/.env` must never define them. */
export const CREDENTIAL_ENV_KEYS = [
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'OPENCODE_API_KEY',
] as const;

export class MissingCredentialError extends Error {
  constructor(
    readonly profile: AgentProfile,
    readonly service: string,
  ) {
    super(`No Keychain item "${service}" for ${profileLabel(profile)}`);
  }

  /** What the owner has to do, as the question of a `needs-access` Run. */
  get question(): string {
    return `The Keychain has no item "${this.service}" (needed for ${profileLabel(this.profile)}). Run: security add-generic-password -s ${this.service} -a "$USER" -w  (type the secret at the prompt), then re-run.`;
  }
}

export const credentialFor = (profile: AgentProfile): { service: string; envVar: string } => {
  const entry = CREDENTIALS[profileLabel(profile)];
  if (!entry) throw new Error(`No credential is defined for ${profileLabel(profile)}`);
  return entry;
};

/** `security` exits 44 and says "could not be found" when the item does not exist. */
const isItemNotFound = (error: unknown): boolean => {
  const { code, stderr } = error as { code?: unknown; stderr?: unknown };
  return code === 44 || (typeof stderr === 'string' && /could not be found/i.test(stderr));
};

/**
 * Reads the profile's secret from the Keychain and returns it as the env the agent needs.
 * A missing item is a `MissingCredentialError`; any other failure (locked keychain, no `security`)
 * is rethrown as is, because a failed read proves nothing about the item. The value is never
 * logged or stored.
 */
export const resolveCredentials = async (
  profile: AgentProfile,
  exec: Exec,
): Promise<Record<string, string>> => {
  const { service, envVar } = credentialFor(profile);
  let stdout: string;
  try {
    ({ stdout } = await exec('security', ['find-generic-password', '-s', service, '-w']));
  } catch (error) {
    if (isItemNotFound(error)) throw new MissingCredentialError(profile, service);
    throw new Error(`Could not read the Keychain item "${service}"`);
  }
  const secret = stdout.trim();
  if (!secret) throw new MissingCredentialError(profile, service);
  return { [envVar]: secret };
};

/** Keys of a dotenv file that are agent credentials (defined at all, even empty). */
export const credentialKeysIn = (dotenv: string): string[] => {
  const keys = new Set(
    dotenv
      .split('\n')
      .map((line) => /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1])
      .filter((key): key is string => key !== undefined),
  );
  return CREDENTIAL_ENV_KEYS.filter((key) => keys.has(key));
};

/**
 * Sandcastle merges `.sandcastle/.env` under the provider's env, but a credential key defined
 * there and not set by us (e.g. ANTHROPIC_API_KEY next to a Claude OAuth token) would still reach
 * the sandbox and could pick the wrong account. So a Run refuses to start.
 */
export const refuseEnvCredentials = async (repoPath: string): Promise<void> => {
  let content: string;
  try {
    content = await readFile(join(repoPath, '.sandcastle', '.env'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new Error(
      `could not read .sandcastle/.env: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const keys = credentialKeysIn(content);
  if (keys.length > 0) {
    throw new Error(
      `.sandcastle/.env defines ${keys.join(', ')}; remove it: the account comes from the Keychain per Mode`,
    );
  }
};
