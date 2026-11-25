import { isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FRACTORY_ROOT } from '../runner/exec.ts';
import type { Flow } from './types.ts';

export class FlowLoadError extends Error {}

export interface LoadFlowOptions {
  /** Directory holding `<name>.ts` flows. Default: `flows/` in the Fractory package. */
  flowsDir?: string;
  /** Replaces the dynamic import (tests). */
  importModule?: (url: string) => Promise<unknown>;
  exists?: (path: string) => Promise<boolean>;
}

const defaultExists = async (path: string): Promise<boolean> => {
  const { access } = await import('node:fs/promises');
  return access(path).then(
    () => true,
    () => false,
  );
};

/** Resolves a flow name from `.fractory.json` to `flows/<name>.ts` and returns its default export. */
export const loadFlow = async (name: string, options: LoadFlowOptions = {}): Promise<Flow> => {
  const dir = resolve(options.flowsDir ?? join(FRACTORY_ROOT, 'flows'));
  const file = resolve(dir, `${name}.ts`);
  const rel = relative(dir, file);
  if (rel.startsWith('..') || isAbsolute(rel) || rel.includes('/')) {
    throw new FlowLoadError(`Flow "${name}" is outside the flows directory`);
  }
  if (!(await (options.exists ?? defaultExists)(file))) {
    throw new FlowLoadError(`Unknown flow "${name}": there is no flows/${name}.ts`);
  }
  let mod: unknown;
  try {
    mod = await (options.importModule ?? ((url) => import(url)))(pathToFileURL(file).href);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new FlowLoadError(`Flow "${name}" could not be loaded: ${detail}`);
  }
  const flow = (mod as { default?: unknown } | null)?.default;
  if (typeof flow !== 'function') {
    throw new FlowLoadError(`Flow "${name}" must export a function as its default export`);
  }
  return flow as Flow;
};
