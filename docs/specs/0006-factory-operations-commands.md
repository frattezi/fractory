# Spec 0006: Factory Operations Commands

Status: accepted (2026-11-27). Vocabulary: [GLOSSARY.md](../../GLOSSARY.md). Builds on
[Spec 0002](0002-host-limits-and-re-runs.md) and [Spec 0005](0005-owner-answers.md). The
conversational half is Spec 0005 in `frattezi/agent-manager`.

## Goal

The factory runs five repositories and the only thing watching it is the owner. There is no
one place that answers "what needs me right now" across all of them: `fractory status` takes a
single repository, `fractory runs` lists Runs without saying which are stuck, and a Run that
stopped `needs-human` three days ago in a repository the owner has not opened since is
invisible until they go looking. The checks that matter most are the ones nobody thinks to
make — whether the launchd agent is even loaded, whether a `rebuild` would compile a dirty
checkout and report success.

Two adjustments have the same problem. Host Limits exist and hold Runs back correctly, but
changing them means opening `~/.fractory/config.json` in an editor: there is no command, no
validation, and no way to see the reading that triggered the hold next to the limit that
caused it. And nothing anywhere records what a Run cost. The data exists — every Run record
carries its `sessionId`, and the agent CLI's own transcript carries exact per-message usage —
but nothing joins the two, so the owner has no idea whether a Ticket cost ten thousand tokens
or a million.

Three commands close all of it, and each is useful to the owner by hand on the day it lands.
Everything they compute is deterministic: an agent asked to keep the factory running needs
eyes and hands, not a longer prompt.

## Non-goals

- **Changing anything in `doctor`.** It performs no git operation, starts no Run, writes no
  file. `cleanup` owns mutation and keeps it. A Finding names the command that would fix it.
- **An agent, a schedule or a trigger.** Nothing here reacts to a state change or runs on a
  clock. These are commands the owner or a Bot invokes.
- **Stopping a running Run.** Lowering a limit never kills what is already running, as
  Host Limits has always worked.
- **A notification channel.** Doctor prints. Who reads it, and when, is not its concern.
- **Token accounting for agents without a transcript.** Opencode writes no equivalent file.
  Those Runs are reported as unmeasured and counted, never estimated.
- **Cost attribution for interactive sessions.** Only Runs the registry knows about. The
  owner's own chats are their business.
- **Repositories Fractory does not manage.** Every command walks the configured repository
  list. A directory under `~/Work` with no `.fractory.json` is not a Finding; a *configured*
  repository that is unreachable is.
- **Per-Ticket budgeting or enforcement.** `tokens` reports. `maxIterations` remains the only
  budget, and it counts iterations, not tokens.

## Solution

**`fractory doctor [repoPath...]`** sweeps every configured repository — all of them by
default, the named ones when given, following `rebuild` rather than `status` — and prints
Findings grouped by repository, with `--json` for a machine. It reports: a Run that stopped
`needs-human`, with its question; a Run that `failed` or exhausted its budget; an open pull
request whose latest Run is done but which has not merged; a Ticket that is Ready with no Run
and no pull request; a Held Ticket whose blockers are all satisfied; a worktree older than
`staleWorktreeDays`; the queue Held over Host Limits, with the reading that holds it; a
repository whose `rebuild` list would compile a dirty or behind checkout; a configured
repository that is unreachable or whose `.fractory.json` will not parse; and the launchd agent
not loaded, which means no tick is running at all.

A Finding carries what was observed, the repository it concerns, a severity, and the remedy as
text. The sweep exits 0 whenever it completed, however much it found: a Script Automation
wrapping it must be able to tell "three Tickets need you" from "doctor crashed".

**`fractory limits`** prints one picture of the machine: the current reading from
`src/policy/resources.ts` beside each limit it is checked against, the queue's held state and
depth from `host.json`, and `maxConcurrentRuns` beside how many Runs are actually running.
**`fractory limits set <key>=<value>...`** writes `~/.fractory/config.json` atomically, one or
several keys at a time. Every key has a hard range in the command's own code, derived from the
machine where the machine decides it — `cpusPerRun` never above the core count,
`maxConcurrentRuns` never above cores divided by `cpusPerRun`. A value outside its range is
**refused**, with the range in the error, and nothing is written. Nothing is ever clamped
silently: a caller that asked for 32 and got 8 has learned that its request succeeded.

**`fractory tokens [--since <date>] [--repo <path>]`** joins the Run registry to the agent's
transcripts. Every Run record carries `sessionId`; the transcript is found by searching
`~/.claude/projects/*/<sessionId>.jsonl` rather than by deriving a path from the repository,
because a Run's working directory is a worktree and its slug is not the repository's. The
command sums input, output, cache-creation and cache-read tokens per Run and rolls them up per
repository and per day. A Run whose transcript is missing, or which ran on an agent that keeps
none, is listed as unmeasured with its count in the total line, so a cost report never
silently omits work.

## User stories

1. As the owner, I want one command that tells me what needs me across every repository, so that a Run that stopped three days ago in a repository I have not opened is not invisible.
2. As the owner, I want each Finding to name the command that fixes it, so that reading the report and acting on it are the same motion.
3. As the owner, I want Doctor to tell me when no tick is running, so that a silent factory is distinguishable from an idle one.
4. As the owner, I want Doctor to warn me when a `rebuild` would compile a dirty or behind checkout, so that "I rebuilt it" and "I am running the new code" stop being different things I cannot tell apart.
5. As the owner, I want Doctor to change nothing, so that I can run it at any time, from anywhere, without thinking about it.
6. As the owner, I want Doctor to exit 0 when it finds problems, so that wrapping it in a script does not turn every Finding into a failed job.
7. As the owner, I want to see the reading that is holding the queue next to the limit it crossed, so that I know whether to raise the limit or close something.
8. As the owner, I want to change a limit with one command, so that adjusting parallelism does not mean editing JSON.
9. As the owner, I want an out-of-range limit refused with its range, so that I cannot wedge the machine by asking confidently for the wrong number.
10. As the owner, I want to know what a Run cost, so that I can tell an expensive Ticket from a cheap one.
11. As the owner, I want unmeasured Runs counted and labelled, so that a cost total never quietly understates itself.
12. As the owner, I want all three commands to print for a human and emit `--json`, so that the same command serves me and a Bot.

## Implementation decisions

- **Three modules, one shape each**: `src/doctor/`, `src/limits/`, `src/tokens/`, each exporting
  a pure function over injected readers plus a thin CLI binding in `src/cli.ts`. Every external
  process — git, `gh`, `launchctl`, the filesystem, `docker` — is injected the way
  `HostProcesses` already is in `src/policy/resources.ts`, so tests never touch the machine.
- **One traversal.** Doctor reads the configured repository list once and gathers every
  repository's state in parallel, reusing `src/status` rather than reimplementing it. A
  repository that throws yields an unreachable Finding and never fails the sweep.
- **Findings are data.** A `Finding` contract in `src/contracts/` with `kind`, `repoPath`,
  `severity`, `observed` and `remedy`. Rendering is a separate function over that array, so
  `--json` and the human output cannot disagree, and the manager can read the same shape later.
- **Severity has two values**, `needs-owner` and `informational`. A third would invite
  argument about the middle.
- **Limit ranges live in a table in code**, one entry per key with its minimum, its maximum and
  how the maximum is derived. The table is the only place a bound exists, so the CLI, a future
  dialog and a Bot are all held to it.
- **The config write is atomic and whole**: read, validate the merged object against the
  existing zod contract in `src/contracts/factory-config.ts`, write a temporary file, rename.
  A `.bak` already exists beside the config and is kept.
- **`tokens` never parses a transcript line it does not need.** It streams each file, reads
  `message.usage` where present, sums the integer fields and discards the rest. A malformed
  line is skipped, not fatal: these are files another program owns.
- **No new dependency.** All three commands use what is already in the lockfile.
- **`doctor` is not plumbed into `tick`.** Nothing calls it automatically in this Spec.

## Testing decisions

Behaviour through the highest seam, every external process stubbed, no network:

- **`doctor`** (`tests/doctor.test.ts`): each of the ten Finding kinds is produced from a
  fixture and absent when the condition does not hold; a repository that throws yields an
  unreachable Finding and the other repositories still report; a clean factory yields an empty
  array; `--json` and the human rendering carry the same Findings; the exit code is 0 with
  Findings present and non-zero only when the sweep itself could not run.
- **`limits`** (`tests/limits.test.ts`): the reading is shown against the limit it is checked
  against; a value outside its range is refused with the range in the message and the file is
  not touched; a derived maximum follows the injected core count; several keys in one call are
  written together or not at all; a write failure leaves the original file intact.
- **`tokens`** (`tests/tokens.test.ts`): a Run joins its transcript by `sessionId` across
  project directories; the four token fields sum correctly; a missing transcript is reported
  unmeasured and counted in the total; a malformed line is skipped; `--since` and `--repo`
  filter; a Run with no `sessionId` is unmeasured.
- **Fixtures** are real shapes trimmed down: a Run record from the registry and a handful of
  transcript lines, in `tests/fixtures/`.

## Open questions

- Whether a Finding should carry a stable id so a Bot can say "this is the same one as
  yesterday" without matching on text. Deferred until something needs to.
- Whether `tokens` should learn cost in currency. It needs a price table per model, which is a
  maintained list of values an upstream release can change — the shape this project treats as a
  defect. Tokens are the honest unit until a price source exists that can be read.
- Whether Doctor should look at Automation firings. The records exist under
  `$FRACTORY_HOME/automation-runs/`, but there is no history yet to design against.
