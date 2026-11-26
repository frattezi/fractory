import { z } from 'zod';

export const TicketStatusSchema = z.enum(['backlog', 'ready', 'in_progress', 'in_review', 'done']);
export type TicketStatus = z.infer<typeof TicketStatusSchema>;

/**
 * A Ticket reference is globally unique across sources:
 * `github:owner/name#12` or `jira:ABC-12`.
 */
export const TicketRefSchema = z
  .string()
  .regex(/^(github:[\w.-]+\/[\w.-]+#\d+|jira:[A-Z][A-Z0-9]+-\d+)$/);
export type TicketRef = z.infer<typeof TicketRefSchema>;

export const TicketSchema = z.object({
  ref: TicketRefSchema,
  title: z.string(),
  body: z.string(),
  url: z.string().url(),
  status: TicketStatusSchema,
  updatedAt: z.string().datetime(),
  /** Tickets this one depends on, read from the Relations section of its body. */
  blockedBy: z.array(TicketRefSchema).default([]),
  parent: TicketRefSchema.optional(),
  /** Relations the body declares but that could not be read, so they are never silently lost. */
  relationErrors: z.array(z.string()).default([]),
});
export type Ticket = z.infer<typeof TicketSchema>;

/** One implementation per tracker. Adapters validate tracker responses with TicketSchema. */
export interface TicketSource {
  listReady(): Promise<Ticket[]>;
  get(ref: TicketRef): Promise<Ticket>;
  setStatus(ref: TicketRef, status: TicketStatus): Promise<void>;
  comment(ref: TicketRef, body: string): Promise<void>;
}

/**
 * Thrown by `TicketSource.get` when the tracker answers that the Ticket does not exist. Only that
 * answer proves absence: any other failed read is a plain error and proves nothing.
 */
export class TicketNotFoundError extends Error {
  constructor(readonly ref: TicketRef) {
    super(`Ticket ${ref} does not exist`);
    this.name = 'TicketNotFoundError';
  }
}
