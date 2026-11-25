import { z } from 'zod';
import type { Mode } from './repo-config.ts';

/** The coding agent CLI a flow runs inside the sandbox. */
export const AgentKindSchema = z.enum(['claude', 'opencode']);
export type AgentKind = z.infer<typeof AgentKindSchema>;

/** Whose subscription or key pays for and is accountable for the agent's work. */
export const AccountSchema = z.enum(['work', 'personal']);
export type Account = z.infer<typeof AccountSchema>;

/** One agent on one account, e.g. `claude@work`. */
export interface AgentProfile {
  kind: AgentKind;
  account: Account;
}

/**
 * The account follows the Mode: Work Mode repositories run on the employer account, everything
 * else on the personal one. There is no override, so a work repo can never bill or log into a
 * personal account and vice versa.
 */
export const accountFor = (mode: Mode): Account => (mode === 'work' ? 'work' : 'personal');

/** Work Mode runs Claude only (v0 lesson: work jobs must never use another agent). */
const ALLOWED_AGENTS: Record<Mode, readonly AgentKind[]> = {
  work: ['claude'],
  personal: ['claude', 'opencode'],
};

export const allowedAgents = (mode: Mode): readonly AgentKind[] => ALLOWED_AGENTS[mode];

export class AgentNotAllowedError extends Error {
  constructor(
    readonly kind: AgentKind,
    readonly mode: Mode,
  ) {
    super(`Agent "${kind}" is not allowed in ${mode} Mode`);
  }
}

/** Throws when a flow asks for an agent its repository's Mode does not allow. */
export const profileFor = (kind: AgentKind, mode: Mode): AgentProfile => {
  if (!allowedAgents(mode).includes(kind)) throw new AgentNotAllowedError(kind, mode);
  return { kind, account: accountFor(mode) };
};

export const profileLabel = (profile: AgentProfile): string => `${profile.kind}@${profile.account}`;
