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
});
export type Ticket = z.infer<typeof TicketSchema>;

/** One implementation per tracker. Adapters validate tracker responses with TicketSchema. */
export interface TicketSource {
  listReady(): Promise<Ticket[]>;
  get(ref: TicketRef): Promise<Ticket>;
  setStatus(ref: TicketRef, status: TicketStatus): Promise<void>;
  comment(ref: TicketRef, body: string): Promise<void>;
}
