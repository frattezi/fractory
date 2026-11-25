import { access, cp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Marker file inside a skill directory that Fractory installed and may overwrite. */
export const OWNED_MARKER = '.fractory-owned';

export const DEFAULT_SKILLS_SOURCE = join(dirname(fileURLToPath(import.meta.url)), '../../skills');
export const DEFAULT_SKILLS_TARGET = join(homedir(), '.claude', 'skills');

export interface InstallOptions {
  /** Directory holding `<name>/SKILL.md` folders. Defaults to this package's `skills/`. */
  sourceDir?: string;
  /** Defaults to `~/.claude/skills`. */
  targetDir?: string;
}

export interface InstallResult {
  installed: string[];
  /** Existing directories Fractory does not own; left untouched. */
  skipped: string[];
}

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

/**
 * Copies every skill into the target. A directory is replaced only if it carries the
 * `.fractory-owned` marker; a same-named directory without it is never touched.
 */
export const installSkills = async (opts: InstallOptions = {}): Promise<InstallResult> => {
  const sourceDir = opts.sourceDir ?? DEFAULT_SKILLS_SOURCE;
  const targetDir = opts.targetDir ?? DEFAULT_SKILLS_TARGET;
  const entries = await readdir(sourceDir, { withFileTypes: true });
  const names = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

  await mkdir(targetDir, { recursive: true });
  const result: InstallResult = { installed: [], skipped: [] };
  for (const name of names) {
    if (!(await exists(join(sourceDir, name, 'SKILL.md')))) continue;
    const dest = join(targetDir, name);
    if ((await exists(dest)) && !(await exists(join(dest, OWNED_MARKER)))) {
      result.skipped.push(name);
      continue;
    }
    await rm(dest, { recursive: true, force: true });
    await cp(join(sourceDir, name), dest, { recursive: true });
    await writeFile(
      join(dest, OWNED_MARKER),
      'Installed by `fractory install`; safe to overwrite.\n',
    );
    result.installed.push(name);
  }
  return result;
};
