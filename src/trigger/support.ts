import { appendFile, mkdir, open, readFile, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** Appends to a file synchronously-ordered; a failing log write never breaks a tick. */
export const createFileLogger = (path: string, now: () => Date = () => new Date()): Logger => {
  let ready: Promise<unknown> | undefined;
  const write = (level: string, message: string): void => {
    const line = `${now().toISOString()} ${level} ${message}\n`;
    ready = (ready ?? mkdir(dirname(path), { recursive: true }))
      .then(() => appendFile(path, line))
      .catch(() => undefined);
  };
  return {
    info: (m) => write('INFO', m),
    warn: (m) => write('WARN', m),
    error: (m) => write('ERROR', m),
  };
};

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };

export type PidState = 'alive' | 'dead' | 'unknown';

/** Only ESRCH proves a process is gone; any other failure proves nothing. */
export const checkPid = (pid: number): PidState => {
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return 'dead';
    if (code === 'EPERM') return 'alive';
    return 'unknown';
  }
};

export const LOCK_STALE_MS = 15 * 60 * 1000;

export interface Lock {
  release(): Promise<void>;
}

/** O_EXCL lock file; one that is older than `staleMs` belongs to a crashed tick and is taken over. */
export const acquireLock = async (
  path: string,
  now: () => Date = () => new Date(),
  staleMs = LOCK_STALE_MS,
): Promise<Lock | undefined> => {
  await mkdir(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(path, 'wx');
      await handle.writeFile(`${process.pid}\n`);
      await handle.close();
      return {
        release: async () => {
          // Only remove our own lock: a takeover after staleness must not be deleted by us.
          try {
            if ((await readFile(path, 'utf8')).trim() === String(process.pid)) {
              await rm(path, { force: true });
            }
          } catch {
            // already gone
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        const age = now().getTime() - (await stat(path)).mtimeMs;
        if (age <= staleMs) return undefined;
        await rm(path, { force: true });
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') throw statError;
      }
    }
  }
  return undefined;
};
