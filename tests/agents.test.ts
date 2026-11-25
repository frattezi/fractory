import { describe, expect, it } from 'vitest';
import {
  AgentNotAllowedError,
  accountFor,
  allowedAgents,
  profileFor,
  profileLabel,
} from '../src/contracts/agents.ts';

describe('agent profiles', () => {
  it('Work Mode runs Claude on the work account only', () => {
    expect(accountFor('work')).toBe('work');
    expect(allowedAgents('work')).toEqual(['claude']);
    expect(profileLabel(profileFor('claude', 'work'))).toBe('claude@work');
    expect(() => profileFor('opencode', 'work')).toThrow(AgentNotAllowedError);
  });

  it('Personal Mode runs Claude or OpenCode on the personal account', () => {
    expect(profileLabel(profileFor('claude', 'personal'))).toBe('claude@personal');
    expect(profileLabel(profileFor('opencode', 'personal'))).toBe('opencode@personal');
  });
});
