import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ANSWER_REQUEST_VERSION,
  RUN_RECORD_VERSION,
  answerRequestPath,
} from '../src/contracts/run.ts';
import { listAnswerRequests, readAnswerRequest } from '../src/registry/answers.ts';
import { RunRegistry } from '../src/registry/registry.ts';

const now = new Date().toISOString();
const valid = { version: ANSWER_REQUEST_VERSION, answeredAt: now, answer: 'Use the v2 API.' };

const writeAnswer = (dir: string, runId: string, body: unknown): Promise<void> =>
  writeFile(answerRequestPath(dir, runId), typeof body === 'string' ? body : JSON.stringify(body));

describe('answer requests', () => {
  it('lists the Run ids with a valid answer file, sorted', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'answers-'));
    await writeAnswer(dir, 'b', valid);
    await writeAnswer(dir, 'a', valid);
    expect(await listAnswerRequests(dir)).toEqual(['a', 'b']);
    expect(await readAnswerRequest(dir, 'a')).toEqual(valid);
  });

  it('skips invalid and half-written files without throwing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'answers-'));
    await writeAnswer(dir, 'ok', valid);
    await writeAnswer(dir, 'empty-answer', { ...valid, answer: '' });
    await writeAnswer(dir, 'bad-version', { ...valid, version: 2 });
    await writeAnswer(dir, 'half', '{"version":1,"answeredAt":"');
    expect(await listAnswerRequests(dir)).toEqual(['ok']);
    expect(await readAnswerRequest(dir, 'empty-answer')).toBeUndefined();
    expect(await readAnswerRequest(dir, 'half')).toBeUndefined();
    expect(await readAnswerRequest(dir, 'missing')).toBeUndefined();
  });

  it('returns nothing for a missing registry dir', async () => {
    expect(await listAnswerRequests(join(tmpdir(), 'does-not-exist-fractory-answers'))).toEqual([]);
  });

  it('never appear as Runs in the registry', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'answers-'));
    const registry = new RunRegistry(dir);
    await registry.write({
      version: RUN_RECORD_VERSION,
      id: 'r1',
      key: 'github:me/repo#1:ticket-ready',
      ticketRef: 'github:me/repo#1',
      repoPath: '/repo',
      trigger: { kind: 'ticket-ready' },
      status: 'needs-human',
      branch: 'fractory/1',
      logPath: '/logs/r1.log',
      createdAt: now,
      updatedAt: now,
    });
    await writeAnswer(dir, 'r1', valid);
    expect((await registry.list()).map((r) => r.id)).toEqual(['r1']);
  });
});
