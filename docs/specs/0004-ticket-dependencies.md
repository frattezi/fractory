# Spec 0004: Ticket Dependencies

Status: accepted (2026-11-26). Vocabulary: [GLOSSARY.md](../../GLOSSARY.md).

## Goal

Fractory does not know that one Ticket needs another finished first. `fractory tickets create`
accepts `--blocked-by`, writes `Blocked by #4` into the Ticket's body and never reads it again:
the dependency is prose for a human, invisible to the factory. Every Ticket that is Ready is
queued, in whatever order the tracker happened to list it, and every Run branches off the
repository's base branch.

On 2026-11-26 that cost a whole Spec's worth of work in `documentario-de-rua`. Ten Tickets were
created Ready as one chain, every one blocked by the one before it. The tracker listed them
newest first, so the Runs queued in reverse: the parity gate ran at 15:56, the Astro project
every other Ticket depends on merged at 16:51. Six Runs failed, each one correctly reporting
that the work it needed was not on the base branch. The agents were right; the factory sent
them to build on an empty tree.

The owner wants a factory that understands the order of its own work: a Ticket starts only when
what it depends on exists, it builds on top of that work rather than waiting for it to merge,
and nothing merges out of order.

## Non-goals

- **Inferring dependencies.** Fractory reads only declared blockers. It never guesses order from
  Ticket titles, numbers, bodies or the Spec they came from.
- **Cross-repository dependencies.** A blocker in another repository is refused, not modelled.
  One Run, one repository, one base branch.
- **Resolving merge conflicts.** A Restack Run rebases and pushes. When the rebase conflicts the
  Run fails like any other and the owner decides; the factory never resolves a conflict blind.
- **Changing the Gates.** The Ticket Gate, the Spec Gate and when a Ticket becomes Ready are
  untouched. `to-tickets` keeps creating a whole chain Ready at once — that is now safe.
- **A dependency view.** `fractory status` gains lines of text. Drawing the graph belongs to
  Fractory Manager, not here.
- **Dependencies between Specs or Runs.** Blockers are declared between Tickets only.

## Solution

### A Ticket declares its blockers where both humans and the factory can read them

A Ticket's body ends with a Relations section the factory writes and parses:

```
## Relations

Blocked by: github:me/app#4
Parent: github:me/app#1
```

Refs are full Ticket refs, so a blocker is never ambiguous about its repository. The section
renders as ordinary text in GitHub and Jira, so the owner can read and edit it in the tracker.
Tickets written before this Spec carry the old prose line `Blocked by #4`; the parser still
accepts it and resolves the shorthand against the Ticket's own repository.

A Ticket read from any tracker now carries `blockedBy`. A blocker is **satisfied** when its
Ticket is done, and **ready to build on** when its latest Run is done — its branch is pushed and
its pull request is open.

### A Ticket with one blocker stacks on it

When a Ticket has exactly one blocker whose latest Run is done, Fractory queues it immediately
and branches it off the **blocker's branch** instead of the repository's base branch. Its pull
request targets the blocker's branch, so the diff a human reads is the Ticket's own work. The
chain runs as a stack: the law section starts while Diego's wall is still in review.

GitHub retargets a stacked pull request to the repository's base branch when its parent merges,
so a stack unwinds by itself as the bottom of it merges.

### Everything else holds

A Ticket is **held** — not queued, status left Ready, nothing written to the tracker — while:

- a blocker's latest Run is queued, running, failed or needs-human: its branch is a moving or
  broken base, and nothing is built on it;
- it has two or more blockers and any of them is not yet done: a branch has one parent, so a
  Ticket with several blockers cannot be stacked. It waits for all of them to merge and then
  branches off the base branch like any other Ticket;
- it, or any Ticket it depends on, sits in a dependency cycle, or declares a blocker in another
  repository or one that does not exist.

`fractory status` names every held Ticket and the blocker it waits on. Holding is silent in the
tracker: a held Ticket is not In Progress, because nothing is in progress.

### Nothing merges out of order

Auto-merge refuses a pull request whose base is not the repository's base branch. A stacked pull
request's base *is* its blocker's branch until that blocker merges, so this one condition is
exactly "every blocker of mine has merged" — no graph to read at merge time.

### A moved blocker restacks the Tickets above it

A blocker's branch can gain commits after a dependent branched off it: a failing check or a
review comment starts a follow-up Run on it. Every branch stacked above is then missing that
work. Fractory notices the blocker's branch tip moved and queues a **Restack**: a Run on the
dependent that rebases its branch onto the new tip, force-pushes it, and does nothing else. One
moved tip yields one Restack. Restacks launch at the same priority as a failing check, ahead of
newly Ready Tickets, because a stale stack holds back everything above it.

### Ready Tickets queue in blocker order

Unblocked Tickets are queued blockers first, so a chain never queues backwards again regardless
of how the tracker ordered its response.

## User stories

1. As the owner, I want a Ticket to declare the Tickets it depends on, so that the factory
   knows the order of its own work.
2. As the owner, I want to read and edit those dependencies in my tracker as plain text, so
   that I never need Fractory to see or change them.
3. As the owner, I want dependencies declared in GitHub and in Jira alike, so that the rule
   does not depend on which tracker a repository uses.
4. As the owner, I want Tickets created before this Spec to keep working, so that the change
   costs me no migration.
5. As the owner, I want a Ticket to start as soon as what it depends on is built rather than
   merged, so that a chain of ten Tickets is not ten sequential merges.
6. As the owner, I want a dependent Ticket's Run to find its blocker's work already in the
   tree, so that the agent builds on real code instead of reporting an empty base branch.
7. As the owner, I want a dependent's pull request to show only its own change, so that review
   stays readable as the stack grows.
8. As the owner, I want a Ticket whose blocker is still running, failed or waiting on me to
   stay untouched, so that nothing is ever built on a broken or moving base.
9. As the owner, I want a Ticket with several blockers to wait until all of them have merged,
   so that the factory never invents which one to stack on.
10. As the owner, I want a pull request never to merge before the one it is stacked on, so
    that the chain lands in the order it was designed.
11. As the owner, I want a stack rebased automatically when its base gains commits, so that a
    review comment on the first Ticket does not silently invalidate the nine above it.
12. As the owner, I want a dependency cycle to stop every Ticket in it and tell me, so that a
    typo in a Relations section never half-launches a chain.
13. As the owner, I want a blocker in another repository refused at creation, so that I learn
    about it when I write it and not during a Run.
14. As the owner, I want `fractory status` to name every held Ticket and what it waits on, so
    that a quiet factory is explainable without reading logs.
15. As the owner, I want a Run never able to push to the branch it is stacked on, so that a
    dependent cannot rewrite its blocker's work.
16. As the owner, I want unblocked Tickets queued blockers first, so that order is right even
    before any dependency is declared.
17. As the agent on a dependent Ticket, I want to be told which branch I am stacked on and that
    its work is already present, so that I do not re-implement my blocker.

## Implementation decisions

**Relations are one parser, shared by every adapter.** A new module in `src/adapters/` renders
the Relations section and parses it back. `bodyWithRelations` is replaced by it, so the writer
and the reader are the same code and can never drift. Parsing validates every ref with
`TicketRefSchema`; a ref that fails is reported, never dropped silently.

**`TicketSchema` carries the dependency.** `blockedBy` becomes part of the Ticket contract,
defaulting to an empty array, and `parent` alongside it. Both GitHub and Jira adapters fill them
in `toTicket`, so `TicketSource` needs no new method and the tick reads dependencies from the
Tickets it already lists.

**The verdict is a pure function.** A new `src/policy/dependencies.ts` takes the Ready Tickets,
the Run records and the repository config, and returns one verdict per Ticket: launch with a
base (the repository's base branch or a named blocker branch), or hold with a reason. Cycle
detection, the multiple-blocker rule, the blocker-state rule and the queue order all live there.
The tick only acts on verdicts — it makes no dependency decision of its own. This is the whole
No Token Architecture of the Spec: every rule above has a right answer, so every rule is a
tested pure function.

**A Run records its own base.** `RunRecord` gains an optional `baseBranch` and the tip sha it
branched from, written when the Run is queued. Both remain optional, so the registry contract
stays at version 1 for its Agent Manager readers. The two places that use the repository's base
branch today — resolving the base ref before the worktree is created, and `gh pr create --base`
— read the Run's base and fall back to the repository's.

**The pre-push hook protects the stacked base too.** The hook is rendered with the Run's
effective base added to the protected branches, so a dependent Run cannot push to its blocker's
branch any more than it can push to `main`.

**Restack is a new Trigger kind.** `restack` joins the Trigger union, keyed
`<ticketRef>:restack:<blocker tip sha>` so one moved tip yields exactly one Run, idempotent on
the existing key rule. It needs no prompt and no agent: the flow rebases and pushes. Reading a
branch's tip is a new small injected function beside the existing `Gh` seam, so tests replace it
like every other external call.

**Auto-merge gains one condition.** `mayAutoMerge` takes the pull request's base branch and
refuses anything that is not the repository's base branch. `PrViewSchema` and the `gh pr view`
field list grow `baseRefName`.

**The agent is told where it stands.** The Run prompt names the branch a stacked Run is built
on and states that the blocker's work is already in the tree.

## Testing decisions

The highest seam is `tick(deps)`, already fully faked in `tests/trigger-helpers.ts`: a fake
ticket source, a fake `gh`, a real registry on a temp dir. Every behaviour in the Solution is
observable there as external behaviour — which Runs were queued, in what order, on which branch,
which Tickets were left alone, what was merged. That is where this Spec is tested, extending
`tests/trigger.test.ts`.

Three narrower seams carry what the tick cannot see:

- `resolveDependencies` in `tests/policy.test.ts`, as a table of graphs: a chain, a diamond, two
  blockers, a cycle, a self-blocker, a cross-repository ref, each blocker state. Pure in, pure
  out, no fixtures.
- The relations round trip in `tests/adapters-github.test.ts` and `tests/adapters-jira.test.ts`:
  what `create` writes, `get` parses back. Plus the legacy prose line, and a malformed section.
- The Run's base in `tests/runner-execute.test.ts` (worktree base ref and `pr create --base`)
  and `tests/runner-hook.test.ts` (the stacked base is protected).

No test touches the network or a real `gh`, `git` or Docker, as in every existing test.

## Open questions

- Whether a dependent should be rebased onto the base branch once its blocker merges. GitHub
  retargets the pull request and the blocker's commits are already in the dependent's branch, so
  the diff stays correct; it is cosmetic until a conflict appears, which auto-merge already
  refuses.
- Whether Fractory Manager should draw the stack. It can derive it from the Run records as they
  are, so nothing here blocks it.
- Whether a held Ticket deserves a tracker comment after holding for a long time. Silence is
  right for minutes and arguably wrong for a day.
