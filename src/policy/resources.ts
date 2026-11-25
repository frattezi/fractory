import { cpus, loadavg } from 'node:os';
import type { ResourceLimits } from '../contracts/factory-config.ts';

/** One reading of the host. A field is undefined when it could not be read. */
export interface HostLoad {
  /** 1-minute load average divided by the number of CPU cores. */
  loadPerCore?: number;
  /** Memory the OS reports as available to new work, 0-100 (macOS `kern.memorystatus_level`). */
  memoryAvailablePercent?: number;
}

export type ResourceVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Whether the host has room for one more Run. A reading that could not be taken proves nothing,
 * so it never holds Runs back on its own; the other reading still decides.
 */
export const checkResources = (load: HostLoad, limits: ResourceLimits): ResourceVerdict => {
  const reasons: string[] = [];
  if (load.loadPerCore !== undefined && load.loadPerCore > limits.maxLoadPerCore) {
    reasons.push(`CPU load ${load.loadPerCore.toFixed(2)} per core > ${limits.maxLoadPerCore}`);
  }
  if (
    load.memoryAvailablePercent !== undefined &&
    load.memoryAvailablePercent < limits.minMemoryAvailablePercent
  ) {
    reasons.push(
      `memory available ${load.memoryAvailablePercent}% < ${limits.minMemoryAvailablePercent}%`,
    );
  }
  return reasons.length === 0 ? { ok: true } : { ok: false, reason: reasons.join('; ') };
};

/** Reads the host. `sysctl` is injected so tests never touch the machine. */
export const readHostLoad = async (
  sysctl: (name: string) => Promise<string>,
  os: { loadavg: () => number[]; cores: () => number } = {
    loadavg,
    cores: () => cpus().length,
  },
): Promise<HostLoad> => {
  const load: HostLoad = {};
  const [oneMinute] = os.loadavg();
  const cores = os.cores();
  if (oneMinute !== undefined && cores > 0) load.loadPerCore = oneMinute / cores;
  try {
    const level = Number((await sysctl('kern.memorystatus_level')).trim());
    if (Number.isFinite(level) && level >= 0 && level <= 100) load.memoryAvailablePercent = level;
  } catch {
    // Not macOS, or sysctl failed: memory stays unknown.
  }
  return load;
};
