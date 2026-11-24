import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { describeRepoConfig, loadFactoryConfig, loadRepoConfig } from '../src/config/index.ts';

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
    expect(await loadFactoryConfig(path)).toMatchObject({ repos: ['/a'], maxConcurrentRuns: 1, staleWorktreeDays: 7 });
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
      JSON.stringify({ mode: 'personal', ticketSource: { kind: 'github', repo: 'me/app' }, hasCi: true }),
    );
    const config = await loadRepoConfig(dir);
    expect(config).toMatchObject({ baseBranch: 'main', maxIterations: 10, ticketGate: false });
    expect(describeRepoConfig(config)).toMatchObject({ requiresPrGate: false, requiresTicketGate: false });
    expect(describeRepoConfig({ ...config, mode: 'work' })).toMatchObject({
      requiresPrGate: true,
      requiresTicketGate: true,
    });
  });

  it('explains a missing or invalid file', async () => {
    const dir = await tmp();
    await expect(loadRepoConfig(dir)).rejects.toThrow(/fractory init/);
    await writeFile(join(dir, '.fractory.json'), JSON.stringify({ mode: 'x' }));
    await expect(loadRepoConfig(dir)).rejects.toThrow(/Invalid repo config/);
  });
});
