// Project resolver for the Overseer: which directory should a new Session start in?
// Dependency-free, erasable-syntax TypeScript: it ships to ~/.claude/skills/ (no node_modules)
// and runs with plain `node`.
import { execFile } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export type Resolution =
  | { kind: 'match'; path: string }
  | { kind: 'ambiguous' | 'none'; candidates: string[] };

export function resolveProject(name: string, candidates: string[]): Resolution {
  const unique = [...new Set(candidates)];
  const needle = name.trim().toLowerCase();
  const exact = unique.filter((c) => basename(c).toLowerCase() === needle);
  if (exact.length === 1) return { kind: 'match', path: exact[0] as string };
  if (exact.length > 1) return { kind: 'ambiguous', candidates: exact };
  const partial =
    needle === '' ? [] : unique.filter((c) => basename(c).toLowerCase().includes(needle));
  if (partial.length === 1) return { kind: 'match', path: partial[0] as string };
  if (partial.length > 1) return { kind: 'ambiguous', candidates: partial };
  return { kind: 'none', candidates: unique };
}

// The stated exception to "zod at every boundary": this script cannot import zod once installed,
// so `agent-manager groups --json` is checked by this hand-written guard: an array of objects
// carrying a string `directory`. Anything else is refused (undefined).
// Ceiling: the field name is the Spec's; if agent-manager's JSON names it otherwise, groups are
// reported as unreadable (safe), and the name here is the one line to change.
export function parseGroupDirectories(stdout: string): string[] | undefined {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (!Array.isArray(data)) return undefined;
  const dirs: string[] = [];
  for (const item of data) {
    if (typeof item !== 'object' || item === null) return undefined;
    const dir = (item as Record<string, unknown>).directory;
    if (typeof dir !== 'string' || dir === '') return undefined;
    dirs.push(dir);
  }
  return dirs;
}

export type Gatherers = {
  /** Git repositories directly under ~/Work/<area>/. */
  scanRepos: () => string[];
  /** Stdout of `agent-manager groups --json`; throws when the call fails. */
  runGroups: () => Promise<string>;
};

export type Gathered = { candidates: string[]; groupsError?: string };

export async function gatherCandidates(g: Gatherers): Promise<Gathered> {
  const repos = g.scanRepos();
  try {
    const dirs = parseGroupDirectories(await g.runGroups());
    if (dirs === undefined) {
      return {
        candidates: repos,
        groupsError: 'agent-manager groups --json output was not recognised',
      };
    }
    return { candidates: [...new Set([...repos, ...dirs])] };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { candidates: repos, groupsError: `agent-manager groups --json failed: ${reason}` };
  }
}

export function scanWorkRepos(root: string = join(homedir(), 'Work')): string[] {
  const repos: string[] = [];
  const subdirs = (dir: string): string[] => {
    try {
      return readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => join(dir, e.name));
    } catch {
      return [];
    }
  };
  for (const area of subdirs(root)) {
    for (const repo of subdirs(area)) if (existsSync(join(repo, '.git'))) repos.push(repo);
  }
  return repos;
}

const runAgentManagerGroups = (): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile('agent-manager', ['groups', '--json'], (error, stdout) =>
      error ? reject(error) : resolve(stdout),
    );
  });

export type Io = { out: (line: string) => void; err: (line: string) => void };

/** Returns the exit code: 0 on a match, 1 otherwise. */
export async function main(
  argv: string[],
  g: Gatherers = { scanRepos: scanWorkRepos, runGroups: runAgentManagerGroups },
  io: Io = { out: (l) => console.log(l), err: (l) => console.error(l) },
): Promise<number> {
  const json = argv.includes('--json');
  const name = argv.filter((a) => a !== '--json').join(' ');
  if (name.trim() === '') {
    io.err('usage: resolve-project.ts <name> [--json]');
    return 2;
  }
  const { candidates, groupsError } = await gatherCandidates(g);
  const result = resolveProject(name, candidates);
  if (json) {
    io.out(JSON.stringify(groupsError === undefined ? result : { ...result, groupsError }));
  } else {
    if (result.kind === 'match') io.out(result.path);
    else {
      io.out(result.kind === 'ambiguous' ? `ambiguous: ${name}` : `no match: ${name}`);
      for (const c of result.candidates) io.out(`  ${c}`);
    }
    if (groupsError !== undefined) io.out(`group directories could not be read: ${groupsError}`);
  }
  return result.kind === 'match' ? 0 : 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
