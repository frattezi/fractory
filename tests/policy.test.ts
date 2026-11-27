import { describe, expect, it } from 'vitest';
import { ResourceLimitsSchema } from '../src/contracts/factory-config.ts';
import {
  RepoConfigSchema,
  requiresPrGate,
  requiresTicketGate,
} from '../src/contracts/repo-config.ts';
import { type RunRecord, RunRecordSchema, type RunStatus } from '../src/contracts/run.ts';
import type { TicketRef, TicketStatus } from '../src/contracts/ticket.ts';
import {
  type BlockerLookup,
  type DependencyTicket,
  type HoldReason,
  type Verdict,
  blockersToRead,
  describeHold,
  ownerMustFix,
  ownsRef,
  resolveDependencies,
} from '../src/policy/dependencies.ts';
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

describe('resolveDependencies', () => {
  const config = { ticketSource: { kind: 'github', repo: 'me/app' }, baseBranch: 'trunk' } as const;
  const ref = (n: number): TicketRef => `github:me/app#${n}`;
  /** `t(5, [4])`: Ticket #5, blocked by #4; refs may be given in full. */
  const t = (
    n: number,
    blockedBy: (number | string)[] = [],
    status: TicketStatus = 'ready',
  ): DependencyTicket => ({
    ref: ref(n),
    status,
    blockedBy: blockedBy.map((b) => (typeof b === 'number' ? ref(b) : (b as TicketRef))),
    relationErrors: [],
  });
  const found = (ticket: DependencyTicket): BlockerLookup => ({ kind: 'found', ticket });
  const run = (n: number, status: RunStatus, createdAt = '2026-01-01T00:00:00.000Z'): RunRecord =>
    RunRecordSchema.parse({
      version: 1,
      id: `r${n}-${status}`,
      key: `${ref(n)}:ticket-ready:${status}`,
      ticketRef: ref(n),
      repoPath: '/repo/app',
      trigger: { kind: 'ticket-ready' },
      status,
      branch: `fractory/${n}`,
      logPath: `/logs/${n}.log`,
      createdAt,
      updatedAt: createdAt,
    });
  const resolve = (
    ready: DependencyTicket[],
    blockers: [number | string, BlockerLookup][] = [],
    runs: RunRecord[] = [],
  ) =>
    resolveDependencies({
      ready,
      blockers: new Map(
        blockers.map(([b, l]) => [typeof b === 'number' ? ref(b) : (b as TicketRef), l]),
      ),
      runs,
      config,
    });
  /** Each verdict as `#n start`, `#n hold <blocker>: <why>; ...` or `#n active`. */
  const brief = (verdicts: Verdict[]): string[] =>
    verdicts.map((v) => {
      const n = v.ref.replace('github:me/app', '');
      if (v.kind === 'start') {
        const on = v.stackedOn ? ` stacked on ${v.stackedOn.replace('github:me/app', '')}` : '';
        return `${n} start ${v.baseBranch}${on}`;
      }
      if (v.kind === 'active') return `${n} active`;
      return `${n} hold ${v.holds.map((h) => `${h.blocker.replace('github:me/app', '')}: ${describeHold(h)}`).join('; ')}`;
    });

  const graphs: {
    name: string;
    ready: DependencyTicket[];
    blockers?: [number | string, BlockerLookup][];
    runs?: RunRecord[];
    expected: string[];
  }[] = [
    { name: 'no blockers', ready: [t(2), t(1)], expected: ['#1 start trunk', '#2 start trunk'] },
    {
      name: 'a chain created Ready together starts only its root, blockers first',
      ready: [t(4, [3]), t(3, [2]), t(2, [1]), t(1)],
      expected: [
        '#1 start trunk',
        '#2 hold #1: not done: ready, no Run yet',
        '#3 hold #2: not done: ready, no Run yet',
        '#4 hold #3: not done: ready, no Run yet',
      ],
    },
    {
      name: 'a chain whose root is done starts the next link',
      ready: [t(3, [2]), t(2, [1])],
      blockers: [[1, found(t(1, [], 'done'))]],
      expected: ['#2 start trunk', '#3 hold #2: not done: ready, no Run yet'],
    },
    {
      name: 'a diamond stacks each side on its top and waits for both sides at its bottom',
      ready: [t(4, [2, 3]), t(3, [1]), t(2, [1])],
      blockers: [[1, found(t(1, [], 'in_review'))]],
      runs: [run(1, 'done')],
      expected: [
        '#2 start fractory/1 stacked on #1',
        '#3 start fractory/1 stacked on #1',
        '#4 hold #2: not done: ready, no Run yet; #3: not done: ready, no Run yet',
      ],
    },
    {
      name: "one blocker whose latest Run is done stacks on the blocker's branch",
      ready: [t(3, [2]), t(2, [1])],
      blockers: [[1, found(t(1, [], 'in_review'))]],
      runs: [run(1, 'done')],
      expected: ['#2 start fractory/1 stacked on #1', '#3 hold #2: not done: ready, no Run yet'],
    },
    {
      name: 'one blocker whose latest Run is queued, running, failed or needs-human holds',
      ready: [t(10, [1]), t(11, [2]), t(12, [3]), t(13, [4])],
      blockers: [
        [1, found(t(1, [], 'in_progress'))],
        [2, found(t(2, [], 'in_progress'))],
        [3, found(t(3, [], 'in_progress'))],
        [4, found(t(4, [], 'in_progress'))],
      ],
      runs: [
        // A follow-up Run on a done blocker makes its branch a moving base again.
        run(1, 'done', '2026-01-01T00:00:00.000Z'),
        run(1, 'queued', '2026-01-02T00:00:00.000Z'),
        run(2, 'done', '2026-01-01T00:00:00.000Z'),
        run(2, 'running', '2026-01-02T00:00:00.000Z'),
        run(3, 'done', '2026-01-01T00:00:00.000Z'),
        run(3, 'failed', '2026-01-02T00:00:00.000Z'),
        run(4, 'needs-human'),
      ],
      expected: [
        '#10 hold #1: not done: in progress, its latest Run queued',
        '#11 hold #2: not done: in progress, its latest Run running',
        '#12 hold #3: not done: in progress, its latest Run failed',
        '#13 hold #4: not done: in progress, its latest Run needs-human',
      ],
    },
    {
      name: 'one blocker whose done Run has no open pull request any more holds',
      ready: [t(10, [1]), t(11, [2])],
      blockers: [
        [1, found(t(1, [], 'in_review'))],
        [2, found(t(2, [], 'in_review'))],
      ],
      runs: [
        { ...run(1, 'done'), prState: 'MERGED' },
        { ...run(2, 'done'), prState: 'CLOSED' },
      ],
      expected: [
        '#10 hold #1: not done: in review, its latest Run done, its pull request merged',
        '#11 hold #2: not done: in review, its latest Run done, its pull request closed',
      ],
    },
    {
      name: 'two blockers with done Runs are never stacked on',
      ready: [t(5, [1, 2])],
      blockers: [
        [1, found(t(1, [], 'in_review'))],
        [2, found(t(2, [], 'done'))],
      ],
      runs: [run(1, 'done'), run(2, 'done')],
      expected: ['#5 hold #1: not done: in review, its latest Run done'],
    },
    {
      name: 'one blocker beside a relation that cannot be read is not stacked on',
      ready: [{ ...t(5, [1]), relationErrors: ['Blocked by: "soon" is not a Ticket ref'] }],
      blockers: [[1, found(t(1, [], 'in_review'))]],
      runs: [run(1, 'done')],
      expected: [
        '#5 hold Blocked by: "soon" is not a Ticket ref: relation could not be read; #1: not done: in review, its latest Run done',
      ],
    },
    {
      name: 'a diamond whose sides are done starts its bottom',
      ready: [t(4, [2, 3])],
      blockers: [
        [2, found(t(2, [1], 'done'))],
        [3, found(t(3, [1], 'done'))],
      ],
      expected: ['#4 start trunk'],
    },
    {
      name: 'several blockers hold until every one is done',
      ready: [t(5, [2, 3, 4])],
      blockers: [
        [2, found(t(2, [], 'done'))],
        [3, found(t(3, [], 'in_progress'))],
        [4, found(t(4, [], 'done'))],
      ],
      runs: [run(3, 'running')],
      expected: ['#5 hold #3: not done: in progress, its latest Run running'],
    },
    {
      name: 'a cycle holds every Ticket in it, and a Ticket depending on it',
      ready: [t(1, [3]), t(2, [1]), t(3, [2]), t(4, [3]), t(5)],
      expected: [
        '#5 start trunk',
        '#1 hold #3: dependency cycle: github:me/app#1, github:me/app#2, github:me/app#3',
        '#2 hold #1: dependency cycle: github:me/app#1, github:me/app#2, github:me/app#3',
        '#3 hold #2: dependency cycle: github:me/app#1, github:me/app#2, github:me/app#3',
        '#4 hold #3: depends on a dependency cycle',
      ],
    },
    {
      name: 'a cycle through Tickets that are not Ready still holds what depends on it',
      ready: [t(5, [4])],
      blockers: [
        [4, found(t(4, [3], 'in_progress'))],
        [3, found(t(3, [4], 'backlog'))],
      ],
      expected: ['#5 hold #4: depends on a dependency cycle'],
    },
    {
      name: 'a Ticket depending on a Ticket that depends on a cycle is held for it',
      ready: [t(6, [5])],
      blockers: [
        [5, found(t(5, [4], 'in_progress'))],
        [4, found(t(4, [4], 'backlog'))],
      ],
      expected: ['#6 hold #5: depends on a dependency cycle'],
    },
    {
      name: 'a done Ticket closes no cycle',
      ready: [t(2, [1])],
      blockers: [[1, found(t(1, [2], 'done'))]],
      expected: ['#2 start trunk'],
    },
    {
      name: 'a Ticket blocking itself',
      ready: [t(7, [7]), t(8)],
      expected: ['#7 hold #7: the Ticket blocks itself', '#8 start trunk'],
    },
    {
      name: 'each blocker state',
      ready: [t(10, [1]), t(11, [2]), t(12, [3]), t(13, [4]), t(14, [5]), t(15, [6]), t(16, [9])],
      blockers: [
        [1, found(t(1, [], 'done'))],
        [2, found(t(2, [], 'backlog'))],
        [3, found(t(3, [], 'in_progress'))],
        [4, found(t(4, [], 'in_review'))],
        [5, { kind: 'missing' }],
        [6, { kind: 'unreadable' }],
      ],
      runs: [
        run(3, 'failed', '2026-01-01T00:00:00.000Z'),
        run(3, 'needs-human', '2026-01-02T00:00:00.000Z'),
        run(4, 'queued'),
      ],
      expected: [
        '#10 start trunk',
        '#11 hold #2: not done: in the backlog, no Run yet',
        '#12 hold #3: not done: in progress, its latest Run needs-human',
        '#13 hold #4: not done: in review, its latest Run queued',
        '#14 hold #5: does not exist',
        '#15 hold #6: could not be read',
        '#16 hold #9: could not be read',
      ],
    },
    {
      name: 'a blocker in another repository or tracker',
      ready: [t(5, ['github:me/lib#1', 'jira:ABC-2']), t(6, ['github:Me/App#1'])],
      blockers: [['github:Me/App#1', found(t(1, [], 'done'))]],
      expected: [
        '#5 hold github:me/lib#1: in another repository; jira:ABC-2: in another repository',
        '#6 start trunk',
      ],
    },
    {
      name: 'a relation that is not a Ticket ref',
      ready: [{ ...t(5), relationErrors: ['Blocked by: "soon" is not a Ticket ref'] }],
      expected: ['#5 hold Blocked by: "soon" is not a Ticket ref: relation could not be read'],
    },
    {
      name: 'a Ticket that already has a queued or running Run is never started again',
      ready: [t(1), t(2)],
      runs: [run(1, 'running'), run(2, 'failed')],
      expected: ['#1 active', '#2 start trunk'],
    },
  ];

  for (const g of graphs) {
    it(g.name, () => {
      expect(brief(resolve(g.ready, g.blockers, g.runs))).toEqual(g.expected);
    });
  }

  it('uses the Jira project key for the repository', () => {
    const jira = {
      ticketSource: {
        kind: 'jira',
        baseUrl: 'https://acme.atlassian.net',
        projectKey: 'ABC',
        statuses: { ready: 'Ready', inProgress: 'Doing', inReview: 'Review', done: 'Shipped' },
      },
      baseBranch: 'main',
    } as const;
    const ticket = (key: string, blockedBy: string[]): DependencyTicket => ({
      ref: `jira:${key}` as TicketRef,
      status: 'ready',
      blockedBy: blockedBy as TicketRef[],
      relationErrors: [],
    });
    const verdicts = resolveDependencies({
      ready: [ticket('ABC-2', ['jira:ABC-1']), ticket('ABC-3', ['jira:ABCD-1'])],
      blockers: new Map([
        ['jira:ABC-1' as TicketRef, found({ ...ticket('ABC-1', []), status: 'done' })],
      ]),
      runs: [],
      config: jira,
    });
    expect(verdicts.map((v) => [v.ref, v.kind])).toEqual([
      ['jira:ABC-2', 'start'],
      ['jira:ABC-3', 'hold'],
    ]);
  });

  it('names the blockers left to read: in this repo, not known, not behind a done Ticket', () => {
    expect(
      blockersToRead(
        [t(5, [4, 3, 'github:me/lib#1']), t(6, [4, 2]), t(7, [1], 'done')],
        config,
        new Set([ref(2)]),
      ),
    ).toEqual([ref(3), ref(4)]);
  });

  it('tells holds the owner must fix from holds that clear by waiting', () => {
    const kinds: [HoldReason, boolean][] = [
      [{ kind: 'not-done', status: 'ready' }, false],
      [{ kind: 'unreadable' }, false],
      [{ kind: 'cycle', cycle: [ref(1)] }, true],
      [{ kind: 'depends-on-cycle' }, true],
      [{ kind: 'other-repository' }, true],
      [{ kind: 'missing' }, true],
      [{ kind: 'malformed' }, true],
    ];
    for (const [reason, expected] of kinds) {
      expect(ownerMustFix({ blocker: 'x', reason })).toBe(expected);
    }
  });

  it('finds the owner of a ref by GitHub repo or Jira project key', () => {
    const jira = {
      kind: 'jira',
      baseUrl: 'https://acme.atlassian.net',
      projectKey: 'ABC',
      statuses: { ready: 'Ready', inProgress: 'Doing', inReview: 'Review', done: 'Shipped' },
    } as const;
    expect(ownsRef(jira, 'jira:ABC-3')).toBe(true);
    expect(ownsRef(jira, 'jira:ABCD-3')).toBe(false);
    expect(ownsRef(jira, 'github:me/app#3')).toBe(false);
    expect(ownsRef({ kind: 'github', repo: 'Me/App' }, 'github:me/app#3')).toBe(true);
    expect(ownsRef({ kind: 'github', repo: 'me/app' }, 'github:me/lib#3')).toBe(false);
  });
});
