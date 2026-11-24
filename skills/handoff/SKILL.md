---
name: handoff
description: Compact the current conversation into a handoff document for another agent to pick up. Use when a session is ending or the owner wants to continue the work in a fresh session.
license: MIT
metadata:
  source: https://github.com/mattpocock/skills (productivity/handoff)
  commit: d65391149dbb5fe76478e76fa8d5122b2aa5a70e
  note: Adapted for Fractory vocabulary.
---

Write a handoff document summarising the current conversation so a fresh agent can continue the work. Save it to the temporary directory of the user's OS (`$TMPDIR`, else `/tmp`), not the current workspace.

Include a "suggested skills" section naming which skills the next agent should load (for example `grill-with-docs`, `to-spec`, `to-tickets`).

State where the work stands in the flow: Goal, Spec (and whether the Spec Gate was passed), Tickets (and whether the Ticket Gate was passed), or a Run.

Do not duplicate content already captured in other artifacts (Specs, ADRs, Tickets, commits, diffs). Reference them by path, ref or URL instead.

Redact any sensitive information, such as API keys, passwords or personal data.

If the user passed arguments, treat them as the focus of the next session and tailor the document to it.
