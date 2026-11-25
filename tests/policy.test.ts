import { describe, expect, it } from 'vitest';
import {
  RepoConfigSchema,
  requiresPrGate,
  requiresTicketGate,
} from '../src/contracts/repo-config.ts';
import { OutboundPolicyError, assertOutboundAllowed } from '../src/policy/outbound.ts';
import { checkResources, readHostLoad } from '../src/policy/resources.ts';

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

  it('Personal Mode never gates PRs and gates Tickets only on opt-in', () => {
    const withCi = RepoConfigSchema.parse({ ...base, mode: 'personal', hasCi: true });
    const noCi = RepoConfigSchema.parse({
      ...base,
      mode: 'personal',
      hasCi: false,
      ticketGate: true,
    });
    expect(requiresPrGate(withCi)).toBe(false);
    expect(requiresTicketGate(withCi)).toBe(false);
    expect(requiresPrGate(noCi)).toBe(false);
    expect(requiresTicketGate(noCi)).toBe(true);
  });
});

describe('host resources', () => {
  const limits = { maxLoadPerCore: 0.75, minMemoryAvailablePercent: 25, maxLaunchesPerTick: 1 };

  it('passes a host with room and holds one over either limit', () => {
    expect(checkResources({ loadPerCore: 0.5, memoryAvailablePercent: 40 }, limits)).toEqual({
      ok: true,
    });
    expect(checkResources({ loadPerCore: 0.9, memoryAvailablePercent: 40 }, limits)).toMatchObject({
      ok: false,
    });
    expect(checkResources({ loadPerCore: 0.1, memoryAvailablePercent: 10 }, limits)).toMatchObject({
      ok: false,
    });
  });

  it('treats an unread value as unknown, never as over the limit', () => {
    expect(checkResources({}, limits)).toEqual({ ok: true });
  });

  it('reads load per core and macOS available memory, tolerating a failed sysctl', async () => {
    const os = { loadavg: () => [5, 4, 3], cores: () => 10 };
    expect(await readHostLoad(async () => '63\n', os)).toEqual({
      loadPerCore: 0.5,
      memoryAvailablePercent: 63,
    });
    expect(
      await readHostLoad(async () => {
        throw new Error('no sysctl');
      }, os),
    ).toEqual({ loadPerCore: 0.5 });
  });
});
