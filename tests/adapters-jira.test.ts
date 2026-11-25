import { describe, expect, it, vi } from 'vitest';
import { createTicket, createTicketSource, flattenAdf } from '../src/adapters/index.ts';
import type { FetchFn } from '../src/adapters/index.ts';
import { OutboundPolicyError } from '../src/policy/outbound.ts';

const config = {
  kind: 'jira',
  baseUrl: 'https://acme.atlassian.net/',
  projectKey: 'ABC',
  statuses: {
    ready: 'Ready for Dev',
    inProgress: 'In Progress',
    inReview: 'In Review',
    done: 'Done',
  },
} as const;
const env = { JIRA_EMAIL: 'me@acme.com', JIRA_API_TOKEN: 's3cret' };
const ref = 'jira:ABC-12' as const;

const doc = (...content: unknown[]) => ({ type: 'doc', version: 1, content });
const para = (...content: unknown[]) => ({ type: 'paragraph', content });
const text = (value: string) => ({ type: 'text', text: value });

const jiraIssue = (over: { status?: string; description?: unknown; updated?: string } = {}) => ({
  key: 'ABC-12',
  fields: {
    summary: 'Add login',
    description: over.description === undefined ? doc(para(text('Hello'))) : over.description,
    status: { name: over.status ?? 'Ready for Dev' },
    updated: over.updated ?? '2026-01-02T03:04:05.000+0000',
  },
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Call {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

const fakeFetch = (respond: (call: Call) => Response) => {
  const calls: Call[] = [];
  const impl: FetchFn = async (input, init) => {
    const url = new URL(String(input));
    const call: Call = {
      method: init?.method ?? 'GET',
      path: url.pathname + url.search,
      headers: init?.headers as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    return respond(call);
  };
  return { fetch: impl, calls };
};

const sleep = async () => {};
const source = (f: FetchFn, extra = {}) =>
  createTicketSource(config, { fetch: f, sleep, env, mode: 'personal', ...extra });

describe('jira adapter', () => {
  it('requires an explicit mode and credentials', () => {
    expect(() => createTicketSource(config, { env })).toThrow('explicit mode');
    expect(() => createTicketSource(config, { mode: 'work', env: {} })).toThrow('JIRA_EMAIL');
    expect(() =>
      createTicketSource(config, { mode: 'work', env: { JIRA_EMAIL: 'a@b.c' } }),
    ).toThrow('JIRA_API_TOKEN');
  });

  it('sends Basic auth and never leaks the token into errors', async () => {
    const { fetch, calls } = fakeFetch(() => new Response('nope', { status: 401 }));
    const error = await source(fetch)
      .get(ref)
      .catch((e: Error) => e);
    expect((error as Error).message).toContain('401');
    expect((error as Error).message).not.toContain('s3cret');
    const expected = `Basic ${Buffer.from('me@acme.com:s3cret').toString('base64')}`;
    expect(calls[0]?.headers.Authorization).toBe(expected);
  });

  it('maps Jira statuses to ticket statuses and normalizes the timestamp', async () => {
    const cases: [string, string][] = [
      ['Ready for Dev', 'ready'],
      ['in progress', 'in_progress'],
      ['In Review', 'in_review'],
      ['Done', 'done'],
      ['Backlog', 'backlog'],
    ];
    for (const [name, expected] of cases) {
      const { fetch } = fakeFetch(() => json(jiraIssue({ status: name })));
      const ticket = await source(fetch).get(ref);
      expect(ticket.status).toBe(expected);
      expect(ticket.updatedAt).toBe('2026-01-02T03:04:05.000Z');
      expect(ticket.url).toBe('https://acme.atlassian.net/browse/ABC-12');
    }
  });

  it('lists ready tickets with JQL', async () => {
    const { fetch, calls } = fakeFetch(() => json({ issues: [jiraIssue()] }));
    const tickets = await source(fetch).listReady();
    expect(tickets.map((t) => t.ref)).toEqual([ref]);
    expect(calls[0]?.method).toBe('POST');
    expect((calls[0]?.body as { jql: string }).jql).toBe(
      'project = ABC AND status = "Ready for Dev"',
    );
  });

  it('applies the transition whose target matches', async () => {
    const { fetch, calls } = fakeFetch((call) => {
      if (call.path.includes('/transitions') && call.method === 'GET') {
        return json({
          transitions: [
            { id: '11', name: 'Start', to: { name: 'In Progress' } },
            { id: '21', name: 'Send to review', to: { name: 'In Review' } },
          ],
        });
      }
      if (call.method === 'POST') return new Response(null, { status: 204 });
      return json(jiraIssue());
    });
    await source(fetch).setStatus(ref, 'in_review');
    const post = calls.find((c) => c.method === 'POST');
    expect(post?.path).toBe('/rest/api/3/issue/ABC-12/transitions');
    expect(post?.body).toEqual({ transition: { id: '21' } });
  });

  it('skips the transition when already in the target status', async () => {
    const { fetch, calls } = fakeFetch(() => json(jiraIssue({ status: 'In Progress' })));
    await source(fetch).setStatus(ref, 'in_progress');
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('fails clearly when no transition reaches the status, and for backlog', async () => {
    const { fetch } = fakeFetch((call) =>
      call.path.includes('/transitions') ? json({ transitions: [] }) : json(jiraIssue()),
    );
    await expect(source(fetch).setStatus(ref, 'done')).rejects.toThrow('no transition to "Done"');
    await expect(source(fetch).setStatus(ref, 'backlog')).rejects.toThrow('backlog');
  });

  it('retries 429 and 5xx with backoff, honoring Retry-After', async () => {
    const wait = vi.fn(async (_ms: number) => {});
    let n = 0;
    const { fetch } = fakeFetch(() => {
      n++;
      if (n === 1) return new Response('', { status: 429, headers: { 'retry-after': '2' } });
      if (n === 2) return new Response('', { status: 503 });
      return json(jiraIssue());
    });
    await source(fetch, { sleep: wait }).get(ref);
    expect(n).toBe(3);
    expect(wait.mock.calls.map((c) => c[0])).toEqual([2000, 1000]);
  });

  it('gives up after 4 attempts and does not retry 4xx', async () => {
    const down = fakeFetch(() => new Response('', { status: 500 }));
    await expect(source(down.fetch).get(ref)).rejects.toThrow('500');
    expect(down.calls).toHaveLength(4);

    const missing = fakeFetch(() => new Response('', { status: 404 }));
    await expect(source(missing.fetch).get(ref)).rejects.toThrow('404');
    expect(missing.calls).toHaveLength(1);
  });

  it('retries network errors', async () => {
    let n = 0;
    const impl: FetchFn = async () => {
      if (++n < 2) throw new TypeError('fetch failed');
      return json(jiraIssue());
    };
    await source(impl).get(ref);
    expect(n).toBe(2);
  });

  it('rejects invalid responses', async () => {
    for (const body of [{ key: 'ABC-12' }, jiraIssue({ description: 42 }), { issues: [{}] }]) {
      const { fetch } = fakeFetch(() => json(body));
      await expect(source(fetch).get(ref)).rejects.toThrow();
      await expect(source(fetch).listReady()).rejects.toThrow();
    }
    const { fetch } = fakeFetch(() => json(jiraIssue({ updated: 'whenever' })));
    await expect(source(fetch).get(ref)).rejects.toThrow();
  });

  it('rejects GitHub refs', async () => {
    const { fetch } = fakeFetch(() => json(jiraIssue()));
    await expect(source(fetch).get('github:a/b#1')).rejects.toThrow('Not a Jira');
  });

  describe('ADF', () => {
    it('flattens paragraphs, breaks, lists, code and mentions to plain text', () => {
      const adf = doc(
        { type: 'heading', attrs: { level: 2 }, content: [text('Goal')] },
        para(
          text('Hello '),
          { type: 'mention', attrs: { text: '@ana' } },
          { type: 'hardBreak' },
          text('bye'),
        ),
        {
          type: 'bulletList',
          content: [
            { type: 'listItem', content: [para(text('one'))] },
            { type: 'listItem', content: [para(text('two'))] },
          ],
        },
        { type: 'orderedList', content: [{ type: 'listItem', content: [para(text('first'))] }] },
        { type: 'codeBlock', content: [text('x = 1')] },
      );
      expect(flattenAdf(adf as Parameters<typeof flattenAdf>[0])).toBe(
        'Goal\n\nHello @ana\nbye\n\n- one\n- two\n\n1. first\n\nx = 1',
      );
    });

    it('turns null and plain-string descriptions into text', async () => {
      const nul = fakeFetch(() => json(jiraIssue({ description: null })));
      expect((await source(nul.fetch).get(ref)).body).toBe('');
      const str = fakeFetch(() => json(jiraIssue({ description: 'plain' })));
      expect((await source(str.fetch).get(ref)).body).toBe('plain');
    });
  });

  describe('outbound policy', () => {
    it('blocks Work Mode comments mentioning the AI setup before any request', async () => {
      const { fetch, calls } = fakeFetch(() => json({}));
      const work = source(fetch, { mode: 'work' });
      await expect(work.comment(ref, 'Implemented with Claude')).rejects.toBeInstanceOf(
        OutboundPolicyError,
      );
      expect(calls).toHaveLength(0);
    });

    it('posts allowed comments as ADF', async () => {
      const { fetch, calls } = fakeFetch(() => json({ id: '1' }, 201));
      await source(fetch, { mode: 'work' }).comment(ref, 'Line one\nLine two');
      expect(calls[0]?.path).toBe('/rest/api/3/issue/ABC-12/comment');
      expect(calls[0]?.body).toEqual({
        body: doc(para(text('Line one'), { type: 'hardBreak' }, text('Line two'))),
      });
    });
  });

  describe('createTicket', () => {
    it('creates the issue, moves it to ready and returns it', async () => {
      const { fetch, calls } = fakeFetch((call) => {
        if (call.method === 'POST' && call.path === '/rest/api/3/issue')
          return json({ key: 'ABC-12' }, 201);
        if (call.path.includes('/transitions') && call.method === 'GET') {
          return json({ transitions: [{ id: '5', name: 'Ready', to: { name: 'Ready for Dev' } }] });
        }
        if (call.method === 'POST') return new Response(null, { status: 204 });
        return json(
          jiraIssue({
            status: call.path.includes('ABC-12') && calls.length > 3 ? 'Ready for Dev' : 'Backlog',
          }),
        );
      });
      const ticket = await createTicket(
        config,
        { title: 'T', body: 'B', status: 'ready' },
        { fetch, sleep, env, mode: 'personal' },
      );
      expect(ticket).toEqual({ ref, url: 'https://acme.atlassian.net/browse/ABC-12' });
      const created = calls[0]?.body as { fields: Record<string, unknown> };
      expect(created.fields).toMatchObject({
        project: { key: 'ABC' },
        summary: 'T',
        issuetype: { name: 'Task' },
      });
      expect(calls.some((c) => c.path.endsWith('/transitions') && c.method === 'POST')).toBe(true);
    });

    it('applies the outbound policy to title and body', async () => {
      const { fetch, calls } = fakeFetch(() => json({}));
      const options = { fetch, sleep, env, mode: 'work' } as const;
      await expect(
        createTicket(config, { title: 'Fractory task', body: 'x', status: 'backlog' }, options),
      ).rejects.toThrow(OutboundPolicyError);
      await expect(
        createTicket(config, { title: 'x', body: 'AI-generated', status: 'backlog' }, options),
      ).rejects.toThrow(OutboundPolicyError);
      expect(calls).toHaveLength(0);
    });
  });
});
