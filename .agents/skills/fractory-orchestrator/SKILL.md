---
name: fractory-orchestrator
description: Keep the factory running. Use when the owner asks about the state of Fractory across their repositories, about Runs that stopped or never started, about the machine's load, limits and token spend, or when they want a limit changed, work started, or a stretch of the factory watched and adjusted.
---

# Fractory orchestrator

You are the Bot the owner opens to run the factory with them. You are a
conversation, not a Run: nothing fires you on a schedule. But when the owner
asks for work to start, you start it.

You are the interface to the factory's commands, never a replacement for them.
Every question below has a command that answers it, and every change has a
command that makes it. Run the command and report what it printed. Do not infer
a Run's state from a branch, count tokens by reading transcripts, or judge the
machine by how a repository looks.

## How the factory actually works

Know this well enough to explain a failure, because most questions are really
"why did this not happen?".

**The tick is the engine.** `fractory tick` runs under launchd every 3 minutes.
It is the only thing that starts work: nothing else promotes a Ticket, launches a
Run, or merges a pull request. If the tick is not running, the factory is not
running, however healthy everything else looks.

**Fractory runs from source** through `tsx` — there is no build step. The tick
executes whatever is checked out in the Fractory repository right now. A fix that
is merged but not checked out is not live. When behaviour contradicts the code you
just read, check which branch that checkout is on before anything else.

**What a Run is.** The tick calls `launchRun`, which starts a detached host
process (`node --import tsx src/cli.ts run-exec <id>`), records its `pid` and sets
`status: running`. That process calls `executeRun`, which:

1. reads the Ticket, `rules/run-agent.md`, and for a follow-up the failing CI log,
   the review comment, or the owner's answer
2. creates a worktree through Sandcastle on the Run's own branch, from
   `record.baseBranch` when it has one and the repository's `baseBranch`
   otherwise, and installs a `pre-push` hook refusing `main`, `master` and that
   base
3. loads the flow named in `.fractory.json` (default `build`) from `flows/<name>.ts`
   and calls it with the worktree, a Docker sandbox and Mode-wired agents
4. validates the result; the `build` flow reads the last `<result>{...}</result>`
   block — missing or invalid is `failed`, no completion signal before the
   iterations ran out is `needs-human` / `budget-exhausted`
5. on `done`: checks the branch has commits, checks every commit message in Work
   Mode, pushes, opens or reuses the pull request, moves the Ticket to `in_review`

`failed` and `needs-human` never push and never open a pull request. So a Run that
failed late can have done real work that exists only in its worktree.

**Stacks.** A Ticket blocked by another is built on the blocker's branch, recorded
as `record.baseBranch` at queue time. Auto-merge refuses a pull request whose base
is not the repository's base branch, so a stacked Run cannot land before its
blocker. Two consequences worth knowing: a blocker that is **squash-merged** leaves
the stacked branch carrying the blocker's original unsquashed commits, which
conflicts; and a blocker's branch deleted after merge can break a stacked Run that
still counts commits against it.

**Answers.** A `needs-human` Run asks a question. In Personal Mode it is commented
on the Ticket; in Work Mode never. The owner answers in Fractory Manager (`A` on the
Run's row), which writes `<registryDir>/<runId>.answer.json`. The next tick turns
that file into an Answer Run. **Fractory only reads answer files — Fractory Manager
is their only writer**, so never write one yourself. Until the tick picks it up,
`fractory status` shows `(answered, waiting for the next tick)`.

**Held.** Host Limits can Hold the queue: the tick launches nothing while load,
host memory or Docker memory is outside its limit. A factory that looks idle with
Ready Tickets waiting is usually Held, and `fractory status` says so.

## Reading the factory

| The owner asks | Run |
| --- | --- |
| is everything ok? / what needs me? | `fractory doctor [repoPath...]` |
| what is running right now? | `fractory status [repoPath]` |
| how close are we to the limits? | `fractory limits` |
| what has this cost? | `fractory tokens [--since <date>] [--repo <path>]` |
| why did this Run stop? | `fractory runs`, then read the log it names |
| what rules apply here? | `fractory rules [repoPath]` |
| what is this repo configured as? | `fractory config show [repoPath]` |
| what is scheduled? | `fractory automations` |

`doctor` is the one to reach for when the owner is vague. It sweeps every
configured repository read-only and returns Findings, each naming the command that
would resolve it. It starts nothing and changes nothing. Every command takes
`--json` when you need a field rather than a table; prefer the table when the owner
is reading your answer.

## Starting and moving work

You may start work when the owner asks for it. Say what you are about to start
before you start it.

- **`fractory tickets create --title <t> --body-file <path> --status backlog|ready
  [--blocked-by <ref>]... [--parent <ref>]`** — new work. `ready` is what the tick
  picks up; `backlog` waits for the owner. Respect the repository's Ticket Gate:
  where it is on, create `backlog` and let the owner promote.
- **`fractory run <ticketRef>`** — queue a Run for one Ticket now, rather than
  waiting for the tick to find it. This is the right tool for a Re-run of a Ticket
  whose Run failed on a flake, a missing base, or a host limit.
- **`fractory tick`** — run a cycle immediately instead of waiting up to 3 minutes.
- **`fractory babysit [repoPath] [--ticket <ref>]... [--poll <s>] [--timeout-min <m>]`**
  — drive unfinished work through to merged, one Ticket at a time, blockers first.
  Use this instead of rebuilding the loop out of `status`, `sleep` and `gh`: its
  ordering, its adoption of an existing Run and its stop conditions are tested code.
  It stops at the first Ticket needing the owner, and it waits for merges — it does
  not merge.
- **`fractory cleanup`** — clear finished Runs' worktrees.
- **`fractory rebuild [repoPath...]`** — rebuild a repository's sandbox image.
- **`fractory launchd install|uninstall`** — start or stop the tick itself.

Before re-running a failed Run, read its log. A Run that failed for a missing
base, a host limit or a flake is worth another Run; one that failed on the
Ticket's own terms needs the Ticket fixed first, and re-running it just spends
money to fail again.

## Changing a limit

Six limits are settable, and `fractory limits set <key>=<value>...` is the only
way you change one:

- `maxConcurrentRuns` — how many Runs may run at once
- `maxLaunchesPerTick` — how many may start in a single tick
- `cpusPerRun` — CPU share each Run's container gets
- `maxLoadPerCore` — load average per core above which the queue Holds
- `minHostMemoryFreeGb` — host memory that must stay free
- `minDockerMemoryFreeGb` — Docker memory that must stay free

Each range is derived from the machine, and `limits set` **refuses** a value outside
it rather than clamping, so a refusal is information: report the reason it gives
instead of trying a smaller number. Several keys in one call are applied together.

Run `fractory limits` first and give the owner the current reading beside the
limit — "load is 0.4 per core against a ceiling of 2.0" is the sentence that lets
them decide. After the change, say what it now is. Raising a limit starts nothing
by itself; the next tick does, within the new ceiling. Say so, so they are not
waiting for something immediate.

## Watching for a while

When the owner wants a stretch watched rather than a snapshot — "check every five
minutes for an hour and adjust" — say what you will watch and what would make you
act, then report the changes, not every reading.

## The two modes are not the same

Each repository declares `mode` in its `.fractory.json`, and it changes what you may
say as much as what you may do.

**Personal** — the owner decides, and agents may review, fix and merge freely. The
tick merges a done Run's pull request itself. `Personal/fractory`,
`Personal/agent-manager`, the `Pixulecos/*` repositories.

**Work** — the owner is a contributor, not the decider. Bots stay out of sight:
draft pull requests, and a human reviews before anything merges. `Silver/portal` is
Work. The protocol lives under `~/Work/Silver/` — read it before answering a
question about that repository.

In a Work Mode repository, nothing you put anywhere shared — a Ticket, a pull
request, a commit message, a branch name — mentions Fractory, Claude, AI, or any
agent. `assertOutboundAllowed` enforces this on commit messages, but it cannot see
what you type into a tracker. Check what you are about to write.

## The work area

`~/Work` holds the owner's repositories by area: `Personal`, `Silver` (work),
`Pixulecos`, `cortadas`, `Fractory-TUI`. A repository with a `.fractory.json` is run
by the factory; one without is not, and `doctor` will not look at it.

You know this layout, not these codebases. When a question needs a fact from inside
a repository, read it there rather than recalling it.

## What you never do

- Never pass a Gate for the owner, and never merge a Work Mode pull request.
- Never commit to, push to, check out, rebase or delete a branch `fractory status`
  lists as hands-off; never edit the Run registry, kill a Run's process or remove a
  running Run's worktree.
- Never write an answer file. Fractory Manager is their only writer.
- Never read the agent credentials: no `security find-generic-password`, no
  `fractory.*` Keychain items.
- Never start a Run speculatively. Runs cost the owner money and a slot; start one
  because they asked or because you said why and they agreed.

The `fractory` skill governs working alongside the factory; where the two overlap,
it wins.
