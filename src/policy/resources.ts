import { cpus, loadavg, totalmem } from 'node:os';
import type { ResourceLimits } from '../contracts/factory-config.ts';

/** One reading of the host. A number is undefined when it could not be read. */
export interface HostLoad {
  /** 1-minute load average divided by the number of CPU cores. */
  loadPerCore?: number;
  /** Memory macOS reports as available (`kern.memorystatus_level` % of physical memory), in GB. */
  hostMemoryFreeGb?: number;
  /** Docker VM memory not used by containers (`docker info` total minus `docker stats`), in GB. */
  dockerMemoryFreeGb?: number;
  /** False only when `docker info` failed: no Run could start. */
  dockerReachable?: boolean;
}

export type ResourceVerdict = { ok: true } | { ok: false; reason: string };

const gb = (n: number): string => n.toFixed(1);

/**
 * Whether the host has room for one more Run. A reading that could not be taken proves nothing,
 * so it never holds Runs back on its own; only an unreachable Docker does.
 */
export const checkResources = (load: HostLoad, limits: ResourceLimits): ResourceVerdict => {
  if (load.dockerReachable === false) return { ok: false, reason: 'Docker is not reachable' };
  const reasons: string[] = [];
  if (
    load.dockerMemoryFreeGb !== undefined &&
    load.dockerMemoryFreeGb < limits.minDockerMemoryFreeGb
  ) {
    reasons.push(
      `Docker memory ${gb(load.dockerMemoryFreeGb)} GB free < ${limits.minDockerMemoryFreeGb} GB`,
    );
  }
  if (load.hostMemoryFreeGb !== undefined && load.hostMemoryFreeGb < limits.minHostMemoryFreeGb) {
    reasons.push(
      `host memory ${gb(load.hostMemoryFreeGb)} GB free < ${limits.minHostMemoryFreeGb} GB`,
    );
  }
  if (load.loadPerCore !== undefined && load.loadPerCore > limits.maxLoadPerCore) {
    reasons.push(`CPU load ${load.loadPerCore.toFixed(2)} per core > ${limits.maxLoadPerCore}`);
  }
  return reasons.length === 0 ? { ok: true } : { ok: false, reason: reasons.join('; ') };
};

const BYTES_PER_GB = 1024 ** 3;
const UNIT_BYTES: Record<string, number> = {
  b: 1,
  kb: 1000,
  mb: 1000 ** 2,
  gb: 1000 ** 3,
  kib: 1024,
  mib: 1024 ** 2,
  gib: 1024 ** 3,
};

/** `1.5GiB`, `512MiB`, `0B` -> bytes; undefined for anything else. */
export const parseSize = (text: string): number | undefined => {
  const match = text.trim().match(/^([\d.]+)\s*([a-z]+)$/i);
  const unit = match?.[2] ? UNIT_BYTES[match[2].toLowerCase()] : undefined;
  const value = Number(match?.[1]);
  return unit !== undefined && Number.isFinite(value) ? value * unit : undefined;
};

export interface HostProcesses {
  /** `sysctl -n <name>` stdout. */
  sysctl: (name: string) => Promise<string>;
  /** `docker <args>` stdout; rejects on a non-zero exit. */
  docker: (args: string[]) => Promise<string>;
}

export interface HostOs {
  loadavg: () => number[];
  cores: () => number;
  totalmem: () => number;
}

const realOs: HostOs = { loadavg, cores: () => cpus().length, totalmem };

/** Reads the host. Every process is injected so tests never touch the machine. */
export const readHostLoad = async (
  { sysctl, docker }: HostProcesses,
  os: HostOs = realOs,
): Promise<HostLoad> => {
  const load: HostLoad = {};
  const [oneMinute] = os.loadavg();
  const cores = os.cores();
  if (oneMinute !== undefined && cores > 0) load.loadPerCore = oneMinute / cores;

  try {
    const text = (await sysctl('kern.memorystatus_level')).trim();
    const level = text === '' ? Number.NaN : Number(text);
    if (Number.isFinite(level) && level >= 0 && level <= 100) {
      load.hostMemoryFreeGb = (level / 100) * (os.totalmem() / BYTES_PER_GB);
    }
  } catch {
    // Not macOS, or sysctl failed: host memory stays unknown.
  }

  let total: number | undefined;
  try {
    const bytes = Number((await docker(['info', '--format', '{{.MemTotal}}'])).trim());
    load.dockerReachable = true;
    if (Number.isFinite(bytes) && bytes > 0) total = bytes;
  } catch {
    load.dockerReachable = false;
    return load;
  }
  if (total !== undefined) {
    try {
      const out = await docker(['stats', '--no-stream', '--format', '{{.MemUsage}}']);
      let used = 0;
      for (const line of out.split('\n').filter((l) => l.trim() !== '')) {
        // "512MiB / 7.65GiB": the first part is what the container uses.
        const bytes = parseSize(line.split('/')[0] ?? '');
        if (bytes === undefined) throw new Error(`unreadable docker stats line: ${line}`);
        used += bytes;
      }
      load.dockerMemoryFreeGb = (total - used) / BYTES_PER_GB;
    } catch {
      // Stats failed or were unreadable: Docker memory stays unknown.
    }
  }
  return load;
};
