# Fractory — agent instructions

- Python 3.12, standard library only. No runtime dependencies.
- Decisions with a right answer (stages, transitions, gates, escalation, risk) live in tested code in
  `fractory/`, never in prompts.
- `state.py` stays pure (no I/O); persistence is `store.py`; trackers implement `trackers/base.Tracker`.
- Tests: `python3 -m unittest discover -s tests -t .`. Integration tests through `cli.main` with a temp
  `FACTORY_HOME`; external APIs are faked over real HTTP (see `tests/test_plane_import.py`).
- Never read secrets: the Plane key is read by the code from `$PLANE_API_KEY` or the Keychain.
- Design doc: https://claude.ai/artifact/MaZLMg6zhgk1niVf49h5Fc

## Work repos (Able / Caring)

Pedro's employer is Caring. Its repos live under `~/Factory/Able` (`store.repo_kind` → `able`): modular-monolith,
portal, HubSpot extensions, DIR and any other Caring repo.

- Tracker is **Jira** (`caring.atlassian.net`), never Plane.
- Nothing shared with the employer may mention the Fractory or the AI-dev setup (agents, workers, Judge, Orca,
  briefs, profiles, models, cost): Jira issues and comments, PR titles, bodies and comments, commit messages,
  repo docs, Confluence. They read as if a developer wrote them.
- Personal notes, Plane, `~/.factory` and this repo are fine.
- Code that posts outside (Judge PR comments, tracker comments, briefs that end up in PR bodies) must strip or
  skip those mentions for `able` jobs, enforced in code with a test, not left to the prompt.
