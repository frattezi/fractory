import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  AUTOMATION_RUN_RECORD_VERSION,
  type AutomationRunRecord,
} from '../src/contracts/automation.ts';
import { ResourceLimitsSchema } from '../src/contracts/factory-config.ts';
import type { Trigger } from '../src/contracts/run.ts';
import type { HostLoad } from '../src/policy/resources.ts';
import { AutomationStore } from '../src/registry/automations.ts';
import { tick } from '../src/trigger/tick.ts';
import { type Harness, makeHarness, makeRun } from './trigger-helpers.ts';

const limits = ResourceLimitsSchema.parse({});
const roomy: HostLoad = {
  loadPerCore: 0.2,
  hostMemoryFreeGb: 8,
  dockerMemoryFreeGb: 4,
  dockerReachable: true,
};

const store = (h: Harness) => new AutomationStore(h.factory.automationsDir);

const automationRun = (overrides: Partial<AutomationRunRecord> = {}): AutomationRunRecord => {
  const id = overrides.id ?? 'a1-20260601T030000Z';
  const automationId = overrides.automationId ?? 'a1';
  return {
    version: AUTOMATION_RUN_RECORD_VERSION,
    id,
    automationId,
    firedFor: '2026-06-01T03:00:00.000Z',
    status: 'queued',
    // Queued long before any Run, so only priority can put it behind one.
    startedAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-01T00:00:00.000Z',
    logPath: `/automations/${automationId}/${id}.log`,
    outputPath: `/automations/${automationId}/${id}.out`,
    ...overrides,
  };
};

const queuedRun = (id: string, n: number, trigger: Trigger) =>
  makeRun({
    id,
    ticketRef: `github:me/app#${n}`,
    trigger,
    key: `k-${id}`,
    status: 'queued',
    createdAt: '2026-05-31T10:00:00.000Z',
    updatedAt: '2026-05-31T10:00:00.000Z',
  });

const record = async (h: Harness, run = automationRun()) =>
  store(h).getRun(run.automationId, run.id);

const withLimits = async (
  load: () => HostLoad = () => roomy,
  options: { maxLaunchesPerTick?: number; maxConcurrentRuns?: number } = {},
) => {
  const h = await makeHarness(
    options.maxConcurrentRuns === undefined ? {} : { maxConcurrentRuns: options.maxConcurrentRuns },
  );
  h.deps.factory.resources = { ...limits, maxLaunchesPerTick: options.maxLaunchesPerTick ?? 1 };
  h.deps.hostLoad = async () => load();
  return h;
};

/** Records Runs and Automation Runs in one launch order. */
const trackOrder = (h: Harness): string[] => {
  const order: string[] = [];
  const { launchRun, launchAutomationRun } = h.deps;
  h.deps.launchRun = async (run, config) => {
    order.push(`run:${run.id}`);
    await launchRun(run, config);
  };
  h.deps.launchAutomationRun = async (run) => {
    order.push(`automation:${run.id}`);
    await launchAutomationRun(run);
  };
  return order;
};

describe('Automation Run launches in the tick', () => {
  it('launches a queued Automation Run when the host limits allow it', async () => {
    const h = await withLimits();
    await store(h).writeRun(automationRun());

    const summary = await tick(h.deps);

    expect(summary.automations.launched).toEqual(['a1-20260601T030000Z']);
    expect(summary.errors).toBe(0);
    expect(h.launchedAutomations).toEqual(['a1-20260601T030000Z']);
    // Recorded before the tick returned.
    expect(await record(h)).toMatchObject({ status: 'running', pid: 5001 });
    expect(h.log.lines).toContainEqual(expect.stringContaining('automationsLaunched=1'));
  });

  it('waits while the queue is Held and launches on a later tick once the hold lifts', async () => {
    let load: HostLoad = { ...roomy, loadPerCore: 0.92 };
    const h = await withLimits(() => load);
    await store(h).writeRun(automationRun());

    const held = await tick(h.deps);
    expect(held.held).toBe('CPU load 0.92 per core > 0.75');
    expect(held.automations.launched).toEqual([]);
    expect(h.launchedAutomations).toEqual([]);
    expect(await record(h)).toMatchObject({ status: 'queued' });
    const state = JSON.parse(await readFile(h.factory.hostStatePath, 'utf8'));
    expect(state).toMatchObject({ held: true, queued: 1 });

    load = roomy;
    const released = await tick(h.deps);
    expect(released.held).toBeUndefined();
    expect(released.automations.launched).toEqual(['a1-20260601T030000Z']);
    expect(await record(h)).toMatchObject({ status: 'running', pid: 5001 });
  });

  it('counts towards the per-tick launch cap', async () => {
    const h = await withLimits(() => roomy, { maxLaunchesPerTick: 2 });
    const first = automationRun();
    const second = automationRun({ id: 'a2-20260601T030000Z', automationId: 'a2' });
    const third = automationRun({ id: 'a3-20260601T030000Z', automationId: 'a3' });
    for (const run of [first, second, third]) await store(h).writeRun(run);

    expect((await tick(h.deps)).automations.launched).toEqual([first.id, second.id]);
    expect((await tick(h.deps)).automations.launched).toEqual([third.id]);
  });

  it('shares the per-tick cap with Runs: the Run takes the only launch', async () => {
    const h = await withLimits();
    await h.registry.write(queuedRun('ready', 1, { kind: 'ticket-ready' }));
    await store(h).writeRun(automationRun());

    const first = await tick(h.deps);
    expect(first.launched).toEqual(['ready']);
    expect(first.automations.launched).toEqual([]);
    expect(await record(h)).toMatchObject({ status: 'queued' });

    const second = await tick(h.deps);
    expect(second.automations.launched).toEqual(['a1-20260601T030000Z']);
  });

  it('counts a running Automation Run towards the in-flight limit, and is held by Runs', async () => {
    const h = await makeHarness({ maxConcurrentRuns: 1 });
    await store(h).writeRun(automationRun({ status: 'running', pid: 77 }));
    await h.registry.write(queuedRun('ready', 1, { kind: 'ticket-ready' }));
    expect((await tick(h.deps)).launched).toEqual([]);

    const busy = await makeHarness({ maxConcurrentRuns: 1 });
    await busy.registry.write(makeRun({ id: 'active', status: 'running', pid: 88 }));
    await store(busy).writeRun(automationRun());
    expect((await tick(busy.deps)).automations.launched).toEqual([]);
    expect(await record(busy)).toMatchObject({ status: 'queued' });
  });

  it.each<[string, Trigger]>([
    ['manual', { kind: 'manual' }],
    ['ci-failed', { kind: 'ci-failed', prNumber: 7, headSha: 'sha' }],
    ['review-comment', { kind: 'review-comment', prNumber: 7, commentId: 'c' }],
    ['ticket-ready', { kind: 'ticket-ready' }],
  ])('launches a waiting %s Run before an older Automation Run', async (_kind, trigger) => {
    const h = await withLimits(() => roomy, { maxLaunchesPerTick: 10 });
    const order = trackOrder(h);
    await store(h).writeRun(automationRun());
    await h.registry.write(queuedRun('run', 1, trigger));

    await tick(h.deps);

    expect(order).toEqual(['run:run', 'automation:a1-20260601T030000Z']);
  });

  it('puts Automation Runs behind every Run, whatever the mix', async () => {
    const h = await makeHarness({ maxConcurrentRuns: 10 });
    const order = trackOrder(h);
    await store(h).writeRun(automationRun());
    await h.registry.write(queuedRun('ready', 1, { kind: 'ticket-ready' }));
    await h.registry.write(queuedRun('manual', 2, { kind: 'manual' }));

    await tick(h.deps);

    expect(order).toEqual(['run:manual', 'run:ready', 'automation:a1-20260601T030000Z']);
  });

  it('reports a failed launch and keeps going', async () => {
    const h = await makeHarness();
    h.deps.launchAutomationRun = async () => {
      throw new Error('spawn refused');
    };
    await store(h).writeRun(automationRun());
    await h.registry.write(queuedRun('ready', 1, { kind: 'ticket-ready' }));

    const summary = await tick(h.deps);

    expect(summary.launched).toEqual(['ready']);
    expect(summary.automations.launched).toEqual([]);
    expect(summary.errors).toBe(1);
  });
});

describe('dead Automation Runs', () => {
  it('marks an Automation Run whose process died without finishing failed on a later tick', async () => {
    const h = await makeHarness();
    await store(h).writeRun(automationRun());
    await tick(h.deps);
    expect(await record(h)).toMatchObject({ status: 'running', pid: 5001 });

    h.pids.set(5001, 'dead');
    const summary = await tick(h.deps);

    expect(summary.automations.markedDead).toEqual(['a1-20260601T030000Z']);
    expect(await record(h)).toMatchObject({
      status: 'failed',
      pid: 5001,
      result: { outcome: 'failed', summary: 'Host process exited without recording a result.' },
    });
    // A dead Automation Run is never relaunched.
    expect(h.launchedAutomations).toEqual(['a1-20260601T030000Z']);
  });

  it('never marks dead on an inconclusive or failed liveness check', async () => {
    const h = await makeHarness();
    await store(h).writeRun(automationRun({ status: 'running', pid: 77 }));

    h.pids.set(77, 'unknown');
    expect((await tick(h.deps)).automations.markedDead).toEqual([]);
    expect(await record(h)).toMatchObject({ status: 'running' });

    h.deps.checkPid = () => {
      throw new Error('ps failed');
    };
    const summary = await tick(h.deps);
    expect(summary.automations.markedDead).toEqual([]);
    expect(summary.errors).toBe(1);
    expect(await record(h)).toMatchObject({ status: 'running', pid: 77 });
  });

  it('leaves a finished Automation Run alone, whatever its pid says', async () => {
    const h = await makeHarness();
    const done = automationRun({
      status: 'done',
      pid: 77,
      result: { outcome: 'done', summary: 'ok' },
    });
    await store(h).writeRun(done);
    h.pids.set(77, 'dead');

    expect((await tick(h.deps)).automations.markedDead).toEqual([]);
    expect(await record(h)).toEqual(done);
  });
});
