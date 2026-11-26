# Spec 0003: Automation Runs

Status: accepted (2026-11-26). Vocabulary: [GLOSSARY.md](../../GLOSSARY.md).

## Goal

Fractory Manager lets the owner describe a recurring chore as an Automation and notices when
one comes due, but it cannot run anything: it is a Go binary with no container runtime and no
way to call Sandcastle. Fractory already runs agents in worktrees and containers for every
Run, and that is the capability an Automation needs.

This Spec gives Fractory a second kind of work. Alongside Runs, which start from a Ticket and
end in a pull request, Fractory accepts Automation requests from the manager and executes
them: it takes the request, builds a worktree and a container the way it does for a Run, runs
either an agent with a prompt or a plain command, keeps whatever the work produced, and writes
a record the manager reads. An Automation Run has no Ticket, opens no pull request, and is
expected to produce nothing but output.

## Non-goals

- **Scheduling.** The clock lives in Fractory Manager. Fractory never decides that something
  is due; it executes requests that already exist and keeps no schedule of its own.
- **Knowing what an Automation is.** Fractory stores no Automation configuration and never
  reads the manager's `state.db`. Each request carries its whole configuration, so Fractory
  learns "run this, here, in this Mode" and nothing more.
- **A pull request, a Ticket or a branch to review.** An Automation Run is not a Run. It sets
  no Ticket status, needs no commits, and the `publish` path is not involved.
- **Human oversight of the work itself.** Mode is recorded and passed through so the right
  account's credentials are used and the record says which they were; it does not add a review
  step to a chore that runs at 07:00.
- **A new Trigger kind.** A Trigger starts a Run. An Automation Run starts from a request
  file, which is a different lane through the same tick.

## Solution

The tick grows one more step. After it handles Re-runs and before it launches queued Runs, it
reads the request directory, validates each file, and queues an Automation Run for every
request it has not seen. Launching obeys the same Host Limits as a Run — a Held queue holds
Automation Runs too — at a lower priority than any Trigger, so a chore never delays the
owner's Ticket work.

Executing one is the familiar path with the Ticket parts removed. Fractory resolves the
repository from the request, reads its `.fractory.json` for the container image, asks Sandcastle
for a worktree on a detached branch, and starts the container. An Agent Automation runs the
request's CLI with the prompt the request points at, committed in that repository. A Script
Automation runs the request's command in the container. Either way the work writes what it
produces into an output directory that is mounted into the container and lives on the host, so
it survives the worktree being cleaned.

A record is written when the Automation Run is queued and updated as it starts, finishes or
fails, with the path to its log and its output. The manager reads those records; nothing else
does. Once a record exists for a request, the request file has served its purpose and is
removed. Fractory prunes an Automation's records and outputs to the retention count the
request carried.

Credentials come from the Keychain per Mode exactly as they do for a Run, and never enter the
image.

## User stories

1. As the owner, I want Fractory to pick up a request the manager dropped, so that an
   Automation that came due actually runs.
2. As the owner, I want a request validated before anything runs, so that a malformed one
   fails loudly instead of half-executing.
3. As the owner, I want a request whose version Fractory does not understand to be refused with
   a reason, so that an upgrade mismatch is visible rather than silent.
4. As the owner, I want each request executed once, so that a chore with side effects is safe
   to schedule.
5. As the owner, I want an Automation Run to use the repository's container image, so that a
   chore runs with the tools its repository already declares.
6. As the owner, I want an Automation Run isolated in its own worktree, so that a chore at
   07:00 cannot touch my working tree.
7. As the owner, I want an Agent Automation to run the CLI the request names with the prompt it
   points at, so that the logic stays committed and reviewable.
8. As the owner, I want a Script Automation to run its command in the container, so that a
   chore with a right answer costs no tokens.
9. As the owner, I want whatever the work produces to survive the worktree, so that a report or
   a document is still there afterwards.
10. As the owner, I want an Automation Run's log kept as a file, so that the manager can tail it
    live and I can read it days later.
11. As the owner, I want a record written the moment an Automation Run is queued, so that a
    crash never leaves a chore looking as though it never started.
12. As the owner, I want the record to carry the outcome and the paths, so that the manager can
    show me what happened without guessing.
13. As the owner, I want Automation Runs to respect Host Limits, so that chores never swamp the
    machine I am working on.
14. As the owner, I want Automation Runs to launch behind Triggers, so that a chore never
    delays work on a Ticket.
15. As the owner, I want a failed Automation Run recorded as failed with its log, so that I can
    open a Debug Session and find out why.
16. As the owner, I want an Automation Run's credentials chosen by its Mode, so that Work and
    Personal chores use the right account.
17. As the owner, I want credentials kept out of the image, so that a chore's container is no
    more sensitive than a Run's.
18. As the owner, I want old records and outputs pruned to the retention the request carried, so
    that a daily chore does not fill the disk.
19. As the owner, I want a request removed once its record exists, so that the request directory
    does not grow without end.
20. As the owner, I want an Automation Run never to open a pull request or move a Ticket, so
    that my tracker stays about work I asked for.
21. As the owner, I want a dead Automation Run process detected like a dead Run, so that a
    killed chore does not sit as running forever.
22. As the owner, I want `fractory` to list Automation Runs from a shell, so that I can see what
    happened without the TUI.

## Implementation decisions

**Contracts.** Three new schemas in `src/contracts/`, each versioned and owned here, mirrored
by the Go side in Fractory Manager: the Automation configuration, the request that wraps it,
and the Automation Run record. They are the public contract between the two repositories;
changing one means changing both. Unknown fields are ignored on read so either side can extend.
Schemas go in their own commit, as this repo's rules require, with every caller updated.

**Identity.** An Automation is identified by a stable id that never changes; its name is a
label the owner can edit. A record references the id, so renaming an Automation keeps its
history attached.

**Where things live.** Requests in `$FRACTORY_HOME/automations/`, records in
`$FRACTORY_HOME/automation-runs/`, logs beside the existing ones in `$FRACTORY_HOME/logs/`,
and each Automation Run's output in its own directory under `$FRACTORY_HOME/automation-runs/`
keyed by the run's id. The runs registry is untouched, so a Run record and an Automation Run
record never share a directory, a reader or a pruning policy.

**Output directory.** The output directory is created on the host before the container starts
and mounted into it at a fixed path, which is passed to the work as an environment variable.
This is the decision that makes an Automation useful rather than merely observable: the work
writes its report, its spreadsheet or its diff summary there, and the directory outlives the
worktree. The alternative — commit and push to a branch — was rejected because most chores are
not about a repository's contents and would produce a branch nobody wants.

**Execution.** A separate executor, not a widened `executeRun`: it shares the Sandcastle
worktree and container code and the credential resolution, and deliberately does not share the
Ticket read, the prompt assembly, the completion-signal contract or `publish`. An Automation
Run reaching its end without a usable result is recorded as failed with its log; there is no
`needs-human` and no re-run, because the manager owns both retrying and asking the owner.

**The two kinds.** Each is a Flow, the primitive this repo already uses to describe how work is
carried out in a container, so adding a third kind of Automation later is a new flow file and
no change to the executor.

**The tick.** One new step reading the request directory, placed after Re-run handling and
before queued Runs are launched. The launch gate is the existing one: Host Limits, the
per-tick launch cap, and a priority below every Trigger kind. Liveness of an Automation Run
process is checked the way a Run's is, where only a conclusive signal proves death — a failed
read proves nothing.

**Request lifecycle.** A request is accepted exactly once: accepting it writes the record
first, then removes the request. A crash between the two leaves a record and a stale request,
so acceptance is keyed on the request's instant and a request whose record already exists is
discarded rather than run again. The manager's watermark is the outer guard; this is the inner
one.

**CLI.** `fractory automations` lists Automation Runs the way `fractory runs` lists Runs, with
`--json` for scripting.

## Testing decisions

A good test here asserts what Fractory did, not how: which records exist and what they say,
which requests survived, and what the executor was asked to do. Following this repo's rules,
`gh`, `git`, `docker` and Sandcastle are stubbed and no test touches the network.

**The seam to aim for is the tick**, driven with a temp `FRACTORY_HOME` and fixture request
files — the shape `tests/trigger.test.ts` and `trigger-helpers.ts` already use. It covers the
decisions that matter: a valid request becomes a queued record, a malformed or wrong-version
one is refused and recorded as such, a request whose record exists is discarded, Host Limits
and priority are honoured, and the request file is gone once a record exists.

The executor gets its own tests with a stubbed Sandcastle, as `tests/runner-execute.test.ts`
does for a Run: the worktree is requested on the right repository, the container uses the
repository's image, the output directory exists on the host and is mounted, the right
credentials are resolved for the Mode, and no code path reaches `publish` or the Ticket source.
Retention is tested by writing more records than the retention count and asserting which
survive, including their output directories.

## Open questions

- Whether an Automation Run should be able to opt into committing and pushing its worktree, for
  the minority of chores that really are about a repository's contents.
- Whether a repository needs to be listed in `config.json` for an Automation to run in it, or
  whether a `.fractory.json` alone is enough.
- Whether a chore that produces no output at all should be recorded as done or as a distinct
  quiet outcome, which would let the manager show "nothing to do" differently from "it ran".
- Whether the output directory should be readable from the manager's detail column directly, or
  only through a Debug Session.
