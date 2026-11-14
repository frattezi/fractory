"""Intake: a Plane card carrying the intake label becomes a job.

`candidates` is pure. `run_intake` reads Plane, then launches through `launch.launch` with a brief
built from the card. One failing launch never stops the others.
"""

from __future__ import annotations

import tempfile
from collections.abc import Callable, Iterable
from pathlib import Path

from . import judge, launch, state, store
from .trackers import plane as plane_mod

DEFAULT_LABEL = "fractory"
DEFAULT_MAX_PARALLEL = 3
STARTABLE_GROUPS = ("backlog", "unstarted")

FOOTER = """---
Done when: the checks pass, the change is pushed and a pull request is open. Then, from the Fractory
checkout, link the PR to this job (`python3 -m fractory job link <job id> --branch <branch> --pr <n>`),
advance it to built (`python3 -m fractory job advance <job id> built`) and report worker_done.
The Judge reviews the PR against this brief and the Plane card. Do not merge.
"""


def _state_group(issue: dict) -> str:
    st = issue.get("state")
    return str(st.get("group", "")) if isinstance(st, dict) else ""


def candidates(plane_issues: Iterable[dict], label_id: str, jobs: Iterable[state.Job]) -> list[dict]:
    """Cards with the label, not started, and without any job yet (cancelled ones included)."""
    taken = {j.tracker.get("ref") for j in jobs if j.tracker}
    return [
        i
        for i in plane_issues
        if label_id in [(lb["id"] if isinstance(lb, dict) else lb) for lb in i.get("labels") or []]
        and _state_group(i) in STARTABLE_GROUPS
        and i["id"] not in taken
    ]


def build_brief(issue: dict) -> str:
    title = str(issue.get("name") or "").strip()
    body = judge.html_to_text(str(issue.get("description_html") or ""))
    return f"# {title}\n\n{body}\n\n{FOOTER}"


def open_jobs(jobs: Iterable[state.Job]) -> int:
    return sum(1 for j in jobs if j.stage not in state.TERMINAL)


Launcher = Callable[[launch.Args, plane_mod.Plane], int]


def run_intake(config: dict, orch: Path, dry_run: bool = False, launcher: Launcher | None = None) -> int:
    """Launch labelled cards of every `intake_repos` project. Returns the number launched (or planned)."""
    repos = config.get("intake_repos") or {}
    if not repos:
        print("intake: no intake_repos in config.toml")
        return 0
    label_name = str(config.get("intake_label") or DEFAULT_LABEL)
    limit = int(config.get("max_parallel_jobs") or DEFAULT_MAX_PARALLEL)
    plane_url = str(config.get("plane_url") or plane_mod.DEFAULT_URL)
    # force: the footer is boilerplate, so the brief check would always flag it as beyond the card
    launcher = launcher or (lambda a, plane: launch.launch(a, plane, orch))
    jobs = store.all_jobs()
    free = limit - open_jobs(jobs)
    launched = 0
    key = plane_mod.api_key_from_env()
    for project, repo in repos.items():
        try:
            plane = plane_mod.Plane(project, key, plane_url)
            label = next((lb for lb in plane.labels() if lb.get("name") == label_name), None)
            if label is None:
                print(f"intake: {project}: no label {label_name!r}")
                continue
            cards = candidates(plane.list_issues(), label["id"], jobs)
        except (plane_mod.PlaneError, RuntimeError, OSError) as err:
            print(f"intake: {project}: {err}")
            continue
        for issue in cards:
            if launched >= free:
                print(f"intake: {limit} jobs open (max_parallel_jobs); {issue['name']!r} waits")
                continue
            title = str(issue.get("name") or issue["id"])
            if dry_run:
                print(f"intake: would launch {title!r} in {Path(repo).expanduser()}")
                launched += 1
                continue
            try:
                with tempfile.TemporaryDirectory() as tmp:
                    brief = Path(tmp) / "brief.md"
                    brief.write_text(build_brief(issue))
                    args = launch.Args(
                        Path(repo).expanduser(), issue["id"], project, brief, plane_url=plane_url, force=True
                    )
                    code = launcher(args, plane)
                if code != 0:
                    print(f"intake: {title!r}: launch failed (exit {code})")
                    continue
                plane.set_status(issue["id"], "in_progress")
                print(f"intake: launched {title!r}")
                launched += 1
            except (plane_mod.PlaneError, launch.LaunchError, RuntimeError, OSError, ValueError) as err:
                print(f"intake: {title!r}: {err}")
    return launched
