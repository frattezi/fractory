# Run executor

`launchRun` (`src/runner/index.ts`) starts a queued Run as a detached host process
(`node --import tsx src/cli.ts run-exec <id>`) and records `pid` and `status: running` before it
returns. The host process calls `executeRun(runId, deps)` (`src/runner/execute.ts`).

## What a Run does

1. Reads the Ticket, `rules/run-agent.md` and, for follow-up Runs, the failing CI log
   (`gh run list --commit` + `gh run view --log-failed`), the review comment (`gh api`) or, for an
   `answer` Run, the owner's answer (`<runId>.answer.json`) and the answered Run's reason and
   question from the registry. The answer goes into the prompt as data, stated as the owner's
   binding decision; a part that cannot be read makes the prompt point at the Ticket's comments.
2. Creates the Run's worktree through Sandcastle (`createWorktree`, branch strategy `branch` on
   `record.branch`) from the Run's own base branch — `record.baseBranch` when it has one, the
   repository's `baseBranch` otherwise — and installs a `pre-push` hook that refuses `main`,
   `master` and that base branch, then chains to the repository's own `pre-push` hook. A Run that
   names no base of its own behaves exactly as one on the repository's base branch.
3. Loads the flow named by `.fractory.json` (`flow`, default `build`) from `flows/<name>.ts` and
   calls it with the worktree, the Docker sandbox and Mode-wired agents (see `docs/flows.md`). The
   flow decides how agents work and returns a `RunResult`.
4. Validates the result with `RunResultSchema`; a throw or an invalid value is `failed`. The
   `build` flow reads the last `<result>{...}</result>` block: missing or invalid is `failed`, no
   completion signal before the iterations ran out is `needs-human` / `budget-exhausted`. The Run
   record gets `mode`, `flow`, `agents` (e.g. `claude@work`) and `sessionId`.
5. On `done`: checks the branch has commits, (Work Mode) checks every commit message with
   `assertOutboundAllowed`, pushes, opens the PR against the Run's base branch or reuses the open
   one, moves the Ticket to `in_review`. Auto-merge refuses any PR whose base is not the
   repository's base branch, so a Run built on another Run's branch cannot land before it. `failed` and `needs-human` never push or open a PR.
6. `needs-human`: Personal Mode comments the question on the Ticket; Work Mode never posts it.

Structured output uses our own tag parsing rather than Sandcastle's `Output.object`, because
Sandcastle requires `maxIterations: 1` with it.

## Docker setup

Build the sandbox image once per repository (`sandcastle docker build-image`) and set its name in
`.fractory.json` as `sandboxImage`.

## Accounts and credentials

The account follows the Mode, with no override: Work Mode runs `claude@work`; Personal Mode runs
`claude@personal` and may run `opencode@personal`. OpenCode is refused in Work Mode.

Secrets live in the macOS Keychain and are read at run time with
`security find-generic-password -s <service> -w` (through an injectable exec). They are never
logged, never written to disk or the registry, and the host's own `CLAUDE_CODE_OAUTH_TOKEN` and
`ANTHROPIC_API_KEY` are ignored. Add the items once; you type the secret at the prompt:

```sh
# Claude subscriptions: run `claude setup-token` logged in to the right account, paste the token
security add-generic-password -s fractory.claude.work -a "$USER" -w
security add-generic-password -s fractory.claude.personal -a "$USER" -w
# OpenCode Go API key (Personal Mode only)
security add-generic-password -s fractory.opencode.personal -a "$USER" -w
```

| Profile | Keychain service | Env var in the sandbox |
| --- | --- | --- |
| `claude@work` | `fractory.claude.work` | `CLAUDE_CODE_OAUTH_TOKEN` |
| `claude@personal` | `fractory.claude.personal` | `CLAUDE_CODE_OAUTH_TOKEN` |
| `opencode@personal` | `fractory.opencode.personal` | `OPENCODE_API_KEY` |

A missing item ends the Run as `needs-human` / `needs-access` with the exact command above. Any
other Keychain failure (locked keychain) fails the Run: it proves nothing about the item.

The credential reaches the sandbox only as the agent provider's `env` (`claudeCode(model, { env })`).
Sandcastle merges env as `.sandcastle/.env` < sandbox provider env < agent provider env, so the
provider value wins for the same key. But a key defined only in `.sandcastle/.env` (for example
`ANTHROPIC_API_KEY` next to a Claude OAuth token) would still be forwarded, and an empty entry
falls back to the host's `process.env`. So `.sandcastle/.env` must not contain
`CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY` or `OPENCODE_API_KEY`: a Run whose repository has any
of them there fails before starting. `GH_TOKEN` and other keys are fine there. `gh` itself uses its
own authentication on the host; the sandbox does not receive it.

Open question, OpenCode: Sandcastle's own `opencode` init template documents `OPENCODE_API_KEY` as
the variable, and OpenCode's Go docs use `OPENCODE_API_KEY` as the key for its HTTP API; the docs
also store keys through `/connect` (its `auth.json`), and model ids look like
`opencode-go/<model>`. We have not run `opencode run` in a sandbox with only that variable, so
confirm it on the first Personal Mode OpenCode Run. If it is not picked up, the fallback is to
mount an `auth.json` through the Docker sandbox's `mounts`.

Models: `FRACTORY_MODEL` overrides the default Claude model (`claude-opus-5-5`);
`FRACTORY_OPENCODE_MODEL` the default OpenCode model (`opencode-go/kimi-k3`). Flows can pass their
own model to `ctx.agents.claude(model)` / `ctx.agents.opencode(model)`.

## Tests

`tests/runner-*.test.ts` inject Sandcastle, `git`, `gh` and the `TicketSource`; no Docker or
network. The `pre-push` script is exercised with a real `sh`.
