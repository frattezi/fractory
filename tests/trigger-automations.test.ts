import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AUTOMATION_REQUEST_VERSION,
  AUTOMATION_VERSION,
  type Automation,
} from '../src/contracts/automation.ts';
import { rerunRequestPath } from '../src/contracts/run.ts';
import { AutomationStore, automationRunId } from '../src/registry/automations.ts';
import { tick } from '../src/trigger/tick.ts';
import { type Harness, makeHarness, makeRun, makeTicket, writeJson } from './trigger-helpers.ts';

const automation = (overrides: Partial<Automation> = {}): Automation => ({
  version: AUTOMATION_VERSION,
  id: 'a7f3c2e1',
  name: 'nightly-deps',
  kind: 'agent',
  repoPath: '/repo/app',
  cron: '0 3 * * *',
  timezone: 'Europe/Lisbon',
  mode: 'personal',
  cli: 'claude',
  flags: [],
  entryPoint: 'automations/nightly-deps.md',
  keepRuns: 10,
  ...overrides,
});

const FIRED_FOR = '2026-06-01T03:00:00.000Z';

const request = (overrides: Record<string, unknown> = {}) => ({
  version: AUTOMATION_REQUEST_VERSION,
  requestedAt: '2026-06-01T03:00:02.000Z',
  firedFor: FIRED_FOR,
  automation: automation(),
  ...overrides,
});

const store = (h: Harness) => new AutomationStore(h.factory.automationsDir);
const requestPath = (h: Harness, name: string) => join(store(h).requestsDir, name);
const drop = (h: Harness, name: string, value: unknown) => writeJson(requestPath(h, name), value);
const requests = async (h: Harness) => store(h).listRequests();

describe('Automation requests in the tick', () => {
  it('turns a valid request into a queued Automation Run record and removes the file', async () => {
    const h = await makeHarness();
    await drop(h, 'a7f3c2e1-1.json', request());

    const summary = await tick(h.deps);

    const id = automationRunId('a7f3c2e1', FIRED_FOR);
    expect(id).toBe('a7f3c2e1-20260601T030000Z');
    // Queued from the request, then launched by the same tick: Host Limits are off here.
    expect(summary.automations).toEqual({
      queued: [id],
      refused: [],
      discarded: [],
      launched: [id],
      markedDead: [],
    });
    expect(summary.errors).toBe(0);
    const runs = await store(h).listRuns('a7f3c2e1');
    expect(runs).toEqual([
      expect.objectContaining({
        id,
        automationId: 'a7f3c2e1',
        firedFor: FIRED_FOR,
        status: 'running',
        pid: 5001,
        logPath: join(h.factory.automationsDir, 'a7f3c2e1', `${id}.log`),
        outputPath: join(h.factory.automationsDir, 'a7f3c2e1', `${id}.out`),
      }),
    ]);
    expect(await requests(h)).toEqual([]);
  });

  it('never executes, sets a Ticket status or touches the Run registry or a PR', async () => {
    const h = await makeHarness();
    await drop(h, 'r.json', request());
    await tick(h.deps);
    expect(h.launched).toEqual([]);
    expect(h.source.statusCalls).toEqual([]);
    expect(await h.registry.list()).toEqual([]);
    expect(h.gh.merges).toEqual([]);
  });

  it('discards a request whose instant already has a record, and removes the file', async () => {
    const h = await makeHarness();
    await drop(h, 'first.json', request());
    await tick(h.deps);
    const before = await store(h).listRuns('a7f3c2e1');

    // Same instant, written in another form: still the same instant.
    await drop(h, 'again.json', request({ firedFor: '2026-06-01T03:00:00Z' }));
    const summary = await tick(h.deps);

    expect(summary.automations).toMatchObject({
      queued: [],
      refused: [],
      discarded: ['again.json'],
    });
    expect(await store(h).listRuns('a7f3c2e1')).toEqual(before);
    expect(await requests(h)).toEqual([]);
  });

  it('runs a crashed-before-removal request only once', async () => {
    const h = await makeHarness();
    await drop(h, 'r.json', request());
    await tick(h.deps);
    // Simulate a crash after the record was written but before the file was removed.
    await drop(h, 'r.json', request());
    const summary = await tick(h.deps);
    expect(summary.automations.discarded).toEqual(['r.json']);
    expect(await store(h).listRuns('a7f3c2e1')).toHaveLength(1);
  });

  it('treats an unreadable record for the instant as existing', async () => {
    const h = await makeHarness();
    const id = automationRunId('a7f3c2e1', FIRED_FOR);
    await writeJson(join(h.factory.automationsDir, 'a7f3c2e1', `${id}.json`), { version: 99 });
    await drop(h, 'r.json', request());
    const summary = await tick(h.deps);
    expect(summary.automations.discarded).toEqual(['r.json']);
  });

  it('queues two instants of one Automation and two Automations at one instant', async () => {
    const h = await makeHarness();
    await drop(h, 'a.json', request());
    await drop(h, 'b.json', request({ firedFor: '2026-06-02T03:00:00.000Z' }));
    await drop(h, 'c.json', request({ automation: automation({ id: 'other' }) }));
    const summary = await tick(h.deps);
    expect(summary.automations.queued).toEqual([
      'a7f3c2e1-20260601T030000Z',
      'a7f3c2e1-20260602T030000Z',
      'other-20260601T030000Z',
    ]);
  });

  it.each([
    ['a wrong version', request({ version: 2 }), /Unsupported Automation request version 2/],
    [
      'a wrong configuration version',
      request({ automation: { ...automation(), version: 9 } }),
      /automation: Unsupported Automation version 9/,
    ],
    ['a missing field', { ...request(), firedFor: undefined }, /firedFor/],
    [
      'a bad value',
      request({ automation: automation({ cron: 'every day' }) }),
      /automation\.cron: Expected a cron expression/,
    ],
    [
      'an unknown repository',
      request({ automation: automation({ repoPath: '/repo/elsewhere' }) }),
      /Unknown repository \/repo\/elsewhere/,
    ],
  ])('refuses %s, records the reason and removes the file', async (_what, body, reason) => {
    const h = await makeHarness();
    await drop(h, 'bad.json', body);

    const summary = await tick(h.deps);

    expect(summary.automations).toMatchObject({ queued: [], refused: ['bad.json'], discarded: [] });
    expect(summary.errors).toBe(0);
    const refusals = await store(h).listRefusals();
    expect(refusals).toHaveLength(1);
    expect(refusals[0]?.request).toBe('bad.json');
    expect(refusals[0]?.reason).toMatch(reason);
    expect(JSON.parse(refusals[0]?.content ?? '')).toEqual(JSON.parse(JSON.stringify(body)));
    expect(await requests(h)).toEqual([]);
    expect(await readdir(h.factory.automationsDir)).not.toContain('a7f3c2e1');

    // Not retried: the next tick has nothing to look at.
    const next = await tick(h.deps);
    expect(next.automations).toMatchObject({ queued: [], refused: [], discarded: [] });
    expect(await store(h).listRefusals()).toHaveLength(1);
  });

  it('refuses a file that is not JSON', async () => {
    const h = await makeHarness();
    await mkdir(store(h).requestsDir, { recursive: true });
    await writeFile(requestPath(h, 'broken.json'), '{ not json');
    const summary = await tick(h.deps);
    expect(summary.automations.refused).toEqual(['broken.json']);
    const [refusal] = await store(h).listRefusals();
    expect(refusal?.reason).toMatch(/not JSON/);
    expect(refusal?.content).toBe('{ not json');
  });

  it('resolves the repository path before comparing it', async () => {
    const h = await makeHarness();
    await drop(h, 'r.json', request({ automation: automation({ repoPath: '/repo/app/' }) }));
    expect((await tick(h.deps)).automations.queued).toHaveLength(1);
  });

  it('ignores files that are not requests, such as a half-written tmp file', async () => {
    const h = await makeHarness();
    await writeJson(requestPath(h, 'r.json.123.tmp'), request());
    const summary = await tick(h.deps);
    expect(summary.automations).toMatchObject({ queued: [], refused: [], discarded: [] });
    expect(await readdir(store(h).requestsDir)).toEqual(['r.json.123.tmp']);
  });

  it('is not an error when the request directory is absent or empty', async () => {
    const absent = await makeHarness();
    const summary = await tick(absent.deps);
    expect(summary.errors).toBe(0);
    expect(summary.automations).toMatchObject({ queued: [], refused: [], discarded: [] });

    const empty = await makeHarness();
    await mkdir(store(empty).requestsDir, { recursive: true });
    const again = await tick(empty.deps);
    expect(again.errors).toBe(0);
    expect(again.automations).toMatchObject({ queued: [], refused: [], discarded: [] });
  });

  it('reads requests after Re-run handling and before queued Runs are launched', async () => {
    const h = await makeHarness();
    await h.registry.write(makeRun({ id: 'failed-1', status: 'failed' }));
    h.source.tickets.set('github:me/app#1', makeTicket(1, 'in_progress'));
    await writeJson(rerunRequestPath(h.factory.registryDir, 'failed-1'), {
      version: 1,
      requestedAt: '2026-06-01T09:00:00.000Z',
    });
    await drop(h, 'r.json', request());

    await tick(h.deps);

    const index = (pattern: RegExp) => h.log.lines.findIndex((line) => pattern.test(line));
    const rerun = index(/queued Re-run/);
    const accepted = index(/queued Automation Run/);
    const launched = index(/launched Run/);
    expect(rerun).toBeGreaterThanOrEqual(0);
    expect(accepted).toBeGreaterThan(rerun);
    expect(launched).toBeGreaterThan(accepted);
  });

  it('keeps a request it could not record and goes on with the rest', async () => {
    const h = await makeHarness();
    // A file where the refusals directory belongs makes recording a refusal fail.
    await writeJson(join(h.factory.automationsDir, 'refused'), 'not a directory');
    await drop(h, 'a-bad.json', request({ version: 2 }));
    await drop(h, 'b-good.json', request());

    const summary = await tick(h.deps);

    expect(summary.errors).toBe(1);
    expect(summary.automations.queued).toEqual(['a7f3c2e1-20260601T030000Z']);
    // Nothing was recorded for the bad request, so its file stays for the next tick.
    expect(await requests(h)).toEqual(['a-bad.json']);
    expect(h.log.lines.join('\n')).toMatch(/ERROR Automation request a-bad\.json/);
  });
});
