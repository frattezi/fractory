"""Intake: a Plane card carrying the intake label becomes a job.

`candidates` is pure. `run_intake` reads Plane, then launches through `launch.launch` with a brief
built from the card. One failing launch never stops the others.
"""

from __future__ import annotations

import re
import subprocess
import sys
import tempfile
from collections.abc import Callable, Iterable
from pathlib import Path

from . import health, judge, launch, state, store
from .trackers import plane as plane_mod

DEFAULT_LABEL = "fractory"
DEFAULT_MAX_PARALLEL = 3
STARTABLE_GROUPS = ("unstarted",)  # Backlog = not ready; moving the card to Todo is the "go"

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
    parked: list[dict] | None = None,
) -> list[dict]:
    """Cards with the label in Todo, without any job yet (cancelled ones included), and whose
    `Depends on:` cards are all completed. Blocked cards are recorded in `waiting` (id -> unmet refs);
    labelled Backlog cards without a job are appended to `parked`."""
    all_issues = list(plane_issues)
    taken = {j.tracker.get("ref") for j in jobs if j.tracker}
    found = []
    for i in all_issues:
        if not (
            label_id in [(lb["id"] if isinstance(lb, dict) else lb) for lb in i.get("labels") or []]
            and i["id"] not in taken
        ):
            continue
        if _state_group(i) == "backlog":
            if parked is not None:
                parked.append(i)
            continue
        if _state_group(i) not in STARTABLE_GROUPS:
            continue
        unmet = unmet_dependencies(i, all_issues, identifier, warned)
        if unmet:
            if waiting is not None:
                waiting[i["id"]] = unmet
            continue
        found.append(i)
    return found


DEFAULT_PROFILE = "strong"
NON_TAG_LABELS = {"fractory", "humano", "design"}
_WORKER_RE = re.compile(r"^\s*worker\s*:\s*([\w.-]+)\s*$", re.IGNORECASE)
_TAGS_RE = re.compile(r"^\s*tags\s*:\s*(.*)$", re.IGNORECASE)
_ROUTED_RE = re.compile(r"^profile (\S+?):")


def card_line_profile(issue: dict) -> str | None:
    """The profile of the first `Worker: <profile>` line of the card text (bold allowed)."""
    for line in card_text(issue).splitlines():
        m = _WORKER_RE.match(line.replace("*", ""))
        if m:
            return m.group(1)
    return None


def card_tags(issue: dict, label_names: list[str], intake_label: str = DEFAULT_LABEL) -> list[str]:
    """Routing tags: the card's labels other than the standard who-labels, plus a `Tags: a, b` line."""
    skip = NON_TAG_LABELS | {intake_label.lower()}
    tags = [n for n in label_names if n.lower() not in skip]
    for line in card_text(issue).splitlines():
        m = _TAGS_RE.match(line.replace("*", ""))
        if m:
            tags += [t.strip() for t in m.group(1).split(",") if t.strip()]
            break
    return list(dict.fromkeys(tags))


def _run_orch(argv: list[str]) -> tuple[int, str]:
    proc = subprocess.run(argv, check=False, capture_output=True, text=True)
    return proc.returncode, proc.stdout + proc.stderr


def route_spec(title: str, tags: list[str]) -> str:
    front = f"---\ntags: [{', '.join(tags)}]\n---\n" if tags else ""
    return f"{front}# {title}\n"


def choose_profile(
    issue: dict, repo: Path, config: dict, orch: Path, label_names: list[str], runner=None
) -> tuple[str, str]:
    """(profile, why). Order: `Worker:` line, config per repo, config default, `orch.py route`, then strong.
    Route runs without --ignore-quota, so a provider that is signed out or over quota falls to the next candidate."""
    runner = runner or _run_orch
    line = card_line_profile(issue)
    if line:
        return line, "Worker: line in the card"
    intake_cfg = config.get("intake") or {}
    per_repo = next(
        (v for k, v in (intake_cfg.get("profiles") or {}).items() if Path(k).expanduser() == Path(repo).expanduser()),
        None,
    )
    if per_repo:
        return str(per_repo), "config [intake.profiles] for the repo"
    if intake_cfg.get("default_profile"):
        return str(intake_cfg["default_profile"]), "config [intake] default_profile"
    tags = card_tags(issue, label_names, str(config.get("intake_label") or DEFAULT_LABEL))
    with tempfile.TemporaryDirectory() as tmp:
        spec = Path(tmp) / "route.md"
        spec.write_text(route_spec(str(issue.get("name") or ""), tags))
        try:
            code, out = runner([sys.executable, str(orch), "route", "--spec", str(spec), "--repo", str(repo)])
        except OSError as err:
            return DEFAULT_PROFILE, f"route failed ({err}), fallback"
    lines = out.strip().splitlines() if code == 0 and out.strip() else []
    m = None
    matched_line = None
    for line in lines:
        m = _ROUTED_RE.match(line)
        if m:
            matched_line = line
            break
    if not m:
        return DEFAULT_PROFILE, f"route gave nothing (exit {code}), fallback"
    return m.group(1), "orch.py route: " + matched_line


def build_brief(issue: dict) -> str:
    title = str(issue.get("name") or "").strip()
    body = card_text(issue)
    return f"# {title}\n\n{body}\n\n{FOOTER}"


def open_jobs(jobs: Iterable[state.Job]) -> int:
    return sum(1 for j in jobs if j.stage not in state.TERMINAL)


def _entry(issue: dict, identifier: str, label_names: dict[str, str], decision: str, **extra: object) -> dict:
    st = issue.get("state")
    return {
        "key": f"{identifier}-{issue.get('sequence_id')}" if identifier else str(issue.get("sequence_id") or ""),
        "title": str(issue.get("name") or issue["id"]),
        "state": (st.get("name") or st.get("group")) if isinstance(st, dict) else st,
        "labels": [
            label_names.get(i, i)
            for i in ((lb["id"] if isinstance(lb, dict) else lb) for lb in issue.get("labels") or [])
        ],
        "decision": decision,
        **extra,
    }


def _queue_entries(
    all_issues: list[dict],
    label_id: str,
    taken: set,
    parked: list[dict],
    waiting: dict[str, list[str]],
    identifier: str,
    label_names: dict[str, str],
) -> dict[str, dict]:
    """Decision per labelled card that is still in play (id -> entry); launch outcomes are filled in by the caller."""
    parked_ids = {i["id"] for i in parked}
    out = {}
    for i in all_issues:
        if label_id not in [(lb["id"] if isinstance(lb, dict) else lb) for lb in i.get("labels") or []]:
            continue
        if i["id"] in taken:
            if _state_group(i) not in ("completed", "cancelled"):
                out[i["id"]] = _entry(i, identifier, label_names, "has_job")
        elif i["id"] in parked_ids:
            out[i["id"]] = _entry(i, identifier, label_names, "parked")
        elif i["id"] in waiting:
            out[i["id"]] = _entry(i, identifier, label_names, "waits_for", waits_for=waiting[i["id"]])
    return out


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
    queue: dict[str, dict] = {}
    taken = {j.tracker.get("ref") for j in jobs if j.tracker}
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
            parked: list[dict] = []
            cards = candidates(all_issues, label["id"], jobs, identifier, warned, waiting, parked)
            names = {lb["id"]: lb.get("name", lb["id"]) for lb in plane.labels()}
            entries = _queue_entries(all_issues, label["id"], taken, parked, waiting, identifier, names)
            for issue in cards:
                entries[issue["id"]] = _entry(issue, identifier, names, "launched")
            queue[project] = {"identifier": identifier, "cards": entries}
        except (plane_mod.PlaneError, RuntimeError, OSError) as err:
            print(f"intake: {project}: {err}")
            queue[project] = {"error": str(err), "cards": {}}
            continue
        if dry_run:
            for i in parked:
                print(f"intake: {i.get('name') or i['id']} parked (backlog)")
            for i in all_issues:
                if i["id"] in waiting:
                    print(f"intake: {i.get('name') or i['id']} waits for {', '.join(waiting[i['id']])}")
        for issue in cards:
            if launched >= free:
                print(f"intake: {limit} jobs open (max_parallel_jobs); {issue['name']!r} waits")
                queue[project]["cards"][issue["id"]]["decision"] = "max_parallel"
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
                    card_labels = [
                        names.get(lb["id"] if isinstance(lb, dict) else lb, "") for lb in issue.get("labels") or []
                    ]
                    profile, why = choose_profile(issue, Path(repo).expanduser(), config, orch, card_labels)
                    print(f"intake: {title!r}: profile {profile} ({why})")
                    args = launch.Args(
                        Path(repo).expanduser(),
                        issue["id"],
                        project,
                        brief,
                        profile=profile,
                        plane_url=plane_url,
                        force=True,
                        profile_why=why,
                    )
                    code = launcher(args, plane)
                if code != 0:
                    print(f"intake: {title!r}: launch failed (exit {code})")
                    _failed(queue[project], issue, f"exit {code}")
                    continue
                plane.set_status(issue["id"], "in_progress")
                print(f"intake: launched {title!r}")
                launched += 1
            except (plane_mod.PlaneError, launch.LaunchError, RuntimeError, OSError, ValueError) as err:
                print(f"intake: {title!r}: {err}")
                _failed(queue[project], issue, str(err))
    if not dry_run:
        health.write_json(
            "queue.json",
            {
                "at": health.now_iso(),
                "projects": {p: {**v, "cards": list(v["cards"].values())} for p, v in queue.items()},
            },
        )
    return launched


def _failed(project_queue: dict, issue: dict, error: str) -> None:
    project_queue["cards"][issue["id"]].update(decision="launch_failed", error=error)
