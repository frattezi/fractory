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
