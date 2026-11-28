# Spec 0007: Errand, an agent on the repository's Account outside a Run

Status: accepted (2026-11-27). Vocabulary: [GLOSSARY.md](../../GLOSSARY.md).

## Goal

The owner wants a second kind of work to borrow the factory's Accounts: reviewing a
pull request with several agents at once. The code being reviewed belongs to an
employer, so the agents reading it must run on the work Account, and today the only
thing that can reach an Account is a Flow inside a Run. A Run is one agent attempt at
one Ticket, and a colleague's pull request has no Ticket — so the reviewer cannot use
the factory at all without pretending its pull requests are Tickets.

So Fractory gains one command, `fractory errand`, that starts an **Errand**, a single agent on demand: on the Account its
repository's Mode selects, in the sandbox that repository declares, in a directory the
caller names, with a prompt the caller wrote, returning what the agent produced. It
owns no branch, no worktree, no Ticket and no Run record, and it decides nothing about
the work. Everything else — which pull requests matter, how they are examined, what is
found — stays outside Fractory, in the tool that calls this.

## Non-goals

- **Not a Run.** An Errand is not a Run. Nothing is written to the Run registry, no Ticket status moves, no
  pull request is opened, no Trigger fires, and `fractory runs` does not list it.
- **No worktree, no branch.** The caller provides the directory. Fractory does not
  create, move, clean up or reason about it, and never pushes.
- **No choreography.** One command, one agent. Several agents, retries, ordering and
  the meaning of their output belong to the caller. A Flow is still how the factory
  sequences agents for a Ticket.
- **No new Account rules.** The Account still follows the Mode and still cannot be
  overridden, and Work Mode still allows Claude only.
- **Not a queue.** Host Limits hold Runs; they do not hold this. The caller decides how
  many agents to start at once.

## Solution

```
fractory errand --repo <path> --prompt-file <path> [--model <id>] [--cwd <dir>]
                    [--name <label>] [--max-iterations <n>] [--json]
```

`--repo` names a configured repository: its `.fractory.json` gives the Mode, which
gives the Account, and its `sandboxImage`, which gives the sandbox. `--prompt-file` is
the prompt, as a file, because a review prompt is long and lives in version control.
`--cwd` is where the agent runs, defaulting to the repository itself; it may be any
directory, including a git worktree the caller made, and the agent sees that directory
and nothing above it. `--model` picks the model, defaulting as a Run does. `--name`
labels the log.

The command prints what the agent produced on stdout and exits 0 when the agent
finished. With `--json` it prints one object: the text the agent returned, the model and
Account it ran on, whether it ran sandboxed or on the host, the log file's path, and the
iterations used. A missing Keychain item, an agent the Mode does not allow, an
unreadable repository or an unreadable prompt file each exit non-zero with the reason on
stderr, and the one for a missing credential says which `security add-generic-password`
command would fix it, as a Run's question already does.

Sandboxing follows the repository: a repository that declares `sandboxImage` runs the
agent in that image, and one that does not runs it on the host. The `--json` output says
which, because a finding from a sandboxed agent and one from a host agent are not the
same evidence.

## User stories

1. As the owner, I want to start one agent on a repository's Account without a Ticket, so
   that work which is not a Ticket can still use the right subscription.
2. As the owner, I want a work repository's agent to run on the work Account with no way
   to ask for the personal one, so that employer code is never read on my own account.
3. As the owner, I want the agent to run in a directory I name, so that I can have it read
   a checkout I prepared myself.
4. As the owner, I want to pass the prompt as a file, so that the prompts live in version
   control and are reviewed like code.
5. As the owner, I want to choose the model per call, so that a cheap agent and an
   expensive one can be mixed by the caller.
6. As the owner, I want the agent's own output back, with nothing added to it, so that the
   caller can validate it against its own schema.
7. As a calling tool, I want `--json` to tell me the Account, model, sandboxing and log
   path, so that I can record how a result was produced and not just what it said.
8. As a calling tool, I want a non-zero exit and a single-sentence reason for every
   refusal, so that I can distinguish a missing credential from a bad prompt file.
9. As the owner, I want a missing Keychain item to name the command that creates it, so
   that the remedy is in the error as it is in a Run's question.
10. As the owner, I want this command to leave the Run registry untouched, so that
    `fractory runs`, `fractory status` and Doctor keep describing Tickets only.
11. As the owner, I want several of these running at once without the factory holding
    them, so that a caller can fan out and take responsibility for the load.
12. As the owner, I want the command to refuse a repository the factory does not know,
    so that a path typo cannot silently run on a default Account.
13. As the owner, I want a log file per call under the usual log directory, so that I
    can read what an agent did after the fact.

## Implementation decisions

A new `errand` branch in `src/cli.ts`, dispatching to a new module beside the
runner. It reuses, unchanged: `loadRepoConfig` for the Mode and `sandboxImage`,
`profileFor` and `accountFor` for the Account and the Work Mode restriction,
`resolveCredentials` for the Keychain read and its `MissingCredentialError`, the
`BASE_AGENT_ENV` and credentials-last ordering so nothing in the environment can
override the Account, and `FactoryConfig.resources.cpusPerRun` for the container's CPU
cap.

`SandcastleAdapter` gains one method, which wraps Sandcastle's top-level `run`:

```ts
runAgent(options: {
  agent: AgentProvider;
  sandbox: SandboxProvider;
  cwd: string;
  promptFile: string;          // absolute: Sandcastle resolves it against process.cwd()
  maxIterations: number;
  logging: { type: 'file'; path: string };
  name?: string;
}): Promise<{ stdout: string; iterations: number; logFilePath?: string }>;
```

`run` is the right call rather than `createWorktree` or `createSandbox`, because both of
those require a branch and anchor a worktree under `.sandcastle/worktrees/`, which is
exactly what this command must not own. `run` accepts a `cwd` and defaults to
`branchStrategy: { type: 'head' }` for bind-mount sandboxes, which is what running in a
directory the caller prepared means. A repository with no `sandboxImage` uses
Sandcastle's `no-sandbox` provider.

The directory is validated as external input: it must exist and be a directory. Whether
Sandcastle's `head` strategy accepts a checkout with a detached `HEAD` is the one thing
this Spec cannot settle from the types; if it refuses, the caller's remedy is a local
branch in its own worktree, and this command needs no change either way.

Nothing in `src/registry/`, `src/trigger/`, `src/policy/` or `src/status/` is touched. No
new field appears in `RunRecord` and no migration-shaped change exists here, because
there is no record.

## Testing decisions

One seam, and it already exists: `SandcastleAdapter` is the slice of Sandcastle the
executor uses and tests replace it with a fake, no Docker needed. The second existing
seam is `Exec`, which `tests/credentials.test.ts` already fakes for the Keychain read.
The command is therefore tested end to end from its argument list, with both fakes, in
`tests/errand.test.ts`, asserting external behaviour only:

- a Work Mode repository resolves `claude@work` and a Personal Mode one `claude@personal`,
  read from the asserted Keychain service name;
- the credential env reaches the agent provider and cannot be overridden by the
  environment or by the caller;
- `opencode` in Work Mode is refused with `AgentNotAllowedError`;
- a repository declaring `sandboxImage` gets a sandbox with that image and the
  configured CPU cap; one without gets the no-sandbox provider, and `--json` reports
  which in both cases;
- the agent's stdout is returned unaltered, including output that is not valid JSON,
  because validating it is the caller's job;
- a missing Keychain item exits non-zero and the message contains the
  `security add-generic-password` remedy;
- a `--repo` that is not in the factory config, a `--cwd` that is not a directory, and a
  missing `--prompt-file` each exit non-zero with their own reason;
- the Run registry is unchanged after a call: prior art for asserting that is
  `tests/registry.test.ts`.

Prior art for the command's own wiring is `tests/cli.test.ts`; for the agent and Account
rules, `tests/agents.test.ts` and `tests/credentials.test.ts`.

## Open questions

- Whether a later Flow should call this command rather than `ctx.agents`, so that there
  is one path to an agent. Not now: a Flow has a worktree and a Run record and this does
  not.
