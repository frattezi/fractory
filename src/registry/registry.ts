import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ACTIVE_STATUSES, type RunRecord, RunRecordSchema } from '../contracts/run.ts';

/**
 * File-backed Run registry: one `<id>.json` per Run. Writes are atomic
 * (tmp file + rename) so a reader — the Agent Manager fork — never sees a half-written file.
 */
export class RunRegistry {
  constructor(private readonly dir: string) {}

  private path(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  async write(record: RunRecord): Promise<void> {
    const valid = RunRecordSchema.parse(record);
    await mkdir(this.dir, { recursive: true });
    const tmp = `${this.path(valid.id)}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(valid, null, 2)}\n`);
    await rename(tmp, this.path(valid.id));
  }

  async get(id: string): Promise<RunRecord | undefined> {
    try {
      return RunRecordSchema.parse(JSON.parse(await readFile(this.path(id), 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  /** Unreadable or invalid files are skipped, never fatal: one bad file must not stop the factory. */
  async list(): Promise<RunRecord[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const records = await Promise.all(
      names
        .filter((name) => name.endsWith('.json'))
        .map(async (name) => {
          try {
            return RunRecordSchema.parse(JSON.parse(await readFile(join(this.dir, name), 'utf8')));
          } catch {
            return undefined;
          }
        }),
    );
    return records.filter((r): r is RunRecord => r !== undefined);
  }

  async update(id: string, patch: Partial<Omit<RunRecord, 'id' | 'version'>>): Promise<RunRecord> {
    const current = await this.get(id);
    if (!current) throw new Error(`Run ${id} not found`);
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() } as RunRecord;
    await this.write(next);
    return next;
  }

  async remove(id: string): Promise<void> {
    await rm(this.path(id), { force: true });
  }
}

export const isActive = (record: RunRecord): boolean => ACTIVE_STATUSES.includes(record.status);
