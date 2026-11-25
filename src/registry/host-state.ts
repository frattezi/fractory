import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { type HostState, HostStateSchema } from '../contracts/host-state.ts';

/** Atomic write (tmp file + rename): Fractory Manager never sees a half-written file. */
export const writeHostState = async (path: string, state: HostState): Promise<void> => {
  const valid = HostStateSchema.parse(state);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(valid, null, 2)}\n`);
  await rename(tmp, path);
};

/** The last written state, or undefined when the file is missing or invalid. */
export const readHostState = async (path: string): Promise<HostState | undefined> => {
  try {
    return HostStateSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  } catch {
    return undefined;
  }
};
