import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FactoryConfig } from '../src/contracts/factory-config.ts';
import type { RepoConfig } from '../src/contracts/repo-config.ts';
import { RUN_RECORD_VERSION, type RunRecord, runKey } from '../src/contracts/run.ts';
import type { Ticket, TicketRef, TicketSource, TicketStatus } from '../src/contracts/ticket.ts';
import { type Gh, type PrView, PrViewSchema } from '../src/github/gh.ts';
import { RunRegistry } from '../src/registry/registry.ts';
import type { Logger, PidState } from '../src/trigger/support.ts';
import type { TickDeps } from '../src/trigger/tick.ts';

export const personalRepo: RepoConfig = {
  mode: 'personal',
  ticketSource: { kind: 'github', repo: 'me/app' },
  hasCi: true,
  ticketGate: false,
  baseBranch: 'main',
  maxIterations: 10,
};
export const workRepo: RepoConfig = { ...personalRepo, mode: 'work' };

export const makeTicket = (n: number, status: TicketStatus = 'ready', title = `Add thing ${n}`): Ticket => ({
  ref: `github:me/app#${n}` as TicketRef,
  title,
  body: 'body',
  url: `https://github.com/me/app/issues/${n}`,
  status,
  updatedAt: '2026-01-01T00:00:00.000Z',
});

export class FakeSource implements TicketSource {
  tickets = new Map<string, Ticket>();
  /** When true, setStatus records the change but listReady keeps returning the Ticket. */
  stickyReady = false;
  statusCalls: [string, TicketStatus][] = [];
  constructor(tickets: Ticket[] = []) {
    for (const t of tickets) this.tickets.set(t.ref, t);
  }
  async listReady(): Promise<Ticket[]> {
    return [...this.tickets.values()].filter((t) => t.status === 'ready');
  }
  async get(ref: TicketRef): Promise<Ticket> {
    const t = this.tickets.get(ref);
    if (!t) throw new Error(`no ${ref}`);
    return t;
  }
  async setStatus(ref: TicketRef, status: TicketStatus): Promise<void> {
    this.statusCalls.push([ref, status]);
    const t = this.tickets.get(ref);
    if (t && !this.stickyReady) this.tickets.set(ref, { ...t, status });
  }
  async comment(): Promise<void> {}
}

export const makePr = (overrides: Record<string, unknown> = {}): PrView =>
  PrViewSchema.parse({
    number: 7,
    state: 'OPEN',
    mergeable: 'MERGEABLE',
    headRefOid: 'sha1',
    statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }],
    reviews: [],
    comments: [],
    ...overrides,
  });

export class FakeGh implements Gh {
  prs = new Map<string, PrView | Error>();
  merges: string[] = [];
  user: string | Error = 'factory-bot';
  async viewPr(_cwd: string, pr: string): Promise<PrView> {
    const found = this.prs.get(pr);
    if (!found) throw new Error(`no PR ${pr}`);
    if (found instanceof Error) throw found;
    return found;
  }
  async mergeSquash(_cwd: string, pr: string): Promise<void> {
    this.merges.push(pr);
  }
  async currentUser(): Promise<string> {
    if (this.user instanceof Error) throw this.user;
    return this.user;
  }
}

export const memoryLogger = (): Logger & { lines: string[] } => {
  const lines: string[] = [];
  return {
    lines,
    info: (m) => lines.push(`INFO ${m}`),
    warn: (m) => lines.push(`WARN ${m}`),
    error: (m) => lines.push(`ERROR ${m}`),
  };
};

export const PR_URL = 'https://github.com/me/app/pull/7';

export interface Harness {
  deps: TickDeps;
  registry: RunRegistry;
  factory: FactoryConfig;
  source: FakeSource;
  gh: FakeGh;
  launched: string[];
  log: ReturnType<typeof memoryLogger>;
  pids: Map<number, PidState>;
  configs: Map<string, RepoConfig | Error>;
  setNow(date: Date): void;
}

export const makeHarness = async (
  options: { repos?: string[]; maxConcurrentRuns?: number; config?: RepoConfig } = {},
): Promise<Harness> => {
  const root = await mkdtemp(join(tmpdir(), 'fractory-tick-'));
  const repos = options.repos ?? ['/repo/app'];
  const factory: FactoryConfig = {
    repos,
    maxConcurrentRuns: options.maxConcurrentRuns ?? 3,
    staleWorktreeDays: 7,
    registryDir: join(root, 'runs'),
    logDir: join(root, 'logs'),
  };
  const registry = new RunRegistry(factory.registryDir);
  const source = new FakeSource();
  const gh = new FakeGh();
  const log = memoryLogger();
  const launched: string[] = [];
  const pids = new Map<number, PidState>();
  const configs = new Map<string, RepoConfig | Error>(
    repos.map((r) => [r, options.config ?? personalRepo]),
  );
  let now = new Date('2026-06-01T10:00:00.000Z');
  let counter = 0;
  const deps: TickDeps = {
    factory,
    registry,
    async loadRepoConfig(repoPath) {
      const c = configs.get(repoPath);
      if (!c) throw new Error(`no config ${repoPath}`);
      if (c instanceof Error) throw c;
      return c;
    },
    createTicketSource: () => source,
    gh,
    async launchRun(record) {
      launched.push(record.id);
      await registry.update(record.id, { status: 'running', pid: 4000 + launched.length });
    },
    checkPid: (pid) => pids.get(pid) ?? 'alive',
    now: () => {
      // each reading advances the clock so createdAt orders Runs deterministically
      now = new Date(now.getTime() + 1000);
      return now;
    },
    newId: () => `run-${++counter}`,
    log,
  };
  return {
    deps,
    registry,
    factory,
    source,
    gh,
    launched,
    log,
    pids,
    configs,
    setNow: (d) => {
      now = d;
    },
  };
};

export const makeRun = (overrides: Partial<RunRecord> = {}): RunRecord => {
  const id = overrides.id ?? 'r1';
  const ticketRef = overrides.ticketRef ?? 'github:me/app#1';
  const trigger = overrides.trigger ?? { kind: 'ticket-ready' as const };
  return {
    version: RUN_RECORD_VERSION,
    id,
    key: runKey(ticketRef, trigger),
    ticketRef,
    repoPath: '/repo/app',
    trigger,
    status: 'done',
    branch: 'fractory/1-add-thing-1',
    logPath: `/logs/${id}.log`,
    createdAt: '2026-05-31T10:00:00.000Z',
    updatedAt: '2026-05-31T10:00:00.000Z',
    ...overrides,
  };
};

export const writeJson = async (path: string, value: unknown): Promise<void> => {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, JSON.stringify(value));
};
