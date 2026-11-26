import { z } from 'zod';
import { ModeSchema } from './repo-config.ts';
import { RunResultSchema } from './run.ts';

/**
 * Automation contracts, owned by Fractory and mirrored by Fractory Manager (see Spec 0003).
 * Fractory Manager writes an Automation request; Fractory reads it and writes an Automation Run
 * record. Bump the matching version on any breaking change. Unknown fields are stripped on read
 * (zod's default), so either side can add an optional field without breaking the other.
 */
export const AUTOMATION_VERSION = 1;
export const AUTOMATION_REQUEST_VERSION = 1;
export const AUTOMATION_RUN_RECORD_VERSION = 1;

/** What an Automation runs: an agent CLI with a committed prompt, or a committed script. */
export const AutomationKindSchema = z.enum(['agent', 'script']);
export type AutomationKind = z.infer<typeof AutomationKindSchema>;

/** Five (minute-first) or six (second-first) whitespace-separated cron fields. */
const CronSchema = z
  .string()
  .trim()
  .refine((value) => [5, 6].includes(value.split(/\s+/).length), {
    message: 'Expected a cron expression with 5 or 6 fields',
  });

const isIanaTimezone = (value: string): boolean => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
};

const TimezoneSchema = z
  .string()
  .min(1)
  .refine(isIanaTimezone, { message: 'Expected an IANA timezone, e.g. "Europe/Lisbon"' });

export const AutomationSchema = z.object({
  version: z.literal(AUTOMATION_VERSION),
  /** Unique per host; used in file names, so letters, digits, `-` and `_` only. */
  name: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'Expected letters, digits, "-" or "_" only'),
  kind: AutomationKindSchema,
  repoPath: z.string().min(1),
  cron: CronSchema,
  timezone: TimezoneSchema,
  mode: ModeSchema,
  /** The CLI that runs the entry point, e.g. `claude` for an agent or `bash` for a script. */
  cli: z.string().min(1),
  /** Launch flags passed to the CLI, verbatim. */
  flags: z.array(z.string()).default([]),
  /** Committed path, relative to the repository, of the prompt or script the Automation runs. */
  entryPoint: z.string().min(1),
  /** How many Automation Run records (and their logs and outputs) to keep. */
  keepRuns: z.number().int().min(1),
});
export type Automation = z.infer<typeof AutomationSchema>;

/** Dropped by Fractory Manager when an Automation fires; carries the configuration verbatim. */
export const AutomationRequestSchema = z.object({
  version: z.literal(AUTOMATION_REQUEST_VERSION),
  requestedAt: z.string().datetime(),
  /** The scheduled instant the Automation fired for (not when it was noticed). */
  firedFor: z.string().datetime(),
  automation: AutomationSchema,
});
export type AutomationRequest = z.infer<typeof AutomationRequestSchema>;

export const AutomationRunStatusSchema = z.enum(['queued', 'running', 'done', 'failed']);
export type AutomationRunStatus = z.infer<typeof AutomationRunStatusSchema>;

export const AutomationRunRecordSchema = z.object({
  version: z.literal(AUTOMATION_RUN_RECORD_VERSION),
  id: z.string().min(1),
  /** The Automation's `name`. */
  automation: z.string().min(1),
  firedFor: z.string().datetime(),
  status: AutomationRunStatusSchema,
  startedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  logPath: z.string().min(1),
  outputPath: z.string().min(1),
  /** Set once the Run finishes. */
  result: RunResultSchema.optional(),
});
export type AutomationRunRecord = z.infer<typeof AutomationRunRecordSchema>;

export type Parsed<T> = { ok: true; value: T } | { ok: false; reason: string };

const describeIssues = (error: z.ZodError): string =>
  error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`)
    .join('; ');

const versionOf = (raw: unknown): unknown =>
  typeof raw === 'object' && raw !== null ? (raw as { version?: unknown }).version : undefined;

/** Checks the version first, so a newer or older file is refused as such, not as a bad shape. */
const parseVersioned = <T>(
  what: string,
  version: number,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  raw: unknown,
): Parsed<T> => {
  const found = versionOf(raw);
  if (found !== version) {
    return {
      ok: false,
      reason: `Unsupported ${what} version ${JSON.stringify(found) ?? 'undefined'}: this release understands version ${version}`,
    };
  }
  const result = schema.safeParse(raw);
  return result.success
    ? { ok: true, value: result.data }
    : { ok: false, reason: `Invalid ${what}: ${describeIssues(result.error)}` };
};

export const parseAutomation = (raw: unknown): Parsed<Automation> =>
  parseVersioned('Automation', AUTOMATION_VERSION, AutomationSchema, raw);

export const parseAutomationRequest = (raw: unknown): Parsed<AutomationRequest> => {
  const parsed = parseVersioned(
    'Automation request',
    AUTOMATION_REQUEST_VERSION,
    AutomationRequestSchema,
    raw,
  );
  if (parsed.ok) return parsed;
  // Report a wrong configuration version as such, not as a literal mismatch.
  const automation =
    typeof raw === 'object' && raw !== null
      ? (raw as { automation?: unknown }).automation
      : undefined;
  if (versionOf(raw) === AUTOMATION_REQUEST_VERSION && automation !== undefined) {
    const inner = parseAutomation(automation);
    if (!inner.ok && inner.reason.startsWith('Unsupported')) {
      return { ok: false, reason: `Invalid Automation request: automation: ${inner.reason}` };
    }
  }
  return parsed;
};

export const parseAutomationRunRecord = (raw: unknown): Parsed<AutomationRunRecord> =>
  parseVersioned(
    'Automation Run record',
    AUTOMATION_RUN_RECORD_VERSION,
    AutomationRunRecordSchema,
    raw,
  );
