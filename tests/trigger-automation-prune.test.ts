import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AUTOMATION_REQUEST_VERSION,
  AUTOMATION_RUN_RECORD_VERSION,
  AUTOMATION_VERSION,
  type Automation,
  type AutomationRunRecord,
  type AutomationRunStatus,
} from '../src/contracts/automation.ts';
import { AutomationStore, automationRunId } from '../src/registry/automations.ts';
import { prunableRuns, pruneAutomationRuns } from '../src/trigger/automation-prune.ts';
import { tick } from '../src/trigger/tick.ts';
import { type Harness, makeHarness } from './trigger-helpers.ts';

const automation = (id: string, keepRuns: number): Automation => ({
  version: AUTOMATION_VERSION,
  id,
  name: id,
  kind: 'script',
  repoPath: '/repo/app',
  cron: '0 3 * * *',
  timezone: 'Europe/Lisbon',
  mode: 'personal',
  cli: 'bash',
  flags: [],
  entryPoint: 'automations/run.sh',
  keepRuns,
});

const store = (h: Harness) => new AutomationStore(h.factory.automationsDir);

/** Day `day` of June 2026, 03:00 UTC. */
const firedOn = (day: number): string => `2026-06-${String(day).padStart(2, '0')}T03:00:00.000Z`;

interface Seed {
  day: number;
  status?: AutomationRunStatus;
  keepRuns?: number;
  prunedAt?: string | undefined;
  /** Writes the output directory with a file in it; default true. */
  output?: boolean;
}

/** Writes a record with its request copy, log and (unless told not to) output directory. */
const seed = async (
  h: Harness,
  automationId: string,
  { day, status = 'done', keepRuns = 3, prunedAt, output = true }: Seed,
): Promise<AutomationRunRecord> => {
  const s = store(h);
  const firedFor = firedOn(day);
  const id = automationRunId(automationId, firedFor);
  await s.writeRequestCopy(id, {
    version: AUTOMATION_REQUEST_VERSION,
    requestedAt: firedFor,
    firedFor,
    automation: automation(automationId, keepRuns),
  });
  const record: AutomationRunRecord = {
    version: AUTOMATION_RUN_RECORD_VERSION,
    id,
    automationId,
    firedFor,
    status,
    startedAt: firedFor,
    updatedAt: firedFor,
    logPath: s.logPath(automationId, id),
    outputPath: s.outputPath(automationId, id),
    ...(status === 'done' && { result: { outcome: 'done' as const, summary: 'ok' } }),
    ...(prunedAt && { prunedAt }),
  };
  await s.writeRun(record);
  await writeFile(record.logPath, 'log\n');
  if (output) {
    await mkdir(record.outputPath, { recursive: true });
    await writeFile(join(record.outputPath, 'report.csv'), 'a,b\n');
  }
  return record;
};

const exists = async (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

const ids = async (h: Harness, automationId: string): Promise<string[]> =>
  (await store(h).listRuns(automationId)).map((r) => r.id).sort();

const runId = (automationId: string, day: number) => automationRunId(automationId, firedOn(day));

describe('prunableRuns', () => {
  const rec = (day: number, status: AutomationRunStatus = 'done'): AutomationRunRecord => ({
    version: AUTOMATION_RUN_RECORD_VERSION,
    id: runId('a', day),
    automationId: 'a',
    firedFor: firedOn(day),
    status,
    startedAt: firedOn(day),
    updatedAt: firedOn(day),
    logPath: '/x.log',
    outputPath: '/x.out',
  });

  it('removes the oldest records beyond the count, whatever order they come in', () => {
    const records = [rec(3), rec(1), rec(5), rec(2), rec(4)];
    expect(prunableRuns(records, 2).map((r) => r.firedFor)).toEqual([
      firedOn(3),
      firedOn(2),
      firedOn(1),
    ]);
  });

  it('never removes a queued or running Run, however old', () => {
    const records = [rec(1, 'running'), rec(2, 'queued'), rec(3), rec(4)];
    expect(prunableRuns(records, 1).map((r) => r.firedFor)).toEqual([firedOn(3)]);
  });

  it('keeps the newest finished Run when in-flight Runs fill every kept place', () => {
    const records = [rec(1, 'failed'), rec(2), rec(3, 'queued')];
    expect(prunableRuns(records, 1).map((r) => r.firedFor)).toEqual([firedOn(1)]);
    expect(prunableRuns(records, 0).map((r) => r.firedFor)).toEqual([firedOn(1)]);
  });
});

describe('pruning Automation Runs in the tick', () => {
  it('prunes to the count the finished Run carried, removing logs and output directories', async () => {
    const h = await makeHarness();
    const records: AutomationRunRecord[] = [];
    for (let day = 1; day <= 6; day++) {
      records.push(await seed(h, 'daily', { day, prunedAt: day < 6 ? firedOn(day) : undefined }));
    }

    const summary = await tick(h.deps);

    const gone = [1, 2, 3].map((d) => runId('daily', d));
    const kept = [4, 5, 6].map((d) => runId('daily', d));
    expect([...summary.automations.pruned].sort()).toEqual(gone);
    expect(summary.errors).toBe(0);
    expect(await ids(h, 'daily')).toEqual(kept);
    for (const record of records) {
      const survives = kept.includes(record.id);
      expect(await exists(record.logPath)).toBe(survives);
      expect(await exists(record.outputPath)).toBe(survives);
      expect(await exists(store(h).requestCopyPath('daily', record.id))).toBe(survives);
    }
    // Every survivor is marked, so the next tick leaves this history alone.
    expect((await store(h).listRuns('daily')).every((r) => r.prunedAt)).toBe(true);
    expect((await tick(h.deps)).automations.pruned).toEqual([]);
    expect(h.log.lines.some((l) => l.includes('automationsPruned=3'))).toBe(true);
  });

  it('uses the count of the Run that just finished, not an older one', async () => {
    const h = await makeHarness();
    for (let day = 1; day <= 4; day++) {
      await seed(h, 'daily', {
        day,
        keepRuns: day === 4 ? 1 : 10,
        prunedAt: day < 4 ? firedOn(day) : undefined,
      });
    }
    const summary = await pruneAutomationRuns(h.deps);
    expect(summary.pruned).toHaveLength(3);
    expect(await ids(h, 'daily')).toEqual([runId('daily', 4)]);
  });

  it('counts and removes only the Automation whose Run just finished', async () => {
    const h = await makeHarness();
    for (let day = 1; day <= 4; day++) {
      await seed(h, 'finished', { day, keepRuns: 2, prunedAt: day < 4 ? firedOn(day) : undefined });
      // Over its own count, but none of its Runs finished since it was last pruned.
      await seed(h, 'other', { day, keepRuns: 1, prunedAt: firedOn(day) });
    }
    await seed(h, 'other', { day: 5, status: 'queued', keepRuns: 1 });

    const summary = await tick(h.deps);

    expect([...summary.automations.pruned].sort()).toEqual([
      runId('finished', 1),
      runId('finished', 2),
    ]);
    expect(await ids(h, 'finished')).toEqual([runId('finished', 3), runId('finished', 4)]);
    expect(await ids(h, 'other')).toEqual([1, 2, 3, 4, 5].map((d) => runId('other', d)));
  });

  it('never prunes a queued or running Run, and always keeps the newest finished one', async () => {
    const h = await makeHarness({ maxConcurrentRuns: 0 });
    await seed(h, 'daily', { day: 1, status: 'running', keepRuns: 1 });
    await seed(h, 'daily', { day: 2, status: 'failed', keepRuns: 1, prunedAt: firedOn(2) });
    await seed(h, 'daily', { day: 3, status: 'done', keepRuns: 1 });
    await seed(h, 'daily', { day: 4, status: 'queued', keepRuns: 1 });

    const summary = await tick(h.deps);

    expect(summary.automations.pruned).toEqual([runId('daily', 2)]);
    expect(await ids(h, 'daily')).toEqual([1, 3, 4].map((d) => runId('daily', d)));
  });

  it('does not fail when an output directory is already gone', async () => {
    const h = await makeHarness();
    const old = await seed(h, 'daily', {
      day: 1,
      keepRuns: 1,
      prunedAt: firedOn(1),
      output: false,
    });
    await seed(h, 'daily', { day: 2, keepRuns: 1 });

    const summary = await tick(h.deps);

    expect(summary.errors).toBe(0);
    expect(summary.automations.pruned).toEqual([old.id]);
    expect(await exists(old.logPath)).toBe(false);
    expect(await ids(h, 'daily')).toEqual([runId('daily', 2)]);
  });

  it('prunes after a Run the tick itself marks dead', async () => {
    const h = await makeHarness();
    await seed(h, 'daily', { day: 1, keepRuns: 1, prunedAt: firedOn(1) });
    const running = await seed(h, 'daily', { day: 2, status: 'running', keepRuns: 1 });
    await store(h).writeRun({ ...running, pid: 77 });
    h.pids.set(77, 'dead');

    const summary = await tick(h.deps);

    expect(summary.automations.markedDead).toEqual([running.id]);
    expect(summary.automations.pruned).toEqual([runId('daily', 1)]);
  });

  it('prunes nothing when the finished Run kept no configuration, and tries again later', async () => {
    const h = await makeHarness();
    await seed(h, 'daily', { day: 1, keepRuns: 1, prunedAt: firedOn(1) });
    const latest = await seed(h, 'daily', { day: 2, keepRuns: 1 });
    await rm(store(h).requestCopyPath('daily', latest.id));

    const summary = await tick(h.deps);

    expect(summary.automations.pruned).toEqual([]);
    expect(summary.errors).toBe(0);
    expect(await ids(h, 'daily')).toHaveLength(2);
    expect((await store(h).getRun('daily', latest.id))?.prunedAt).toBeUndefined();
  });

  it('refuses to remove a recorded path outside the Automation directory', async () => {
    const h = await makeHarness();
    const old = await seed(h, 'daily', { day: 1, keepRuns: 1, prunedAt: firedOn(1) });
    await store(h).writeRun({ ...old, outputPath: h.factory.logDir });
    await seed(h, 'daily', { day: 2, keepRuns: 1 });
    await mkdir(h.factory.logDir, { recursive: true });

    const summary = await tick(h.deps);

    expect(summary.automations.pruned).toEqual([]);
    expect(summary.errors).toBe(1);
    expect(await exists(h.factory.logDir)).toBe(true);
    expect(await ids(h, 'daily')).toHaveLength(2);
  });
});
