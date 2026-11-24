import { describe, expect, it, vi } from 'vitest';
import { createTicket, createTicketSource } from '../src/adapters/index.ts';
import type { ExecFn } from '../src/adapters/index.ts';
import { OutboundPolicyError } from '../src/policy/outbound.ts';

const config = { kind: 'github', repo: 'acme/app' } as const;
const ref = 'github:acme/app#7' as const;

const issue = (over: Record<string, unknown> = {}) => ({
  number: 7,
  title: 'Add login',
  body: 'Details',
  url: 'https://github.com/acme/app/issues/7',
  state: 'OPEN',
  labels: [],
  updatedAt: '2026-01-02T03:04:05Z',
  ...over,
});

/** Records every gh call; `respond` answers by the first two args (`issue view`, `label create`...). */
const fakeExec = (respond: (args: string[]) => string | Error = () => '') => {
  const calls: string[][] = [];
  const exec: ExecFn = async (cmd, args) => {
    expect(cmd).toBe('gh');
    calls.push(args);
    const out = respond(args);
    if (out instanceof Error) throw out;
    return out;
  };
  return { exec, calls };
};

const sleep = vi.fn(async (_ms: number) => {});

describe('github adapter', () => {
  it('maps labels and state to ticket status', async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ labels: [] }, 'backlog'],
      [{ labels: [{ name: 'fractory:ready' }] }, 'ready'],
      [{ labels: [{ name: 'fractory:in-progress' }] }, 'in_progress'],
      [{ labels: [{ name: 'fractory:in-review' }] }, 'in_review'],
      [{ state: 'CLOSED', labels: [{ name: 'fractory:in-review' }] }, 'done'],
    ];
    for (const [over, expected] of cases) {
      const { exec } = fakeExec(() => JSON.stringify(issue(over)));
      const ticket = await createTicketSource(config, { exec, sleep }).get(ref);
      expect(ticket.status).toBe(expected);
      expect(ticket.ref).toBe(ref);
    }
  });

  it('lists ready issues through gh issue list', async () => {
    const { exec, calls } = fakeExec(() =>
      JSON.stringify([issue({ labels: [{ name: 'fractory:ready' }], body: null })]),
    );
    const tickets = await createTicketSource(config, { exec, sleep }).listReady();
    expect(tickets).toHaveLength(1);
    expect(tickets[0]?.body).toBe('');
    expect(calls[0]).toEqual(
      expect.arrayContaining(['issue', 'list', '--label', 'fractory:ready', '--json']),
    );
  });

  it('swaps labels in one edit and creates the labels once', async () => {
    const { exec, calls } = fakeExec((args) =>
      args[1] === 'view'
        ? JSON.stringify(issue({ labels: [{ name: 'fractory:ready' }, { name: 'bug' }] }))
        : '',
    );
    const source = createTicketSource(config, { exec, sleep });
    await source.setStatus(ref, 'in_progress');
    await source.setStatus(ref, 'in_progress');

    const creates = calls.filter((c) => c[0] === 'label' && c[1] === 'create');
    expect(creates).toHaveLength(3);
    expect(creates.every((c) => c.includes('--force'))).toBe(true);
    const edit = calls.find((c) => c[1] === 'edit');
    expect(edit).toEqual(
      expect.arrayContaining([
        '--add-label',
        'fractory:in-progress',
        '--remove-label',
        'fractory:ready',
      ]),
    );
    expect(edit?.join(' ')).not.toContain('bug');
  });

  it('closes the issue and strips fractory labels for done', async () => {
    const { exec, calls } = fakeExec((args) =>
      args[1] === 'view' ? JSON.stringify(issue({ labels: [{ name: 'fractory:in-review' }] })) : '',
    );
    await createTicketSource(config, { exec, sleep }).setStatus(ref, 'done');
    expect(calls.some((c) => c[1] === 'edit' && c.includes('--remove-label'))).toBe(true);
    expect(calls.some((c) => c[1] === 'close')).toBe(true);
  });

  it('reopens a closed issue moved back to ready', async () => {
    const { exec, calls } = fakeExec((args) =>
      args[1] === 'view' ? JSON.stringify(issue({ state: 'CLOSED' })) : '',
    );
    await createTicketSource(config, { exec, sleep }).setStatus(ref, 'ready');
    const order = calls.filter((c) => c[0] === 'issue').map((c) => c[1]);
    expect(order).toEqual(['view', 'reopen', 'edit']);
  });

  it('does nothing when the status is already set', async () => {
    const { exec, calls } = fakeExec((args) =>
      args[1] === 'view' ? JSON.stringify(issue({ labels: [{ name: 'fractory:ready' }] })) : '',
    );
    await createTicketSource(config, { exec, sleep }).setStatus(ref, 'ready');
    expect(calls.some((c) => c[1] === 'edit' || c[1] === 'close' || c[1] === 'reopen')).toBe(false);
  });

  it('retries rate-limited gh calls with backoff, then gives up after 4 attempts', async () => {
    const wait = vi.fn(async (_ms: number) => {});
    let n = 0;
    const flaky = fakeExec(() =>
      ++n < 3 ? new Error('gh: API rate limit exceeded') : JSON.stringify(issue()),
    );
    const ticket = await createTicketSource(config, { exec: flaky.exec, sleep: wait }).get(ref);
    expect(ticket.title).toBe('Add login');
    expect(wait.mock.calls.map((c) => c[0])).toEqual([500, 1000]);

    const dead = fakeExec(() => new Error('HTTP 502: Bad Gateway'));
    await expect(
      createTicketSource(config, { exec: dead.exec, sleep: wait }).get(ref),
    ).rejects.toThrow('502');
    expect(dead.calls).toHaveLength(4);
  });

  it('does not retry other gh failures', async () => {
    const { exec, calls } = fakeExec(() => new Error('HTTP 404: Not Found'));
    await expect(createTicketSource(config, { exec, sleep }).get(ref)).rejects.toThrow('404');
    expect(calls).toHaveLength(1);
  });

  it('rejects invalid gh responses', async () => {
    const bad = [
      JSON.stringify({ number: 7 }),
      'not json',
      JSON.stringify(issue({ updatedAt: 'yesterday' })),
    ];
    for (const out of bad) {
      const { exec } = fakeExec(() => out);
      await expect(createTicketSource(config, { exec, sleep }).get(ref)).rejects.toThrow();
    }
  });

  it('rejects refs from another repo or tracker', async () => {
    const { exec } = fakeExec();
    const source = createTicketSource(config, { exec, sleep });
    await expect(source.get('github:other/app#7')).rejects.toThrow('other/app');
    await expect(source.get('jira:ABC-1')).rejects.toThrow('Not a GitHub');
  });

  describe('outbound policy', () => {
    it('blocks Work Mode comments that mention the AI setup, before calling gh', async () => {
      const { exec, calls } = fakeExec();
      const source = createTicketSource(config, { exec, sleep, mode: 'work' });
      await expect(source.comment(ref, 'Done by Claude')).rejects.toBeInstanceOf(
        OutboundPolicyError,
      );
      expect(calls).toHaveLength(0);
      await source.comment(ref, 'Fixed in #12');
      expect(calls[0]).toEqual(
        expect.arrayContaining(['issue', 'comment', '7', '--body', 'Fixed in #12']),
      );
    });

    it('allows the same text in Personal Mode', async () => {
      const { exec, calls } = fakeExec();
      await createTicketSource(config, { exec, sleep, mode: 'personal' }).comment(
        ref,
        'Done by Claude',
      );
      expect(calls).toHaveLength(1);
    });
  });

  describe('createTicket', () => {
    it('renders parent and blockers as body lines', async () => {
      const { exec, calls } = fakeExec((args) =>
        args[1] === 'create' ? 'https://github.com/acme/app/issues/9' : '',
      );
      await createTicket(
        config,
        {
          title: 'T',
          body: 'B',
          status: 'backlog',
          parent: 'github:acme/app#1',
          blockedBy: ['github:acme/app#2', 'github:other/lib#3', 'jira:ABC-4'],
        },
        { exec, sleep },
      );
      const create = calls.find((c) => c[1] === 'create') ?? [];
      expect(create[create.indexOf('--body') + 1]).toBe(
        'B\n\nParent: #1\nBlocked by #2\nBlocked by other/lib#3\nBlocked by ABC-4',
      );
    });

    it('checks relation lines against the outbound policy too', async () => {
      const { exec, calls } = fakeExec();
      await expect(
        createTicket(
          config,
          { title: 'T', body: 'B', status: 'backlog', blockedBy: ['github:fractory/x#1'] },
          { exec, sleep, mode: 'work' },
        ),
      ).rejects.toThrow(OutboundPolicyError);
      expect(calls).toHaveLength(0);
    });

    it('creates a ready issue and returns it', async () => {
      const { exec, calls } = fakeExec((args) => {
        if (args[1] === 'create') return 'https://github.com/acme/app/issues/7\n';
        if (args[1] === 'view')
          return JSON.stringify(issue({ labels: [{ name: 'fractory:ready' }] }));
        return '';
      });
      const ticket = await createTicket(
        config,
        { title: 'T', body: 'B', status: 'ready' },
        { exec, sleep },
      );
      expect(ticket).toEqual({ ref, url: 'https://github.com/acme/app/issues/7' });
      const create = calls.find((c) => c[0] === 'issue' && c[1] === 'create');
      expect(create).toEqual(
        expect.arrayContaining(['--title', 'T', '--body', 'B', '--label', 'fractory:ready']),
      );
      expect(calls.some((c) => c[0] === 'label')).toBe(true);
    });

    it('applies no label when not ready', async () => {
      const { exec, calls } = fakeExec((args) =>
        args[1] === 'create' ? 'https://github.com/acme/app/issues/7' : JSON.stringify(issue()),
      );
      await createTicket(config, { title: 'T', body: 'B', status: 'backlog' }, { exec, sleep });
      expect(calls.find((c) => c[1] === 'create')).not.toContain('--label');
    });

    it('applies the outbound policy to title and body', async () => {
      const { exec, calls } = fakeExec();
      const options = { exec, sleep, mode: 'work' } as const;
      await expect(
        createTicket(config, { title: 'Ask Claude', body: 'x', status: 'backlog' }, options),
      ).rejects.toThrow(OutboundPolicyError);
      await expect(
        createTicket(config, { title: 'x', body: 'Generated with AI', status: 'backlog' }, options),
      ).rejects.toThrow(OutboundPolicyError);
      expect(calls).toHaveLength(0);
    });
  });
});
