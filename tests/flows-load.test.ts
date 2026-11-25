import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadFlow } from '../src/flows/load.ts';

const flowsDir = async (files: Record<string, string>): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'flows-'));
  await mkdir(dir, { recursive: true });
  for (const [name, source] of Object.entries(files)) await writeFile(join(dir, name), source);
  return dir;
};

describe('loadFlow', () => {
  it('loads the default export of flows/<name>.ts', async () => {
    const flowsDirPath = await flowsDir({
      'mine.ts': "export default async () => ({ outcome: 'done', summary: 'ok' });",
    });
    const flow = await loadFlow('mine', { flowsDir: flowsDirPath });
    expect(await flow({} as never)).toEqual({ outcome: 'done', summary: 'ok' });
  });

  it('loads the shipped build flow', async () => {
    expect(typeof (await loadFlow('build'))).toBe('function');
  });

  it('fails clearly for an unknown flow', async () => {
    const dir = await flowsDir({});
    await expect(loadFlow('nope', { flowsDir: dir })).rejects.toThrow(/Unknown flow "nope"/);
  });

  it('rejects a default export that is not a function', async () => {
    const dir = await flowsDir({ 'bad.ts': 'export default { outcome: "done" };' });
    await expect(loadFlow('bad', { flowsDir: dir })).rejects.toThrow(/default export/);
  });

  it('rejects a module without a default export', async () => {
    const dir = await flowsDir({ 'none.ts': 'export const flow = () => 1;' });
    await expect(loadFlow('none', { flowsDir: dir })).rejects.toThrow(/default export/);
  });

  it('refuses names that escape the flows directory', async () => {
    const dir = await flowsDir({});
    for (const name of ['../x', 'a/b', '/etc/passwd']) {
      await expect(loadFlow(name, { flowsDir: dir })).rejects.toThrow(/outside|Unknown/);
    }
  });

  it('reports a flow that throws while loading', async () => {
    const dir = await flowsDir({ 'boom.ts': "throw new Error('syntax-ish');" });
    await expect(loadFlow('boom', { flowsDir: dir })).rejects.toThrow(
      /could not be loaded.*syntax-ish/,
    );
  });
});
