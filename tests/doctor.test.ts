import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { type CliEnv, main } from '../src/cli.ts';
import { FindingSchema } from '../src/contracts/finding.ts';
import { type RepoConfig, RepoConfigSchema } from '../src/contracts/repo-config.ts';
import { type RunRecord, RunRecordSchema } from '../src/contracts/run.ts';
import {
  type DoctorReaders,
  doctor,
  formatFindings,
  renderFindings,
} from '../src/doctor/doctor.ts';
import { RunRegistry } from '../src/registry/registry.ts';
import { FakeGh, makeRun, memoryLogger } from './trigger-helpers.ts';

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

const readers = (overrides: Partial<DoctorReaders> = {}): DoctorReaders => ({
  repos: [APP, API],
  loadRepoConfig: async () => config,
  listRuns: async () => [],
  listAnswerRequests: async () => [],
  ...overrides,
});

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
        throw new Error('doctor must not read the tracker');
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

  it('exits non-zero only when the sweep itself cannot run', async () => {
    const { root, env } = await setup();
    expect(await main(['doctor', join(root, 'not-configured')], env)).toBe(1);
    await writeFile(join(root, 'config.json'), '{ not json');
    expect(await main(['doctor'], env)).toBe(1);
  });
});
