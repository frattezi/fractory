---
name: to-tickets
description: Break an approved Spec into tracer-bullet Tickets and create them with `fractory tickets create`. Use only after the owner approved the Spec at the Spec Gate. Tickets stay in backlog when the repo's Ticket Gate is on, and are created Ready otherwise.
license: MIT
metadata:
  source: https://github.com/mattpocock/skills (to-tickets)
  commit: d65391149dbb5fe76478e76fa8d5122b2aa5a70e
  note: Adapted for Fractory; publishing goes through the fractory CLI and the repo's Ticket Gate decides the initial status.
---

# To Tickets

Break an approved **Spec** into **Tickets**: tracer-bullet vertical slices, each small enough for one agent to build and ship in a single **Run**, each declaring the Tickets that block it.

## Preconditions

- The Spec exists in `docs/specs/` and its status is `accepted`. If it is not, stop: the Spec Gate has not been passed.
- Read the repo's gate. Run `fractory config show` in the repo and read its JSON output: `requiresTicketGate` decides the initial status (`true` means `backlog`, `false` means `ready`), and `mode` tells you whether text will be shared with other developers. If the command fails, stop and report; never guess the gate.

## Process

1. **Read** the Spec, `GLOSSARY.md` and the ADRs in the area. Use the glossary vocabulary in every title and body.
2. **Explore** the code to see where prefactoring would make the change easy.
3. **Draft vertical slices.** Each slice cuts a narrow but complete path through every layer, is demoable or verifiable on its own, and fits a single fresh context window. Prefactoring comes first. A wide mechanical refactor is the exception: expand, migrate in batches, contract, each its own Ticket with the right blockers.
4. **Quiz the owner.** Present a numbered list: Title, Blocked by, What it delivers. Ask whether the granularity is right, the blocking edges are genuine, and anything should merge or split. Iterate until approved.
5. **Create the Tickets** in dependency order (blockers first) so each can reference real refs. For each one, write the body to a temporary file using the template below and run:

   ```
   fractory tickets create --title "<title>" --body-file <path> --status <backlog|ready> [--blocked-by <ref>]... [--parent <ref>]
   ```

   It prints the created Ticket as JSON (`{"ref": "...", "url": "..."}`); use `ref` in later `--blocked-by` flags. `--status` is `backlog` when the Ticket Gate is on and `ready` when it is off. Never create a Ticket as `ready` when the gate is on: a Ticket becoming Ready is what starts a Run.
6. **Report.** Tell the owner how many Tickets were created and their refs. When the Ticket Gate is on, say that they are in backlog and that moving them to Ready is the owner's approval at the Ticket Gate. Do not do it for them.

In a Work Mode repo, Ticket titles and bodies go to a shared tracker: write them as a developer would, with no mention of Fractory, agents, Claude or AI tooling. The CLI rejects text that does.

Do not close or modify any parent issue.

## Ticket body template

```md
## Spec

Path of the Spec file (docs/specs/NNNN-slug.md).

## What to build

The end-to-end behaviour this Ticket makes work, from the user's perspective, not a layer-by-layer list.

## Acceptance criteria

- [ ] Criterion 1
- [ ] Criterion 2

## Blocked by

The refs of the blocking Tickets, or "None (can start immediately)".
```

Avoid file paths and code snippets other than the Spec path: they go stale. The exception is a type shape or state machine that prose cannot state precisely.
