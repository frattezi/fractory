import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AUTOMATION_REQUEST_VERSION,
  AUTOMATION_RUN_RECORD_VERSION,
  type Automation,
  type AutomationRunRecord,
} from '../src/contracts/automation.ts';
import type { RepoConfig } from '../src/contracts/repo-config.ts';
import { AutomationStore } from '../src/registry/automations.ts';
import {
  AUTOMATION_OUTPUT_ENV,
  AUTOMATION_OUTPUT_MOUNT,
  agentCommand,
  agentKindOf,
  automationCommand,
  executeAutomationRun,
} from '../src/runner/automation-execute.ts';
import type { Exec } from '../src/runner/exec.ts';
import type { SandboxExtras, SandcastleAdapter } from '../src/runner/types.ts';

const RUN_ID = 'a1-20260601T030000Z';
const NOW = new Date('2026-06-01T03:00:10.000Z');

interface ContainerSpec {
  image: string | undefined;
  cpus: number | undefined;
  extra: SandboxExtras | undefined;
  /** Whether the output directory existed on the host when the container started. */
  outputExisted: boolean;
}

interface Options {
  automation?: Partial<Automation>;
  /** Files committed in the repository, copied into the worktree. */
  files?: Record<string, string>;
  /** What the stubbed container does with the command. */
  container?: (
    command: string,
    extra: SandboxExtras | undefined,
    onLine: (line: string) => void,
  ) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  keychain?: Record<string, string>;
  keepRequest?: boolean;
}

const setup = async (options: Options = {}) => {
  const dir = await mkdtemp(join(tmpdir(), 'auto-exec-'));
  const store = new AutomationStore(join(dir, 'automations'));
  const repoPath = join(dir, 'repo');
  const automation: Automation = {
    version: 1,
    id: 'a1',
    name: 'Monthly report',
    kind: 'script',
    repoPath,
    cron: '0 3 1 * *',
    timezone: 'Europe/Lisbon',
    mode: 'personal',
    cli: 'bash',
    flags: ['-e', "--label=it's"],
    entryPoint: 'scripts/report.sh',
    keepRuns: 5,
    ...options.automation,
  };
  const record: AutomationRunRecord = {
    version: AUTOMATION_RUN_RECORD_VERSION,
    id: RUN_ID,
    automationId: 'a1',
    firedFor: '2026-06-01T03:00:00.000Z',
    status: 'running',
    startedAt: '2026-06-01T03:00:02.000Z',
    updatedAt: '2026-06-01T03:00:02.000Z',
    logPath: store.logPath('a1', RUN_ID),
    outputPath: store.outputPath('a1', RUN_ID),
    pid: 4321,
  };
  if (options.keepRequest !== false) {
    await store.writeRequestCopy(RUN_ID, {
      version: AUTOMATION_REQUEST_VERSION,
      requestedAt: '2026-06-01T03:00:01.000Z',
      firedFor: record.firedFor,
      automation,
    });
  }
  await store.writeRun(record);

  const config: RepoConfig = {
    mode: 'personal',
    ticketSource: { kind: 'github', repo: 'o/r' },
    hasCi: false,
    ticketGate: false,
    baseBranch: 'trunk',
    sandboxImage: 'chores:latest',
    maxIterations: 3,
    flow: 'build',
  };
  const files = options.files ?? { 'scripts/report.sh': 'echo hi' };

  const worktreeRequests: { repoPath: string; branch: string; baseRef: string }[] = [];
  const containers: ContainerSpec[] = [];
  const commands: string[] = [];
  const stdins: (string | undefined)[] = [];
  const events: string[] = [];
  const worktreePath = join(dir, 'worktree');
  const sandcastle = {
    createWorktree: async (request: { repoPath: string; branch: string; baseRef: string }) => {
      worktreeRequests.push(request);
      for (const [path, content] of Object.entries(files)) {
        await mkdir(join(worktreePath, path, '..'), { recursive: true });
        await writeFile(join(worktreePath, path), content);
      }
      return {
        branch: request.branch,
        worktreePath,
        createSandbox: async ({ sandbox }: { sandbox: ContainerSpec }) => {
          containers.push({ ...sandbox, outputExisted: existsSync(record.outputPath) });
          events.push('container started');
          return {
            exec: async (
              command: string,
              o: { onLine: (line: string) => void; stdin?: string },
            ) => {
              commands.push(command);
              stdins.push(o.stdin);
              const run =
                options.container ??
                (async () => ({ stdout: '', stderr: '', exitCode: 0 }) as const);
              return run(command, sandbox.extra, o.onLine);
            },
            close: async () => {
              events.push('container closed');
            },
          };
        },
        close: async () => {
          await rm(worktreePath, { recursive: true, force: true });
          events.push('worktree closed');
          return {};
        },
      };
    },
    sandbox: (image: string | undefined, cpus?: number, extra?: SandboxExtras) => ({
      image,
      cpus,
      extra,
    }),
  } as unknown as SandcastleAdapter;

  const calls: { file: string; args: string[] }[] = [];
  const keychain = options.keychain ?? {
    'fractory.claude.personal': 'personal-token',
    'fractory.claude.work': 'work-token',
  };
  const exec: Exec = async (file, args) => {
    calls.push({ file, args });
    if (file === 'security') {
      const service = args[args.indexOf('-s') + 1] ?? '';
      const secret = keychain[service];
      if (secret === undefined) {
        throw Object.assign(new Error('not found'), { code: 44, stderr: 'could not be found' });
      }
      return { stdout: `${secret}\n`, stderr: '' };
    }
    return { stdout: '', stderr: '' };
  };

  const run = () =>
    executeAutomationRun('a1', RUN_ID, {
      store,
      sandcastle,
      exec,
      cpus: 2,
      now: () => NOW,
      loadRepoConfig: async (path) => {
        expect(path).toBe(repoPath);
        return config;
      },
    });
  return {
    run,
    store,
    record,
    repoPath,
    worktreePath,
    worktreeRequests,
    containers,
    commands,
    stdins,
    events,
    calls,
  };
};

/** Writes into the host directory mounted at the output path, as the work in the container would. */
const hostPathOf = (extra: SandboxExtras | undefined): string => {
  const mount = extra?.mounts?.find((m) => m.sandboxPath === AUTOMATION_OUTPUT_MOUNT);
  if (!mount) throw new Error('output directory not mounted');
  return mount.hostPath;
};

describe('executeAutomationRun', () => {
  it('asks Sandcastle for a worktree on the repository the request names', async () => {
    const h = await setup();
    await h.run();
    expect(h.worktreeRequests).toEqual([
      { repoPath: h.repoPath, branch: `automation/${RUN_ID}`, baseRef: 'trunk' },
    ]);
  });

  it("uses the repository's image and mounts the output directory, created first", async () => {
    const h = await setup();
    await h.run();
    expect(h.containers).toHaveLength(1);
    const [container] = h.containers;
    expect(container?.image).toBe('chores:latest');
    expect(container?.cpus).toBe(2);
    expect(container?.outputExisted).toBe(true);
    expect(container?.extra?.mounts).toEqual([
      { hostPath: h.record.outputPath, sandboxPath: AUTOMATION_OUTPUT_MOUNT },
    ]);
    expect(container?.extra?.env?.[AUTOMATION_OUTPUT_ENV]).toBe(AUTOMATION_OUTPUT_MOUNT);
  });

  it('keeps a file written to the output path after the worktree is gone', async () => {
    const h = await setup({
      container: async (_command, extra) => {
        await writeFile(join(hostPathOf(extra), 'report.csv'), 'a,b\n1,2\n');
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    });
    const final = await h.run();
    expect(existsSync(h.worktreePath)).toBe(false);
    expect(await readFile(join(final.outputPath, 'report.csv'), 'utf8')).toBe('a,b\n1,2\n');
    expect(h.events).toEqual(['container started', 'container closed', 'worktree closed']);
  });

  it('runs the entry point with the flags and logs everything it printed', async () => {
    const h = await setup({
      container: async (_command, _extra, onLine) => {
        onLine('line one');
        onLine('line two');
        return { stdout: 'line one\nline two\n', stderr: 'late warning', exitCode: 0 };
      },
    });
    await h.run();
    expect(h.commands).toEqual([`'bash' '-e' '--label=it'\\''s' 'scripts/report.sh' 2>&1`]);
    const log = await readFile(h.record.logPath, 'utf8');
    expect(log).toContain('line one\nline two\n');
    expect(log).toContain('late warning\n');
  });

  it('records a clean exit as done, with the log and output paths', async () => {
    const h = await setup();
    const final = await h.run();
    expect(final).toMatchObject({
      status: 'done',
      result: { outcome: 'done' },
      logPath: h.record.logPath,
      outputPath: h.record.outputPath,
      pid: 4321,
      updatedAt: NOW.toISOString(),
    });
    expect(await h.store.getRun('a1', RUN_ID)).toEqual(final);
  });

  it('records a non-zero exit as failed', async () => {
    const h = await setup({
      container: async () => ({ stdout: '', stderr: '', exitCode: 3 }),
    });
    const final = await h.run();
    expect(final.status).toBe('failed');
    expect(final.result).toEqual({
      outcome: 'failed',
      summary: 'scripts/report.sh exited with code 3',
    });
    expect(final.logPath).toBe(h.record.logPath);
  });

  it('records a crash of the container as failed and still cleans up', async () => {
    const h = await setup({
      container: async () => {
        throw new Error('docker died');
      },
    });
    const final = await h.run();
    expect(final).toMatchObject({
      status: 'failed',
      result: { outcome: 'failed', summary: 'docker died' },
    });
    expect(h.events).toEqual(['container started', 'container closed', 'worktree closed']);
  });

  it('fails with a reason when the entry point is missing, without starting a container', async () => {
    const h = await setup({ files: {} });
    const final = await h.run();
    expect(final.status).toBe('failed');
    expect(final.result).toMatchObject({ outcome: 'failed' });
    expect(final.result && 'summary' in final.result && final.result.summary).toMatch(
      /Entry point scripts\/report\.sh is missing from the repository/,
    );
    expect(h.containers).toEqual([]);
    expect(h.events).toEqual(['worktree closed']);
  });

  it('refuses an entry point outside the repository', async () => {
    const h = await setup({ automation: { entryPoint: '../secrets.sh' } });
    const final = await h.run();
    expect(final.result).toMatchObject({
      outcome: 'failed',
      summary: 'Entry point ../secrets.sh is not a path inside the repository',
    });
    expect(h.containers).toEqual([]);
  });

  it("passes the credential for the Automation's Mode at container start", async () => {
    const h = await setup({ automation: { mode: 'work' } });
    await h.run();
    expect(h.containers[0]?.extra?.env).toMatchObject({ CLAUDE_CODE_OAUTH_TOKEN: 'work-token' });
    expect(h.calls.filter((c) => c.file === 'security')).toEqual([
      { file: 'security', args: ['find-generic-password', '-s', 'fractory.claude.work', '-w'] },
    ]);
    // The image is the repository's own; credentials are never part of it.
    expect(h.containers[0]?.image).toBe('chores:latest');
  });

  it('fails, saying which Keychain item is missing, before any worktree', async () => {
    const h = await setup({ keychain: {} });
    const final = await h.run();
    expect(final.result).toMatchObject({ outcome: 'failed' });
    expect(JSON.stringify(final.result)).toContain('fractory.claude.personal');
    expect(h.worktreeRequests).toEqual([]);
  });

  it('fails a Run whose configuration was not kept', async () => {
    const h = await setup({ keepRequest: false });
    const final = await h.run();
    expect(final.status).toBe('failed');
    expect(h.worktreeRequests).toEqual([]);
  });

  it('never touches a Ticket, commits or a pull request', async () => {
    const h = await setup();
    await h.run();
    const gitOrGh = h.calls.filter((c) => c.file !== 'security');
    expect(gitOrGh).toEqual([{ file: 'git', args: ['branch', '-D', `automation/${RUN_ID}`] }]);
  });

  it('leaves a finished Run alone', async () => {
    const h = await setup();
    await h.store.writeRun({ ...h.record, status: 'done' });
    const final = await h.run();
    expect(final.status).toBe('done');
    expect(h.worktreeRequests).toEqual([]);
  });
});

const PROMPT = 'Write the monthly report to $AUTOMATION_OUTPUT_DIR/report.md.\n';

const agent = (options: Options = {}) =>
  setup({
    files: { 'prompts/report.md': PROMPT },
    ...options,
    automation: {
      kind: 'agent',
      cli: 'claude',
      flags: ['-p', '--model', 'claude-sonnet-5-5'],
      entryPoint: 'prompts/report.md',
      ...options.automation,
    },
  });

describe('executeAutomationRun, Agent Automation', () => {
  it('runs the named CLI with its flags and the committed prompt, end to end', async () => {
    const h = await agent({
      container: async (_command, extra, onLine) => {
        await writeFile(join(hostPathOf(extra), 'report.md'), '# June\n');
        onLine('thinking...');
        onLine('Wrote report.md');
        return { stdout: 'thinking...\nWrote report.md\n', stderr: 'warn: slow', exitCode: 0 };
      },
    });
    const final = await h.run();

    expect(h.worktreeRequests).toEqual([
      { repoPath: h.repoPath, branch: `automation/${RUN_ID}`, baseRef: 'trunk' },
    ]);
    expect(h.commands).toEqual([`'claude' '-p' '--model' 'claude-sonnet-5-5' 2>&1`]);
    expect(h.stdins).toEqual([PROMPT]);

    const [container] = h.containers;
    expect(container?.image).toBe('chores:latest');
    expect(container?.outputExisted).toBe(true);
    expect(container?.extra?.mounts).toEqual([
      { hostPath: h.record.outputPath, sandboxPath: AUTOMATION_OUTPUT_MOUNT },
    ]);
    expect(container?.extra?.env).toMatchObject({
      [AUTOMATION_OUTPUT_ENV]: AUTOMATION_OUTPUT_MOUNT,
      CLAUDE_CODE_OAUTH_TOKEN: 'personal-token',
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    });

    const log = await readFile(h.record.logPath, 'utf8');
    expect(log).toContain('thinking...\nWrote report.md\n');
    expect(log).toContain('warn: slow\n');

    expect(final).toMatchObject({ status: 'done', result: { outcome: 'done' } });
    expect(await readFile(join(final.outputPath, 'report.md'), 'utf8')).toBe('# June\n');
    expect(h.events).toEqual(['container started', 'container closed', 'worktree closed']);
    expect(h.calls.filter((c) => c.file !== 'security')).toEqual([
      { file: 'git', args: ['branch', '-D', `automation/${RUN_ID}`] },
    ]);
  });

  it("resolves the credentials of the CLI's agent for the Automation's Mode", async () => {
    const h = await agent({
      automation: { cli: 'opencode', flags: ['run'] },
      keychain: { 'fractory.opencode.personal': 'oc-key' },
      container: async () => ({ stdout: 'ok', stderr: '', exitCode: 0 }),
    });
    const final = await h.run();
    expect(final.status).toBe('done');
    expect(h.calls.filter((c) => c.file === 'security')).toEqual([
      {
        file: 'security',
        args: ['find-generic-password', '-s', 'fractory.opencode.personal', '-w'],
      },
    ]);
    expect(h.containers[0]?.extra?.env).toMatchObject({ OPENCODE_API_KEY: 'oc-key' });
    expect(h.containers[0]?.image).toBe('chores:latest');
  });

  it('uses the work account in Work Mode', async () => {
    const h = await agent({
      automation: { mode: 'work' },
      container: async () => ({ stdout: 'ok', stderr: '', exitCode: 0 }),
    });
    await h.run();
    expect(h.containers[0]?.extra?.env).toMatchObject({ CLAUDE_CODE_OAUTH_TOKEN: 'work-token' });
  });

  it('fails a CLI that is not a known agent before any worktree', async () => {
    const h = await agent({ automation: { cli: 'gemini' } });
    const final = await h.run();
    expect(final.status).toBe('failed');
    expect(JSON.stringify(final.result)).toContain('Agent CLI gemini is not a known agent');
    expect(h.worktreeRequests).toEqual([]);
  });

  it('fails with a reason when the prompt is missing, without starting a container', async () => {
    const h = await agent({ files: {} });
    const final = await h.run();
    expect(final.status).toBe('failed');
    expect(final.result && 'summary' in final.result && final.result.summary).toMatch(
      /Entry point prompts\/report\.md is missing from the repository/,
    );
    expect(h.containers).toEqual([]);
    expect(h.commands).toEqual([]);
    expect(h.events).toEqual(['worktree closed']);
  });

  it('records an agent that printed nothing as failed, with its log path', async () => {
    const h = await agent({
      container: async (_command, _extra, onLine) => {
        onLine('   ');
        return { stdout: '  \n', stderr: '', exitCode: 0 };
      },
    });
    const final = await h.run();
    expect(final.status).toBe('failed');
    expect(final.result).toEqual({
      outcome: 'failed',
      summary: `claude printed nothing: no usable result; log: ${h.record.logPath}`,
    });
    expect(final.logPath).toBe(h.record.logPath);
  });

  it('records an agent that exited non-zero as failed with its log, never needs-human', async () => {
    const h = await agent({
      container: async (_command, _extra, onLine) => {
        onLine('Error: rate limited');
        return { stdout: 'Error: rate limited\n', stderr: '', exitCode: 1 };
      },
    });
    const final = await h.run();
    expect(final).toMatchObject({
      status: 'failed',
      result: {
        outcome: 'failed',
        summary: `claude exited with code 1 without a usable result; log: ${h.record.logPath}`,
      },
    });
    expect(await readFile(h.record.logPath, 'utf8')).toContain('Error: rate limited\n');
    // Nothing re-runs it: exactly one container and one command.
    expect(h.commands).toHaveLength(1);
    expect(h.containers).toHaveLength(1);
  });

  it('never records needs-human, even when the agent prints a needs-human result', async () => {
    const h = await agent({
      container: async () => ({
        stdout:
          '<result>{"outcome":"needs-human","reason":"ambiguous-spec","question":"Which?"}</result>',
        stderr: '',
        exitCode: 0,
      }),
    });
    const final = await h.run();
    expect(final.status).not.toBe('needs-human');
    expect(final.result?.outcome).not.toBe('needs-human');
  });
});

describe('agentCommand', () => {
  it('quotes the CLI and flags and leaves the prompt to stdin', () => {
    expect(
      agentCommand({
        cli: 'claude',
        flags: ['-p', '$(whoami)'],
        entryPoint: 'prompts/x.md',
      } as Automation),
    ).toBe(`'claude' '-p' '$(whoami)' 2>&1`);
  });
});

describe('agentKindOf', () => {
  it('names the agent by the CLI file name', () => {
    expect(agentKindOf('claude')).toBe('claude');
    expect(agentKindOf('/usr/local/bin/opencode')).toBe('opencode');
    expect(() => agentKindOf('bash')).toThrow(/not a known agent/);
  });
});

describe('automationCommand', () => {
  it('quotes every word so the flags reach the CLI verbatim', () => {
    expect(
      automationCommand({
        cli: 'python3',
        flags: ['-u', '$(rm -rf /)'],
        entryPoint: 'chores/run me.py',
      } as Automation),
    ).toBe(`'python3' '-u' '$(rm -rf /)' 'chores/run me.py' 2>&1`);
  });
});
