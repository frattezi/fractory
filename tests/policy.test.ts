import { describe, expect, it } from 'vitest';
import {
  RepoConfigSchema,
  requiresPrGate,
  requiresTicketGate,
} from '../src/contracts/repo-config.ts';
import { OutboundPolicyError, assertOutboundAllowed } from '../src/policy/outbound.ts';

describe('assertOutboundAllowed', () => {
  it('blocks AI-setup mentions in Work Mode', () => {
    expect(() => assertOutboundAllowed('Fix login\n\nCo-Authored-By: Claude <x>', 'work')).toThrow(
      OutboundPolicyError,
    );
    expect(() => assertOutboundAllowed('🤖 Generated with tooling', 'work')).toThrow();
  });

  it('allows plain developer text in Work Mode and anything in Personal Mode', () => {
    expect(() => assertOutboundAllowed('Fix null check in claims parser', 'work')).not.toThrow();
    expect(() => assertOutboundAllowed('Run by Fractory via Claude', 'personal')).not.toThrow();
  });
});

describe('gates', () => {
  const base = { ticketSource: { kind: 'github', repo: 'me/repo' } } as const;

  it('Work Mode always gates PRs and Tickets', () => {
    const config = RepoConfigSchema.parse({ ...base, mode: 'work', hasCi: true });
    expect(requiresPrGate(config)).toBe(true);
    expect(requiresTicketGate(config)).toBe(true);
  });

  it('Personal Mode gates PRs only without CI, Tickets only on opt-in', () => {
    const withCi = RepoConfigSchema.parse({ ...base, mode: 'personal', hasCi: true });
    const noCi = RepoConfigSchema.parse({
      ...base,
      mode: 'personal',
      hasCi: false,
      ticketGate: true,
    });
    expect(requiresPrGate(withCi)).toBe(false);
    expect(requiresTicketGate(withCi)).toBe(false);
    expect(requiresPrGate(noCi)).toBe(true);
    expect(requiresTicketGate(noCi)).toBe(true);
  });
});
