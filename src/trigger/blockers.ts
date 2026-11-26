import { parseBlockers } from '../adapters/shared.ts';
import type { RepoConfig, TicketSourceConfig } from '../contracts/repo-config.ts';
import type { Ticket, TicketRef, TicketSource } from '../contracts/ticket.ts';

/**
 * Where a blocker stands. Only `resolved` lets a Ticket start: a blocker whose Ticket is open, that
 * no configured repo owns, or whose source could not be read all hold it.
 */
export type BlockerState = 'resolved' | 'open' | 'unowned' | 'unreadable';

export interface HoldingBlocker {
  /** The full ref, or the label as written when it cannot be resolved to one. */
  blocker: string;
  state: Exclude<BlockerState, 'resolved'>;
}

export interface ConfiguredRepo {
  repoPath: string;
  config: RepoConfig;
}

/** Whether a repository's ticket source is the one a ref lives in. */
export const ownsRef = (source: TicketSourceConfig, ref: TicketRef): boolean => {
  if (source.kind === 'github') {
    const repo = ref.match(/^github:([\w.-]+\/[\w.-]+)#\d+$/)?.[1];
    return repo !== undefined && repo.toLowerCase() === source.repo.toLowerCase();
  }
  const project = ref.match(/^jira:([A-Z][A-Z0-9]+)-\d+$/)?.[1];
  return project !== undefined && project === source.projectKey;
};

export const ownerOf = (ref: TicketRef, repos: ConfiguredRepo[]): ConfiguredRepo | undefined =>
  repos.find((repo) => ownsRef(repo.config.ticketSource, ref));

export interface BlockerResolverDeps {
  /** Every configured repo whose config could be read this tick. */
  repos(): Promise<ConfiguredRepo[]>;
  sourceFor(repo: ConfiguredRepo): TicketSource;
  /** Told why a blocker could not be read; the blocker then holds its Ticket. */
  onReadError(ref: TicketRef, error: unknown): void;
}

/**
 * Resolves a blocker through the ticket source of the repo that owns it. A blocker is resolved only
 * when its Ticket is done there: a closed GitHub issue, or Jira's configured done status. Answers
 * are cached, so a blocker shared by many Tickets is read once per resolver.
 */
export const createBlockerResolver = (
  deps: BlockerResolverDeps,
): ((ref: TicketRef) => Promise<BlockerState>) => {
  const cache = new Map<TicketRef, Promise<BlockerState>>();
  const read = async (ref: TicketRef): Promise<BlockerState> => {
    const owner = ownerOf(ref, await deps.repos());
    if (!owner) return 'unowned';
    try {
      const blocker = await deps.sourceFor(owner).get(ref);
      return blocker.status === 'done' ? 'resolved' : 'open';
    } catch (error) {
      // A failed read proves nothing: the blocker is not known to be done, so it still holds.
      deps.onReadError(ref, error);
      return 'unreadable';
    }
  };
  return (ref) => {
    let answer = cache.get(ref);
    if (!answer) {
      answer = read(ref);
      cache.set(ref, answer);
    }
    return answer;
  };
};

/** The blockers recorded in a Ticket's body that are not resolved; empty means it may start. */
export const holdingBlockers = async (
  ticket: Pick<Ticket, 'ref' | 'body'>,
  resolve: (ref: TicketRef) => Promise<BlockerState>,
): Promise<HoldingBlocker[]> => {
  const holding: HoldingBlocker[] = [];
  for (const line of parseBlockers(ticket.body, ticket.ref)) {
    if (!line.ref) {
      holding.push({ blocker: line.label, state: 'unowned' });
      continue;
    }
    const state = await resolve(line.ref);
    if (state !== 'resolved') holding.push({ blocker: line.ref, state });
  }
  return holding;
};

const STATE_TEXT: Record<HoldingBlocker['state'], string> = {
  open: 'open',
  unowned: 'not owned by any configured repo',
  unreadable: 'could not be read',
};

export const describeHolding = (holding: HoldingBlocker[]): string =>
  holding.map((h) => `${h.blocker} (${STATE_TEXT[h.state]})`).join(', ');
