import { z } from 'zod';
import type { TicketSourceConfig } from '../contracts/repo-config.ts';
import {
  type Ticket,
  type TicketRef,
  TicketSchema,
  type TicketSource,
  type TicketStatus,
} from '../contracts/ticket.ts';
import { assertOutboundAllowed } from '../policy/outbound.ts';
import { parseRelations, renderRelations } from './relations.ts';
import {
  type AdapterOptions,
  type CreatedTicket,
  type NewTicket,
  RetryableError,
  defaultExec,
  defaultSleep,
  withRetry,
} from './shared.ts';

type GithubConfig = Extract<TicketSourceConfig, { kind: 'github' }>;

const LABELS = {
  ready: 'fractory:ready',
  in_progress: 'fractory:in-progress',
  in_review: 'fractory:in-review',
} as const;
const ALL_LABELS: string[] = Object.values(LABELS);
const LABEL_COLOR = '0E8A16';

const GhIssueSchema = z.object({
  number: z.number().int(),
  title: z.string(),
  body: z
    .string()
    .nullable()
    .transform((value) => value ?? ''),
  url: z.string().url(),
  state: z.string().transform((value) => value.toUpperCase()),
  labels: z.array(z.object({ name: z.string() })),
  updatedAt: z.string().datetime(),
});
type GhIssue = z.infer<typeof GhIssueSchema>;

const JSON_FIELDS = 'number,title,body,url,state,labels,updatedAt';

const statusOf = (issue: GhIssue): TicketStatus => {
  if (issue.state === 'CLOSED') return 'done';
  const names = new Set(issue.labels.map((label) => label.name));
  if (names.has(LABELS.in_review)) return 'in_review';
  if (names.has(LABELS.in_progress)) return 'in_progress';
  if (names.has(LABELS.ready)) return 'ready';
  return 'backlog';
};

const RETRYABLE_GH_ERROR = /rate limit|abuse detection|HTTP (429|5\d\d)\b/i;

export const createGithubAdapter = (config: GithubConfig, options: AdapterOptions = {}) => {
  const exec = options.exec ?? defaultExec;
  const sleep = options.sleep ?? defaultSleep;
  const mode = options.mode ?? 'personal';

  const gh = (args: string[]): Promise<string> =>
    withRetry(
      sleep,
      (error) =>
        error instanceof Error && RETRYABLE_GH_ERROR.test(error.message)
          ? new RetryableError(error.message)
          : undefined,
      () => exec('gh', args),
    );

  const numberOf = (ref: TicketRef): number => {
    const match = ref.match(/^github:([\w.-]+\/[\w.-]+)#(\d+)$/);
    if (!match) throw new Error(`Not a GitHub ticket ref: ${ref}`);
    if (match[1] !== config.repo) {
      throw new Error(`Ticket ${ref} belongs to ${match[1]}, this source is ${config.repo}`);
    }
    return Number(match[2]);
  };

  const toTicket = (issue: GhIssue): Ticket => {
    const ref: TicketRef = `github:${config.repo}#${issue.number}`;
    const { errors, ...relations } = parseRelations(issue.body, ref);
    return TicketSchema.parse({
      ref,
      title: issue.title,
      body: issue.body,
      url: issue.url,
      status: statusOf(issue),
      updatedAt: issue.updatedAt,
      ...relations,
      relationErrors: errors,
    });
  };

  const parseJson = <T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, stdout: string): T => {
    let raw: unknown;
    try {
      raw = JSON.parse(stdout);
    } catch {
      throw new Error('gh returned output that is not JSON');
    }
    return schema.parse(raw);
  };

  const view = async (number: number): Promise<GhIssue> =>
    parseJson(
      GhIssueSchema,
      await gh(['issue', 'view', String(number), '--repo', config.repo, '--json', JSON_FIELDS]),
    );

  let labelsReady: Promise<void> | undefined;
  const ensureLabels = (): Promise<void> => {
    labelsReady ??= (async () => {
      for (const name of ALL_LABELS) {
        await gh([
          'label',
          'create',
          name,
          '--force',
          '--color',
          LABEL_COLOR,
          '--description',
          'Ticket status',
          '--repo',
          config.repo,
        ]);
      }
    })().catch((error) => {
      labelsReady = undefined;
      throw error;
    });
    return labelsReady;
  };

  const source: TicketSource = {
    async listReady() {
      const stdout = await gh([
        'issue',
        'list',
        '--repo',
        config.repo,
        '--state',
        'open',
        '--label',
        LABELS.ready,
        '--limit',
        '100',
        '--json',
        JSON_FIELDS,
      ]);
      return parseJson(z.array(GhIssueSchema), stdout).map(toTicket);
    },

    async get(ref) {
      return toTicket(await view(numberOf(ref)));
    },

    async setStatus(ref, status) {
      const number = numberOf(ref);
      await ensureLabels();
      const issue = await view(number);
      const present = issue.labels
        .map((label) => label.name)
        .filter((name) => ALL_LABELS.includes(name));
      const target =
        status === 'ready' || status === 'in_progress' || status === 'in_review'
          ? LABELS[status]
          : undefined;
      const remove = present.filter((name) => name !== target);
      const add = target && !present.includes(target) ? [target] : [];

      if (status !== 'done' && issue.state === 'CLOSED') {
        await gh(['issue', 'reopen', String(number), '--repo', config.repo]);
      }
      if (add.length > 0 || remove.length > 0) {
        const args = ['issue', 'edit', String(number), '--repo', config.repo];
        if (add.length > 0) args.push('--add-label', add.join(','));
        if (remove.length > 0) args.push('--remove-label', remove.join(','));
        await gh(args);
      }
      if (status === 'done' && issue.state !== 'CLOSED') {
        await gh(['issue', 'close', String(number), '--repo', config.repo]);
      }
    },

    async comment(ref, body) {
      assertOutboundAllowed(body, mode);
      await gh(['issue', 'comment', String(numberOf(ref)), '--repo', config.repo, '--body', body]);
    },
  };

  const create = async (input: NewTicket): Promise<CreatedTicket> => {
    const body = renderRelations(input.body, {
      blockedBy: input.blockedBy ?? [],
      parent: input.parent,
    });
    assertOutboundAllowed(input.title, mode);
    assertOutboundAllowed(body, mode);
    const args = ['issue', 'create', '--repo', config.repo, '--title', input.title, '--body', body];
    if (input.status === 'ready') {
      await ensureLabels();
      args.push('--label', LABELS.ready);
    }
    const url = (await gh(args)).trim().split('\n').pop() ?? '';
    const match = url.match(/\/issues\/(\d+)$/);
    if (!match)
      throw new Error(`gh issue create did not return an issue URL: ${url.slice(0, 200)}`);
    return { ref: `github:${config.repo}#${match[1]}`, url: url.trim() };
  };

  return { source, create };
};
