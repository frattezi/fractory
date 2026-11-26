import type { AutomationRunRecord } from '../contracts/automation.ts';
import type { FactoryConfig } from '../contracts/factory-config.ts';
import { AutomationStore } from '../registry/automations.ts';
import type { Logger } from './support.ts';

export interface PruneDeps {
  factory: Pick<FactoryConfig, 'automationsDir'>;
  now(): Date;
  log: Logger;
}

export interface PruneSummary {
  /** Automation Run ids removed, with their logs and output directories. */
  pruned: string[];
  errors: number;
}

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const inFlight = (record: AutomationRunRecord): boolean =>
  record.status === 'queued' || record.status === 'running';

/** Newest first: by the instant each Run fired for, then when it started, then by id. */
const newestFirst = (a: AutomationRunRecord, b: AutomationRunRecord): number =>
  new Date(b.firedFor).getTime() - new Date(a.firedFor).getTime() ||
  b.startedAt.localeCompare(a.startedAt) ||
  b.id.localeCompare(a.id);

/**
 * The records of one Automation to remove so `keep` remain. The newest `keep` records are kept;
 * of the rest, a queued or running Run is never removed, and neither is the newest finished Run,
 * even when in-flight Runs fill every kept place.
 */
export const prunableRuns = (
  records: readonly AutomationRunRecord[],
  keep: number,
): AutomationRunRecord[] => {
  const sorted = [...records].sort(newestFirst);
  const newestFinished = sorted.find((record) => !inFlight(record));
  return sorted
    .slice(Math.max(0, keep))
    .filter((record) => !inFlight(record) && record !== newestFinished);
};

/**
 * After an Automation Run finishes, prunes that Automation's history to the `keepRuns` its request
 * carried. A finished record without `prunedAt` marks a Run whose Automation has not been pruned
 * since; Automations without one are left alone, so one Automation's history never affects
 * another's. When several Runs finished, the newest one's request decides the count.
 *
 * A Run whose request copy is gone gives no count, and a removal that fails leaves the records
 * unmarked: either way the next tick tries again rather than guessing.
 */
export const pruneAutomationRuns = async (deps: PruneDeps): Promise<PruneSummary> => {
  const summary: PruneSummary = { pruned: [], errors: 0 };
  const { log } = deps;
  const store = new AutomationStore(deps.factory.automationsDir);
  const fail = (what: string, error: unknown): void => {
    summary.errors++;
    log.error(`${what}: ${message(error)}`);
  };

  let all: AutomationRunRecord[];
  try {
    all = await store.listAllRuns();
  } catch (error) {
    fail('Automation Runs to prune', error);
    return summary;
  }
  const byAutomation = new Map<string, AutomationRunRecord[]>();
  for (const record of all) {
    byAutomation.set(record.automationId, [
      ...(byAutomation.get(record.automationId) ?? []),
      record,
    ]);
  }

  for (const [automationId, records] of byAutomation) {
    const finished = records.filter((r) => !inFlight(r) && r.prunedAt === undefined);
    const latest = finished.sort(newestFirst)[0];
    if (!latest) continue;
    try {
      const request = await store.readRequestCopy(automationId, latest.id);
      if (!request) {
        log.warn(
          `Automation ${automationId} not pruned: no configuration was kept for Run ${latest.id}`,
        );
        continue;
      }
      const keep = request.automation.keepRuns;
      let removedAll = true;
      const removed = new Set<string>();
      for (const record of prunableRuns(records, keep)) {
        try {
          await store.removeRun(record);
          removed.add(record.id);
          summary.pruned.push(record.id);
          log.info(`pruned Automation Run ${record.id} of ${automationId} (keeps ${keep})`);
        } catch (error) {
          removedAll = false;
          fail(`prune of Automation Run ${record.id}`, error);
        }
      }
      if (!removedAll) continue;
      const stamp = deps.now().toISOString();
      for (const record of finished) {
        if (removed.has(record.id)) continue;
        await store.writeRun({ ...record, prunedAt: stamp });
      }
    } catch (error) {
      fail(`prune of Automation ${automationId}`, error);
    }
  }
  return summary;
};
