# Fractory: agent rules

Read [GLOSSARY.md](GLOSSARY.md) for vocabulary, [docs/adr/](docs/adr/) for decisions and
[docs/specs/0001-fractory-v1.md](docs/specs/0001-fractory-v1.md) for the v1 plan.

## Stack

- TypeScript, strict, ESM, Node ≥ 22, run with `tsx` (no build step). pnpm.
- `zod` validates every boundary: config files, registry files, tracker and `gh` responses,
  agent structured output.
- Tests: vitest in `tests/`, named `<area>.test.ts`. Stub external processes (`gh`, `git`,
  `docker`, Sandcastle) and `fetch`; no network in tests.
- Before committing: `pnpm typecheck && pnpm test && pnpm lint`.

## Rules

- No Token Architecture: anything with a right answer is code with a test. Prompts route and phrase.
- A question or decision an agent puts to the owner travels as an **Agent Surface**: a description
  in [A2UI](https://a2ui.org), written to the Run's output for Fractory Manager to render. Validate
  it with `zod` and pin its version like any other contract. A Run never paints a screen, and a
  structured ask never becomes prose in a log or a private JSON shape of its own.
- Contracts in `src/contracts/` are shared by every part. Change them in their own commit and
  update every caller.
- External calls go through small injected functions so tests can replace them.
- A failed read of external state proves nothing: never treat it as "dead", "failed" or "absent".
- Work Mode text sent outside (tracker, PR, commit, branch) passes `assertOutboundAllowed`.
- Never log secrets. Credentials come from the environment.
