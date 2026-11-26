---
name: fractory
description: Work alongside Fractory in a repository that has a `.fractory.json`. Use before changing code, branches or tickets in such a repo, and when the owner asks about Runs, the factory, or handing work to it. Says which branches are hands-off and how to pass work to the factory instead of doing it by hand.
license: MIT
---

# Working alongside Fractory

Fractory is the owner's software factory. In a repository with a `.fractory.json`, it turns Ready
Tickets into Runs: agents in Docker (Sandcastle) that commit on their own branch and open a PR. Its
`tick` runs every 3 minutes. You are an interactive session next to it: you plan with the owner, and
the factory builds. Vocabulary: the repo's `GLOSSARY.md` if it has one, else Fractory's.

## First, ask the code

Run `fractory status --json` from the repository. It answers, without guessing:

- `managed`: whether the factory runs this repo. If it is not a Fractory repository, this skill does
  not apply.
- `mode`, `ticketGate`, `prGate`, `autoMerge`: the workflow rules (`fractory rules` explains each).
- `activeRuns`, `openPrs`, `needsHuman`, `factoryBranches`.

Re-run it before any git operation that touches branches. Never read `~/.fractory/runs/` or a log
to work this out yourself.

## Hands-off

- Never commit to, push to, check out, rebase or delete a branch in `factoryBranches`, and never
  edit files under `.sandcastle/worktrees/`. A Run may be writing there, and follow-up Runs reuse
  the branch of an open PR.
- Never edit the Run registry, kill a Run's process or remove its worktree. `fractory cleanup` does
  that.
- Never pass a Gate for the owner: do not add the `fractory:ready` label or move a Ticket to Ready
  unless the owner says so, and never merge a Work Mode PR.
- Never read the agent credentials (`security find-generic-password`, `fractory.*` Keychain items).

## Handing work to the factory

| The owner wants | Do |
| --- | --- |
| A new outcome | `grill-with-docs`, then `to-spec` (Spec Gate), then `to-tickets` |
| One small change, as a Ticket | `fractory tickets create --title … --body-file … --status backlog`; `ready` only if the owner says so |
| A Ticket built now | `fractory run <ticketRef>` (only when asked; the next tick starts it) |
| A Run's change adjusted | a review comment on the PR, or the owner's comments in Fractory Manager; never a hand commit on its branch |
| A Run that stopped with needs-human unblocked | show the `question` and help the owner decide; they answer it in Fractory Manager (`A` on the Run's row), and the next tick starts a Run on the Ticket's branch with the Answer. An entry marked `answered` is already waiting: do not ask again |
| To know what happened | `fractory runs`; the Run's log is its `logPath` |
| The installed tools refreshed after merges | `fractory rebuild` (see below) |

Doing the work yourself is fine when the owner asks for it: do it on a branch that is not in
`factoryBranches`.

## Keeping the installed tools current

Not every tool the owner runs picks up a merge by itself:

- **Fractory** runs from source through `tsx`, so a merge to its base branch is live at once — for
  your shell and for the next `tick`. It never needs building.
- **Anything installed from a build**, such as Fractory Manager's binary, keeps running the code it
  was compiled from until it is rebuilt.

`fractory rebuild` runs the `rebuild` list of every configured repository that declares one, in
config order (`fractory rebuild <repoPath>...` for named repos only). `fractory config show`
reports a repository's list.

**It performs no git operation: whatever is checked out is built as it stands.** A repository
sitting on a feature branch, behind its remote, or with uncommitted changes is compiled in that
state, and the result looks like a successful rebuild. So before rebuilding for "the newest
features", check each target with `git status -sb` and `git rev-list --count HEAD..origin/<base>`,
and tell the owner what you found instead of switching or stashing their work — a dirty checkout is
usually someone's work in progress, and may belong to a Run or another session.

## Text that leaves the machine

In a Work Mode repo, anything sent to a shared system (Ticket, PR, commit, branch name) must not
mention Fractory, Claude, OpenCode or AI. Fractory enforces this for its own text; you follow it for
yours.

## Other live sessions

Several Claude Code and OpenCode sessions may run in Fractory Manager at once. Coordinate with them
only when the owner asks, through Fractory Manager's session tools (for example reserving the files
you are about to edit). Runs do not take part in this: `fractory status` is how you see them.

**`fractory status` does not show other sessions**, only Runs. Another session may be working the
same repository from a different directory, with the same `gh` credentials — so it can create
Tickets, close pull requests and delete branches, and GitHub records all of it as the owner. Two
consequences:

- A Ticket or pull request you did not create may belong to a live session that holds context you
  do not. Before you close, merge or rebase one, say so to the owner rather than deciding alone,
  and consider that the same Goal may already have a Ticket under a different title.
- When something changed that no Run and no person explains, the actor is probably another session.
  `gh api repos/<owner>/<repo>/issues/<n>/timeline` dates the event; the owner's own transcripts
  (`~/.claude/projects/`) say which session ran the command. Never report the owner as having done
  something because GitHub attributes it to their account.
