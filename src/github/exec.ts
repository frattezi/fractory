import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export interface ExecOptions {
  cwd?: string;
}
/** Runs a process and resolves with stdout; rejects on non-zero exit, timeout or spawn failure. */
export type Exec = (cmd: string, args: string[], options?: ExecOptions) => Promise<string>;

const execFileAsync = promisify(execFile);

export const defaultExec: Exec = async (cmd, args, options = {}) => {
  const { stdout } = await execFileAsync(cmd, args, {
    ...options,
    timeout: 60_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout;
};
