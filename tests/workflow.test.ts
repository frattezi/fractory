import { describe, expect, it } from 'vitest';
import { describeWorkflow, formatWorkflow, mayAutoMerge } from '../src/policy/workflow.ts';
import { personalRepo, workRepo } from './trigger-helpers.ts';

const ready = {
  config: personalRepo,
  checks: 'passing',
  mergeable: 'MERGEABLE',
  baseBranch: 'main',
  latestRunStatus: 'done',
} as const;

describe('mayAutoMerge', () => {
  it('Personal Mode merges with passing checks or no CI at all', () => {
    expect(mayAutoMerge(ready)).toBe(true);
    expect(mayAutoMerge({ ...ready, checks: 'none' })).toBe(true);
    expect(
      mayAutoMerge({ ...ready, config: { ...personalRepo, hasCi: false }, checks: 'none' }),
    ).toBe(true);
  });

  it('never merges while checks are pending or failing', () => {
    expect(mayAutoMerge({ ...ready, checks: 'pending' })).toBe(false);
    expect(mayAutoMerge({ ...ready, checks: 'failing' })).toBe(false);
  });

  it('Work Mode never merges', () => {
    expect(mayAutoMerge({ ...ready, config: workRepo })).toBe(false);
    expect(mayAutoMerge({ ...ready, config: workRepo, checks: 'none' })).toBe(false);
  });

  it('never merges a conflicting or unknown PR, or a Run that is not done', () => {
    expect(mayAutoMerge({ ...ready, mergeable: 'CONFLICTING' })).toBe(false);
    expect(mayAutoMerge({ ...ready, mergeable: 'UNKNOWN' })).toBe(false);
    for (const latestRunStatus of ['queued', 'running', 'failed', 'needs-human'] as const) {
      expect(mayAutoMerge({ ...ready, latestRunStatus })).toBe(false);
    }
  });

  it('merges only a PR based on the repository base branch', () => {
    const develop = { ...personalRepo, baseBranch: 'develop' };
    expect(mayAutoMerge({ ...ready, config: develop, baseBranch: 'develop' })).toBe(true);
    expect(mayAutoMerge({ ...ready, config: develop, baseBranch: 'main' })).toBe(false);
    for (const checks of ['passing', 'none'] as const) {
      expect(mayAutoMerge({ ...ready, checks, baseBranch: 'fractory/1-blocker' })).toBe(false);
      expect(mayAutoMerge({ ...ready, checks, baseBranch: '' })).toBe(false);
    }
  });
});

describe('describeWorkflow', () => {
  const byId = (d: ReturnType<typeof describeWorkflow>, id: string) =>
    d.rules.find((r) => r.id === id);

  it('describes Personal Mode: no PR Gate, auto-merge, both agents', () => {
    const d = describeWorkflow(personalRepo, { maxConcurrentRuns: 3 });
    expect(byId(d, 'spec-gate')?.value).toBe('on');
    expect(byId(d, 'ticket-gate')?.value).toBe('off');
    expect(byId(d, 'pr-gate')?.value).toBe('off');
    expect(byId(d, 'auto-merge')?.value).toBe('on');
    expect(byId(d, 'agents')?.value).toBe('claude, opencode');
    expect(byId(d, 'account')?.value).toBe('personal');
    expect(byId(d, 'concurrency')?.value).toBe('3');
  });

  it('describes Work Mode: both Gates on, never auto-merges, Claude on the work account', () => {
    const d = describeWorkflow(workRepo);
    expect(byId(d, 'ticket-gate')?.value).toBe('on');
    expect(byId(d, 'pr-gate')?.value).toBe('on');
    expect(byId(d, 'auto-merge')?.value).toBe('never');
    expect(d.agents).toEqual(['claude']);
    expect(d.account).toBe('work');
    expect(byId(d, 'concurrency')).toBeUndefined();
  });

  it('explains the Ticket Gate opt-in and renders readable text', () => {
    const d = describeWorkflow({ ...personalRepo, ticketGate: true });
    expect(byId(d, 'ticket-gate')?.why).toMatch(/ticketGate/);
    expect(formatWorkflow(d)).toContain('Max iterations');
  });
});
