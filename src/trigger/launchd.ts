import { constants, accessSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';
import type { Exec } from '../github/exec.ts';

export const LAUNCHD_LABEL = 'com.fractory.tick';
export const TICK_INTERVAL_SECONDS = 180;
const SYSTEM_PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];

const escapeXml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Fills `{{NAME}}` placeholders; every value is XML-escaped. Unknown placeholders are an error. */
export const renderPlist = (template: string, vars: Record<string, string>): string =>
  template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => {
    const value = vars[name];
    if (value === undefined) throw new Error(`plist template placeholder ${name} has no value`);
    return escapeXml(value);
  });

/** Finds an executable on a PATH string, like `which`. */
export const resolveBin = (name: string, pathVar = process.env.PATH ?? ''): string | undefined => {
  for (const dir of pathVar.split(delimiter).filter(Boolean)) {
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return undefined;
};

/** launchd starts jobs with a bare PATH, so every tool the Runs need is added explicitly. */
export const buildPath = (
  resolve: (name: string) => string | undefined,
  nodePath: string,
): { path: string; missing: string[] } => {
  const dirs = [dirname(nodePath)];
  const missing: string[] = [];
  for (const bin of ['claude', 'gh', 'docker', 'git']) {
    const found = resolve(bin);
    if (found) dirs.push(dirname(found));
    else if (bin !== 'git') missing.push(bin);
  }
  return { path: [...new Set([...dirs, ...SYSTEM_PATH])].join(delimiter), missing };
};

export type Launchctl = (args: string[]) => Promise<void>;

export interface LaunchdDeps {
  rootDir: string;
  launchAgentsDir: string;
  home: string;
  uid: number;
  logDir: string;
  nodePath: string;
  resolveBin: (name: string) => string | undefined;
  launchctl: Launchctl;
  exec: Exec;
  out: (line: string) => void;
}

const plistPath = (deps: LaunchdDeps): string =>
  join(deps.launchAgentsDir, `${LAUNCHD_LABEL}.plist`);

export const installLaunchd = async (deps: LaunchdDeps): Promise<string> => {
  const template = await readFile(
    join(deps.rootDir, 'launchd', `${LAUNCHD_LABEL}.plist.template`),
    'utf8',
  );
  const { path, missing } = buildPath(deps.resolveBin, deps.nodePath);
  for (const bin of missing)
    deps.out(`warning: ${bin} not found on PATH; Runs needing it will fail`);
  const xml = renderPlist(template, {
    LABEL: LAUNCHD_LABEL,
    TSX: join(deps.rootDir, 'node_modules', '.bin', 'tsx'),
    CLI: join(deps.rootDir, 'src', 'cli.ts'),
    ROOT: deps.rootDir,
    INTERVAL: String(TICK_INTERVAL_SECONDS),
    PATH: path,
    HOME: deps.home,
    LOG: join(deps.logDir, 'launchd.log'),
  });
  await mkdir(deps.launchAgentsDir, { recursive: true });
  await mkdir(deps.logDir, { recursive: true });
  const target = plistPath(deps);
  await writeFile(target, xml);
  // git over HTTPS through gh credentials: SSH keys are not reachable from launchd.
  await deps
    .exec('gh', ['auth', 'setup-git'])
    .catch((e: Error) => deps.out(`warning: gh auth setup-git failed: ${e.message}`));
  const domain = `gui/${deps.uid}`;
  await deps.launchctl(['bootout', `${domain}/${LAUNCHD_LABEL}`]).catch(() => undefined);
  await deps.launchctl(['bootstrap', domain, target]);
  return target;
};

export const uninstallLaunchd = async (deps: LaunchdDeps): Promise<string> => {
  await deps.launchctl(['bootout', `gui/${deps.uid}/${LAUNCHD_LABEL}`]).catch(() => undefined);
  const target = plistPath(deps);
  await rm(target, { force: true });
  return target;
};
