import { access, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  ModeSchema,
  REPO_CONFIG_FILE,
  type RepoConfig,
  RepoConfigSchema,
} from '../contracts/repo-config.ts';

const JiraStatusesFlagsSchema = z.object({
  ready: z.string(),
  inProgress: z.string(),
  inReview: z.string(),
  done: z.string(),
});

/** Flat, prompt-free options as `fractory init <repo>` receives them from flags. */
export const InitOptionsSchema = z
  .object({
    repoPath: z.string().min(1),
    mode: ModeSchema,
    hasCi: z.boolean(),
    /** GitHub Issues as the Ticket source: `owner/name`. Mutually exclusive with `jira`. */
    github: z.string().optional(),
    jira: z
      .object({
        baseUrl: z.string(),
        projectKey: z.string(),
        statuses: JiraStatusesFlagsSchema,
      })
      .optional(),
    ticketGate: z.boolean().optional(),
    baseBranch: z.string().optional(),
    sandboxImage: z.string().optional(),
    maxIterations: z.number().optional(),
    /** Overwrite an existing `.fractory.json`. */
    force: z.boolean().default(false),
  })
  .refine((o) => (o.github === undefined) !== (o.jira === undefined), {
    message: 'Provide exactly one Ticket source: github or jira',
  });
export type InitOptions = z.input<typeof InitOptionsSchema>;

/** Builds the config from options and validates it with the shared schema. Throws a ZodError. */
export const buildRepoConfig = (input: InitOptions): RepoConfig => {
  const o = InitOptionsSchema.parse(input);
  return RepoConfigSchema.parse({
    mode: o.mode,
    ticketSource: o.github ? { kind: 'github', repo: o.github } : { kind: 'jira', ...o.jira },
    hasCi: o.hasCi,
    ...(o.ticketGate !== undefined && { ticketGate: o.ticketGate }),
    ...(o.baseBranch !== undefined && { baseBranch: o.baseBranch }),
    ...(o.sandboxImage !== undefined && { sandboxImage: o.sandboxImage }),
    ...(o.maxIterations !== undefined && { maxIterations: o.maxIterations }),
  });
};

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

/** Writes `<repo>/.fractory.json`. Refuses to overwrite one unless `force` is set. */
export const initRepo = async (
  input: InitOptions,
): Promise<{ path: string; config: RepoConfig }> => {
  const config = buildRepoConfig(input);
  const { repoPath, force } = InitOptionsSchema.parse(input);
  const path = join(repoPath, REPO_CONFIG_FILE);
  if (!force && (await exists(path))) {
    throw new Error(`${path} already exists; pass force to overwrite it`);
  }
  await mkdir(repoPath, { recursive: true });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return { path, config };
};
