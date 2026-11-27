import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { type CliEnv, main } from '../src/cli.ts';
import { type Finding, FindingSchema } from '../src/contracts/finding.ts';
import type { HostState } from '../src/contracts/host-state.ts';
import { type RepoConfig, RepoConfigSchema } from '../src/contracts/repo-config.ts';
import { type RunRecord, RunRecordSchema } from '../src/contracts/run.ts';
import {
  type DoctorReaders,
  doctor,
  formatFindings,
  renderFindings,
} from '../src/doctor/doctor.ts';
import { RunRegistry } from '../src/registry/registry.ts';
import { launchdLoaded } from '../src/trigger/launchd.ts';
import { FakeGh, FakeSource, makeRun, makeTicket, memoryLogger } from './trigger-helpers.ts';

const APP = '/repos/app';
const API = '/repos/api';

const fixtureRun = async (): Promise<RunRecord> =>
  RunRecordSchema.parse(
    JSON.parse(await readFile(join(import.meta.dirname, 'fixtures', 'doctor-run.json'), 'utf8')),
  );

const config: RepoConfig = RepoConfigSchema.parse({
  mode: 'personal',
  ticketSource: { kind: 'github', repo: 'me/app' },
  hasCi: false,
});

const NOW = new Date('2026-11-27T12:00:00.000Z');
const HOME = '/home/me/.fractory';

/** A clean machine: no tracker work, no worktree on disk, launchd loaded, no host state. */
const readers = (overrides: Partial<DoctorReaders> = {}): DoctorReaders => ({
  repos: [APP, API],
  factoryConfigPath: `${HOME}/config.json`,
  staleWorktreeDays: 7,
  now: () => NOW,
  loadRepoConfig: async () => config,
  listRuns: async () => [],
  listAnswerRequests: async () => [],
  readHostState: async () => undefined,
  ticketSource: () => new FakeSource(),
  git: async () => '',
  pathExists: async () => false,
  launchdLoaded: async () => true,
  ...overrides,
});

const host = (overrides: Partial<HostState> = {}): HostState => ({
  version: 1,
  held: false,
  queued: 0,
  updatedAt: NOW.toISOString(),
  ...overrides,
});

const kinds = (findings: Finding[]): [string, string][] =>
  findings.map((f) => [f.kind, f.repoPath]);

describe('doctor', () => {
  it('a clean factory yields an empty array', async () => {
    const done = makeRun({
      repoPath: APP,
      status: 'done',
      result: { outcome: 'done', summary: 'ok' },
    });
    expect(await doctor(readers({ listRuns: async () => [done] }))).toEqual([]);
  });

  it('reports a Run that stopped needs-human, with its question', async () => {
    const run = await fixtureRun();
    const findings = await doctor(readers({ listRuns: async () => [run] }));
    expect(findings).toEqual([
      expect.objectContaining({ kind: 'needs-human', repoPath: APP, severity: 'needs-owner' }),
    ]);
    expect(findings[0]?.observed).toContain('Should the export include archived rows?');
    expect(findings[0]?.observed).toContain('github:me/app#7');
    for (const f of findings) FindingSchema.parse(f);
  });

  it('reports an answered needs-human question as informational', async () => {
    const run = await fixtureRun();
    const findings = await doctor(
      readers({ listRuns: async () => [run], listAnswerRequests: async () => [run.id] }),
    );
    expect(findings).toEqual([
      expect.objectContaining({ kind: 'needs-human', severity: 'informational' }),
    ]);
  });

  it('has no needs-human Finding when a later Run on the Ticket superseded it', async () => {
    const run = await fixtureRun();
    const later = makeRun({
      id: 'later',
      ticketRef: run.ticketRef,
      repoPath: APP,
      status: 'running',
      createdAt: '2026-11-21T10:00:00.000Z',
    });
    expect(await doctor(readers({ listRuns: async () => [run, later] }))).toEqual([]);
  });

  it('reports a failed Run, with its summary and log', async () => {
    const run = makeRun({
      id: 'f1',
      repoPath: APP,
      status: 'failed',
      result: { outcome: 'failed', summary: 'tests would not pass' },
    });
    const findings = await doctor(readers({ listRuns: async () => [run] }));
    expect(findings).toEqual([
      expect.objectContaining({ kind: 'run-failed', repoPath: APP, severity: 'needs-owner' }),
    ]);
    expect(findings[0]?.observed).toContain('tests would not pass');
    expect(findings[0]?.remedy).toContain('/logs/f1.log');
    expect(findings[0]?.remedy).toContain(`fractory run ${run.ticketRef}`);
  });

  it('reports a Run that exhausted its budget as run-failed, not needs-human', async () => {
    const run = makeRun({
      repoPath: APP,
      status: 'needs-human',
      result: { outcome: 'needs-human', reason: 'budget-exhausted', question: 'More iterations?' },
    });
    const findings = await doctor(readers({ listRuns: async () => [run] }));
    expect(findings.map((f) => f.kind)).toEqual(['run-failed']);
    expect(findings[0]?.observed).toContain('exhausted its budget');
  });

  it('has no run-failed Finding once a later Run on the Ticket is done', async () => {
    const failed = makeRun({ id: 'a', repoPath: APP, status: 'failed' });
    const done = makeRun({
      id: 'b',
      repoPath: APP,
      status: 'done',
      createdAt: '2026-06-01T10:00:00.000Z',
    });
    expect(await doctor(readers({ listRuns: async () => [failed, done] }))).toEqual([]);
  });

  it('a repository that throws yields an unreachable Finding and the others still report', async () => {
    const run = makeRun({ repoPath: API, status: 'failed' });
    const findings = await doctor(
      readers({
        listRuns: async () => [run],
        loadRepoConfig: async (repo) => {
          if (repo === APP) throw new Error('/repos/app/.fractory.json not found');
          return config;
        },
      }),
    );
    expect(findings.map((f) => [f.kind, f.repoPath])).toEqual([
      ['unreachable', APP],
      ['run-failed', API],
    ]);
    expect(findings[0]?.observed).toContain('not found');
  });

  it('sweeps only the named repositories and refuses one that is not configured', async () => {
    const runs = [
      makeRun({ id: 'x', repoPath: APP, status: 'failed' }),
      makeRun({ id: 'y', ticketRef: 'github:me/app#2', repoPath: API, status: 'failed' }),
    ];
    const findings = await doctor(readers({ listRuns: async () => runs }), [API]);
    expect(findings.map((f) => f.repoPath)).toEqual([API]);
    await expect(doctor(readers(), ['/repos/other'])).rejects.toThrow(/not a configured repo/);
  });

  it('reads the registry once for every repository', async () => {
    const listRuns = vi.fn(async () => []);
    await doctor(readers({ listRuns }));
    expect(listRuns).toHaveBeenCalledTimes(1);
  });
});

describe('doctor: the rest of the factory', () => {
  const PR = 'https://github.com/me/app/pull/7';
  const appOnly = (overrides: Partial<DoctorReaders> = {}): DoctorReaders =>
    readers({ repos: [APP], ...overrides });

  describe('pr-unmerged', () => {
    it('reports an open pull request whose latest Run is done', async () => {
      const run = makeRun({ repoPath: APP, status: 'done', prUrl: PR, prState: 'OPEN' });
      const findings = await doctor(appOnly({ listRuns: async () => [run] }));
      expect(kinds(findings)).toEqual([['pr-unmerged', APP]]);
      expect(findings[0]?.observed).toContain(PR);
      expect(findings[0]?.remedy).toContain(`gh pr merge ${PR}`);
    });

    it('is absent once the pull request merged, closed, or a follow-up Run is active', async () => {
      for (const runs of [
        [makeRun({ repoPath: APP, prUrl: PR, prState: 'MERGED' })],
        [makeRun({ repoPath: APP, prUrl: PR, prState: 'CLOSED' })],
        [
          makeRun({ id: 'a', repoPath: APP, prUrl: PR, prState: 'OPEN' }),
          makeRun({
            id: 'b',
            repoPath: APP,
            prUrl: PR,
            status: 'running',
            createdAt: '2026-06-01T10:00:00.000Z',
          }),
        ],
      ]) {
        expect(await doctor(appOnly({ listRuns: async () => runs }))).toEqual([]);
      }
    });
  });

  describe('ready-not-started', () => {
    it('reports a Ready Ticket with no Run and no pull request', async () => {
      const source = new FakeSource([makeTicket(3)]);
      const findings = await doctor(appOnly({ ticketSource: () => source }));
      expect(findings).toEqual([
        expect.objectContaining({
          kind: 'ready-not-started',
          repoPath: APP,
          severity: 'needs-owner',
        }),
      ]);
      expect(findings[0]?.observed).toContain('github:me/app#3');
      expect(findings[0]?.remedy).toContain('fractory run github:me/app#3');
      expect(source.statusCalls).toEqual([]);
    });

    it('is informational while the next tick has not had its chance', async () => {
      const fresh = { ...makeTicket(3), updatedAt: '2026-11-27T11:59:00.000Z' };
      const findings = await doctor(appOnly({ ticketSource: () => new FakeSource([fresh]) }));
      expect(findings.map((f) => [f.kind, f.severity])).toEqual([
        ['ready-not-started', 'informational'],
      ]);
    });

    it('is absent when the Ticket has a Run, or is held on a blocker not done', async () => {
      const withRun = await doctor(
        appOnly({
          ticketSource: () => new FakeSource([makeTicket(3)]),
          listRuns: async () => [
            makeRun({ ticketRef: 'github:me/app#3', repoPath: APP, status: 'queued' }),
          ],
        }),
      );
      expect(withRun).toEqual([]);
      const blocked = { ...makeTicket(3), blockedBy: ['github:me/app#2' as const] };
      const held = await doctor(
        appOnly({ ticketSource: () => new FakeSource([blocked, makeTicket(2, 'in_progress')]) }),
      );
      expect(held).toEqual([]);
    });

    it('a tracker that cannot be read yields unreachable and the rest still reports', async () => {
      const run = makeRun({ repoPath: APP, status: 'failed' });
      const findings = await doctor(
        appOnly({
          listRuns: async () => [run],
          ticketSource: () => ({
            listReady: async () => {
              throw new Error('gh: HTTP 502');
            },
            get: async () => {
              throw new Error('unused');
            },
          }),
        }),
      );
      expect(kinds(findings)).toEqual([
        ['run-failed', APP],
        ['unreachable', APP],
      ]);
      expect(findings[1]?.observed).toContain('HTTP 502');
    });
  });

  describe('held-unblocked', () => {
    const blocked = { ...makeTicket(3), blockedBy: ['github:me/app#2' as const] };
    const heldBy = (updatedAt: string) =>
      host({
        updatedAt,
        heldTickets: [{ repoPath: APP, ticketRef: blocked.ref, blockers: ['github:me/app#2'] }],
      });

    it('reports a Held Ticket whose blockers are all satisfied and no tick started', async () => {
      const findings = await doctor(
        appOnly({
          ticketSource: () => new FakeSource([blocked, makeTicket(2, 'done')]),
          readHostState: async () => heldBy('2026-11-27T10:00:00.000Z'),
        }),
      );
      expect(findings).toEqual([
        expect.objectContaining({ kind: 'held-unblocked', repoPath: APP, severity: 'needs-owner' }),
      ]);
      expect(findings[0]?.observed).toContain('github:me/app#2');
      expect(findings[0]?.remedy).toContain('fractory run github:me/app#3');
    });

    it('is informational right after the tick that held it', async () => {
      const findings = await doctor(
        appOnly({
          ticketSource: () => new FakeSource([blocked, makeTicket(2, 'done')]),
          readHostState: async () => heldBy('2026-11-27T11:59:00.000Z'),
        }),
      );
      expect(findings.map((f) => [f.kind, f.severity])).toEqual([
        ['held-unblocked', 'informational'],
      ]);
    });

    it('is absent while a blocker is not done, or when the blocker cannot be read', async () => {
      for (const source of [
        new FakeSource([blocked, makeTicket(2, 'in_review')]),
        new FakeSource([blocked]),
      ]) {
        const findings = await doctor(
          appOnly({
            ticketSource: () => source,
            readHostState: async () => heldBy('2026-11-27T10:00:00.000Z'),
          }),
        );
        expect(findings).toEqual([]);
      }
    });
  });

  describe('stale-worktree', () => {
    const worktree = '/repos/app/.worktrees/9';
    const old = makeRun({
      id: 'w',
      repoPath: APP,
      status: 'failed',
      worktreePath: worktree,
      finishedAt: '2026-11-10T00:00:00.000Z',
      result: { outcome: 'failed', summary: 'no' },
    });

    it('reports a worktree older than staleWorktreeDays', async () => {
      const pathExists = vi.fn(async () => true);
      const findings = await doctor(appOnly({ listRuns: async () => [old], pathExists }));
      expect(kinds(findings)).toEqual([
        ['run-failed', APP],
        ['stale-worktree', APP],
      ]);
      expect(findings[1]?.observed).toContain(worktree);
      expect(findings[1]?.observed).toContain('17 days');
      expect(findings[1]?.remedy).toContain('fractory cleanup');
      expect(pathExists).toHaveBeenCalledWith(worktree);
    });

    it('is absent when younger, already cleaned, gone from disk or still in use', async () => {
      const cases: [RunRecord, boolean][] = [
        [{ ...old, finishedAt: '2026-11-25T00:00:00.000Z' }, true],
        [{ ...old, cleanedAt: '2026-11-26T00:00:00.000Z' }, true],
        [old, false],
        [{ ...old, status: 'running', result: undefined }, true],
      ];
      for (const [run, exists] of cases) {
        const findings = await doctor(
          appOnly({ listRuns: async () => [run], pathExists: async () => exists }),
        );
        expect(findings.map((f) => f.kind)).not.toContain('stale-worktree');
      }
    });
  });

  describe('host-held', () => {
    it('reports the queue Held over Host Limits, with the reading that holds it', async () => {
      const state = host({
        held: true,
        reason: 'Docker memory 0.8 GB free < 1 GB',
        heldSince: '2026-11-27T11:00:00.000Z',
        queued: 2,
        readings: {
          dockerMemoryFreeGb: 0.8,
          dockerReachable: true,
          checkedAt: '2026-11-27T11:58:00.000Z',
        },
      });
      const findings = await doctor(appOnly({ readHostState: async () => state }));
      expect(kinds(findings)).toEqual([['host-held', HOME]]);
      expect(findings[0]?.observed).toContain('Docker memory 0.8 GB free < 1 GB');
      expect(findings[0]?.observed).toContain('2 Runs queued');
      expect(findings[0]?.remedy).toContain(`${HOME}/config.json`);
    });

    it('is absent when the queue is not Held or no tick wrote the host state', async () => {
      expect(await doctor(appOnly({ readHostState: async () => host({ queued: 3 }) }))).toEqual([]);
      expect(await doctor(appOnly({ readHostState: async () => undefined }))).toEqual([]);
    });
  });

  describe('rebuild-stale', () => {
    const rebuilding = RepoConfigSchema.parse({ ...config, rebuild: ['pnpm install'] });
    const git =
      (status: string, behind: string) =>
      async (_repo: string, args: string[]): Promise<string> =>
        args[0] === 'status' ? status : behind;

    it('reports a dirty checkout and one behind origin/<baseBranch>', async () => {
      const calls: string[][] = [];
      const findings = await doctor(
        appOnly({
          loadRepoConfig: async () => rebuilding,
          git: async (repo, args) => {
            calls.push([repo, ...args]);
            return git(' M src/cli.ts\n?? notes.md\n', '3\n')(repo, args);
          },
        }),
      );
      expect(kinds(findings)).toEqual([
        ['rebuild-stale', APP],
        ['rebuild-stale', APP],
      ]);
      expect(findings[0]?.observed).toContain('dirty checkout: 2 uncommitted changes');
      expect(findings[1]?.observed).toContain('3 commits behind origin/main');
      expect(findings[1]?.remedy).toContain(`fractory rebuild ${APP}`);
      expect(calls).toEqual([
        [APP, 'status', '--porcelain'],
        [APP, 'rev-list', '--count', 'HEAD..origin/main'],
      ]);
    });

    it('is absent for a clean, current checkout, with no rebuild list, or when git fails', async () => {
      const clean = await doctor(
        appOnly({ loadRepoConfig: async () => rebuilding, git: git('', '0\n') }),
      );
      expect(clean).toEqual([]);
      const git2 = vi.fn(git(' M x\n', '1\n'));
      expect(await doctor(appOnly({ git: git2 }))).toEqual([]);
      expect(git2).not.toHaveBeenCalled();
      const failing = await doctor(
        appOnly({
          loadRepoConfig: async () => rebuilding,
          git: async () => {
            throw new Error('not a git repository');
          },
        }),
      );
      expect(failing).toEqual([]);
    });
  });

  describe('unreachable', () => {
    it('reports a .fractory.json that will not parse', async () => {
      const findings = await doctor(
        appOnly({
          loadRepoConfig: async () => {
            RepoConfigSchema.parse({ mode: 'sometimes' });
            return config;
          },
        }),
      );
      expect(findings).toEqual([
        expect.objectContaining({ kind: 'unreachable', repoPath: APP, severity: 'needs-owner' }),
      ]);
      expect(findings[0]?.remedy).toContain(`fractory config show ${APP}`);
    });
  });

  describe('launchd-not-loaded', () => {
    it('reports the launchd agent not loaded', async () => {
      const findings = await doctor(appOnly({ launchdLoaded: async () => false }));
      expect(kinds(findings)).toEqual([['launchd-not-loaded', HOME]]);
      expect(findings[0]?.remedy).toContain('fractory launchd install');
    });

    it('is absent when loaded, or when that cannot be told', async () => {
      expect(await doctor(appOnly({ launchdLoaded: async () => true }))).toEqual([]);
      expect(await doctor(appOnly({ launchdLoaded: async () => undefined }))).toEqual([]);
      expect(
        await doctor(
          appOnly({
            launchdLoaded: async () => {
              throw new Error('launchctl: not found');
            },
          }),
        ),
      ).toEqual([]);
    });

    it('reads launchd and the host state once, and reports the machine after the repositories', async () => {
      const launchdLoaded = vi.fn(async () => false);
      const readHostState = vi.fn(async () => host({ held: true, reason: 'CPU' }));
      const findings = await doctor(
        readers({
          launchdLoaded,
          readHostState,
          listRuns: async () => [makeRun({ repoPath: API, status: 'failed' })],
        }),
      );
      expect(kinds(findings)).toEqual([
        ['run-failed', API],
        ['host-held', HOME],
        ['launchd-not-loaded', HOME],
      ]);
      expect(launchdLoaded).toHaveBeenCalledTimes(1);
      expect(readHostState).toHaveBeenCalledTimes(1);
      for (const f of findings) FindingSchema.parse(f);
    });
  });
});

describe('launchdLoaded', () => {
  it('only "could not find service" proves the agent is not loaded', async () => {
    const calls: string[][] = [];
    expect(
      await launchdLoaded(async (args) => {
        calls.push(args);
      }, 501),
    ).toBe(true);
    expect(calls).toEqual([['print', 'gui/501/com.fractory.tick']]);
    expect(
      await launchdLoaded(async () => {
        throw new Error('Could not find service "com.fractory.tick" in domain for port');
      }, 501),
    ).toBe(false);
    expect(
      await launchdLoaded(async () => {
        throw new Error('spawn launchctl ENOENT');
      }, 501),
    ).toBeUndefined();
  });
});

describe('rendering', () => {
  it('--json and the human output carry the same Findings', async () => {
    const run = await fixtureRun();
    const failed = makeRun({
      id: 'f',
      ticketRef: 'github:me/app#9',
      repoPath: API,
      status: 'failed',
    });
    const findings = await doctor(readers({ listRuns: async () => [run, failed] }));
    expect(findings).toHaveLength(2);
    expect(JSON.parse(renderFindings(findings, { json: true }))).toEqual(findings);
    const text = renderFindings(findings, { json: false });
    expect(text).toBe(formatFindings(findings));
    for (const f of findings) {
      expect(text).toContain(`${f.repoPath}:`);
      expect(text).toContain(f.observed);
      expect(text).toContain(f.remedy);
    }
  });

  it('says so when nothing was found', () => {
    expect(renderFindings([], { json: false })).toMatch(/No Findings/);
    expect(renderFindings([], { json: true })).toBe('[]');
  });
});

describe('fractory doctor', () => {
  const setup = async () => {
    const root = await mkdtemp(join(tmpdir(), 'fractory-doctor-'));
    const repo = join(root, 'repo');
    await mkdir(repo);
    await writeFile(
      join(repo, '.fractory.json'),
      JSON.stringify({
        mode: 'personal',
        ticketSource: { kind: 'github', repo: 'me/app' },
        hasCi: false,
      }),
    );
    const registryDir = join(root, 'runs');
    const missing = join(root, 'gone');
    await writeFile(
      join(root, 'config.json'),
      JSON.stringify({
        repos: [repo, missing],
        registryDir,
        logDir: join(root, 'logs'),
        hostStatePath: join(root, 'host.json'),
        automationsDir: join(root, 'automations'),
        resources: false,
      }),
    );
    const out: string[] = [];
    const exec = vi.fn(async () => '');
    const runShell = vi.fn(async () => 0);
    const env: CliEnv = {
      out: (l) => out.push(l),
      cwd: root,
      factoryConfigPath: join(root, 'config.json'),
      rootDir: root,
      home: root,
      launchAgentsDir: join(root, 'LaunchAgents'),
      uid: 501,
      exec,
      runShell,
      gh: new FakeGh(),
      launchctl: async () => {},
      resolveBin: () => undefined,
      createTicketSource: () => {
        const source = new FakeSource();
        source.setStatus = async () => {
          throw new Error('doctor must not move a Ticket');
        };
        source.comment = async () => {
          throw new Error('doctor must not comment');
        };
        return source;
      },
      createTicket: async () => {
        throw new Error('doctor must not create Tickets');
      },
      launchRun: vi.fn(async () => {}),
      launchAutomationRun: vi.fn(async () => {}),
      makeLogger: () => memoryLogger(),
      now: () => new Date('2026-11-27T00:00:00.000Z'),
      newId: () => 'id',
    };
    return { root, repo, missing, registryDir, env, out, exec, runShell };
  };

  it('exits 0 with Findings present, and --json matches the human output', async () => {
    const { repo, missing, registryDir, env, out, exec, runShell } = await setup();
    const registry = new RunRegistry(registryDir);
    const run = { ...(await fixtureRun()), repoPath: repo };
    await registry.write(run);
    expect(await main(['doctor', '--json'], env)).toBe(0);
    const findings = JSON.parse(out[0] as string);
    expect(findings.map((f: { kind: string; repoPath: string }) => [f.kind, f.repoPath])).toEqual([
      ['needs-human', repo],
      ['unreachable', missing],
    ]);
    out.length = 0;
    expect(await main(['doctor'], env)).toBe(0);
    expect(out[0]).toBe(formatFindings(findings));
    expect(exec).not.toHaveBeenCalled();
    expect(runShell).not.toHaveBeenCalled();
  });

  it('does not change the registry', async () => {
    const { repo, registryDir, env } = await setup();
    const registry = new RunRegistry(registryDir);
    await registry.write({ ...(await fixtureRun()), repoPath: repo });
    const before = await registry.list();
    await main(['doctor'], env);
    expect(await registry.list()).toEqual(before);
    expect(await readdir(registryDir)).toEqual([`${before[0]?.id}.json`]);
  });

  it('exits 0 for a clean sweep of the named repository', async () => {
    const { repo, env, out } = await setup();
    expect(await main(['doctor', repo, '--json'], env)).toBe(0);
    expect(JSON.parse(out[0] as string)).toEqual([]);
  });

  it('reads the host state and launchd from the machine, and moves nothing', async () => {
    const { root, repo, env, out } = await setup();
    await writeFile(
      join(root, 'host.json'),
      JSON.stringify({
        version: 1,
        held: true,
        reason: 'CPU load 1.20 per core > 0.75',
        queued: 1,
        updatedAt: '2026-11-27T00:00:00.000Z',
      }),
    );
    const printed: string[][] = [];
    env.launchctl = async (args) => {
      printed.push(args);
      throw new Error('Could not find service "com.fractory.tick" in domain for port');
    };
    expect(await main(['doctor', repo, '--json'], env)).toBe(0);
    const findings = JSON.parse(out[0] as string);
    expect(findings.map((f: { kind: string; repoPath: string }) => [f.kind, f.repoPath])).toEqual([
      ['host-held', root],
      ['launchd-not-loaded', root],
    ]);
    expect(findings[0].observed).toContain('CPU load 1.20 per core > 0.75');
    expect(printed).toEqual([['print', 'gui/501/com.fractory.tick']]);
  });

  it('exits non-zero only when the sweep itself cannot run', async () => {
    const { root, env } = await setup();
    expect(await main(['doctor', join(root, 'not-configured')], env)).toBe(1);
    await writeFile(join(root, 'config.json'), '{ not json');
    expect(await main(['doctor'], env)).toBe(1);
  });
});
