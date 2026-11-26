import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  type AutomationId,
  type AutomationRunRecord,
  AutomationRunRecordSchema,
  parseAutomationRunRecord,
} from '../contracts/automation.ts';

/**
 * File layout under `FactoryConfig.automationsDir` (Spec 0003):
 *
 * - `requests/<name>.json`: Automation requests dropped by Fractory Manager. Fractory removes each
 *   one once it has a record or a refusal.
 * - `<automationId>/<runId>.json`, `.log`, `.out`: one Automation Run's record, log and output.
 * - `refused/<name>.json`: why a request was refused, with its original text.
 *
 * Every write is atomic (tmp file + rename) so a reader never sees a half-written file.
 */
export const REQUESTS_DIR = 'requests';
export const REFUSED_DIR = 'refused';

export const REFUSAL_VERSION = 1;
export const AutomationRefusalSchema = z.object({
  version: z.literal(REFUSAL_VERSION),
  /** File name of the refused request inside `requests/`. */
  request: z.string().min(1),
  reason: z.string().min(1),
  refusedAt: z.string().datetime(),
  /** The request file's text, verbatim, so the owner can see what was refused. */
  content: z.string(),
});
export type AutomationRefusal = z.infer<typeof AutomationRefusalSchema>;

const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT';

const writeAtomic = async (path: string, value: unknown): Promise<void> => {
  await mkdir(join(path, '..'), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
  await rename(tmp, path);
};

/** `2026-11-26T03:00:00.000Z` -> `20261126T030000Z`; milliseconds are kept only when set. */
const compactInstant = (instant: string): string =>
  new Date(instant)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.000Z$/, 'Z');

/** One Automation Run per Automation and instant, so its id is derived from both. */
export const automationRunId = (automationId: AutomationId, firedFor: string): string =>
  `${automationId}-${compactInstant(firedFor)}`;

export class AutomationStore {
  constructor(readonly dir: string) {}

  get requestsDir(): string {
    return join(this.dir, REQUESTS_DIR);
  }

  runDir(automationId: AutomationId): string {
    return join(this.dir, automationId);
  }

  logPath(automationId: AutomationId, runId: string): string {
    return join(this.runDir(automationId), `${runId}.log`);
  }

  outputPath(automationId: AutomationId, runId: string): string {
    return join(this.runDir(automationId), `${runId}.out`);
  }

  /** Request file names, sorted. An absent directory has none; temporary files are not requests. */
  async listRequests(): Promise<string[]> {
    try {
      return (await readdir(this.requestsDir)).filter((name) => name.endsWith('.json')).sort();
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
  }

  async readRequest(name: string): Promise<string> {
    return readFile(join(this.requestsDir, name), 'utf8');
  }

  /** Removing a request that is already gone is not an error. */
  async removeRequest(name: string): Promise<void> {
    await rm(join(this.requestsDir, name), { force: true });
  }

  /** The Automation's Run records. An unreadable or invalid file is skipped, never fatal. */
  async listRuns(automationId: AutomationId): Promise<AutomationRunRecord[]> {
    let names: string[];
    try {
      names = await readdir(this.runDir(automationId));
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const records = await Promise.all(
      names
        .filter((name) => name.endsWith('.json'))
        .map(async (name) => {
          try {
            const parsed = parseAutomationRunRecord(
              JSON.parse(await readFile(join(this.runDir(automationId), name), 'utf8')),
            );
            return parsed.ok ? parsed.value : undefined;
          } catch {
            return undefined;
          }
        }),
    );
    return records.filter((r): r is AutomationRunRecord => r !== undefined);
  }

  /** Every Automation's Run records, across all Automations. Unreadable records are skipped. */
  async listAllRuns(): Promise<AutomationRunRecord[]> {
    let names: string[];
    try {
      names = (await readdir(this.dir, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .filter((name) => name !== REQUESTS_DIR && name !== REFUSED_DIR)
        .sort();
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    return (await Promise.all(names.map((name) => this.listRuns(name)))).flat();
  }

  /** One Automation Run's record; `undefined` when it is absent or unreadable. */
  async getRun(
    automationId: AutomationId,
    runId: string,
  ): Promise<AutomationRunRecord | undefined> {
    return (await this.listRuns(automationId)).find((r) => r.id === runId);
  }

  /**
   * Whether the Automation already has a record for this instant. A record file that exists but
   * cannot be read still counts: a failed read proves nothing, so it must not cause a second Run.
   */
  async hasRunFor(automationId: AutomationId, firedFor: string): Promise<boolean> {
    const id = automationRunId(automationId, firedFor);
    try {
      await readFile(join(this.runDir(automationId), `${id}.json`));
      return true;
    } catch (error) {
      if (!isMissing(error)) return true;
    }
    const instant = new Date(firedFor).getTime();
    return (await this.listRuns(automationId)).some(
      (r) => new Date(r.firedFor).getTime() === instant,
    );
  }

  async writeRun(record: AutomationRunRecord): Promise<void> {
    const valid = AutomationRunRecordSchema.parse(record);
    await writeAtomic(join(this.runDir(valid.automationId), `${valid.id}.json`), valid);
  }

  private refusalPath(request: string): string {
    return join(this.dir, REFUSED_DIR, request);
  }

  async writeRefusal(refusal: AutomationRefusal): Promise<void> {
    const valid = AutomationRefusalSchema.parse(refusal);
    await writeAtomic(this.refusalPath(valid.request), valid);
  }

  async listRefusals(): Promise<AutomationRefusal[]> {
    const dir = join(this.dir, REFUSED_DIR);
    let names: string[];
    try {
      names = (await readdir(dir)).filter((name) => name.endsWith('.json')).sort();
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const refusals = await Promise.all(
      names.map(async (name) => {
        try {
          return AutomationRefusalSchema.parse(JSON.parse(await readFile(join(dir, name), 'utf8')));
        } catch {
          return undefined;
        }
      }),
    );
    return refusals.filter((r): r is AutomationRefusal => r !== undefined);
  }
}
