import { type TicketRef, TicketRefSchema } from '../contracts/ticket.ts';

/** What a Ticket declares about the Tickets around it. */
export interface Relations {
  blockedBy: TicketRef[];
  parent?: TicketRef | undefined;
}

export interface ParsedRelations {
  blockedBy: TicketRef[];
  parent?: TicketRef;
  /** One message per line or ref that could not be read. */
  errors: string[];
}

const HEADING = '## Relations';
const SECTION_HEADING = /^#{1,6}\s*Relations\s*$/i;
const ANY_HEADING = /^#{1,6}\s/;
const SECTION_LINE = /^(?:[-*]\s+)?(blocked by|parent)\s*:?\s*(.*)$/i;
/** What bodies written before the Relations section carried: `Parent: #1`, `Blocked by #4`. */
const LEGACY_LINE = /^(Parent:|Blocked by) (\S+)$/;

/**
 * Appends the Relations section to a body. Refs are written in full, so the section reads the
 * same in any tracker and `parseRelations` gives back exactly what was written.
 */
export const renderRelations = (body: string, relations: Relations): string => {
  const lines = [
    ...relations.blockedBy.map((ref) => `Blocked by: ${ref}`),
    ...(relations.parent ? [`Parent: ${relations.parent}`] : []),
  ];
  return lines.length > 0 ? `${body.trimEnd()}\n\n${HEADING}\n\n${lines.join('\n')}` : body;
};

/** Reads a written ref, resolving the shorthand older bodies used against the Ticket's own ref. */
const resolve = (token: string, own: TicketRef): TicketRef | undefined => {
  const full = TicketRefSchema.safeParse(token);
  if (full.success) return full.data;
  const ownRepo = own.match(/^github:([\w.-]+\/[\w.-]+)#\d+$/)?.[1];
  const candidate = /^#\d+$/.test(token)
    ? ownRepo
      ? `github:${ownRepo}${token}`
      : undefined
    : /^[\w.-]+\/[\w.-]+#\d+$/.test(token)
      ? `github:${token}`
      : /^[A-Z][A-Z0-9]+-\d+$/.test(token)
        ? `jira:${token}`
        : undefined;
  const parsed = TicketRefSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
};

interface Entry {
  kind: 'blocked by' | 'parent';
  value: string;
}

const collect = (entries: Entry[], own: TicketRef, errors: string[]): ParsedRelations => {
  const blockedBy: TicketRef[] = [];
  let parent: TicketRef | undefined;
  for (const { kind, value } of entries) {
    const label = kind === 'parent' ? 'Parent' : 'Blocked by';
    const tokens = value.split(/[\s,]+/).filter(Boolean);
    if (tokens.length === 0) errors.push(`${label}: no Ticket ref given`);
    for (const token of tokens) {
      const ref = resolve(token, own);
      if (!ref) {
        errors.push(`${label}: "${token}" is not a Ticket ref`);
      } else if (kind === 'blocked by') {
        if (!blockedBy.includes(ref)) blockedBy.push(ref);
      } else if (parent && parent !== ref) {
        errors.push(`Parent: "${token}" is a second parent (already ${parent})`);
      } else {
        parent = ref;
      }
    }
  }
  return { blockedBy, ...(parent ? { parent } : {}), errors };
};

/**
 * Reads the Relations a body declares. The last Relations section wins; without one, a body
 * whose closing paragraph is the older prose form is read instead. A body with neither has no
 * relations. Lines and refs that cannot be read are reported in `errors`, never dropped.
 */
export const parseRelations = (body: string, own: TicketRef): ParsedRelations => {
  const lines = body.split(/\r?\n/).map((line) => line.trim());
  const start = lines.findLastIndex((line) => SECTION_HEADING.test(line));

  if (start >= 0) {
    const errors: string[] = [];
    const entries: Entry[] = [];
    for (const line of lines.slice(start + 1)) {
      if (ANY_HEADING.test(line)) break;
      if (!line) continue;
      const match = line.match(SECTION_LINE);
      if (!match) {
        errors.push(`Relations: cannot read "${line}"`);
        continue;
      }
      const kind = (match[1] ?? '').toLowerCase() as Entry['kind'];
      entries.push({ kind, value: match[2] ?? '' });
    }
    return collect(entries, own, errors);
  }

  const paragraphs = body.trimEnd().split(/\n\s*\n/);
  const last = (paragraphs[paragraphs.length - 1] ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const legacy = last.map((line) => line.match(LEGACY_LINE));
  if (last.length === 0 || legacy.some((match) => !match)) return { blockedBy: [], errors: [] };
  return collect(
    legacy.map((match) => ({
      kind: match?.[1] === 'Parent:' ? 'parent' : 'blocked by',
      value: match?.[2] ?? '',
    })),
    own,
    [],
  );
};
