import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { type CliEnv, main } from '../src/cli.ts';
import { ResourceLimitsSchema } from '../src/contracts/factory-config.ts';
import type { HostState } from '../src/contracts/host-state.ts';
import { type LimitsReaders, formatLimits, readLimits } from '../src/limits/limits.ts';
import { RunRegistry } from '../src/registry/registry.ts';
import { FakeGh, FakeSource, makeRun, memoryLogger } from './trigger-helpers.ts';

const limits = ResourceLimitsSchema.parse({});
const factory = { resources: limits, maxConcurrentRuns: 3 };
const now = new Date('2026-06-01T00:00:00.000Z');

const held: HostState = {
  version: 1,
  held: true,
  reason: 'Docker memory 0.8 GB free < 1 GB',
  heldSince: '2026-05-31T23:18:00.000Z',
  queued: 2,
  updatedAt: '2026-05-31T23:59:00.000Z',
};

const readers = (over: Partial<LimitsReaders> = {}): LimitsReaders => ({
  hostLoad: async () => ({
    loadPerCore: 0.5,
    hostMemoryFreeGb: 6,
    dockerMemoryFreeGb: 0.8,
    dockerReachable: true,
  }),
  hostState: async () => held,
  running: async () => 2,
  ...over,
});

describe('readLimits', () => {
  it('shows each reading against the limit it is checked against', async () => {
    const report = await readLimits(readers(), factory);
    expect(report.checks).toEqual([
      {
        key: 'maxLoadPerCore',
        label: 'CPU load',
        unit: 'per core',
        bound: 'max',
        limit: 0.75,
        reading: 0.5,
        status: 'ok',
      },
      {
        key: 'minHostMemoryFreeGb',
        label: 'Host memory free',
        unit: 'GB',
        bound: 'min',
        limit: 2,
        reading: 6,
        status: 'ok',
      },
      {
        key: 'minDockerMemoryFreeGb',
        label: 'Docker memory free',
        unit: 'GB',
        bound: 'min',
        limit: 1,
        reading: 0.8,
        status: 'holds',
      },
    ]);
    expect(report.docker).toEqual({ reachable: true, status: 'ok' });
    const text = formatLimits(report, now);
    expect(text).toMatch(/CPU load\s+0\.50 per core\s+max 0\.75 per core\s+ok/);
    expect(text).toMatch(/Host memory free\s+6\.0 GB\s+min 2 GB\s+ok/);
    expect(text).toMatch(/Docker memory free\s+0\.8 GB\s+min 1 GB\s+HOLDS/);
  });

  it('agrees with the tick at the boundary: a reading equal to its limit does not hold', async () => {
    const report = await readLimits(
      readers({
        hostLoad: async () => ({ loadPerCore: 0.75, hostMemoryFreeGb: 2, dockerReachable: true }),
      }),
      factory,
    );
    expect(report.checks.map((c) => c.status)).toEqual(['ok', 'ok', 'unknown']);
    const over = await readLimits(
      readers({ hostLoad: async () => ({ loadPerCore: 0.9, dockerReachable: true }) }),
      factory,
    );
    expect(over.checks[0]?.status).toBe('holds');
  });

  it('reports a reading that could not be taken as unknown, never as a breach', async () => {
    const report = await readLimits(
      readers({ hostLoad: async () => ({ dockerReachable: true }) }),
      factory,
    );
    for (const check of report.checks) {
      expect(check.reading).toBeNull();
      expect(check.status).toBe('unknown');
    }
    const text = formatLimits(report, now);
    expect(text).not.toContain('HOLDS');
    expect(text).toMatch(/Host memory free\s+unknown\s+min 2 GB\s+unknown \(could not be read\)/);
  });

  it('treats a reader that throws as unknown, never as a breach or a crash', async () => {
    const fail = async (): Promise<never> => {
      throw new Error('boom');
    };
    const report = await readLimits(
      readers({ hostLoad: fail, hostState: fail, running: fail }),
      factory,
    );
    expect(report.checks.every((c) => c.status === 'unknown')).toBe(true);
    expect(report.docker).toEqual({ reachable: null, status: 'unknown' });
    expect(report.concurrency).toEqual({ maxConcurrentRuns: 3, running: null, status: 'unknown' });
    expect(report.queue).toBeNull();
    const text = formatLimits(report, now);
    expect(text).not.toContain('HOLDS');
    expect(text).toContain('Concurrency: unknown Runs running of maxConcurrentRuns 3');
  });

  it('an unreachable Docker holds, as it does in the tick', async () => {
    const report = await readLimits(
      readers({ hostLoad: async () => ({ loadPerCore: 0.1, dockerReachable: false }) }),
      factory,
    );
    expect(report.docker).toEqual({ reachable: false, status: 'holds' });
    expect(report.checks[2]?.status).toBe('unknown');
    expect(formatLimits(report, now)).toMatch(/Docker\s+not reachable\s+reachable\s+HOLDS/);
  });

  it('shows maxConcurrentRuns beside the Runs actually running', async () => {
    const room = await readLimits(readers(), factory);
    expect(room.concurrency).toEqual({ maxConcurrentRuns: 3, running: 2, status: 'room' });
    expect(formatLimits(room, now)).toContain('Concurrency: 2 of maxConcurrentRuns 3 running.');
    const full = await readLimits(readers({ running: async () => 3 }), factory);
    expect(full.concurrency.status).toBe('full');
    expect(formatLimits(full, now)).toContain('3 of maxConcurrentRuns 3 running (full)');
  });

  it("shows the queue's held state and depth from host.json, or says there is none", async () => {
    const report = await readLimits(readers(), factory);
    expect(report.queue).toEqual({
      held: true,
      reason: 'Docker memory 0.8 GB free < 1 GB',
      heldSince: '2026-05-31T23:18:00.000Z',
      queued: 2,
      updatedAt: '2026-05-31T23:59:00.000Z',
    });
    expect(formatLimits(report, now)).toContain(
      'Queue: Held 42 min: Docker memory 0.8 GB free < 1 GB (2 Runs queued',
    );
    const free = await readLimits(
      readers({ hostState: async () => ({ ...held, held: false, reason: undefined, queued: 0 }) }),
      factory,
    );
    expect(formatLimits(free, now)).toContain('Queue: not Held (0 Runs queued');
    const none = await readLimits(readers({ hostState: async () => undefined }), factory);
    expect(formatLimits(none, now)).toContain('Queue: no tick has written the host state yet.');
  });

  it('with Host Limits off, still shows the readings but holds nothing', async () => {
    const report = await readLimits(readers(), { resources: false, maxConcurrentRuns: 3 });
    expect(report.enabled).toBe(false);
    expect(report.checks.every((c) => c.status === 'off' && c.limit === null)).toBe(true);
    expect(report.checks[2]?.reading).toBe(0.8);
    expect(report.docker.status).toBe('off');
    const text = formatLimits(report, now);
    expect(text).toContain('Host Limits: off');
    expect(text).not.toContain('HOLDS');
  });
});

describe('fractory limits', () => {
  const setup = async () => {
    const root = await mkdtemp(join(tmpdir(), 'fractory-limits-'));
    const registryDir = join(root, 'runs');
    await mkdir(registryDir);
    await writeFile(
      join(root, 'config.json'),
      JSON.stringify({
        repos: [],
        registryDir,
        logDir: join(root, 'logs'),
        hostStatePath: join(root, 'host.json'),
        automationsDir: join(root, 'automations'),
        maxConcurrentRuns: 2,
      }),
    );
    await writeFile(join(root, 'host.json'), JSON.stringify(held));
    const out: string[] = [];
    const exec = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === 'sysctl') throw new Error('not macOS');
      if (args[0] === 'info') return `${4 * 1024 ** 3}\n`;
      if (args[0] === 'stats') return '3.5GiB / 4GiB\n';
      throw new Error(`unexpected ${cmd}`);
    });
    const env: CliEnv = {
      out: (l) => out.push(l),
      cwd: root,
      factoryConfigPath: join(root, 'config.json'),
      rootDir: root,
      home: root,
      launchAgentsDir: join(root, 'LaunchAgents'),
      uid: 501,
      exec,
      runShell: async () => 0,
      gh: new FakeGh(),
      launchctl: async () => {},
      resolveBin: () => undefined,
      createTicketSource: () => new FakeSource([]),
      createTicket: async () => ({ ref: 'github:me/app#1', url: 'https://example.test' }),
      launchRun: vi.fn(async () => {}),
      launchAutomationRun: vi.fn(async () => {}),
      makeLogger: () => memoryLogger(),
      now: () => now,
      newId: () => 'x',
    };
    const registry = new RunRegistry(registryDir);
    await registry.write(makeRun({ id: 'a', status: 'running', pid: 1 }));
    await registry.write(makeRun({ id: 'b', status: 'queued' }));
    return { env, out };
  };

  it('prints the readings beside their limits, in text and JSON', async () => {
    const { env, out } = await setup();
    expect(await main(['limits'], env)).toBe(0);
    expect(out[0]).toMatch(/Docker memory free\s+0\.5 GB\s+min 1 GB\s+HOLDS/);
    expect(out[0]).toMatch(/Host memory free\s+unknown/);
    expect(out[0]).toContain('Concurrency: 1 of maxConcurrentRuns 2 running.');
    expect(out[0]).toContain('Queue: Held 42 min');
    out.length = 0;
    expect(await main(['limits', '--json'], env)).toBe(0);
    const report = JSON.parse(out[0] as string);
    expect(report.checks[1]).toMatchObject({ reading: null, status: 'unknown' });
    expect(report.checks[2]).toMatchObject({ limit: 1, reading: 0.5, status: 'holds' });
    expect(report.concurrency).toEqual({ maxConcurrentRuns: 2, running: 1, status: 'room' });
    expect(report.queue).toMatchObject({ held: true, queued: 2 });
  });

  it('refuses a subcommand it does not know', async () => {
    const { env } = await setup();
    expect(await main(['limits', 'set', 'cpusPerRun=2'], env)).not.toBe(0);
  });
});
