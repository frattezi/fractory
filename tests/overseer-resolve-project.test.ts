import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  main,
  parseGroupDirectories,
  resolveProject,
  scanWorkRepos,
} from '../skills/fractory-overseer/scripts/resolve-project.ts';

const run = async (argv: string[], repos: string[], groups: () => Promise<string>) => {
  const lines: string[] = [];
  const code = await main(
    argv,
    { scanRepos: () => repos, runGroups: groups },
    {
      out: (l) => lines.push(l),
      err: (l) => lines.push(l),
    },
  );
  return { code, lines };
};
const groupsOf = (dirs: string[]) => async () =>
  JSON.stringify(dirs.map((directory) => ({ directory })));

describe('resolveProject', () => {
  it('prefers an exact match over substring matches, ignoring case', () => {
    expect(resolveProject('FRACTORY', ['/w/a/fractory', '/w/a/fractory-site'])).toEqual({
      kind: 'match',
      path: '/w/a/fractory',
    });
  });
  it('resolves one substring match', () => {
    expect(resolveProject('port', ['/w/a/portal', '/w/a/other'])).toEqual({
      kind: 'match',
      path: '/w/a/portal',
    });
  });
  it('is ambiguous on two substring matches, listing both', () => {
    expect(resolveProject('port', ['/w/a/portal', '/w/a/import'])).toEqual({
      kind: 'ambiguous',
      candidates: ['/w/a/portal', '/w/a/import'],
    });
  });
  it('is ambiguous on the same basename in two areas', () => {
    expect(resolveProject('portal', ['/w/a/portal', '/w/b/portal']).kind).toBe('ambiguous');
  });
  it('treats a duplicate path as one candidate', () => {
    expect(resolveProject('portal', ['/w/a/portal', '/w/a/portal'])).toEqual({
      kind: 'match',
      path: '/w/a/portal',
    });
  });
  it('returns none with the candidates weighed', () => {
    expect(resolveProject('zzz', ['/w/a/portal'])).toEqual({
      kind: 'none',
      candidates: ['/w/a/portal'],
    });
  });
});

describe('scanWorkRepos', () => {
  it('lists repositories holding .git and skips other directories', () => {
    const root = mkdtempSync(join(tmpdir(), 'work-'));
    mkdirSync(join(root, 'area', 'repo', '.git'), { recursive: true });
    mkdirSync(join(root, 'area', 'plain'), { recursive: true });
    expect(scanWorkRepos(root)).toEqual([join(root, 'area', 'repo')]);
  });
});

describe('parseGroupDirectories', () => {
  it('refuses anything but an array of objects with a string directory', () => {
    expect(parseGroupDirectories('{}')).toBeUndefined();
    expect(parseGroupDirectories('nope')).toBeUndefined();
    expect(parseGroupDirectories('[{"directory":3}]')).toBeUndefined();
    expect(parseGroupDirectories('[{"directory":"/x"}]')).toEqual(['/x']);
  });
});

describe('resolve-project entry point', () => {
  it('uses a group directory as a candidate and exits 0 on a match', async () => {
    const { code, lines } = await run(['atlas'], ['/w/a/portal'], groupsOf(['/g/atlas']));
    expect(code).toBe(0);
    expect(lines).toEqual(['/g/atlas']);
  });
  it('dedupes a group directory that is also a repository', async () => {
    const { code } = await run(['portal'], ['/w/a/portal'], groupsOf(['/w/a/portal']));
    expect(code).toBe(0);
  });
  it('exits non-zero on ambiguity and on no match', async () => {
    expect((await run(['portal'], ['/w/a/portal', '/w/b/portal'], groupsOf([]))).code).not.toBe(0);
    expect((await run(['zzz'], ['/w/a/portal'], groupsOf([]))).code).not.toBe(0);
  });
  it('keeps repositories matchable when groups fails, and reports it', async () => {
    const { code, lines } = await run(['portal'], ['/w/a/portal'], async () => {
      throw new Error('boom');
    });
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('group directories could not be read');
  });
  it('keeps repositories matchable when groups is malformed, and reports it', async () => {
    const { code, lines } = await run(['portal', '--json'], ['/w/a/portal'], async () => '{"x":1}');
    expect(code).toBe(0);
    expect(JSON.parse(lines[0] as string)).toMatchObject({ kind: 'match', path: '/w/a/portal' });
    expect(JSON.parse(lines[0] as string).groupsError).toBeTypeOf('string');
  });
  it('--json prints the result object', async () => {
    const { lines } = await run(['port', '--json'], ['/w/a/portal', '/w/a/import'], groupsOf([]));
    expect(JSON.parse(lines[0] as string)).toEqual({
      kind: 'ambiguous',
      candidates: ['/w/a/portal', '/w/a/import'],
    });
  });
});
