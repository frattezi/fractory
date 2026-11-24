import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

export interface ExecOptions {
  cwd?: string;
}

/** Runs a process and resolves with its output; rejects on a non-zero exit. */
export type Exec = (
  file: string,
  args: string[],
  options?: ExecOptions,
) => Promise<{ stdout: string; stderr: string }>;

const execFileAsync = promisify(execFile);

export const defaultExec: Exec = async (file, args, options = {}) => {
  const { stdout, stderr } = await execFileAsync(file, args, {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    maxBuffer: 64 * 1024 * 1024,
  });
  return { stdout, stderr };
};

/** Root of the Fractory package: where `rules/` and `src/cli.ts` live. */
export const FRACTORY_ROOT = fileURLToPath(new URL('../../', import.meta.url));
