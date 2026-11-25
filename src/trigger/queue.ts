import { join } from 'node:path';
import type { FactoryConfig } from '../contracts/factory-config.ts';
import type { Mode } from '../contracts/repo-config.ts';
import { RUN_RECORD_VERSION, type RunRecord, type Trigger, runKey } from '../contracts/run.ts';
import type { TicketRef } from '../contracts/ticket.ts';
import { assertOutboundAllowed } from '../policy/outbound.ts';
import type { RunRegistry } from '../registry/registry.ts';

export const slugify = (text: string, maxLength = 40): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');

/** `github:o/n#12` -> `12`, `jira:ABC-12` -> `abc-12`. */
const refSlug = (ref: TicketRef): string =>
  ref.startsWith('jira:') ? slugify(ref.slice(5)) : ref.slice(ref.lastIndexOf('#') + 1);

/**
 * Branch for a new Run. Work Mode branches are shared names, so they carry no `fractory` prefix and
 * pass the outbound policy; the title part is dropped if it would trip the policy.
 */
export const branchFor = (ref: TicketRef, title: string, mode: Mode): string => {
  const prefix = mode === 'work' ? 'feat' : 'fractory';
  const titleSlug = slugify(title);
  const candidates = [
    titleSlug ? `${prefix}/${refSlug(ref)}-${titleSlug}` : '',
    `${prefix}/${refSlug(ref)}`,
  ].filter(Boolean);
  let lastError: unknown;
  for (const branch of candidates) {
    try {
      assertOutboundAllowed(branch, mode);
      return branch;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
};

export interface QueueInput {
  ticketRef: TicketRef;
  repoPath: string;
  trigger: Trigger;
  branch: string;
  /** Snapshot of the repo's Mode and flow, recorded so readers need no config. */
  mode?: Mode | undefined;
  flow?: string | undefined;
}

export interface QueueDeps {
  registry: RunRegistry;
  factory: Pick<FactoryConfig, 'logDir'>;
  now: () => Date;
  newId: () => string;
}

/** Writes a `queued` Run. Idempotent on the key: an existing Run with it is returned untouched. */
export const queueRun = async (
  deps: QueueDeps,
  input: QueueInput,
): Promise<{ record: RunRecord; created: boolean }> => {
  const key = runKey(input.ticketRef, input.trigger);
  const existing = (await deps.registry.list()).find((r) => r.key === key);
  if (existing) return { record: existing, created: false };
  const id = deps.newId();
  const stamp = deps.now().toISOString();
  const record: RunRecord = {
    version: RUN_RECORD_VERSION,
    id,
    key,
    ticketRef: input.ticketRef,
    repoPath: input.repoPath,
    trigger: input.trigger,
    status: 'queued',
    branch: input.branch,
    ...(input.mode === undefined ? {} : { mode: input.mode }),
    ...(input.flow === undefined ? {} : { flow: input.flow }),
    logPath: join(deps.factory.logDir, `${id}.log`),
    createdAt: stamp,
    updatedAt: stamp,
  };
  await deps.registry.write(record);
  return { record, created: true };
};
