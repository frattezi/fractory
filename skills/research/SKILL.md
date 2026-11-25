---
name: research
description: Investigate a question against high-trust primary sources and capture the findings as a Markdown file in the repo. Use when a topic needs researching, docs or API facts need gathering, or reading legwork can go to a background agent.
license: MIT
metadata:
  source: https://github.com/mattpocock/skills (research)
  commit: d65391149dbb5fe76478e76fa8d5122b2aa5a70e
  note: Upstream text plus a secrets and Work Mode line.
---

Spin up a **background agent** to do the research, so you keep working while it reads. Start it with a fresh context window.

Its job:

1. Investigate the question against **primary sources** (official docs, source code, specs, first-party APIs), not a secondary write-up of them. Follow every claim back to the source that owns it.
2. Write the findings to a single Markdown file, citing each claim's source.
3. Save it where the repo already keeps such notes; match the existing convention, and if there is none, put it somewhere sensible and say where.

Never put secrets in the file. In a Work Mode repo, write the notes as a developer would, with no mention of Fractory or AI tooling.
