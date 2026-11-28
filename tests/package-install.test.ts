import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SKILLS_SOURCE, OWNED_MARKER, installSkills } from '../src/package/install.ts';

const tmp = () => mkdtemp(join(tmpdir(), 'install-'));

const makeSkill = async (root: string, name: string, body: string) => {
  await mkdir(join(root, name), { recursive: true });
  await writeFile(join(root, name, 'SKILL.md'), body);
};

describe('installSkills', () => {
  it('copies skills with an ownership marker and overwrites its own on reinstall', async () => {
    const sourceDir = await tmp();
    const targetDir = join(await tmp(), 'skills');
    await makeSkill(sourceDir, 'alpha', 'v1');
    await installSkills({ sourceDir, targetDir });
    expect(await readFile(join(targetDir, 'alpha', 'SKILL.md'), 'utf8')).toBe('v1');
    expect(await readdir(join(targetDir, 'alpha'))).toContain(OWNED_MARKER);

    await makeSkill(sourceDir, 'alpha', 'v2');
    const result = await installSkills({ sourceDir, targetDir });
    expect(result.installed).toEqual(['alpha']);
    expect(await readFile(join(targetDir, 'alpha', 'SKILL.md'), 'utf8')).toBe('v2');
  });

  it('never touches a same-named directory it does not own, nor unrelated ones', async () => {
    const sourceDir = await tmp();
    const targetDir = await tmp();
    await makeSkill(sourceDir, 'alpha', 'ours');
    await makeSkill(sourceDir, 'beta', 'ours');
    await makeSkill(targetDir, 'alpha', 'theirs');
    await makeSkill(targetDir, 'other', 'theirs');

    const result = await installSkills({ sourceDir, targetDir });
    expect(result).toEqual({ installed: ['beta'], skipped: ['alpha'] });
    expect(await readFile(join(targetDir, 'alpha', 'SKILL.md'), 'utf8')).toBe('theirs');
    expect(await readFile(join(targetDir, 'other', 'SKILL.md'), 'utf8')).toBe('theirs');
  });

  it('ignores source entries that are not skills', async () => {
    const sourceDir = await tmp();
    const targetDir = await tmp();
    await mkdir(join(sourceDir, 'empty'));
    await writeFile(join(sourceDir, 'README.md'), 'x');
    expect(await installSkills({ sourceDir, targetDir })).toEqual({ installed: [], skipped: [] });
  });

  it('ships skills whose frontmatter name matches the directory', async () => {
    const names = (await readdir(DEFAULT_SKILLS_SOURCE, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'grill-with-docs',
        'to-spec',
        'to-tickets',
        'research',
        'handoff',
        'orchestrator',
        'reviewer',
      ]),
    );
    for (const name of names) {
      // `fractory install` skips a directory without a SKILL.md (a skill still being built).
      if (!existsSync(join(DEFAULT_SKILLS_SOURCE, name, 'SKILL.md'))) continue;
      const text = await readFile(join(DEFAULT_SKILLS_SOURCE, name, 'SKILL.md'), 'utf8');
      expect(text).toMatch(new RegExp(`^---\\nname: ${name}\\n`));
    }
  });
});
