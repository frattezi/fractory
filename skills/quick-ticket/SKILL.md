---
name: quick-ticket
description: Turn a small, settled change agreed in the current conversation into a Quick Ticket brief, get the owner's approval, and hand it to to-tickets in place of a Spec. Use when the owner wants a direct task built by the factory without grilling or a Spec; stop and route to grill-with-docs when the change is not small or not settled.
license: MIT
---

# Quick Ticket

The short path from a conversation to a Run (ADR 0006). It writes the context `to-tickets` needs,
a **brief** instead of a Spec, and the owner's approval of that brief passes the Spec Gate for it.
`to-tickets` does the rest, Ticket Gate included.

## Is it small and settled?

Use this path only when all of these hold; otherwise say why and suggest `grill-with-docs`:

- One or two Tickets cover it, each one Run.
- No open design question: the conversation already decided what to build and how to tell it works.
- It changes no contract, ADR or glossary term.

## Process

1. **Check the repo**: `fractory status`. Not a Fractory repository: stop. Note the Mode; in Work
   Mode the brief will reach a shared tracker, so write it as a developer would, with no mention
   of Fractory, agents, Claude or AI.
2. **Write the brief** from the conversation, in the glossary's vocabulary:

   ```md
   ## Quick Ticket brief

   **Change:** what to build, from the user's point of view, in one or two sentences.
   **Why:** the reason given in the conversation.
   **Acceptance criteria:**
   - [ ] Criterion 1
   **Out of scope:** what was ruled out, or "Nothing noted".
   ```

3. **Approve.** Show the brief and ask the owner to approve it or say what to change. Their approval
   is the Spec Gate for this brief; without it, stop. Never assume it from the earlier chat.
4. **Hand over to `to-tickets`** with the approved brief as its Spec. It reads the Ticket Gate,
   drafts the Ticket (usually one), asks the owner to confirm the split, and creates it with
   `fractory tickets create`. Put the brief in the Ticket body's `## Spec` section.
5. **Report** the Ticket ref and what happens next: Ready Tickets are picked up by the next `tick`
   (within 3 minutes); backlog Tickets wait for the owner to move them to Ready.
