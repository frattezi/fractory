import { describe, expect, it } from 'vitest';
import {
  AUTOMATION_REQUEST_VERSION,
  AUTOMATION_RUN_RECORD_VERSION,
  AUTOMATION_VERSION,
  automationOf,
  parseAutomation,
  parseAutomationRequest,
  parseAutomationRunRecord,
} from '../src/contracts/automation.ts';
import type { Automation } from '../src/contracts/automation.ts';

const automation = (): Automation => ({
  version: AUTOMATION_VERSION,
  id: 'a7f3c2e1',
  name: 'nightly-deps',
  kind: 'agent',
  repoPath: '/repos/app',
  cron: '0 3 * * *',
  timezone: 'Europe/Lisbon',
  mode: 'personal',
  cli: 'claude',
  flags: ['--print'],
  entryPoint: 'automations/nightly-deps.md',
  keepRuns: 10,
});

const request = () => ({
  version: AUTOMATION_REQUEST_VERSION,
  requestedAt: '2026-11-26T03:00:02.000Z',
  firedFor: '2026-11-26T03:00:00.000Z',
  automation: automation(),
});

const record = () => ({
  version: AUTOMATION_RUN_RECORD_VERSION,
  id: 'a7f3c2e1-20261126T030000Z',
  automationId: 'a7f3c2e1',
  firedFor: '2026-11-26T03:00:00.000Z',
  status: 'done',
  startedAt: '2026-11-26T03:00:05.000Z',
  updatedAt: '2026-11-26T03:04:00.000Z',
  logPath: '/factory/automations/nightly-deps/1.log',
  outputPath: '/factory/automations/nightly-deps/1.out',
  result: { outcome: 'done', summary: 'Bumped 3 dependencies.' },
});

const refusal = (parsed: { ok: boolean; reason?: string }): string => {
  expect(parsed.ok).toBe(false);
  return parsed.reason ?? '';
};

describe('Automation configuration', () => {
  it('parses a valid instance', () => {
    expect(parseAutomation(automation())).toEqual({ ok: true, value: automation() });
  });

  it('refuses a wrong version and says so', () => {
    const reason = refusal(parseAutomation({ ...automation(), version: 2 }));
    expect(reason).toMatch(/Unsupported Automation version 2/);
    expect(reason).toMatch(/version 1/);
  });

  it('refuses a missing field, naming it', () => {
    const { entryPoint: _, ...rest } = automation();
    expect(refusal(parseAutomation(rest))).toMatch(/entryPoint: Required/);
  });

  it('requires a stable id, naming it when missing or bad', () => {
    const { id: _, ...noId } = automation();
    expect(refusal(parseAutomation(noId))).toMatch(/Invalid Automation: id: Required/);
    expect(refusal(parseAutomation({ ...automation(), id: '' }))).toMatch(/id:/);
    expect(refusal(parseAutomation({ ...automation(), id: '../x' }))).toMatch(/id:/);
  });

  it('still requires a file-name-safe name', () => {
    const { name: _, ...noName } = automation();
    expect(refusal(parseAutomation(noName))).toMatch(/name: Required/);
  });

  it('keeps the id when the name is edited', () => {
    const parsed = parseAutomation({ ...automation(), name: 'weekly-deps' });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.id).toBe(automation().id);
  });

  it('refuses a kind outside agent and script', () => {
    expect(refusal(parseAutomation({ ...automation(), kind: 'webhook' }))).toMatch(/kind:/);
    expect(parseAutomation({ ...automation(), kind: 'script', cli: 'bash' }).ok).toBe(true);
  });

  it('refuses bad values, naming the field', () => {
    expect(refusal(parseAutomation({ ...automation(), mode: 'shared' }))).toMatch(/mode:/);
    expect(refusal(parseAutomation({ ...automation(), timezone: 'Mars/Olympus' }))).toMatch(
      /timezone: Expected an IANA timezone/,
    );
    expect(refusal(parseAutomation({ ...automation(), cron: '0 3 *' }))).toMatch(/cron:/);
    expect(refusal(parseAutomation({ ...automation(), keepRuns: 0 }))).toMatch(/keepRuns:/);
    expect(refusal(parseAutomation({ ...automation(), name: '../etc' }))).toMatch(/name:/);
  });

  it('ignores an unknown field', () => {
    const parsed = parseAutomation({ ...automation(), colour: 'blue' });
    expect(parsed).toEqual({ ok: true, value: automation() });
  });
});

describe('Automation request', () => {
  it('parses a valid request and carries the configuration whole', () => {
    const parsed = parseAutomationRequest(request());
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.automation).toEqual(automation());
  });

  it('refuses a version this release does not understand', () => {
    expect(refusal(parseAutomationRequest({ ...request(), version: 99 }))).toMatch(
      /Unsupported Automation request version 99: this release understands version 1/,
    );
    expect(refusal(parseAutomationRequest({ ...request(), version: undefined }))).toMatch(
      /Unsupported Automation request version undefined/,
    );
    expect(refusal(parseAutomationRequest('not json object'))).toMatch(/Unsupported/);
  });

  it('refuses a carried configuration with an unknown version, saying so', () => {
    const reason = refusal(
      parseAutomationRequest({ ...request(), automation: { ...automation(), version: 3 } }),
    );
    expect(reason).toMatch(/automation: Unsupported Automation version 3/);
  });

  it('refuses a missing field, naming it', () => {
    const { firedFor: _, ...rest } = request();
    expect(refusal(parseAutomationRequest(rest))).toMatch(/firedFor: Required/);
    const { cron: __, ...noCron } = automation();
    expect(refusal(parseAutomationRequest({ ...request(), automation: noCron }))).toMatch(
      /automation\.cron: Required/,
    );
    const { id: ___, ...noId } = automation();
    expect(refusal(parseAutomationRequest({ ...request(), automation: noId }))).toMatch(
      /automation\.id: Required/,
    );
  });

  it('refuses a bad value, naming the field', () => {
    expect(refusal(parseAutomationRequest({ ...request(), requestedAt: 'yesterday' }))).toMatch(
      /requestedAt:/,
    );
    expect(
      refusal(
        parseAutomationRequest({ ...request(), automation: { ...automation(), kind: 'cron' } }),
      ),
    ).toMatch(/automation\.kind:/);
  });

  it('ignores unknown fields at both levels', () => {
    const parsed = parseAutomationRequest({
      ...request(),
      origin: 'manager',
      automation: { ...automation(), owner: 'me' },
    });
    expect(parsed).toEqual({ ok: true, value: request() });
  });
});

describe('Automation Run record', () => {
  it('parses a valid instance', () => {
    expect(parseAutomationRunRecord(record())).toEqual({ ok: true, value: record() });
    const { result: _, ...running } = { ...record(), status: 'running' };
    expect(parseAutomationRunRecord(running).ok).toBe(true);
  });

  it('refuses a wrong version and says so', () => {
    expect(refusal(parseAutomationRunRecord({ ...record(), version: 0 }))).toMatch(
      /Unsupported Automation Run record version 0/,
    );
  });

  it('refuses a missing field, naming it', () => {
    const { outputPath: _, ...rest } = record();
    expect(refusal(parseAutomationRunRecord(rest))).toMatch(/outputPath: Required/);
    const { automationId: __, ...noAutomationId } = record();
    expect(refusal(parseAutomationRunRecord(noAutomationId))).toMatch(/automationId: Required/);
  });

  it('refuses a record that references the Automation by name only', () => {
    const { automationId: _, ...rest } = record();
    expect(refusal(parseAutomationRunRecord({ ...rest, automation: automation().name }))).toMatch(
      /automationId: Required/,
    );
  });

  it('accepts only the closed set of statuses', () => {
    for (const status of ['queued', 'running', 'done', 'failed']) {
      expect(parseAutomationRunRecord({ ...record(), status }).ok).toBe(true);
    }
    expect(refusal(parseAutomationRunRecord({ ...record(), status: 'paused' }))).toMatch(/status:/);
  });

  it('refuses a bad result, naming the field', () => {
    expect(
      refusal(parseAutomationRunRecord({ ...record(), result: { outcome: 'maybe' } })),
    ).toMatch(/result\.outcome:/);
  });

  it('ignores an unknown field', () => {
    expect(parseAutomationRunRecord({ ...record(), exitCode: 0 })).toEqual({
      ok: true,
      value: record(),
    });
  });
});

describe('Matching a record to its Automation', () => {
  it('finds the configuration by id, even after a rename', () => {
    const renamed = { ...automation(), name: 'weekly-deps' };
    const other = { ...automation(), id: 'b81d0e44', name: 'nightly-deps' };
    expect(automationOf(record(), [other, renamed])).toBe(renamed);
  });

  it('parses a record whose id matches no configuration, and identifies it as orphaned', () => {
    const parsed = parseAutomationRunRecord({ ...record(), automationId: 'gone-0001' });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // Same name, different id: a name never stands in for the identity.
    expect(automationOf(parsed.value, [automation()])).toBeUndefined();
    expect(automationOf(parsed.value, [])).toBeUndefined();
  });
});
