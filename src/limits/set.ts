import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { type FactoryConfig, FactoryConfigSchema } from '../contracts/factory-config.ts';

/** The keys `fractory limits set` may change: the Host Limits plus `maxConcurrentRuns`. */
export const LIMIT_KEYS = [
  'maxLoadPerCore',
  'minHostMemoryFreeGb',
  'minDockerMemoryFreeGb',
  'maxLaunchesPerTick',
  'cpusPerRun',
  'maxConcurrentRuns',
] as const;
export type LimitKey = (typeof LIMIT_KEYS)[number];

/** What the machine decides. A reading that could not be taken is 0 and decides nothing. */
export interface Machine {
  cores: number;
  memoryGb: number;
}

/** A maximum and, in words, where it came from, so a refusal can say why. */
interface Bound {
  value: number;
  from: string;
}

interface RangeContext {
  machine: Machine;
  /** The config as it would be after this call, defaults filled in. */
  config: FactoryConfig;
}

interface RangeEntry {
  /** True for keys under `resources`, false for top-level keys. */
  resource: boolean;
  integer: boolean;
  min: number;
  /** Undefined when the machine reading it depends on could not be taken. */
  max: (ctx: RangeContext) => Bound | undefined;
  /** Keys whose value this maximum is derived from. */
  dependsOn: LimitKey[];
}

const cores = ({ machine }: RangeContext): number | undefined =>
  machine.cores > 0 ? machine.cores : undefined;

const memory = ({ machine }: RangeContext): Bound | undefined =>
  machine.memoryGb > 0
    ? { value: machine.memoryGb, from: `the host's total memory, ${machine.memoryGb} GB` }
    : undefined;

/**
 * The only place a limit's bound exists. The CLI, a future dialog and a Bot are all held to it.
 * A value outside its range is refused, never clamped.
 */
export const LIMIT_RANGES: Record<LimitKey, RangeEntry> = {
  maxLoadPerCore: {
    resource: true,
    integer: false,
    min: 0.1,
    max: () => ({ value: 2, from: 'fixed' }),
    dependsOn: [],
  },
  minHostMemoryFreeGb: {
    resource: true,
    integer: false,
    min: 0,
    max: memory,
    dependsOn: [],
  },
  minDockerMemoryFreeGb: {
    resource: true,
    integer: false,
    min: 0,
    max: memory,
    dependsOn: [],
  },
  maxLaunchesPerTick: {
    resource: true,
    integer: true,
    min: 1,
    max: ({ config }) => ({
      value: config.maxConcurrentRuns,
      from: `maxConcurrentRuns, ${config.maxConcurrentRuns}`,
    }),
    dependsOn: ['maxConcurrentRuns'],
  },
  cpusPerRun: {
    resource: true,
    integer: false,
    min: 0.5,
    max: (ctx) => {
      const n = cores(ctx);
      return n === undefined ? undefined : { value: n, from: `the core count, ${n}` };
    },
    dependsOn: [],
  },
  maxConcurrentRuns: {
    resource: false,
    integer: true,
    min: 1,
    max: (ctx) => {
      const n = cores(ctx);
      if (n === undefined) return undefined;
      const { resources } = ctx.config;
      if (resources === false) {
        return { value: n, from: `the core count, ${n} (Host Limits are off)` };
      }
      return {
        value: Math.floor(n / resources.cpusPerRun),
        from: `${n} cores / cpusPerRun ${resources.cpusPerRun}`,
      };
    },
    dependsOn: ['cpusPerRun'],
  },
};

export interface LimitChange {
  key: LimitKey;
  from: number;
  to: number;
}

/** Reading and writing the config file, injected so tests can fail any step. */
export interface ConfigFiles {
  /** The file's text, or undefined when it does not exist. */
  read: (path: string) => Promise<string | undefined>;
  write: (path: string, text: string) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  remove: (path: string) => Promise<void>;
}

export const nodeConfigFiles: ConfigFiles = {
  read: async (path) => {
    try {
      return await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  },
  write: async (path, text) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
  },
  rename,
  remove: (path) => rm(path, { force: true }),
};

const isLimitKey = (key: string): key is LimitKey =>
  (LIMIT_KEYS as readonly string[]).includes(key);

/** Parses `key=value` pairs. Throws on an unknown key, a repeated key or a non-number. */
export const parseAssignments = (pairs: string[]): Map<LimitKey, number> => {
  if (pairs.length === 0) {
    throw new Error(`Usage: fractory limits set <key>=<value>... (keys: ${LIMIT_KEYS.join(', ')})`);
  }
  const values = new Map<LimitKey, number>();
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    const key = eq === -1 ? pair : pair.slice(0, eq);
    const text = eq === -1 ? '' : pair.slice(eq + 1).trim();
    if (!isLimitKey(key)) {
      throw new Error(`Unknown limit "${key}". Keys: ${LIMIT_KEYS.join(', ')}.`);
    }
    if (values.has(key)) throw new Error(`${key} is given more than once.`);
    const value = text === '' ? Number.NaN : Number(text);
    if (!Number.isFinite(value)) throw new Error(`${key} needs a number, got "${text}".`);
    values.set(key, value);
  }
  return values;
};

const describeRange = (entry: RangeEntry, max: Bound): string =>
  `${entry.min}..${max.value}${entry.integer ? ', a whole number' : ''} (maximum: ${max.from})`;

/** Why a value is refused, or undefined when it is inside its range. */
const refusal = (key: LimitKey, value: number, ctx: RangeContext): string | undefined => {
  const entry = LIMIT_RANGES[key];
  const max = entry.max(ctx);
  if (max === undefined) {
    return `${key}=${value} cannot be checked: the machine reading its maximum is derived from could not be taken.`;
  }
  if (entry.integer && !Number.isInteger(value)) {
    return `${key}=${value} is not a whole number; its range is ${describeRange(entry, max)}.`;
  }
  if (value < entry.min || value > max.value) {
    return `${key}=${value} is outside its range ${describeRange(entry, max)}.`;
  }
  return undefined;
};

const current = (config: FactoryConfig, key: LimitKey): number | undefined => {
  if (!LIMIT_RANGES[key].resource) return config[key as 'maxConcurrentRuns'];
  return config.resources === false ? undefined : config.resources[key as 'cpusPerRun'];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const parseConfig = (raw: unknown, path: string): FactoryConfig => {
  const parsed = FactoryConfigSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`Invalid factory config ${path}: ${parsed.error.message}`);
  return parsed.data;
};

export interface SetLimitsDeps {
  path: string;
  machine: Machine;
  files?: ConfigFiles;
  /** Suffix of the temporary file; distinct per process so two writers never share one. */
  tmpSuffix?: string;
}

/**
 * Sets one or several limits in the factory config, all of them or none. The file is read,
 * merged, checked against the range table and the config contract, written to a temporary
 * file and renamed over the original. Any refusal or failure leaves the original untouched.
 * The `.bak` beside the config is never touched.
 */
export const setLimits = async (pairs: string[], deps: SetLimitsDeps): Promise<LimitChange[]> => {
  const { path, machine } = deps;
  const files = deps.files ?? nodeConfigFiles;
  const values = parseAssignments(pairs);

  const text = await files.read(path);
  let raw: unknown = {};
  if (text !== undefined) {
    try {
      raw = JSON.parse(text);
    } catch (error) {
      throw new Error(
        `${path} is not valid JSON: ${(error as Error).message}. Nothing was written.`,
      );
    }
  }
  if (!isRecord(raw)) throw new Error(`${path} is not a JSON object. Nothing was written.`);
  const before = parseConfig(raw, path);

  const settingResources = [...values.keys()].filter((k) => LIMIT_RANGES[k].resource);
  if (before.resources === false && settingResources.length > 0) {
    throw new Error(
      `Host Limits are off (resources: false), so ${settingResources.join(', ')} cannot be set. Nothing was written.`,
    );
  }

  const merged: Record<string, unknown> = { ...raw };
  const resources: Record<string, unknown> = isRecord(raw.resources) ? { ...raw.resources } : {};
  for (const [key, value] of values) {
    if (LIMIT_RANGES[key].resource) resources[key] = value;
    else merged[key] = value;
  }
  if (settingResources.length > 0) merged.resources = resources;
  // The config as it would be, built from the parsed one so the range table is checked first
  // and a refusal names the range; the contract checks the merged file after it.
  const after: FactoryConfig = { ...before };
  for (const [key, value] of values) {
    if (!LIMIT_RANGES[key].resource) after.maxConcurrentRuns = value;
    else if (after.resources !== false) after.resources = { ...after.resources, [key]: value };
  }

  const ctx: RangeContext = { machine, config: after };
  const refusals: string[] = [];
  for (const [key, value] of values) {
    const why = refusal(key, value, ctx);
    if (why) refusals.push(why);
  }
  // A key left alone whose maximum moves because of this call must still fit inside it.
  for (const key of LIMIT_KEYS) {
    if (values.has(key)) continue;
    const entry = LIMIT_RANGES[key];
    if (!entry.dependsOn.some((d) => values.has(d))) continue;
    const value = current(after, key);
    if (value === undefined) continue;
    const why = refusal(key, value, ctx);
    if (why) refusals.push(`${why} It is unchanged, so set it in the same call.`);
  }
  if (refusals.length > 0) throw new Error(`${refusals.join(' ')} Nothing was written.`);
  parseConfig(merged, path);

  const tmp = `${path}.${deps.tmpSuffix ?? process.pid}.tmp`;
  try {
    await files.write(tmp, `${JSON.stringify(merged, null, 2)}\n`);
    await files.rename(tmp, path);
  } catch (error) {
    await files.remove(tmp).catch(() => {});
    throw new Error(
      `Could not write ${path}: ${(error as Error).message}. The original is unchanged.`,
    );
  }

  return [...values].map(([key, to]) => ({ key, from: current(before, key) as number, to }));
};

/** The human rendering of what `limits set` changed. */
export const formatLimitChanges = (changes: LimitChange[]): string =>
  [
    ...changes.map((c) => `${c.key}: ${c.from} -> ${c.to}`),
    'Runs already running are not stopped; the new limits apply from the next tick.',
  ].join('\n');
