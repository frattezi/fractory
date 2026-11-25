# Spec 0001: Fractory v1

Status: accepted (grilling session, 2026-11-24). Vocabulary: [GLOSSARY.md](../../GLOSSARY.md).
Decisions: [ADR 0001–0004](../adr/).

## Goal

Turn an approved Spec into merged code with the owner stepping in only at Gates. Tickets come from
Jira (Work Mode repos) or GitHub Issues (Personal Mode repos); Runs execute through Sandcastle in
Docker; the owner watches and reviews in a fork of Agent Manager. Every step that has a right answer
is tested TypeScript, runnable without a model.

## Non-goals for v1

- A UI of Fractory's own (ADR 0001).
- An LLM judge or diff risk scoring (v0 had both; revisit after v1 runs for real).
- Answering a Run's questions automatically from written sources (v0 `answerer`; revisit).
- Scheduled Triggers, cost tracking, release-branch sync, Ticket dependency ordering.
- Cloud sandboxes.

## Flow

```
Goal ──grill──▶ Spec ──[Spec Gate]──▶ to-tickets ──▶ Tickets ──[Ticket Gate*]──▶ Ready
Ready ──Trigger──▶ Run (Sandcastle, Docker, worktree) ──▶ PR
PR ──CI red──▶ Trigger ──▶ new Run on the same branch
PR ──review comment──▶ Trigger ──▶ new Run on the same branch
PR ──Personal Mode, Run done, mergeable, checks passing or none──▶ auto-merge ──▶ Ticket done ──▶ worktree cleanup
PR ──Personal Mode, checks pending──▶ wait (never merge while pending or failing)
PR ──Work Mode──▶ [PR Gate] human merges ──▶ Ticket done ──▶ worktree cleanup
```
\* Ticket Gate: always in Work Mode, opt-in in Personal Mode. Passing it means moving Tickets to
Ready; with the Gate off, `to-tickets` creates them Ready.

## Shared contracts (done — `src/contracts/`, `src/registry/`, `src/policy/`)

- `RepoConfig` at `<repo>/.fractory.json`: mode, ticket source, `hasCi`, `ticketGate`, base branch,
  sandbox image, `maxIterations`, `flow`. `requiresPrGate`, `requiresTicketGate` and
  `src/policy/workflow.ts` (`mayAutoMerge`, `describeWorkflow`, shown by `fractory rules`) are the
  only workflow logic.
- `FactoryConfig` at `~/.fractory/config.json` (`FRACTORY_HOME` overrides): repo paths,
  `maxConcurrentRuns` (3), `staleWorktreeDays` (7), registry and log dirs.
- `Ticket`, `TicketRef` (`github:owner/name#N` | `jira:KEY-N`), `TicketSource` interface.
- `RunRecord` (version 1), one JSON file per Run in the registry; `runKey()` gives the idempotency
  key; `RunResult` = `done | failed | needs-human{reason, question}` with reasons
  `ambiguous-spec | needs-access | destructive-op | budget-exhausted`.
- `RunRegistry`: atomic writes, corrupt files skipped.
- `assertOutboundAllowed(text, mode)`: in Work Mode, anything sent to a shared system (tracker
  comment, PR title/body, commit message, branch name) must pass; it throws otherwise.

Changing a contract is a change for every part: do it in its own commit, update all callers.

## Parts

### A. Fractory package (rules and skills) — `skills/`, `rules/`

1. Skills, adapted to our vocabulary and following the Agent Skills spec: `grill-with-docs`,
   `to-spec` (writes `docs/specs/NNNN-*.md` and stops at the Spec Gate), `to-tickets` (creates
   Tickets through `fractory tickets create`, Ready only when the repo's Ticket Gate is off),
   `quick-ticket` (a brief from a conversation in place of a Spec, ADR 0006), `fractory` (how
   interactive agents work next to the factory), `research`, `handoff`. Each skill only routes and phrases; anything deterministic is a
   `fractory` CLI subcommand.
2. `rules/run-agent.md`: the instructions every Run's agent receives: work only on the Ticket,
   commit to the Run branch, never push to the base branch, end with a `RunResult`, stop with
   `needs-human` only for the four reasons, never write Fractory/AI mentions in Work Mode text.
3. `fractory init <repo>`: writes a `.fractory.json` from flags (no prompts) and validates it.
4. Install doc: how a Claude Code session loads Fractory (copies skills into `~/.claude/skills` via
   `fractory install`, plus ai-memory setup, plus `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` for Runs).

### B. Ticket adapters — `src/adapters/`

- `createTicketSource(config)` returns the GitHub or Jira implementation of `TicketSource`.
- GitHub: through the `gh` CLI (`gh issue list/view/edit/comment --json`). Status lives in labels
  `fractory:ready | fractory:in-progress | fractory:in-review`; closed issue = `done`; no label =
  `backlog`. `setStatus` swaps labels atomically from the caller's point of view.
- Jira: REST v3 with `JIRA_EMAIL` + `JIRA_API_TOKEN` from the environment (never logged). Status
  mapping from `RepoConfig.ticketSource.statuses`; `setStatus` applies the transition whose target
  is that status. Description ADF is flattened to text.
- Every tracker response is validated with `TicketSchema` at the boundary.
- `comment()` and any text written calls `assertOutboundAllowed` with the repo's Mode.
- HTTP 429/5xx: retry with backoff (v0 lesson: Plane 429).
- Tests stub `gh` and `fetch`; no network.

### C. Run executor — `src/runner/`

- `launchRun(record, config)`: spawns a detached `fractory run-exec <id>` host process, records
  `pid` and `status: running` **before** returning (v0 lesson: record the attempt before
  launching, or a crash loop relaunches forever).
- `run-exec`: uses `@ai-hero/sandcastle` `run()` with the Docker sandbox, Claude Code agent,
  `branchStrategy: 'branch'` on `record.branch`, `maxIterations` from config, the prompt built from
  `rules/run-agent.md` + the Ticket + (for follow-up Runs) the failing CI log or review comment.
  Structured output validated with `RunResultSchema`; missing/invalid output = `failed`.
  Iterations exhausted = `needs-human/budget-exhausted`.
- After the agent: push the branch, open the PR (or update it), Ticket → `in_review`, write
  `worktreePath`, `sessionId`, `prUrl`, `result`, `finishedAt`, final status.
- Every worktree gets a `pre-push` hook refusing pushes to the base branch, `main` and `master`,
  chaining to the repo's own hook (v0 lesson: workers pushed to main).
- `needs-human`: in Personal Mode, comment the question on the Ticket; in Work Mode never post it
  to the tracker — the registry and Agent Manager are the only places it appears.
- PR title/body and commit messages go through `assertOutboundAllowed`; in Work Mode no
  attribution trailers are added.
- Logs stream to `record.logPath`.
- Tests: Sandcastle and git/gh are injected and stubbed.

### D. Trigger tick, merge and cleanup — `src/trigger/`, `src/cleanup/`, `src/cli.ts`, `launchd/`

- `fractory tick`: one-shot and idempotent, run by launchd every 3 minutes. For each repo in
  `FactoryConfig.repos`:
  1. Mark dead Runs: `running` with a pid that no longer exists → `failed` (a failed check of
     process or PR state proves nothing — skip, don't mark).
  2. For each Run with a PR, read it in any state (`gh pr view --json
     state,mergeable,statusCheckRollup,reviews,comments,headRefOid`):
     - MERGED → Ticket `done`, Run kept for cleanup.
     - Every read records `prState` (`OPEN|MERGED|CLOSED`) on the PR's Runs; Runs whose `prState` is
       `MERGED` or `CLOSED` are not read again (it is recorded only after the Ticket moved to
       `done`, so a failure is retried).
     - CI failed on head sha → Trigger `ci-failed` (key includes sha).
     - New review comment not by the factory → Trigger `review-comment` (key includes comment id).
     - `mayAutoMerge` (`src/policy/workflow.ts`): Personal Mode, the Ticket's latest Run `done`,
       `mergeable == MERGEABLE`, checks `passing` or `none` (no CI) → `gh pr merge --squash`.
       Never while checks are `pending` or `failing`, never in Work Mode, never a conflicting PR
       (v0 lesson). Merges are never a Gate in Personal Mode (ADR 0005).
  3. Review comments from Agent Manager: for each Run with `<registryDir>/<runId>.comments.json`
     (`RunCommentsFileSchema`, written atomically by Agent Manager, never modified by Fractory),
     queue one `review-comment` Trigger batching the comments no earlier Run consumed, keyed by
     `commentId = am:<newest comment id>`, on the Ticket's latest Run branch, only when no Run on
     the Ticket is queued/running. Consumption is derived from existing Run keys (idempotent).
     The executor reads the same file for `am:` ids and feeds path, line and body to the agent.
     An invalid file is logged and skipped. `RunRegistry.list()` ignores `*.comments.json`.
  4. Tickets `listReady()` without a Run for key `ticket-ready` → Trigger `ticket-ready`
     (Ticket → `in_progress`).
  5. Start queued Runs only into free slots: active Runs < `maxConcurrentRuns`, oldest first.
     After a reboot this prevents relaunching everything at once (v0 lesson). With
     `FactoryConfig.resources` set, each launch also needs the host under its limits (1-minute load
     per core, macOS available memory) and at most `maxLaunchesPerTick` Runs start per tick; held
     Runs stay queued and `tick` reports why (`held`). An unreadable value never holds Runs.
  - Each repo and each Run is wrapped so one failure never stops the rest; errors are logged.
  - A per-tick lock file prevents overlapping ticks.
- Follow-up Runs reuse the PR's branch so Sandcastle's `branch` strategy continues it.
- `fractory cleanup` (also called at the end of `tick`): delete a Run's worktree only when it is
  clean and its PR is merged, or when the Run failed more than `staleWorktreeDays` ago; match by the
  recorded `worktreePath`, never by name (v0 lesson); prune branches Sandcastle left behind. After removing a worktree, cleanup sets `cleanedAt` on its
  Runs and skips Runs that have it. `prState` and `cleanedAt` are optional `RunRecord` fields, so
  the record stays version 1.
- `fractory runs` lists the registry; `fractory run <ticketRef>` queues a `manual` Run.
- `launchd/com.fractory.tick.plist` template + `fractory launchd install`: sets PATH to include
  `node`, `claude`, `gh`, `docker`; git over HTTPS via `gh auth setup-git` (v0 lesson: SSH fails
  under launchd).

### E. Agent Manager fork: Runs view — separate repo (`frattezi/agent-manager`)

- A read-only "Runs" group fed by the registry directory (fsnotify or poll), one row per Run:
  Ticket, status, branch, PR link, needs-human question.
- Actions: open the Run's log in a terminal tab; open the existing diff review on `worktreePath`;
  review comments on a Run are written atomically to `<registryDir>/<id>.comments.json`
  (`{ version: 1, comments: [{ id, path, line, body, createdAt }] }`, `RunCommentsFileSchema` in
  `src/contracts/run.ts`) and the next `tick` turns them into a `review-comment` Trigger. Agent
  Manager owns the file; Fractory never rewrites or deletes it.
- Smallest possible diff against upstream; no change to existing session behaviour.

## Build order

The contracts are done, so A, B, C, D and E proceed in parallel. D calls `createTicketSource` and
`launchRun` through the stubs in `src/adapters/index.ts` and `src/runner/index.ts`. Integration
happens on `frattezi/reset-v1`; each part lands with its tests passing and `pnpm typecheck`, `pnpm
test` and `pnpm lint` green.

## Open questions (do not block v1)

- Docker auth for Claude Code inside the sandbox: OAuth token via env (`CLAUDE_CODE_OAUTH_TOKEN`)
  or API key. Part C documents whichever works.
- Whether Agent Manager's existing Claude session resume can open a Run's captured conversation
  (ADR 0002 says not to rely on it).
