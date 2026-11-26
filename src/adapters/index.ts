import type { TicketSourceConfig } from '../contracts/repo-config.ts';
import type { TicketSource } from '../contracts/ticket.ts';
import { createGithubAdapter } from './github.ts';
import { createJiraAdapter } from './jira.ts';
import type { AdapterOptions, CreatedTicket, NewTicket } from './shared.ts';

export type {
  AdapterOptions,
  CreatedTicket,
  NewTicket,
  ExecFn,
  FetchFn,
  SleepFn,
} from './shared.ts';
export { flattenAdf } from './jira.ts';
export { BLOCKED_BY, type BlockerLine, parseBlockers } from './shared.ts';

const build = (config: TicketSourceConfig, options?: AdapterOptions) =>
  config.kind === 'github'
    ? createGithubAdapter(config, options)
    : createJiraAdapter(config, options);

/** Builds the TicketSource for a repository's configured tracker. Jira requires `options.mode`. */
export const createTicketSource = (
  config: TicketSourceConfig,
  options?: AdapterOptions,
): TicketSource => build(config, options).source;

/** Creates a Ticket in the configured tracker. Title and body pass the outbound policy. */
export const createTicket = (
  config: TicketSourceConfig,
  input: NewTicket,
  options?: AdapterOptions,
): Promise<CreatedTicket> => build(config, options).create(input);
