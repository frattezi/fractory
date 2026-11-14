"""Intake: a Plane card carrying the intake label becomes a job.

`candidates` is pure. `run_intake` reads Plane, then launches through `launch.launch` with a brief
built from the card. One failing launch never stops the others.
"""

from __future__ import annotations

import re
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


_DEPENDS_RE = re.compile(r"^\s*depends\s+on\s*:\s*(.*)$", re.IGNORECASE)


def card_text(issue: dict) -> str:
    return judge.html_to_text(str(issue.get("description_html") or ""))


def depends_on(issue: dict) -> list[str]:
    """Refs of the first `Depends on: <refs>` line of the card text (bold allowed). `none` or empty -> []."""
    for line in card_text(issue).splitlines():
        m = _DEPENDS_RE.match(line.replace("*", ""))
        if m:
            refs = [r.strip() for r in m.group(1).split(",") if r.strip()]
            return [] if [r.lower() for r in refs] == ["none"] else refs
    return []


def _resolve(ref: str, issues: Iterable[dict], identifier: str) -> dict | None:
    """The card a ref points to: a Plane key (`CUIDADO-12`) or a title prefix (`07`: `07 ...` or `07 · ...`)."""
    for i in issues:
        if identifier and ref.upper() == f"{identifier}-{i.get('sequence_id')}".upper():
            return i
        title = str(i.get("name") or "")
        if title == ref or title.startswith((f"{ref} ", f"{ref}\u00a0")):
            return i
    return None


def unmet_dependencies(
    issue: dict, issues: list[dict], identifier: str = "", warned: set[tuple[str, str]] | None = None
) -> list[str]:
    """Refs of `issue` that are not in a completed card. Unknown refs are reported once per `warned`."""
    unmet = []
    for ref in depends_on(issue):
        target = _resolve(ref, issues, identifier)
        if target is None:
            mark = (str(issue.get("id")), ref)
            if warned is None or mark not in warned:
                print(f"intake: {issue.get('name') or issue.get('id')}: unknown dependency {ref}")
                if warned is not None:
                    warned.add(mark)
            unmet.append(ref)
        elif _state_group(target) != "completed":
            unmet.append(ref)
    return unmet


def candidates(
    plane_issues: Iterable[dict],
    label_id: str,
    jobs: Iterable[state.Job],
    identifier: str = "",
    warned: set[tuple[str, str]] | None = None,
    waiting: dict[str, list[str]] | None = None,
) -> list[dict]:
    """Cards with the label, not started, without any job yet (cancelled ones included), and whose
    `Depends on:` cards are all completed. Blocked cards are recorded in `waiting` (id -> unmet refs)."""
    all_issues = list(plane_issues)
    taken = {j.tracker.get("ref") for j in jobs if j.tracker}
    found = []
    for i in all_issues:
        if not (
            label_id in [(lb["id"] if isinstance(lb, dict) else lb) for lb in i.get("labels") or []]
            and _state_group(i) in STARTABLE_GROUPS
            and i["id"] not in taken
        ):
            continue
        unmet = unmet_dependencies(i, all_issues, identifier, warned)
        if unmet:
            if waiting is not None:
                waiting[i["id"]] = unmet
            continue
        found.append(i)
    return found


def build_brief(issue: dict) -> str:
    title = str(issue.get("name") or "").strip()
    body = card_text(issue)
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
    warned: set[tuple[str, str]] = set()
    for project, repo in repos.items():
        try:
            plane = plane_mod.Plane(project, key, plane_url)
            label = next((lb for lb in plane.labels() if lb.get("name") == label_name), None)
            if label is None:
                print(f"intake: {project}: no label {label_name!r}")
                continue
            identifier = next(
                (p["identifier"] for p in plane_mod.Plane.projects(key, plane_url) if p["id"] == project), ""
            )
            waiting: dict[str, list[str]] = {}
            all_issues = plane.list_issues()
            cards = candidates(all_issues, label["id"], jobs, identifier, warned, waiting)
        except (plane_mod.PlaneError, RuntimeError, OSError) as err:
            print(f"intake: {project}: {err}")
            continue
        if dry_run:
            for i in all_issues:
                if i["id"] in waiting:
                    print(f"intake: {i.get('name') or i['id']} waits for {', '.join(waiting[i['id']])}")
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
