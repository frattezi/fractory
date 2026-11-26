import { z } from 'zod';
import { type Exec, defaultExec } from './exec.ts';

const AuthorSchema = z.object({ login: z.string().nullish() }).nullish();

const CheckSchema = z.object({
  status: z.string().nullish(),
  conclusion: z.string().nullish(),
  /** StatusContext entries (legacy commit statuses) use `state` instead. */
  state: z.string().nullish(),
});

export const PrViewSchema = z.object({
  number: z.number().int(),
  state: z.enum(['OPEN', 'MERGED', 'CLOSED']),
  mergeable: z.string().default('UNKNOWN'),
  /** The branch the PR merges into. */
  baseRefName: z.string(),
  headRefOid: z.string(),
  statusCheckRollup: z
    .array(CheckSchema)
    .nullish()
    .transform((v) => v ?? []),
  reviews: z
    .array(
      z.object({
        id: z.string(),
        author: AuthorSchema,
        body: z.string().nullish(),
        state: z.string().nullish(),
      }),
    )
    .default([]),
  comments: z
    .array(z.object({ id: z.string(), author: AuthorSchema, body: z.string().nullish() }))
    .default([]),
});
export type PrView = z.infer<typeof PrViewSchema>;

export type ChecksSummary = 'none' | 'pending' | 'passing' | 'failing';

const PASSING = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
const FAILING = new Set([
  'FAILURE',
  'ERROR',
  'TIMED_OUT',
  'CANCELLED',
  'ACTION_REQUIRED',
  'STARTUP_FAILURE',
]);

/** `failing` wins over `pending`: a red check on the head sha is actionable now. */
export const summarizeChecks = (checks: PrView['statusCheckRollup']): ChecksSummary => {
  if (checks.length === 0) return 'none';
  let pending = false;
  for (const check of checks) {
    const verdict = (check.conclusion || check.state || '').toUpperCase();
    const completed = !check.status || check.status.toUpperCase() === 'COMPLETED';
    if (FAILING.has(verdict)) return 'failing';
    if (!completed || !PASSING.has(verdict)) pending = true;
  }
  return pending ? 'pending' : 'passing';
};

export interface ReviewFeedback {
  id: string;
  author: string | undefined;
}

/** Review bodies and PR comments a human wrote, oldest first. Plain approvals are not feedback. */
export const feedbackItems = (pr: PrView): ReviewFeedback[] => {
  const reviews = pr.reviews
    .filter((r) => {
      const state = (r.state ?? '').toUpperCase();
      if (state === 'CHANGES_REQUESTED') return true;
      return state === 'COMMENTED' && (r.body ?? '').trim() !== '';
    })
    .map((r) => ({ id: r.id, author: r.author?.login ?? undefined }));
  const comments = pr.comments
    .filter((c) => (c.body ?? '').trim() !== '')
    .map((c) => ({ id: c.id, author: c.author?.login ?? undefined }));
  return [...reviews, ...comments];
};

export interface Gh {
  viewPr(cwd: string, pr: string): Promise<PrView>;
  mergeSquash(cwd: string, pr: string): Promise<void>;
  /** Login of the gh-authenticated user, i.e. the author of the factory's own comments. */
  currentUser(): Promise<string>;
}

export const createGh = (exec: Exec = defaultExec): Gh => ({
  async viewPr(cwd, pr) {
    const stdout = await exec(
      'gh',
      [
        'pr',
        'view',
        pr,
        '--json',
        'number,state,mergeable,baseRefName,statusCheckRollup,reviews,comments,headRefOid',
      ],
      { cwd },
    );
    return PrViewSchema.parse(JSON.parse(stdout));
  },
  async mergeSquash(cwd, pr) {
    await exec('gh', ['pr', 'merge', pr, '--squash'], { cwd });
  },
  async currentUser() {
    const stdout = await exec('gh', ['api', 'user', '--jq', '.login']);
    const login = stdout.trim();
    if (!login) throw new Error('gh api user returned no login');
    return login;
  },
});
