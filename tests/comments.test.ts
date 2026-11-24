import { writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { RunCommentsFileSchema, commentsFilePath } from '../src/contracts/run.ts';
import { tick } from '../src/trigger/tick.ts';
import {
  type Harness,
  PR_URL,
  makeHarness,
  makePr,
  makeRun,
  makeTicket,
} from './trigger-helpers.ts';

const comment = (id: string, minute: number) => ({
  id,
  path: `src/${id}.ts`,
  line: minute,
  body: `fix ${id}`,
  createdAt: `2026-06-01T10:0${minute}:00.000Z`,
});

const seed = async (h: Harness, comments: unknown) => {
  h.source.tickets.set('github:me/app#1', makeTicket(1, 'in_review'));
  h.gh.prs.set(PR_URL, makePr());
  await h.registry.write(makeRun({ id: 'r1', prUrl: PR_URL }));
  await writeFile(commentsFilePath(h.factory.registryDir, 'r1'), JSON.stringify(comments));
};

describe('Agent Manager review comments', () => {
  it('queues one batched review-comment Run keyed by the newest comment, on the Run branch', async () => {
    const h = await makeHarness();
    await seed(h, { version: 1, comments: [comment('c1', 1), comment('c2', 2)] });
    await tick(h.deps);
    const follow = (await h.registry.list()).filter((r) => r.id !== 'r1');
    expect(follow).toHaveLength(1);
    expect(follow[0]).toMatchObject({
      key: 'github:me/app#1:review-comment:am:c2',
      trigger: { kind: 'review-comment', prNumber: 7, commentId: 'am:c2' },
      branch: 'fractory/1-add-thing-1',
    });
    expect(h.launched).toHaveLength(1);
  });

  it('is idempotent across ticks and picks up only newer comments afterwards', async () => {
    const h = await makeHarness();
    await seed(h, { version: 1, comments: [comment('c1', 1)] });
    await tick(h.deps);
    const [queued] = (await h.registry.list()).filter((r) => r.id !== 'r1');
    await h.registry.update(queued?.id ?? '', { status: 'done' });
    await tick(h.deps);
    expect(await h.registry.list()).toHaveLength(2);

    await writeFile(
      commentsFilePath(h.factory.registryDir, 'r1'),
      JSON.stringify({ version: 1, comments: [comment('c1', 1), comment('c2', 2)] }),
    );
    await tick(h.deps);
    const keys = (await h.registry.list()).map((r) => r.key);
    expect(keys).toContain('github:me/app#1:review-comment:am:c2');
    expect(keys).toHaveLength(3);
  });

  it('waits while a Run on the Ticket is active', async () => {
    const h = await makeHarness();
    await seed(h, { version: 1, comments: [comment('c1', 1)] });
    await h.registry.write(
      makeRun({ id: 'r2', status: 'running', pid: 1, createdAt: '2026-06-01T09:00:00.000Z' }),
    );
    await tick(h.deps);
    expect(await h.registry.list()).toHaveLength(2);
  });

  it('logs and skips an invalid comments file', async () => {
    const h = await makeHarness();
    await seed(h, { version: 2, comments: 'nope' });
    const summary = await tick(h.deps);
    expect(await h.registry.list()).toHaveLength(1);
    expect(summary.errors).toBe(0);
    expect(h.log.lines.some((l) => l.includes('invalid comments file for Run r1'))).toBe(true);
  });

  it('does not list a comments file as a Run', async () => {
    const h = await makeHarness();
    await seed(h, { version: 1, comments: [comment('c1', 1)] });
    expect((await h.registry.list()).map((r) => r.id)).toEqual(['r1']);
  });

  it('validates the file shape', () => {
    expect(
      RunCommentsFileSchema.safeParse({ version: 1, comments: [comment('c1', 1)] }).success,
    ).toBe(true);
    expect(RunCommentsFileSchema.safeParse({ version: 1, comments: [{ id: 'x' }] }).success).toBe(
      false,
    );
  });
});
