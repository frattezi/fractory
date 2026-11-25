---
name: to-spec
description: Turn a grilled Goal into a Spec file at docs/specs/NNNN-slug.md and stop at the Spec Gate. Use after grill-with-docs, when the owner says the Goal is agreed; does not interview and never creates Tickets.
license: MIT
metadata:
  source: https://github.com/mattpocock/skills (to-spec)
  commit: d65391149dbb5fe76478e76fa8d5122b2aa5a70e
  note: Adapted for Fractory vocabulary; writes a file in the repo instead of publishing to a tracker.
---

Take the current conversation and the codebase and write a **Spec**: a Goal after it has been grilled and agreed. Do NOT interview; synthesise what is already settled. If something is still open, say so and send the owner back to `grill-with-docs` rather than guessing.

## Process

1. Read `GLOSSARY.md` and `docs/adr/` and use their vocabulary. Never invent a synonym for Goal, Spec, Ticket, Run, Gate or Mode.
2. Explore the code the Spec touches, if you have not already.
3. Sketch the test seams. Prefer existing seams, use the highest one possible, and aim for one. Confirm them with the owner.
4. Pick the number: list `docs/specs/`, take the highest `NNNN` and add one (four digits, `0001` when empty). The file is `docs/specs/NNNN-<kebab-slug>.md`.
5. Write the Spec with the template below.
6. **Stop at the Spec Gate.** Tell the owner where the file is and ask them to approve it. Do not run `to-tickets`, create Tickets or start any implementation until they say it is approved. When they approve, set `Status: accepted (<date>)` in the file.

In a Work Mode repo (`fractory config show` reports `"mode": "work"`) the Spec is committed to a shared repository: write it as a developer would, with no mention of Fractory, agents, Claude or AI tooling.

## Template

```md
# Spec NNNN: <title>

Status: draft. Vocabulary: [GLOSSARY.md](../../GLOSSARY.md).

## Goal

The outcome the owner wants, in one or two paragraphs, from the user's perspective.

## Non-goals

What this Spec deliberately does not do.

## Solution

How it behaves from the user's perspective.

## User stories

A long, numbered list: "As an <actor>, I want <feature>, so that <benefit>". Cover every aspect.

## Implementation decisions

Modules built or changed, their interfaces, schema or API contracts, architectural calls. No file
paths or code snippets that go stale; the exception is a type shape or state machine that prose
cannot state precisely.

## Testing decisions

What makes a good test here (external behaviour only), the seams, which modules are tested, prior art.

## Open questions

Anything that does not block the work.
```
