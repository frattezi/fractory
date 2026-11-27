import type { FactoryConfig, ResourceLimits } from '../contracts/factory-config.ts';
import type { HostState } from '../contracts/host-state.ts';
import { type HostLoad, checkResources } from '../policy/resources.ts';

/**
 * Where a reading stands against its limit. `unknown` means the reading could not be taken: it
 * proves nothing and is never a breach. `off` means Host Limits are turned off.
 */
export type CheckStatus = 'ok' | 'holds' | 'unknown' | 'off';

export interface LimitCheck {
  /** The `resources` key the reading is checked against. */
  key: 'maxLoadPerCore' | 'minHostMemoryFreeGb' | 'minDockerMemoryFreeGb';
  label: string;
  unit: 'per core' | 'GB';
  /** `max`: the reading holds Runs when above the limit; `min`: when below it. */
  bound: 'max' | 'min';
  /** The configured limit; null when Host Limits are off. */
  limit: number | null;
  /** The current reading; null when it could not be taken. */
  reading: number | null;
  status: CheckStatus;
}

export interface LimitsReport {
  /** False when `resources: false` turns Host Limits off. */
  enabled: boolean;
  checks: LimitCheck[];
  /** Whether `docker info` answered; an unreachable Docker holds every Run. */
  docker: { reachable: boolean | null; status: CheckStatus };
  /** Limits with no reading to set beside them. */
  maxLaunchesPerTick: number | null;
  cpusPerRun: number | null;
  /** `maxConcurrentRuns` beside the Runs and Automation Runs running now. */
  concurrency: {
    maxConcurrentRuns: number;
    running: number | null;
    status: 'room' | 'full' | 'unknown';
  };
  /** The queue as the last tick left it in `host.json`; null when there is none to read. */
  queue: {
    held: boolean;
    reason: string | null;
    heldSince: string | null;
    queued: number;
    updatedAt: string;
  } | null;
}

/** Every outside read, injected. A reader that throws yields an unknown, never a failure. */
export interface LimitsReaders {
  hostLoad: () => Promise<HostLoad>;
  hostState: () => Promise<HostState | undefined>;
  /** How many Runs and Automation Runs are `running`. */
  running: () => Promise<number>;
}

const settle = async <T>(read: () => Promise<T>): Promise<T | undefined> => {
  try {
    return await read();
  } catch {
    return undefined;
  }
};

/**
 * Status of one reading against its limit, decided by `checkResources` itself on a load that
 * carries only that reading, so this picture and the tick can never disagree.
 */
const statusOf = (
  reading: number | undefined,
  field: keyof Omit<HostLoad, 'dockerReachable'>,
  limits: ResourceLimits | false,
): CheckStatus => {
  if (limits === false) return 'off';
  if (reading === undefined) return 'unknown';
  return checkResources({ [field]: reading }, limits).ok ? 'ok' : 'holds';
};

/** One picture of the machine: each reading beside the limit it is checked against. */
export const readLimits = async (
  readers: LimitsReaders,
  factory: Pick<FactoryConfig, 'resources' | 'maxConcurrentRuns'>,
): Promise<LimitsReport> => {
  const [load, host, running] = await Promise.all([
    settle(readers.hostLoad),
    settle(readers.hostState),
    settle(readers.running),
  ]);
  const limits = factory.resources;
  const reading = load ?? {};
  const check = (
    key: LimitCheck['key'],
    field: keyof Omit<HostLoad, 'dockerReachable'>,
    label: string,
    unit: LimitCheck['unit'],
    bound: LimitCheck['bound'],
  ): LimitCheck => ({
    key,
    label,
    unit,
    bound,
    limit: limits === false ? null : limits[key],
    reading: reading[field] ?? null,
    status: statusOf(reading[field], field, limits),
  });
  const reachable = reading.dockerReachable;
  const usable = running !== undefined && Number.isInteger(running) && running >= 0;
  return {
    enabled: limits !== false,
    checks: [
      check('maxLoadPerCore', 'loadPerCore', 'CPU load', 'per core', 'max'),
      check('minHostMemoryFreeGb', 'hostMemoryFreeGb', 'Host memory free', 'GB', 'min'),
      check('minDockerMemoryFreeGb', 'dockerMemoryFreeGb', 'Docker memory free', 'GB', 'min'),
    ],
    docker: {
      reachable: reachable ?? null,
      status:
        limits === false
          ? 'off'
          : reachable === undefined
            ? 'unknown'
            : checkResources({ dockerReachable: reachable }, limits).ok
              ? 'ok'
              : 'holds',
    },
    maxLaunchesPerTick: limits === false ? null : limits.maxLaunchesPerTick,
    cpusPerRun: limits === false ? null : limits.cpusPerRun,
    concurrency: {
      maxConcurrentRuns: factory.maxConcurrentRuns,
      running: usable ? running : null,
      status: !usable ? 'unknown' : running >= factory.maxConcurrentRuns ? 'full' : 'room',
    },
    queue: host
      ? {
          held: host.held,
          reason: host.reason ?? null,
          heldSince: host.heldSince ?? null,
          queued: host.queued,
          updatedAt: host.updatedAt,
        }
      : null,
  };
};

const formatValue = (value: number | null, unit: LimitCheck['unit']): string => {
  if (value === null) return 'unknown';
  return unit === 'GB' ? `${value.toFixed(1)} GB` : `${value.toFixed(2)} per core`;
};

const formatLimit = (c: LimitCheck): string =>
  c.limit === null
    ? 'off'
    : `${c.bound} ${c.unit === 'GB' ? `${c.limit} GB` : `${c.limit} per core`}`;

const STATUS_TEXT: Record<CheckStatus, string> = {
  ok: 'ok',
  holds: 'HOLDS',
  unknown: 'unknown (could not be read)',
  off: 'off',
};

const table = (rows: string[][]): string[] => {
  const widths =
    rows[0]?.map((_, col) => Math.max(...rows.map((r) => (r[col] ?? '').length))) ?? [];
  return rows.map((r) =>
    r
      .map((cell, col) => cell.padEnd(widths[col] ?? 0))
      .join('  ')
      .trimEnd(),
  );
};

const plural = (n: number): string => `${n} Run${n === 1 ? '' : 's'}`;

/** The human rendering of a report; `--json` prints the report itself. */
export const formatLimits = (report: LimitsReport, now: Date): string => {
  const lines: string[] = [`Host Limits: ${report.enabled ? 'on' : 'off (resources: false)'}`];
  const dockerReading =
    report.docker.reachable === null
      ? 'unknown'
      : report.docker.reachable
        ? 'reachable'
        : 'not reachable';
  lines.push(
    ...table([
      ['READING', 'NOW', 'LIMIT', 'STATUS'],
      ...report.checks.map((c) => [
        c.label,
        formatValue(c.reading, c.unit),
        formatLimit(c),
        STATUS_TEXT[c.status],
      ]),
      [
        'Docker',
        dockerReading,
        report.enabled ? 'reachable' : 'off',
        STATUS_TEXT[report.docker.status],
      ],
    ]).map((l) => `  ${l}`),
  );
  if (report.enabled) {
    lines.push(
      `  Launches per tick: max ${report.maxLaunchesPerTick}. CPUs per Run: ${report.cpusPerRun}.`,
    );
  }
  const c = report.concurrency;
  lines.push(
    c.running === null
      ? `Concurrency: unknown Runs running of maxConcurrentRuns ${c.maxConcurrentRuns} (could not be read).`
      : `Concurrency: ${c.running} of maxConcurrentRuns ${c.maxConcurrentRuns} running${c.status === 'full' ? ' (full)' : ''}.`,
  );
  const q = report.queue;
  if (!q) {
    lines.push('Queue: no tick has written the host state yet.');
  } else if (q.held) {
    const minutes = q.heldSince
      ? Math.max(0, Math.round((now.getTime() - Date.parse(q.heldSince)) / 60_000))
      : undefined;
    lines.push(
      `Queue: Held${minutes === undefined ? '' : ` ${minutes} min`}: ${q.reason ?? 'unknown reason'} (${plural(q.queued)} queued, updated ${q.updatedAt}).`,
    );
  } else {
    lines.push(`Queue: not Held (${plural(q.queued)} queued, updated ${q.updatedAt}).`);
  }
  return lines.join('\n');
};
