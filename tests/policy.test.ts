import { describe, expect, it } from 'vitest';
import { ResourceLimitsSchema } from '../src/contracts/factory-config.ts';
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
  const limits = ResourceLimitsSchema.parse({});
  const roomy = {
    loadPerCore: 0.5,
    hostMemoryFreeGb: 4,
    dockerMemoryFreeGb: 3,
    dockerReachable: true,
  };

  it('has the Spec defaults', () => {
    expect(limits).toEqual({
      maxLoadPerCore: 0.75,
      minHostMemoryFreeGb: 2,
      minDockerMemoryFreeGb: 1,
      maxLaunchesPerTick: 1,
      cpusPerRun: 4,
    });
  });

  it('passes a host with room and says which limit holds it otherwise', () => {
    expect(checkResources(roomy, limits)).toEqual({ ok: true });
    expect(checkResources({ ...roomy, dockerMemoryFreeGb: 0.8 }, limits)).toEqual({
      ok: false,
      reason: 'Docker memory 0.8 GB free < 1 GB',
    });
    expect(checkResources({ ...roomy, hostMemoryFreeGb: 1.5 }, limits)).toEqual({
      ok: false,
      reason: 'host memory 1.5 GB free < 2 GB',
    });
    expect(checkResources({ ...roomy, loadPerCore: 0.92 }, limits)).toEqual({
      ok: false,
      reason: 'CPU load 0.92 per core > 0.75',
    });
    expect(
      checkResources({ loadPerCore: 2, hostMemoryFreeGb: 1, dockerMemoryFreeGb: 0.5 }, limits),
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/Docker.*host.*CPU/) });
  });

  it('holds when Docker is unreachable, but never for an unread value', () => {
    expect(checkResources({ ...roomy, dockerReachable: false }, limits)).toEqual({
      ok: false,
      reason: 'Docker is not reachable',
    });
    expect(checkResources({}, limits)).toEqual({ ok: true });
    expect(checkResources({ dockerReachable: true }, limits)).toEqual({ ok: true });
  });
});

describe('readHostLoad', () => {
  const os = { loadavg: () => [5, 4, 3], cores: () => 10, totalmem: () => 16 * 1024 ** 3 };
  const docker =
    (info: string | Error, stats: string | Error) =>
    async (args: string[]): Promise<string> => {
      const out = args[0] === 'info' ? info : stats;
      if (out instanceof Error) throw out;
      return out;
    };
  const GIB = 1024 ** 3;

  it('reads load, host memory and Docker memory from the processes', async () => {
    const load = await readHostLoad(
      {
        sysctl: async () => '50\n',
        docker: docker(`${8 * GIB}\n`, '1GiB / 7.65GiB\n512MiB / 7.65GiB\n1024KiB / 7.65GiB\n'),
      },
      os,
    );
    expect(load.loadPerCore).toBe(0.5);
    expect(load.hostMemoryFreeGb).toBe(8);
    expect(load.dockerReachable).toBe(true);
    expect(load.dockerMemoryFreeGb).toBeCloseTo(8 - 1 - 0.5 - 1 / 1024, 5);
  });

  it('counts no containers as all Docker memory free and parses B and GB units', async () => {
    const empty = await readHostLoad(
      { sysctl: async () => '50', docker: docker(`${4 * GIB}`, '') },
      os,
    );
    expect(empty.dockerMemoryFreeGb).toBe(4);
    const mixed = await readHostLoad(
      { sysctl: async () => '50', docker: docker(`${4 * GIB}`, '0B / 4GiB\n2GiB / 4GiB') },
      os,
    );
    expect(mixed.dockerMemoryFreeGb).toBe(2);
  });

  it('marks Docker unreachable when docker info fails, and leaves other readings alone', async () => {
    const load = await readHostLoad(
      { sysctl: async () => '50', docker: docker(new Error('daemon down'), '') },
      os,
    );
    expect(load).toEqual({ loadPerCore: 0.5, hostMemoryFreeGb: 8, dockerReachable: false });
  });

  it('leaves a failed reading unknown without holding anything', async () => {
    const load = await readHostLoad(
      {
        sysctl: async () => {
          throw new Error('no sysctl');
        },
        docker: docker(`${4 * GIB}`, new Error('stats failed')),
      },
      os,
    );
    expect(load).toEqual({ loadPerCore: 0.5, dockerReachable: true });
    const garbled = await readHostLoad(
      { sysctl: async () => 'abc', docker: docker('nope', 'lots') },
      os,
    );
    expect(garbled).toEqual({ loadPerCore: 0.5, dockerReachable: true });
    const blank = await readHostLoad({ sysctl: async () => '', docker: docker('', '') }, os);
    expect(blank).toEqual({ loadPerCore: 0.5, dockerReachable: true });
  });
});
