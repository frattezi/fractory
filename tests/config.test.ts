import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { describeRepoConfig, loadFactoryConfig, loadRepoConfig } from '../src/config/index.ts';
import { DEFAULT_IDLE_TIMEOUT_SECONDS } from '../src/contracts/repo-config.ts';

const tmp = () => mkdtemp(join(tmpdir(), 'fractory-config-'));

describe('loadFactoryConfig', () => {
  it('uses defaults when the file is missing', async () => {
    const config = await loadFactoryConfig(join(await tmp(), 'config.json'));
    expect(config).toMatchObject({ repos: [], maxConcurrentRuns: 3, staleWorktreeDays: 7 });
  });

  it('merges a partial file with defaults and rejects invalid values', async () => {
    const dir = await tmp();
    const path = join(dir, 'config.json');
    await writeFile(path, JSON.stringify({ repos: ['/a'], maxConcurrentRuns: 1 }));
    expect(await loadFactoryConfig(path)).toMatchObject({
      repos: ['/a'],
      maxConcurrentRuns: 1,
      staleWorktreeDays: 7,
    });
    await writeFile(path, JSON.stringify({ maxConcurrentRuns: 0 }));
    await expect(loadFactoryConfig(path)).rejects.toThrow(/Invalid factory config/);
    await writeFile(path, '{nope');
    await expect(loadFactoryConfig(path)).rejects.toThrow(/not valid JSON/);
  });
});

describe('loadRepoConfig', () => {
  it('loads with defaults and computes the Gates', async () => {
    const dir = await tmp();
    await writeFile(
      join(dir, '.fractory.json'),
      JSON.stringify({
        mode: 'personal',
        ticketSource: { kind: 'github', repo: 'me/app' },
        hasCi: true,
      }),
    );
    const config = await loadRepoConfig(dir);
    expect(config).toMatchObject({ baseBranch: 'main', maxIterations: 10, ticketGate: false });
    expect(config.idleTimeoutSeconds).toBe(DEFAULT_IDLE_TIMEOUT_SECONDS);
    // A quiet test suite that runs 530 to 690 seconds must fit in the default.
    expect(config.idleTimeoutSeconds).toBeGreaterThan(690);
    expect(describeRepoConfig(config)).toMatchObject({
      requiresPrGate: false,
      requiresTicketGate: false,
    });
    expect(describeRepoConfig({ ...config, mode: 'work' })).toMatchObject({
      requiresPrGate: true,
      requiresTicketGate: true,
    });
  });

  it('takes the idle timeout from the file and refuses a bad one', async () => {
    const dir = await tmp();
    const write = (idleTimeoutSeconds: unknown) =>
      writeFile(
        join(dir, '.fractory.json'),
        JSON.stringify({
          mode: 'personal',
          ticketSource: { kind: 'github', repo: 'me/app' },
          hasCi: true,
          idleTimeoutSeconds,
        }),
      );
    await write(3600);
    const config = await loadRepoConfig(dir);
    expect(config.idleTimeoutSeconds).toBe(3600);
    expect(describeRepoConfig(config)).toMatchObject({ idleTimeoutSeconds: 3600 });
    for (const bad of [0, -5, 1.5, '900', 86_401]) {
      await write(bad);
      await expect(loadRepoConfig(dir)).rejects.toThrow(/Invalid repo config/);
    }
  });

  it('explains a missing or invalid file', async () => {
    const dir = await tmp();
    await expect(loadRepoConfig(dir)).rejects.toThrow(/fractory init/);
    await writeFile(join(dir, '.fractory.json'), JSON.stringify({ mode: 'x' }));
    await expect(loadRepoConfig(dir)).rejects.toThrow(/Invalid repo config/);
  });
});
