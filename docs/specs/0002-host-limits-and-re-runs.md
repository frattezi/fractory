# Spec 0002: Host Limits and Re-runs

Status: accepted (2026-11-25). Vocabulary: [GLOSSARY.md](../../GLOSSARY.md). Builds on
[Spec 0001](0001-fractory-v1.md) and ADR 0002.

## Goal

The owner's machine is modest and shared with their own work (a local Kubernetes cluster, several
interactive agent sessions). Fractory must never start more Runs than the machine can carry: a new
Run starts only when the computer and the Docker sandbox both have room, and the owner can see at a
glance when and why the queue is Held.

When a Run fails or stops for a human, the owner retries it from Fractory Manager with one key, sees
how many Re-runs a Ticket has needed, and reads the history of every Run on it.

## Non-goals

- Stopping, pausing or throttling a Run that is already running.
- Limiting interactive sessions the owner starts in Fractory Manager.
- A way to start a Run while the queue is Held.
- Notifications about long holds.
- A per-Run memory cap (Sandcastle's Docker sandbox cannot set one).
- Re-running a `done` Run: changes to an open PR go through review comments (follow-up Runs).

## Solution

**Host Limits.** Before starting each queued Run, `tick` reads the machine: the 1-minute load per
core, the memory macOS reports as available, and the free memory of the Docker VM where Runs execute.
The Run starts only when the load is at most 0.75 per core, the computer has at least 2 GB free and
Docker at least 1 GB. At most one Run starts per tick, so each one shows up in the readings before
the next. Each Run's container is capped at 4 CPUs. While a limit is exceeded, queued Runs wait and
the queue is Held; if Docker is not reachable the queue is Held too, because no Run could start. A
reading that fails for any other reason never holds the queue on its own. Limits are on by default
and set in `~/.fractory/config.json`.

When the queue has room, Runs start in this order: manual Runs and Re-runs, then follow-up Runs (CI
failed, review comment), then Runs for newly Ready Tickets; oldest first within each group.

Every tick writes the host state to a file Fractory Manager and `fractory status` read: Held or not,
why, since when, the readings and how many Runs are queued.

**Re-runs.** In Fractory Manager's Runs view each Ticket is one row showing its latest Run. A Ticket
that needed Re-runs carries `↻N` (`RN` in Compatible mode). Selecting a row lists every Run of the
Ticket with its Trigger, result and log. When the latest Run failed or needs a human, the footer
shows `R re-run`; pressing it asks Fractory for a Re-run, the row shows `↻…` until the next tick
queues it, and the Re-run continues on the Ticket's branch. A held queue shows as one line at the
top of the Runs view, for example "Held 42 min: Docker memory 0.8 GB free < 1 GB".

**Fractory Manager as a Fractory repository.** The fork (`frattezi/agent-manager`) becomes a Personal
Mode repository with GitHub Issues as its Tickets and its own sandbox image (Go and tmux), so its
Tickets, including this Spec's, are built by Runs.

## User stories

1. As the owner, I want Fractory to start a Run only when my computer has CPU and memory to spare, so that my own work stays responsive.
2. As the owner, I want Fractory to check the Docker VM's free memory, so that Runs are not killed for lack of memory while macOS looks fine.
3. As the owner, I want at most one Run to start per tick, so that the readings reflect each new Run before another starts.
4. As the owner, I want each Run's container capped at a number of CPUs, so that one heavy build cannot take the whole machine.
5. As the owner, I want a running Run never to be stopped by Host Limits, so that no work is lost.
6. As the owner, I want the queue Held when Docker is not reachable, so that Runs do not fail at start.
7. As the owner, I want a reading that cannot be taken not to hold the queue, so that a broken metric never stops the factory.
8. As the owner, I want Host Limits on by default with sensible values, so that a fresh install is safe.
9. As the owner, I want to change or turn off each limit in `~/.fractory/config.json`, so that I can tune it to my machine.
10. As the owner, I want manual Runs and Re-runs to start before follow-ups and new Tickets, so that what I asked for is not stuck behind a batch.
11. As the owner, I want follow-up Runs to start before Runs for new Tickets, so that open PRs finish before new work starts.
12. As the owner, I want `fractory status` and the `tick` output to say whether the queue is Held and why, so that I can tell from a terminal.
13. As the owner, I want Fractory Manager to show a Held line with the reason and how long, so that I see it without opening logs.
14. As the owner, I want one row per Ticket in the Runs view, so that Re-runs do not crowd the list.
15. As the owner, I want a `↻N` marker on a Ticket that needed Re-runs, so that I see at a glance which work is struggling.
16. As the owner, I want to see every Run of a Ticket with its Trigger, result and log when I select it, so that I understand what happened.
17. As the owner, I want to press `R` on a failed or needs-human Ticket to ask for a Re-run, so that I retry without a terminal.
18. As the owner, I want the `R re-run` hint only when a Re-run is possible, so that the footer never offers an action that does nothing.
19. As the owner, I want a second press of `R` before the tick to change nothing, so that I cannot queue duplicate Runs.
20. As the owner, I want a Re-run to continue on the Ticket's branch, so that commits a failed Run made are not thrown away.
21. As the owner, I want a pending Re-run shown as `↻…`, so that I know my request was received.
22. As the owner, I want the fork to be a Fractory repository, so that its Tickets are built by Runs and shown in Fractory Manager itself.

## Implementation decisions

**Contracts (`src/contracts/`, their own commit).**

- `FactoryConfig.resources`: `false` or an object, default on:

  ```ts
  {
    maxLoadPerCore: number;        // 0.75
    minHostMemoryFreeGb: number;   // 2
    minDockerMemoryFreeGb: number; // 1
    maxLaunchesPerTick: number;    // 1
    cpusPerRun: number;            // 4
  }
  ```

  It replaces PR #74's `minMemoryAvailablePercent` and its opt-in default.
- `HostState` (version 1), written atomically to `<FACTORY_HOME>/host.json` by every tick:

  ```ts
  {
    version: 1;
    held: boolean;
    reason?: string;          // e.g. "Docker memory 0.8 GB free < 1 GB"
    heldSince?: string;       // ISO time the current hold began
    readings?: { loadPerCore?: number; hostMemoryFreeGb?: number; dockerMemoryFreeGb?: number;
                 dockerReachable: boolean; checkedAt: string };
    queued: number;
    updatedAt: string;
  }
  ```

  Readings are taken only on ticks with a queued Run; `held` is false whenever nothing is queued.
- Re-run request at `<registryDir>/<runId>.rerun.json`: `{ version: 1, requestedAt }`, written
  atomically by Fractory Manager, never modified by Fractory. `RunRegistry.list()` ignores it. The
  resulting Run's key is `<ticketRef>:rerun:<runId>`, so one request yields one Run.

**Host readings (`src/policy/resources.ts`).** `readHostLoad` gains the host memory free in GB
(available percentage × physical memory) and the Docker reading: total from `docker info`, used as
the sum of `docker stats --no-stream`; `docker info` failing means Docker is not reachable.
`checkResources` decides; a missing value never fails a check, `dockerReachable: false` does.

**Tick (`src/trigger/tick.ts`).** Before the launch step: process Re-run requests (the Run is the
Ticket's latest and `failed` or `needs-human`, and no Run exists for the key → queue a manual Run on
the Ticket's branch; otherwise log and skip). The launch step sorts queued Runs by group (manual,
follow-up, ticket-ready) then age, applies `maxLaunchesPerTick` and the checks, and writes
`host.json` (keeping `heldSince` across consecutive held ticks). `TickSummary.held` stays.

**Runner.** The Docker sandbox gets `cpus: resources.cpusPerRun` when resources are on.

**CLI.** `fractory status` adds the host state from `host.json`.

**Fractory Manager fork (`internal/ui/runs` and the Runs view).**

- Registry reading groups Runs by Ticket; a Ticket's row is its latest Run. The Re-run count is the
  number of its Runs with a Re-run key; follow-ups are not counted.
- Row marker after the status dot: `↻N` / `RN`; `↻…` / `R…` while a request file exists without its
  Run.
- Detail pane: the Ticket's Runs, newest first, with Trigger kind, status or result, time, and the
  existing log action per Run.
- `R` writes the request for the latest Run when it is `failed` or `needs-human`; the footer lists
  `R re-run` only then, through the manager's existing contextual key legend.
- Held line at the top of the Runs view from `host.json` (`HostState` mirrored in Go, version
  checked like `RunRecord`).

**Fork as a Fractory repository.** `.fractory.json` (personal, GitHub `frattezi/agent-manager`,
`hasCi: false`, its own `sandboxImage`), a `.sandcastle/` Dockerfile with Go and tmux, the repo
registered in `~/.fractory/config.json`, and the `fractory:*` labels on the fork.

## Testing decisions

Tests check behaviour through the highest seam, with every external process stubbed:

- **`tick` harness** (`tests/trigger-helpers.ts`, injected `hostLoad`): holds and releases the queue
  on each limit, Docker unreachable holds, an unread value does not, one launch per tick, the
  three-group order, Re-run requests (valid, duplicate, not latest, wrong status), and the
  `host.json` content including `heldSince`. This is the main seam; prior art is the concurrency-cap
  and resource-limit tests.
- **`readHostLoad`** with stubbed `sysctl` and `docker` output, including failures.
- **CLI** (`tests/cli.test.ts`): `status` shows the host state; config defaults and `false`.
- **Runner**: the sandbox receives `cpus` (existing runner-execute stubs).
- **Fork** (`internal/ui/runs` Go tests): grouping and Re-run counts from registry fixtures, request
  file writing and idempotency, `host.json` parsing, and a view test for the marker, the footer hint
  and the Held line, following the package's existing tests.

## Open questions

- The Go+tmux sandbox image size and build time; whether the fork's tmux-dependent tests pass inside
  Docker (they fail under a nested tmux on the host today).
- Whether `kern.memorystatus_level` × physical memory tracks "free" closely enough on this machine;
  revisit the 2 GB default after a week of readings in `host.json`.
