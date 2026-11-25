import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { type CliEnv, main, parseArgs } from '../src/cli.ts';
import { RunRegistry } from '../src/registry/registry.ts';
import { FakeGh, FakeSource, makeRun, makeTicket, memoryLogger } from './trigger-helpers.ts';

const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), 'fractory-cli-'));
  const repo = join(root, 'repo');
  await mkdir(repo);
  await writeFile(
    join(repo, '.fractory.json'),
    JSON.stringify({ mode: 'work', ticketSource: { kind: 'github', repo: 'me/app' }, hasCi: true }),
  );
  const registryDir = join(root, 'runs');
  await writeFile(
    join(root, 'config.json'),
    JSON.stringify({
      repos: [repo],
      registryDir,
      logDir: join(root, 'logs'),
      hostStatePath: join(root, 'host.json'),
      resources: false,
    }),
  );
  await mkdir(join(root, 'launchd'));
  const template = await readFile(
    join(process.cwd(), 'launchd', 'com.fractory.tick.plist.template'),
    'utf8',
  );
  await writeFile(join(root, 'launchd', 'com.fractory.tick.plist.template'), template);

  const out: string[] = [];
  const launchctlCalls: string[][] = [];
  const source = new FakeSource([makeTicket(5)]);
  const env: CliEnv = {
    out: (l) => out.push(l),
    cwd: repo,
    factoryConfigPath: join(root, 'config.json'),
    rootDir: root,
    home: root,
    launchAgentsDir: join(root, 'LaunchAgents'),
    uid: 501,
    exec: async () => '',
    gh: new FakeGh(),
    launchctl: async (args) => {
      launchctlCalls.push(args);
    },
    resolveBin: (name) => (name === 'docker' ? undefined : `/opt/tools/${name}`),
    createTicketSource: () => source,
    createTicket: async (_c, input, options) => ({
      ref: 'github:me/app#99',
      url: `https://example.test/${input.title}?${options.mode}`,
    }),
    launchRun: vi.fn(async () => {}),
    makeLogger: () => memoryLogger(),
    now: () => new Date('2026-06-01T00:00:00.000Z'),
    newId: () => 'manual-1',
  };
  return { root, repo, env, out, source, launchctlCalls, registry: new RunRegistry(registryDir) };
};

describe('parseArgs', () => {
  it('handles positionals, --k v, --k=v, booleans and repeatable flags', () => {
    expect(
      parseArgs([
        'x',
        '--mode',
        'work',
        '--github=a/b',
        '--ci',
        '--blocked-by',
        'jira:A-1',
        '--blocked-by',
        'jira:A-2',
      ]),
    ).toEqual({
      positionals: ['x'],
      flags: { mode: 'work', github: 'a/b', ci: true, 'blocked-by': ['jira:A-1', 'jira:A-2'] },
    });
    expect(() => parseArgs(['--mode'])).toThrow(/needs a value/);
  });
});

describe('fractory CLI', () => {
  it('config show prints the merged config with computed Gates', async () => {
    const { env, out } = await setup();
    expect(await main(['config', 'show'], env)).toBe(0);
    expect(JSON.parse(out[0] as string)).toMatchObject({
      mode: 'work',
      baseBranch: 'main',
      requiresTicketGate: true,
      requiresPrGate: true,
    });
  });

  it('config show includes the workflow description', async () => {
    const { env, out } = await setup();
    expect(await main(['config', 'show'], env)).toBe(0);
    expect(JSON.parse(out[0] as string).workflow.rules.length).toBeGreaterThan(5);
  });

  it('rules prints readable text, or JSON with --json', async () => {
    const { env, out } = await setup();
    expect(await main(['rules'], env)).toBe(0);
    expect(out[0]).toContain('PR Gate');
    expect(out[0]).toContain('Concurrency');
    out.length = 0;
    expect(await main(['rules', '--json'], env)).toBe(0);
    expect(JSON.parse(out[0] as string)).toMatchObject({ mode: 'work', account: 'work' });
  });

  it('status reports the Mode and hands-off branches of the current repo, or says it is not one', async () => {
    const { env, out, registry, root } = await setup();
    await registry.write(makeRun({ repoPath: env.cwd, status: 'running', pid: 1 }));
    expect(await main(['status', '--json'], env)).toBe(0);
    expect(JSON.parse(out[0] as string)).toMatchObject({
      managed: true,
      mode: 'work',
      prGate: true,
      autoMerge: false,
      factoryBranches: ['fractory/1-add-thing-1'],
    });
    out.length = 0;
    expect(await main(['status', root], env)).toBe(0);
    expect(out[0]).toMatch(/not a Fractory repository/);
  });

  it('status shows the host state from host.json, in text and JSON', async () => {
    const { env, out, root } = await setup();
    expect(await main(['status'], env)).toBe(0);
    expect(out[0]).toContain('no tick has written the host state yet');
    out.length = 0;
    expect(await main(['status', '--json'], env)).toBe(0);
    expect(JSON.parse(out[0] as string).host).toBeNull();

    const host = {
      version: 1,
      held: true,
      reason: 'Docker memory 0.8 GB free < 1 GB',
      heldSince: '2026-05-31T23:18:00.000Z',
      readings: {
        dockerMemoryFreeGb: 0.8,
        dockerReachable: true,
        checkedAt: '2026-05-31T23:59:00.000Z',
      },
      queued: 2,
      updatedAt: '2026-05-31T23:59:00.000Z',
    };
    await writeFile(join(root, 'host.json'), JSON.stringify(host));
    out.length = 0;
    await main(['status'], env);
    expect(out[0]).toContain('queue Held 42 min: Docker memory 0.8 GB free < 1 GB (2 Runs queued)');
    out.length = 0;
    await main(['status', '--json'], env);
    expect(JSON.parse(out[0] as string).host).toEqual(host);
  });

  it('tick writes host.json through the injected sysctl and docker, with Host Limits on by default', async () => {
    const { env, root } = await setup();
    await writeFile(
      join(root, 'config.json'),
      JSON.stringify({
        repos: [env.cwd],
        registryDir: join(root, 'runs'),
        logDir: join(root, 'logs'),
        hostStatePath: join(root, 'host.json'),
      }),
    );
    const calls: string[] = [];
    env.exec = async (cmd, args) => {
      calls.push(`${cmd} ${args[0]}`);
      if (cmd === 'docker' && args[0] === 'info') throw new Error('daemon down');
      return '';
    };
    await main(['tick'], env);
    const host = JSON.parse(await readFile(join(root, 'host.json'), 'utf8'));
    expect(host).toMatchObject({ held: true, reason: 'Docker is not reachable', queued: 1 });
    expect(calls).toContain('docker info');
    expect(calls).toContain('sysctl -n');
  });

  it('config defaults Host Limits on and accepts resources: false', async () => {
    const { loadFactoryConfig } = await import('../src/config/index.ts');
    const dir = await mkdtemp(join(tmpdir(), 'fractory-cfg-'));
    const path = join(dir, 'config.json');
    expect((await loadFactoryConfig(path)).resources).toEqual({
      maxLoadPerCore: 0.75,
      minHostMemoryFreeGb: 2,
      minDockerMemoryFreeGb: 1,
      maxLaunchesPerTick: 1,
      cpusPerRun: 4,
    });
    await writeFile(path, JSON.stringify({ resources: { cpusPerRun: 2 } }));
    expect((await loadFactoryConfig(path)).resources).toMatchObject({
      cpusPerRun: 2,
      maxLoadPerCore: 0.75,
    });
    await writeFile(path, JSON.stringify({ resources: false }));
    expect((await loadFactoryConfig(path)).resources).toBe(false);
    expect((await loadFactoryConfig(path)).hostStatePath).toMatch(/host\.json$/);
  });

  it('run queues a manual Run on the Ticket branch and runs lists it', async () => {
    const { env, out, registry } = await setup();
    expect(await main(['run', 'github:me/app#5'], env)).toBe(0);
    const [run] = await registry.list();
    expect(run).toMatchObject({
      id: 'manual-1',
      status: 'queued',
      trigger: { kind: 'manual' },
      branch: 'feat/5-add-thing-5',
    });
    out.length = 0;
    expect(await main(['runs'], env)).toBe(0);
    expect(out[0]).toContain('manual-1');
    expect(out[0]).toContain('queued');
    expect(out[0]).toContain('MODE');
    expect(out[0]).toContain('AGENTS');
  });

  it('run takes the Ticket out of Ready so the tick does not queue a second Run', async () => {
    const { env, source } = await setup();
    expect(await main(['run', 'github:me/app#5'], env)).toBe(0);
    expect(source.statusCalls).toEqual([['github:me/app#5', 'in_progress']]);
  });

  it('run rejects a Ticket no configured repo owns', async () => {
    const { env } = await setup();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await main(['run', 'github:other/thing#1'], env)).toBe(1);
    err.mockRestore();
  });

  it('tick runs end to end with injected deps', async () => {
    const { env, out, registry } = await setup();
    await main(['tick'], env);
    expect(JSON.parse(out[0] as string)).toMatchObject({
      locked: false,
      queued: ['manual-1'],
      launched: ['manual-1'],
    });
    expect((await registry.list())[0]?.ticketRef).toBe('github:me/app#5');
  });

  it('launchd install writes the plist and calls launchctl only through the injected function', async () => {
    const { env, root, launchctlCalls } = await setup();
    expect(await main(['launchd', 'install'], env)).toBe(0);
    const plist = await readFile(join(root, 'LaunchAgents', 'com.fractory.tick.plist'), 'utf8');
    expect(plist).toContain('<integer>180</integer>');
    expect(plist).toContain('/opt/tools');
    expect(plist).toContain('<string>tick</string>');
    expect(plist).not.toContain('{{');
    expect(launchctlCalls.at(-1)).toEqual([
      'bootstrap',
      'gui/501',
      join(root, 'LaunchAgents', 'com.fractory.tick.plist'),
    ]);

    expect(await main(['launchd', 'uninstall'], env)).toBe(0);
    await expect(stat(join(root, 'LaunchAgents', 'com.fractory.tick.plist'))).rejects.toThrow();
    expect(launchctlCalls.at(-1)?.[0]).toBe('bootout');
  });

  it('tickets create refuses Ready while the Ticket Gate is on', async () => {
    const { env, repo } = await setup();
    await writeFile(join(repo, 'body.md'), 'Do it');
    const spy = vi.fn(env.createTicket);
    env.createTicket = spy;
    const args = [
      'tickets',
      'create',
      '--title',
      'T',
      '--body-file',
      'body.md',
      '--status',
      'ready',
    ];
    expect(await main(args, env)).toBe(1);
    expect(spy).not.toHaveBeenCalled();
  });

  it('tickets create passes the repo mode and relations to the adapter', async () => {
    const { env, out, repo } = await setup();
    await writeFile(join(repo, 'body.md'), 'Do it');
    const spy = vi.fn(env.createTicket);
    env.createTicket = spy;
    expect(
      await main(
        [
          'tickets',
          'create',
          '--title',
          'T',
          '--body-file',
          'body.md',
          '--status',
          'backlog',
          '--blocked-by',
          'github:me/app#1',
        ],
        env,
      ),
    ).toBe(0);
    expect(spy).toHaveBeenCalledWith(
      { kind: 'github', repo: 'me/app' },
      { title: 'T', body: 'Do it', status: 'backlog', blockedBy: ['github:me/app#1'] },
      { mode: 'work' },
    );
    expect(JSON.parse(out[0] as string)).toMatchObject({ ref: 'github:me/app#99' });
  });

  it('prints help and fails on an unknown command', async () => {
    const { env, out } = await setup();
    expect(await main(['nope'], env)).toBe(1);
    expect(out[0]).toContain('Usage: fractory');
  });

  it.each(['help', '--help', '-h'])('prints help and succeeds on %s', async (spelling) => {
    const { env, out } = await setup();
    expect(await main([spelling], env)).toBe(0);
    expect(out[0]).toContain('Usage: fractory');
  });

  it('prints help and succeeds with no arguments', async () => {
    const { env, out } = await setup();
    expect(await main([], env)).toBe(0);
    expect(out[0]).toContain('Usage: fractory');
  });

  it('keeps unused fixtures honest', () => {
    expect(makeRun().id).toBe('r1');
  });
});
