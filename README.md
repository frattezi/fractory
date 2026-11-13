# Fractory

Engine and control plane of the agent factory on Orca. Code decides a job's stage, transitions,
gates and escalation; a model only works inside a stage.

Design: [Fractory — design da versão final](https://claude.ai/artifact/MaZLMg6zhgk1niVf49h5Fc).
This repo is **v0 (engine)**: the job state machine, the CLI, the Plane adapter and the import of open
specs. Building still runs through `orch.py` (passthrough, behaviour unchanged).

## Run

```sh
python3 -m fractory --help          # no install needed, stdlib only (Python 3.12+)
pipx install -e .                    # optional: a `fractory` command on PATH
python3 -m unittest discover -s tests -t .
```

## Jobs

State lives outside every repo, in `$FACTORY_HOME/jobs/<id>/` (default `~/.factory`):
`state.json`, plus `holdout/` for acceptance scenarios the build never sees.

```
discovery --scoped--> spec --planned--> build --built--> checks --green--> review --reviewed--> judge
                                          ^                 |red                                  |approved
                                          +-----------------+------------<rejected----------------+
judge --approved--> ship --merged (internal) | draft_pr (Able)--> done          any --cancel--> cancelled
```

| Rule | Where |
| --- | --- |
| Same check red 2x → `escalate_model` (step up via `orch.py route --escalate-from`) | `state.apply_event` |
| 2 judge rejections → gate `judge_rounds`; events refused until resolved | `state.apply_event` |
| Spend over budget (default US$ 50) → gate `cost` | `state.add_cost` |
| Able repos (under `~/Factory/Able`) end in `draft_pr`; internal ones in `merged` | `state.apply_event`, `store.repo_kind` |

```sh
fractory job new --repo ~/Factory/Esquerdalha/cortadas --title "Chat no Plane"
fractory job advance cortadas-0001 scoped
fractory job link cortadas-0001 --worktree spec-x --terminal term_… --profile backend
fractory job advance cortadas-0001 red --check lint
fractory job cost cortadas-0001 3.20
fractory gate list
fractory gate resolve cortadas-0001 continue --note "spec ajustada"
fractory dash --out /tmp/dash.json
fractory orch alive term_…          # everything orch.py does, unchanged
```

## Plane

API key: `$PLANE_API_KEY`, or the Keychain item `fractory-plane`
(`security add-generic-password -s fractory-plane -a plane -w`). Create the key in Plane under
Profile settings → Personal access tokens.

```sh
fractory plane projects
fractory plane import-specs --repo ~/Factory/Esquerdalha/cortadas --project <id>           # dry run
fractory plane import-specs --repo ~/Factory/Esquerdalha/cortadas --project <id> --apply   # create
```

Only open specs (`draft`, `blocked`, `ready`, `in-progress`, `in-review`) are imported; done ones stay in
the repo as frozen history. Each issue carries `external_id` = the spec id, so a second run reports
`exists` instead of duplicating.

## Next (v1)

Holdout verifier, risk score and review by risk, Judge with a fixed rubric, the supervisor driving
`fractory job advance` from CI and PR events, Orca native gates, and retiring the always-on orchestrator.
