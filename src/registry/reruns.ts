import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { RERUN_SUFFIX, RerunRequestSchema } from '../contracts/run.ts';

/**
 * Run ids with a valid Re-run request file in the registry dir. The files belong to Fractory
 * Manager: they are only read, never modified or deleted. An invalid file is skipped.
 */
export const listRerunRequests = async (registryDir: string): Promise<string[]> => {
  let names: string[];
  try {
    names = await readdir(registryDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const ids = await Promise.all(
    names
      .filter((name) => name.endsWith(RERUN_SUFFIX))
      .map(async (name) => {
        try {
          RerunRequestSchema.parse(JSON.parse(await readFile(join(registryDir, name), 'utf8')));
          return name.slice(0, -RERUN_SUFFIX.length);
        } catch {
          return undefined;
        }
      }),
  );
  return ids.filter((id): id is string => id !== undefined).sort();
};
