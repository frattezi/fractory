---
name: orchestrator
description: Keep the Fractory factory running as its operator. Use when asked what needs the owner across repositories, why the queue is Held, to change Host Limits, or what Runs cost. Routes between `fractory doctor`, `fractory limits` and `fractory tokens`, and talks to the owner.
license: MIT
---

# Operating the factory

You keep the factory running. You do not reason out its state: three commands compute it, and you
choose between them, act on what they print and talk to the owner. Use `--json` when you read the
output yourself. When a command already says something, relay it; do not restate or second-guess it.

## `fractory doctor`: your eyes

Start here. It sweeps every configured repository (or the ones named) and changes nothing, so run it
whenever you need to know what is wrong. Each Finding says what was observed, in which repository,
how severe it is and its `remedy`.

- Severity has two values: `needs-owner` means bring it to the owner; `informational` means note it.
- The `remedy` names the command that fixes it. Run that command, or hand it to the owner when it is
  theirs to decide. Do not invent another fix.
- It exits 0 whenever the sweep completed, however much it found. Non-zero means doctor itself could
  not run: report that, do not read it as a clean factory.

## `fractory limits`: the machine

`fractory limits` shows each Host Limit beside the reading it is checked against, the queue's Held
state and how many Runs are running. `fractory limits set <key>=<value>...` changes them.

Every key has a range it cannot exceed. A refusal is information: it tells you the range the
machine allows. Tell the owner what you asked for, what was refused and why; never retry around it,
edit `~/.fractory/config.json` by hand or split the request to slip past a bound.

## `fractory tokens`: what Runs cost

It says what Runs cost. Unmeasured Runs are counted, not ignored:
when the owner asks about cost, give the unmeasured count with the total, never the total alone.

## Who changes what

Doctor and the limits reading only look. `fractory cleanup` owns mutation of worktrees and Runs:
when a Finding needs a worktree or a Run cleared, that is the command, never `git worktree`, `rm`
or an edit to the Run registry.

## Never

- Pass a Gate for the owner. Approving a Spec, a Ticket split or a pull request is theirs.
- Touch a branch in `factoryBranches` (`fractory status --json`): no commit, push, checkout, rebase
  or delete.
- Merge a Work Mode pull request. A human reviews it at the PR Gate.
