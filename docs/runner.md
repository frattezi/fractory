# Run executor

`launchRun` (`src/runner/index.ts`) starts a queued Run as a detached host process
(`node --import tsx src/cli.ts run-exec <id>`) and records `pid` and `status: running` before it
returns. The host process calls `executeRun(runId, deps)` (`src/runner/execute.ts`).

## What a Run does

1. Reads the Ticket, `rules/run-agent.md` and, for follow-up Runs, the failing CI log
   (`gh run list --commit` + `gh run view --log-failed`) or the review comment (`gh api`).
2. Creates the Run's worktree through Sandcastle (`createWorktree`, branch strategy `branch` on
   `record.branch`) and installs a `pre-push` hook that refuses `main`, `master` and the base
   branch, then chains to the repository's own `pre-push` hook.
3. Runs the Claude Code agent in a Docker sandbox for up to `maxIterations` iterations.
4. Reads the last `<result>{...}</result>` block from the agent's output and validates it with
   `RunResultSchema`. Missing or invalid is `failed`; no completion signal before the iterations
   ran out is `needs-human` / `budget-exhausted`.
5. On `done`: checks the branch has commits, (Work Mode) checks every commit message with
   `assertOutboundAllowed`, pushes, opens the PR or reuses the open one, moves the Ticket to
   `in_review`. `failed` and `needs-human` never push or open a PR.
6. `needs-human`: Personal Mode comments the question on the Ticket; Work Mode never posts it.

Structured output uses our own tag parsing rather than Sandcastle's `Output.object`, because
Sandcastle requires `maxIterations: 1` with it.

## Docker setup

Build the sandbox image once per repository (`sandcastle docker build-image`) and set its name in
`.fractory.json` as `sandboxImage`.

## Claude Code authentication in Docker

The sandbox has no access to the host's Claude login. Export one of these in the environment of
the process that launches Runs (shell profile, launchd plist or `.env` you do not commit):

- `CLAUDE_CODE_OAUTH_TOKEN`: a long-lived token for a Claude subscription (`claude setup-token`).
- `ANTHROPIC_API_KEY`: an API key.

The executor forwards only these two variables, plus `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, into the
sandbox. They are never written to the log or the registry. `gh` uses its own authentication on
the host (`gh auth login` or `GH_TOKEN`); the sandbox does not receive it.

`FRACTORY_MODEL` overrides the agent model (default `claude-opus-5-5`).

## Tests

`tests/runner-*.test.ts` inject Sandcastle, `git`, `gh` and the `TicketSource`; no Docker or
network. The `pre-push` script is exercised with a real `sh`.
