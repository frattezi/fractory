---
name: babysit
description: Watch a Fractory repository's unfinished work through to merged. Use when the owner asks to babysit changes, to chase Runs or pull requests until they land, or to pick up Tickets whose Run failed or stopped for a human. Drives one Ticket at a time with `fractory babysit`.
license: MIT
---

# Babysitting work to merged

The factory starts Runs; it does not chase them. A Run that failed or stopped for a human is never
retried, and its Ticket is out of Ready, so nothing queues it again: the work sits there. A Ticket
built before the Ticket it depends on has merged fails on a base that is missing that change, and a
whole batch fails together.

Babysitting closes that loop. `fractory babysit` queues a Run where a Ticket has none, waits for the
Run to end, waits for the change to merge, and only then starts the next Ticket.

## Run the command, don't improvise the loop

```
fractory babysit [repoPath] [--ticket <ref>]... [--poll <seconds>] [--timeout-min <minutes>]
```

- No `--ticket`: every unfinished Ticket in the repository, oldest Run first. Unfinished means its
  newest Run is queued, running, failed or needs-human, or is done with a pull request that has not
  merged. A Ticket with no Run at all is never started: babysitting chases work, it does not create
  it; nor is one the tracker already calls done, so a Ticket closed by hand or finished by work that
  landed another way is not re-queued for nothing.
- `--ticket` (repeatable): exactly these Tickets, **in the order given**. Order matters — give
  blockers before the Tickets that depend on them.
- It prints one line per state change and a summary, and exits non-zero when it stops or times out.
- While driving a Ticket it reads the Run registry only, and the tracker once per candidate when
  discovering Tickets. Pull request state comes from the tick, so the factory must be running
  (`fractory launchd install`), or nothing will ever merge.

Run it in the background and report what it prints. Never rebuild the loop out of `fractory runs`,
`sleep` and `gh` calls: the ordering, the adoption of an existing Run and the stop conditions are
code with tests, and a hand-rolled version gets them wrong.

## When it stops

It stops at the first Ticket that needs the owner, because the next Ticket would be built on a base
without this one's change. The summary names the Ticket, the Run and its question or failure.

- **needs-human**: show the question. Decide with the owner, then put the answer where the next Run
  will see it — a manual Run's prompt carries the rules and the Ticket body, and nothing else, so a
  tracker comment alone does not reach it. Then babysit again from that Ticket.
- **failed**: read the Run's log (`fractory runs` gives its path) before re-running. A Run that
  failed for a missing base, a host limit or a flake is worth another Run; one that failed on the
  Ticket's own terms needs the Ticket fixed first.
- **timed out**: check `fractory status` for a Held queue or a stuck tick before assuming the Ticket
  is at fault.

## Rules that still apply

The `fractory` skill governs everything else: never commit to, push to or check out a branch
`fractory status` lists as hands-off, never edit the Run registry or kill a Run, and never pass a
Gate for the owner. Babysitting waits for merges; it does not merge. In Personal Mode the tick
merges a done Run's pull request by itself; in Work Mode a human reviews first, so babysitting a
Work Mode repository will wait at the PR Gate until that review happens — say so rather than
sitting silent.
