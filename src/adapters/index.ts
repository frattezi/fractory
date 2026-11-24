import type { TicketSourceConfig } from '../contracts/repo-config.ts';
import type { TicketSource } from '../contracts/ticket.ts';

/** Builds the TicketSource for a repository's configured tracker. Implemented in spec part B. */
export const createTicketSource = (_config: TicketSourceConfig): TicketSource => {
  throw new Error('not implemented');
};
