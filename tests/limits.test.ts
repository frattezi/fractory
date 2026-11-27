import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { type CliEnv, main } from '../src/cli.ts';
import { ResourceLimitsSchema } from '../src/contracts/factory-config.ts';
import type { HostState } from '../src/contracts/host-state.ts';
import { type LimitsReaders, formatLimits, readLimits } from '../src/limits/limits.ts';
import { LIMIT_RANGES, nodeConfigFiles, setLimits } from '../src/limits/set.ts';
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
      machine: () => ({ cores: 8, memoryGb: 16 }),
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
    expect(await main(['limits', 'bogus'], env)).not.toBe(0);
  });

  it('sets limits through the CLI and prints what changed', async () => {
    const { env, out } = await setup();
    expect(await main(['limits', 'set', 'cpusPerRun=2', 'maxConcurrentRuns=4'], env)).toBe(0);
    expect(out[0]).toContain('cpusPerRun: 4 -> 2');
    expect(out[0]).toContain('maxConcurrentRuns: 2 -> 4');
    const written = JSON.parse(await readFile(env.factoryConfigPath, 'utf8'));
    expect(written).toMatchObject({ maxConcurrentRuns: 4, resources: { cpusPerRun: 2 } });
    out.length = 0;
    expect(await main(['limits', 'set', 'maxConcurrentRuns=1', '--json'], env)).toBe(0);
    expect(JSON.parse(out[0] as string)).toEqual({
      changes: [{ key: 'maxConcurrentRuns', from: 4, to: 1 }],
    });
  });

  it('exits non-zero and writes nothing when the CLI is asked for an out-of-range value', async () => {
    const { env } = await setup();
    const before = await readFile(env.factoryConfigPath, 'utf8');
    expect(await main(['limits', 'set', 'cpusPerRun=32'], env)).not.toBe(0);
    expect(await readFile(env.factoryConfigPath, 'utf8')).toBe(before);
  });
});

describe('setLimits', () => {
  const machine = { cores: 8, memoryGb: 16 };
  const original = `${JSON.stringify({ repos: ['/r'], maxConcurrentRuns: 2, resources: { cpusPerRun: 4 } }, null, 2)}\n`;

  const setup = async (text: string | null = original) => {
    const root = await mkdtemp(join(tmpdir(), 'fractory-limits-set-'));
    const path = join(root, 'config.json');
    if (text !== null) await writeFile(path, text);
    await writeFile(`${path}.bak`, 'the backup');
    const read = async () => readFile(path, 'utf8');
    return { root, path, read };
  };

  it('refuses a value outside its range, with the range in the message, and writes nothing', async () => {
    const { path, read } = await setup();
    await expect(setLimits(['cpusPerRun=32'], { path, machine })).rejects.toThrow(
      'cpusPerRun=32 is outside its range 0.5..8 (maximum: the core count, 8)',
    );
    await expect(setLimits(['maxLoadPerCore=0'], { path, machine })).rejects.toThrow(
      /range 0\.1\.\.2 .*Nothing was written/,
    );
    await expect(setLimits(['maxConcurrentRuns=1.5'], { path, machine })).rejects.toThrow(
      /not a whole number; its range is 1\.\.2, a whole number/,
    );
    await expect(setLimits(['minHostMemoryFreeGb=64'], { path, machine })).rejects.toThrow(
      "range 0..16 (maximum: the host's total memory, 16 GB)",
    );
    expect(await read()).toBe(original);
  });

  it('never clamps: an out-of-range request fails rather than being lowered', async () => {
    const { path, read } = await setup();
    await expect(setLimits(['maxConcurrentRuns=32'], { path, machine })).rejects.toThrow(
      'maxConcurrentRuns=32 is outside its range 1..2, a whole number (maximum: 8 cores / cpusPerRun 4)',
    );
    expect(JSON.parse(await read()).maxConcurrentRuns).toBe(2);
  });

  it('derives the maximum from the injected core count', async () => {
    const { path, read } = await setup();
    await expect(
      setLimits(['cpusPerRun=12'], { path, machine: { cores: 8, memoryGb: 16 } }),
    ).rejects.toThrow('range 0.5..8');
    await setLimits(['cpusPerRun=12', 'maxConcurrentRuns=1'], {
      path,
      machine: { cores: 16, memoryGb: 16 },
    });
    expect(JSON.parse(await read()).resources.cpusPerRun).toBe(12);

    const ctx = (cores: number, cpusPerRun: number) => ({
      machine: { cores, memoryGb: 16 },
      config: { ...factory, resources: { ...limits, cpusPerRun } } as never,
    });
    expect(LIMIT_RANGES.maxConcurrentRuns.max(ctx(8, 4))?.value).toBe(2);
    expect(LIMIT_RANGES.maxConcurrentRuns.max(ctx(32, 4))?.value).toBe(8);
    expect(LIMIT_RANGES.maxConcurrentRuns.max(ctx(10, 3))?.value).toBe(3);
    expect(LIMIT_RANGES.cpusPerRun.max(ctx(6, 4))?.value).toBe(6);
  });

  it('checks maxConcurrentRuns against the cpusPerRun set in the same call', async () => {
    const { path, read } = await setup();
    await setLimits(['cpusPerRun=2', 'maxConcurrentRuns=4'], { path, machine });
    expect(JSON.parse(await read())).toMatchObject({
      maxConcurrentRuns: 4,
      resources: { cpusPerRun: 2 },
    });
    // Raising cpusPerRun alone would leave maxConcurrentRuns 4 above 8 / 4 = 2.
    await expect(setLimits(['cpusPerRun=4'], { path, machine })).rejects.toThrow(
      /maxConcurrentRuns=4 is outside its range 1\.\.2, a whole number .*set it in the same call/,
    );
  });

  it('refuses when the core count could not be read, rather than guessing', async () => {
    const { path, read } = await setup();
    await expect(
      setLimits(['cpusPerRun=2'], { path, machine: { cores: 0, memoryGb: 16 } }),
    ).rejects.toThrow('could not be taken');
    expect(await read()).toBe(original);
  });

  it('writes several keys together or not at all', async () => {
    const { path, read } = await setup();
    await expect(
      setLimits(['maxLoadPerCore=1', 'cpusPerRun=32', 'maxConcurrentRuns=2'], { path, machine }),
    ).rejects.toThrow('cpusPerRun=32');
    expect(await read()).toBe(original);

    const changes = await setLimits(['maxLoadPerCore=1', 'minDockerMemoryFreeGb=3'], {
      path,
      machine,
    });
    expect(changes).toEqual([
      { key: 'maxLoadPerCore', from: 0.75, to: 1 },
      { key: 'minDockerMemoryFreeGb', from: 1, to: 3 },
    ]);
    const written = JSON.parse(await read());
    expect(written).toEqual({
      repos: ['/r'],
      maxConcurrentRuns: 2,
      resources: { cpusPerRun: 4, maxLoadPerCore: 1, minDockerMemoryFreeGb: 3 },
    });
  });

  it('leaves the original intact and no temporary file when the write fails', async () => {
    const { root, path, read } = await setup();
    const failingRename = {
      ...nodeConfigFiles,
      rename: async () => Promise.reject(new Error('disk full')),
    };
    await expect(
      setLimits(['cpusPerRun=2'], { path, machine, files: failingRename }),
    ).rejects.toThrow('Could not write');
    expect(await read()).toBe(original);
    const failingWrite = {
      ...nodeConfigFiles,
      write: async () => Promise.reject(new Error('EACCES')),
    };
    await expect(
      setLimits(['cpusPerRun=2'], { path, machine, files: failingWrite }),
    ).rejects.toThrow('The original is unchanged');
    expect(await read()).toBe(original);
    expect((await readdir(root)).sort()).toEqual(['config.json', 'config.json.bak']);
  });

  it('keeps the .bak beside the config', async () => {
    const { root, path } = await setup();
    await setLimits(['cpusPerRun=2'], { path, machine });
    expect(await readFile(`${path}.bak`, 'utf8')).toBe('the backup');
    expect((await readdir(root)).sort()).toEqual(['config.json', 'config.json.bak']);
  });

  it('creates the config when there is none, without writing the defaults into it', async () => {
    const { path, read } = await setup(null);
    await setLimits(['maxConcurrentRuns=1'], { path, machine });
    expect(JSON.parse(await read())).toEqual({ maxConcurrentRuns: 1 });
  });

  it('refuses an unknown key, a repeated key or a non-number', async () => {
    const { path, read } = await setup();
    await expect(setLimits(['cores=2'], { path, machine })).rejects.toThrow(
      'Unknown limit "cores"',
    );
    await expect(setLimits(['cpusPerRun=2', 'cpusPerRun=3'], { path, machine })).rejects.toThrow(
      'more than once',
    );
    await expect(setLimits(['cpusPerRun=lots'], { path, machine })).rejects.toThrow(
      'needs a number',
    );
    await expect(setLimits([], { path, machine })).rejects.toThrow('Usage');
    expect(await read()).toBe(original);
  });

  it('refuses a Host Limit while Host Limits are off, without turning them on', async () => {
    const off = `${JSON.stringify({ resources: false })}\n`;
    const { path, read } = await setup(off);
    await expect(setLimits(['cpusPerRun=2'], { path, machine })).rejects.toThrow(
      'Host Limits are off',
    );
    expect(await read()).toBe(off);
    await setLimits(['maxConcurrentRuns=8'], { path, machine });
    expect(JSON.parse(await read())).toEqual({ resources: false, maxConcurrentRuns: 8 });
  });

  it('refuses to overwrite a config that does not parse', async () => {
    const { path, read } = await setup('{ not json');
    await expect(setLimits(['cpusPerRun=2'], { path, machine })).rejects.toThrow('not valid JSON');
    expect(await read()).toBe('{ not json');
  });
});
