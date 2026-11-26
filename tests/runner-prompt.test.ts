import { describe, expect, it } from 'vitest';
import type { Ticket } from '../src/contracts/ticket.ts';
import {
  BASE_AGENT_ENV,
  buildPrompt,
  formatReviewComment,
  parseRunResult,
  truncateTail,
} from '../src/runner/prompt.ts';

const ticket: Ticket = {
  ref: 'github:me/repo#1',
  title: 'Add a thing',
  body: 'Do the thing.',
  url: 'https://github.com/me/repo/issues/1',
  status: 'ready',
  updatedAt: new Date().toISOString(),
  blockedBy: [],
  relationErrors: [],
};

describe('buildPrompt', () => {
  it('puts the rules, the Ticket and the output contract in order', () => {
    const prompt = buildPrompt({ rules: 'RULES', ticket });
    expect(prompt.indexOf('RULES')).toBeLessThan(prompt.indexOf('Add a thing'));
    expect(prompt.indexOf('Add a thing')).toBeLessThan(prompt.indexOf('<result>'));
  });

  it('adds the CI log tail for a ci-failed follow-up', () => {
    const log = `${'x'.repeat(30_000)}BOOM`;
    const prompt = buildPrompt({
      rules: 'R',
      ticket,
      followUp: { kind: 'ci-failed', prNumber: 7, log },
    });
    expect(prompt).toContain('PR #7');
    expect(prompt).toContain('BOOM');
    expect(prompt).toContain('truncated');
    expect(truncateTail('short')).toBe('short');
  });

  it('adds the review comment, or says it is missing', () => {
    const withComment = buildPrompt({
      rules: 'R',
      ticket,
      followUp: { kind: 'review-comment', prNumber: 7, comment: 'rename this' },
    });
    expect(withComment).toContain('rename this');
    const without = buildPrompt({
      rules: 'R',
      ticket,
      followUp: { kind: 'review-comment', prNumber: 7, comment: undefined },
    });
    expect(without).toContain('could not be fetched');
  });
});

describe('parseRunResult', () => {
  it('takes the last valid block, also inside a code fence', () => {
    const out = `<result>{"outcome":"failed","summary":"x"}</result>\n<result>\n\`\`\`json\n{"outcome":"done","summary":"ok"}\n\`\`\`\n</result>`;
    expect(parseRunResult(out)).toEqual({ outcome: 'done', summary: 'ok' });
  });

  it('ignores an opening tag the agent mentions in prose before the real block', () => {
    const out = [
      'I did not check the `<result>` contract against the old parser.',
      'Summary: the final output is a <result> block with the RunResult JSON.',
      '<result>{"outcome":"done","summary":"327 tests pass"}</result>',
      '<promise>COMPLETE</promise>',
    ].join('\n');
    expect(parseRunResult(out)).toEqual({ outcome: 'done', summary: '327 tests pass' });
  });

  it('takes the last valid block when several are printed, skipping a later malformed one', () => {
    const out = [
      '<result>{"outcome":"failed","summary":"first"}</result>',
      '<result>{"outcome":"done","summary":"second"}</result>',
      'then a stray <result> and a broken <result>{"outcome":</result>',
    ].join('\n');
    expect(parseRunResult(out)).toEqual({ outcome: 'done', summary: 'second' });
  });

  it('ignores a closing tag the agent mentions in prose after the real block', () => {
    const out =
      '<result>{"outcome":"done","summary":"ok"}</result>\nThe block ends with </result>.';
    expect(parseRunResult(out)).toEqual({ outcome: 'done', summary: 'ok' });
  });

  it('returns undefined when only tags in prose or a malformed block are printed', () => {
    expect(parseRunResult('I will print a <result> block at the end.')).toBeUndefined();
    expect(
      parseRunResult('mention <result> then <result>{"outcome":"done"}</result>'),
    ).toBeUndefined();
  });

  it('returns undefined for missing, malformed or schema-invalid output', () => {
    expect(parseRunResult('nothing')).toBeUndefined();
    expect(parseRunResult('<result>not json</result>')).toBeUndefined();
    expect(
      parseRunResult('<result>{"outcome":"needs-human","reason":"bored","question":"?"}</result>'),
    ).toBeUndefined();
  });
});

describe('formatReviewComment', () => {
  it('formats a gh comment and rejects garbage', () => {
    expect(formatReviewComment('{"body":"fix","path":"a.ts"}')).toContain('File: a.ts');
    expect(formatReviewComment('{}')).toBeUndefined();
  });
});

describe('BASE_AGENT_ENV', () => {
  it('only disables auto memory: credentials never come from the host env', () => {
    expect(BASE_AGENT_ENV).toEqual({ CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' });
  });
});
