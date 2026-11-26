import { describe, expect, it } from 'vitest';
import type { RepoConfig } from '../src/contracts/repo-config.ts';
import { formatStatus, repoStatus } from '../src/status/status.ts';
import { makeRun } from './trigger-helpers.ts';

const personal = {
  mode: 'personal',
  ticketSource: { kind: 'github', repo: 'me/app' },
  hasCi: false,
  ticketGate: false,
  baseBranch: 'main',
  maxIterations: 10,
  flow: 'build',
} as RepoConfig;

const PR = 'https://github.com/me/app/pull/7';

describe('repoStatus', () => {
  it('says a repo without .fractory.json is not a Fractory repository', () => {
    const s = repoStatus({ repoPath: '/repo/app', config: undefined, factoryRepos: [], runs: [] });
    expect(s.managed).toBe(false);
    expect(s.configuredOnly).toBe(false);
    expect(formatStatus(s)).toMatch(/not a Fractory repository/);
  });

  it('flags a configured repo that no tick runs', () => {
    const s = repoStatus({ repoPath: '/repo/app', config: personal, factoryRepos: [], runs: [] });
    expect(s).toMatchObject({ managed: false, configuredOnly: true, mode: 'personal' });
  });

  it('lists active Runs, open PRs and needs-human questions from each Ticket latest Run', () => {
    const runs = [
      makeRun({
        id: 'a',
        key: 'ka',
        ticketRef: 'github:me/app#1',
        branch: 'fractory/1-a',
        status: 'running',
        pid: 1,
      }),
      makeRun({
        id: 'b',
        key: 'kb',
        ticketRef: 'github:me/app#2',
        branch: 'fractory/2-b',
        status: 'done',
        prUrl: PR,
      }),
      makeRun({
        id: 'c',
        key: 'kc',
        ticketRef: 'github:me/app#3',
        branch: 'fractory/3-c',
        status: 'done',
        prUrl: PR,
        prState: 'MERGED',
      }),
      makeRun({
        id: 'd',
        key: 'kd',
        ticketRef: 'github:me/app#4',
        branch: 'fractory/4-d',
        status: 'needs-human',
        result: { outcome: 'needs-human', reason: 'ambiguous-spec', question: 'Which flag?' },
      }),
      makeRun({
        id: 'e',
        key: 'ke',
        repoPath: '/repo/other',
        ticketRef: 'github:me/other#9',
        branch: 'fractory/9',
        status: 'running',
        pid: 2,
      }),
    ];
    const s = repoStatus({
      repoPath: '/repo/app',
      config: personal,
      factoryRepos: ['/repo/app'],
      runs,
    });
    expect(s.managed).toBe(true);
    expect(s.activeRuns.map((r) => r.id)).toEqual(['a']);
    expect(s.openPrs).toEqual([
      { ticketRef: 'github:me/app#2', branch: 'fractory/2-b', prUrl: PR },
    ]);
    expect(s.needsHuman).toEqual([
      {
        ticketRef: 'github:me/app#4',
        reason: 'ambiguous-spec',
        question: 'Which flag?',
        runId: 'd',
      },
    ]);
    expect(s.factoryBranches).toEqual(['fractory/1-a', 'fractory/2-b']);
    expect(s.autoMerge).toBe(true);
    expect(s.prGate).toBe(false);
  });

  it('uses only the latest Run of a Ticket', () => {
    const runs = [
      makeRun({
        id: 'old',
        key: 'k1',
        status: 'running',
        pid: 1,
        createdAt: '2026-06-01T00:00:00.000Z',
      }),
      makeRun({ id: 'new', key: 'k2', status: 'failed', createdAt: '2026-06-02T00:00:00.000Z' }),
    ];
    const s = repoStatus({
      repoPath: '/repo/app',
      config: personal,
      factoryRepos: ['/repo/app'],
      runs,
    });
    expect(s.activeRuns).toEqual([]);
  });

  it('reports a Held Ticket of this repo as waiting on its blockers', () => {
    const s = repoStatus({
      repoPath: '/repo/app',
      config: personal,
      factoryRepos: ['/repo/app'],
      runs: [],
      heldTickets: [
        { repoPath: '/repo/app', ticketRef: 'github:me/app#5', blockers: ['github:me/app#4'] },
        { repoPath: '/repo/lib', ticketRef: 'github:me/lib#2', blockers: ['github:me/lib#1'] },
      ],
    });
    expect(s.waitingOnBlockers).toEqual([
      { ticketRef: 'github:me/app#5', blockers: ['github:me/app#4'] },
    ]);
    expect(formatStatus(s)).toContain(
      'Waiting on blockers: \n  - github:me/app#5 held by github:me/app#4',
    );
  });

  describe('answered needs-human questions', () => {
    const waiting = [
      makeRun({
        id: 'd',
        key: 'kd',
        ticketRef: 'github:me/app#4',
        branch: 'fractory/4-d',
        status: 'needs-human',
        result: { outcome: 'needs-human', reason: 'ambiguous-spec', question: 'Which flag?' },
      }),
    ];
    const status = (answeredRunIds?: string[]) =>
      repoStatus({
        repoPath: '/repo/app',
        config: personal,
        factoryRepos: ['/repo/app'],
        runs: waiting,
        ...(answeredRunIds && { answeredRunIds }),
      });

    it('marks a question whose Run has an answer request as answered and waiting for the next tick', () => {
      const s = status(['d']);
      expect(s.needsHuman).toEqual([
        {
          ticketRef: 'github:me/app#4',
          reason: 'ambiguous-spec',
          question: 'Which flag?',
          runId: 'd',
          answered: true,
        },
      ]);
      expect(formatStatus(s)).toContain(
        '  - github:me/app#4 ambiguous-spec: Which flag? (answered, waiting for the next tick)',
      );
    });

    it('reports a question with no answer request exactly as before', () => {
      for (const s of [status(), status(['other-run'])]) {
        expect(s.needsHuman).toEqual([
          {
            ticketRef: 'github:me/app#4',
            reason: 'ambiguous-spec',
            question: 'Which flag?',
            runId: 'd',
          },
        ]);
        expect(formatStatus(s)).toContain('  - github:me/app#4 ambiguous-spec: Which flag?\n');
        expect(formatStatus(s)).not.toContain('answered');
      }
    });
  });
});
