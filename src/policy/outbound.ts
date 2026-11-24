import type { Mode } from '../contracts/repo-config.ts';

/**
 * In Work Mode nothing Fractory sends to shared systems (tracker comments, PR titles and
 * bodies, commit messages) may mention the AI setup: it must read as written by a developer.
 */
const WORK_MODE_FORBIDDEN = [
  /\bfractory\b/i,
  /\bsandcastle\b/i,
  /\bagent[- ]manager\b/i,
  /\bclaude\b/i,
  /\banthropic\b/i,
  /\bco-authored-by:\s*claude/i,
  /\bgenerated with\b/i,
  /\b(ai|llm|coding)[- ]agents?\b/i,
  /\bai[- ](generated|assisted|memory)\b/i,
  /🤖/u,
];

export class OutboundPolicyError extends Error {
  constructor(readonly matches: string[]) {
    super(`Work Mode outbound text mentions the AI setup: ${matches.join(', ')}`);
  }
}

export const forbiddenMatches = (text: string): string[] =>
  WORK_MODE_FORBIDDEN.flatMap((pattern) => {
    const match = text.match(pattern);
    return match ? [match[0]] : [];
  });

/** Throws rather than silently rewriting: a blocked message is a bug to fix, not to hide. */
export const assertOutboundAllowed = (text: string, mode: Mode): void => {
  if (mode !== 'work') return;
  const matches = forbiddenMatches(text);
  if (matches.length > 0) throw new OutboundPolicyError(matches);
};
