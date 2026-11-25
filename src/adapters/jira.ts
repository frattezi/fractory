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
import {
  type AdapterOptions,
  type CreatedTicket,
  type NewTicket,
  RetryableError,
  bodyWithRelations,
  defaultSleep,
  withRetry,
} from './shared.ts';

type JiraConfig = Extract<TicketSourceConfig, { kind: 'jira' }>;

export interface AdfNode {
  type: string;
  text?: string | undefined;
  attrs?: Record<string, unknown> | undefined;
  content?: AdfNode[] | undefined;
}
const AdfNodeSchema: z.ZodType<AdfNode> = z.lazy(() =>
  z
    .object({
      type: z.string(),
      text: z.string().optional(),
      attrs: z.record(z.unknown()).optional(),
      content: z.array(AdfNodeSchema).optional(),
    })
    .passthrough(),
);

/** Flattens Atlassian Document Format to plain text: blocks separated by blank lines, lists as `- `. */
export const flattenAdf = (node: AdfNode): string => {
  const children = (separator: string): string =>
    (node.content ?? []).map(flattenAdf).filter(Boolean).join(separator);
  switch (node.type) {
    case 'text':
      return node.text ?? '';
    case 'hardBreak':
      return '\n';
    case 'mention':
      return String(node.attrs?.text ?? '');
    case 'inlineCard':
      return String(node.attrs?.url ?? '');
    case 'emoji':
      return String(node.attrs?.text ?? node.attrs?.shortName ?? '');
    case 'bulletList':
    case 'orderedList':
      return (node.content ?? [])
        .map((item, index) => {
          const marker = node.type === 'orderedList' ? `${index + 1}.` : '-';
          return `${marker} ${flattenAdf(item).replace(/\n/g, '\n  ')}`;
        })
        .join('\n');
    case 'listItem':
      return children('\n');
    case 'paragraph':
    case 'heading':
    case 'codeBlock':
      return (node.content ?? []).map(flattenAdf).join('');
    default:
      return children('\n\n');
  }
};

const toAdf = (text: string) => ({
  type: 'doc',
  version: 1,
  content: text.split(/\n{2,}/).map((paragraph) => ({
    type: 'paragraph',
    content: paragraph
      .split('\n')
      .flatMap((line, index) => [
        ...(index > 0 ? [{ type: 'hardBreak' }] : []),
        ...(line ? [{ type: 'text', text: line }] : []),
      ]),
  })),
});

const JiraIssueSchema = z.object({
  key: z.string(),
  fields: z.object({
    summary: z.string(),
    description: z.union([AdfNodeSchema, z.string()]).nullish(),
    status: z.object({ name: z.string() }),
    updated: z.string(),
  }),
});
type JiraIssue = z.infer<typeof JiraIssueSchema>;

const SearchSchema = z.object({ issues: z.array(JiraIssueSchema) });
const TransitionsSchema = z.object({
  transitions: z.array(
    z.object({ id: z.string(), name: z.string(), to: z.object({ name: z.string() }) }),
  ),
});
const CreatedSchema = z.object({ key: z.string() });

const FIELDS = ['summary', 'description', 'status', 'updated'];
const sameName = (a: string, b: string): boolean =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

/** Jira sends `+0000`; zod's datetime wants `Z`. */
const normalizeTimestamp = (value: string): string => {
  const date = new Date(value.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
};

export const createJiraAdapter = (config: JiraConfig, options: AdapterOptions = {}) => {
  const { mode } = options;
  if (!mode) throw new Error('The Jira adapter requires an explicit mode (work or personal)');
  const env = options.env ?? process.env;
  const email = env.JIRA_EMAIL;
  const token = env.JIRA_API_TOKEN;
  if (!email || !token) {
    throw new Error('JIRA_EMAIL and JIRA_API_TOKEN must be set in the environment to use Jira');
  }
  const authorization = `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`;
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const baseUrl = config.baseUrl.replace(/\/+$/, '');

  const request = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const response = await withRetry(
      sleep,
      (error) => (error instanceof RetryableError ? error : undefined),
      async () => {
        let res: Response;
        try {
          res = await doFetch(`${baseUrl}${path}`, {
            method,
            headers: {
              Authorization: authorization,
              Accept: 'application/json',
              ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          });
        } catch (error) {
          throw new RetryableError(
            `Jira ${method} ${path} network error: ${(error as Error).message}`,
          );
        }
        if (res.status === 429 || res.status >= 500) {
          const seconds = Number(res.headers.get('retry-after'));
          throw new RetryableError(
            `Jira ${method} ${path} failed: ${res.status}`,
            Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 60) * 1000 : undefined,
          );
        }
        return res;
      },
    );
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 300);
      throw new Error(`Jira ${method} ${path} failed: ${response.status} ${detail}`.trim());
    }
    const text = response.status === 204 ? '' : await response.text();
    return text ? JSON.parse(text) : undefined;
  };

  const statusOf = (name: string): TicketStatus => {
    const { statuses } = config;
    if (sameName(name, statuses.ready)) return 'ready';
    if (sameName(name, statuses.inProgress)) return 'in_progress';
    if (sameName(name, statuses.inReview)) return 'in_review';
    if (sameName(name, statuses.done)) return 'done';
    return 'backlog';
  };

  const toTicket = (issue: JiraIssue): Ticket => {
    const { description } = issue.fields;
    return TicketSchema.parse({
      ref: `jira:${issue.key}`,
      title: issue.fields.summary,
      body: !description
        ? ''
        : typeof description === 'string'
          ? description
          : flattenAdf(description),
      url: `${baseUrl}/browse/${issue.key}`,
      status: statusOf(issue.fields.status.name),
      updatedAt: normalizeTimestamp(issue.fields.updated),
    });
  };

  const keyOf = (ref: TicketRef): string => {
    const match = ref.match(/^jira:([A-Z][A-Z0-9]+-\d+)$/);
    if (!match?.[1]) throw new Error(`Not a Jira ticket ref: ${ref}`);
    return match[1];
  };

  const fetchIssue = async (key: string): Promise<JiraIssue> =>
    JiraIssueSchema.parse(
      await request('GET', `/rest/api/3/issue/${key}?fields=${FIELDS.join(',')}`),
    );

  const targetName = (status: TicketStatus): string => {
    switch (status) {
      case 'ready':
        return config.statuses.ready;
      case 'in_progress':
        return config.statuses.inProgress;
      case 'in_review':
        return config.statuses.inReview;
      case 'done':
        return config.statuses.done;
      case 'backlog':
        throw new Error('Jira statuses have no mapping for backlog');
    }
  };

  const source: TicketSource = {
    async listReady() {
      const status = config.statuses.ready.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const data = await request('POST', '/rest/api/3/search/jql', {
        jql: `project = ${config.projectKey} AND status = "${status}"`,
        fields: FIELDS,
        maxResults: 100,
      });
      return SearchSchema.parse(data).issues.map(toTicket);
    },

    async get(ref) {
      return toTicket(await fetchIssue(keyOf(ref)));
    },

    async setStatus(ref, status) {
      const key = keyOf(ref);
      const target = targetName(status);
      const current = await fetchIssue(key);
      if (sameName(current.fields.status.name, target)) return;
      const { transitions } = TransitionsSchema.parse(
        await request('GET', `/rest/api/3/issue/${key}/transitions`),
      );
      const transition = transitions.find((candidate) => sameName(candidate.to.name, target));
      if (!transition) {
        const available = transitions.map((candidate) => candidate.to.name).join(', ') || 'none';
        throw new Error(`${key} has no transition to "${target}" (available: ${available})`);
      }
      await request('POST', `/rest/api/3/issue/${key}/transitions`, {
        transition: { id: transition.id },
      });
    },

    async comment(ref, body) {
      assertOutboundAllowed(body, mode);
      await request('POST', `/rest/api/3/issue/${keyOf(ref)}/comment`, { body: toAdf(body) });
    },
  };

  const create = async (input: NewTicket): Promise<CreatedTicket> => {
    const body = bodyWithRelations(input, (ref) => ref.replace(/^(jira|github):/, ''));
    assertOutboundAllowed(input.title, mode);
    assertOutboundAllowed(body, mode);
    const created = CreatedSchema.parse(
      await request('POST', '/rest/api/3/issue', {
        fields: {
          project: { key: config.projectKey },
          summary: input.title,
          description: toAdf(body),
          issuetype: { name: options.jiraIssueType ?? 'Task' },
        },
      }),
    );
    const ref = `jira:${created.key}` as TicketRef;
    if (input.status === 'ready') await source.setStatus(ref, 'ready');
    return { ref, url: `${baseUrl}/browse/${created.key}` };
  };

  return { source, create };
};
