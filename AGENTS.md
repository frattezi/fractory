# Fractory — agent instructions

- Python 3.12, standard library only. No runtime dependencies.
- Decisions with a right answer (stages, transitions, gates, escalation, risk) live in tested code in
  `fractory/`, never in prompts.
- `state.py` stays pure (no I/O); persistence is `store.py`; trackers implement `trackers/base.Tracker`.
- Tests: `python3 -m unittest discover -s tests -t .`. Integration tests through `cli.main` with a temp
  `FACTORY_HOME`; external APIs are faked over real HTTP (see `tests/test_plane_import.py`).
- Never read secrets: the Plane key is read by the code from `$PLANE_API_KEY` or the Keychain.
- Design doc: https://claude.ai/artifact/MaZLMg6zhgk1niVf49h5Fc
