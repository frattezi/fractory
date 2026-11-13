"""fractory: the control plane of the agent factory.

    fractory job new --repo DIR --title T [--stage S] [--budget USD] [--tracker plane --ref ID]
    fractory job list [--all]
    fractory job status ID [--json]
    fractory job advance ID EVENT [--check NAME] [--note TEXT]
    fractory job link ID [--worktree W] [--terminal T] [--branch B] [--pr N] [--profile P]
    fractory job cost ID USD
    fractory gate list
    fractory gate open ID --reason R [--detail TEXT]
    fractory gate resolve ID continue|cancel [--note TEXT]
    fractory sync [ID...]          advance jobs from PR and CI; mirror to the tracker
    fractory watch [--every S] [--rounds N]   sync in a loop
    fractory watch --install | --uninstall    keep watch running as a LaunchAgent
    fractory dash [--out FILE]
    fractory plane projects
    fractory plane import-specs --repo DIR --project ID [--identifier KEY] [--apply]
    fractory plane create-project --name N --identifier KEY
    fractory plane add-item --project ID --title T [--body MD | --body-file F] [--status S]
    fractory orch ARGS...          passthrough to orch.py (the v0 build engine, unchanged)

Exit 0 means it did what it says; 1 means it did not. Output is short plain text.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

from . import launchd, specs_import, state, store, sync
from .trackers import plane as plane_mod
from .trackers.base import STATUS_GROUPS

ORCH = Path(os.environ.get("FRACTORY_ORCH", Path.home() / ".claude/skills/orchestrate/scripts/orch.py"))
LINK_FIELDS = ("worktree", "terminal", "branch", "pr", "profile")


def _line(job: state.Job) -> str:
    gate = f"  GATE {job.gate.reason}" if job.gate else ""
    return f"{job.id}  {job.stage:<9}  {job.kind:<8}  US$ {job.cost_usd:6.2f}/{job.budget_usd:.0f}  {job.title}{gate}"


def _report(job: state.Job, actions: list[str]) -> None:
    print(_line(job))
    for action in actions:
        if action == "escalate_model":
            profile = job.links.get("profile")
            hint = f"orch.py route --escalate-from {profile}" if profile else "orch.py route --escalate-from <profile>"
            print(f"action: escalate_model (same check red {state.MAX_RED_SAME_CHECK}x) -> {hint}")
        elif action.startswith("gate:"):
            print(f"action: gate opened ({action[5:]}): {job.gate.detail if job.gate else ''}")


def _mutate(job_id: str, fn) -> int:
    with store.locked(job_id):
        job = store.load(job_id)
        job, actions = fn(job)
        store.save(job)
    _report(job, actions)
    return 0


def cmd_job_new(a: argparse.Namespace) -> int:
    repo = Path(a.repo).expanduser().resolve()
    if not repo.is_dir():
        print(f"no such repo dir: {repo}")
        return 1
    job_id = store.next_job_id(repo)
    job = state.new_job(job_id, str(repo), a.title, a.kind or store.repo_kind(repo), a.budget, a.stage)
    if a.tracker:
        job.tracker = {"kind": a.tracker, "ref": a.ref or ""}
        if a.tracker == "plane":
            job.tracker.update(project=a.project or "", url=a.plane_url)
    with store.locked(job_id):
        path = store.save(job)
    print(_line(job))
    print(f"state: {path}")
    return 0


def cmd_job_list(a: argparse.Namespace) -> int:
    jobs = [j for j in store.all_jobs() if a.all or j.stage not in state.TERMINAL]
    for job in jobs:
        print(_line(job))
    if not jobs:
        print("no jobs")
    return 0


def cmd_job_status(a: argparse.Namespace) -> int:
    job = store.load(a.id)
    if a.json:
        print(json.dumps(job.to_dict(), indent=2, ensure_ascii=False))
        return 0
    print(_line(job))
    for key, value in job.links.items():
        print(f"  {key}: {value}")
    if job.tracker:
        print(f"  tracker: {job.tracker.get('kind')} {job.tracker.get('ref', '')}")
    allowed = ", ".join(state.TRANSITIONS.get(job.stage, {})) or "-"
    print(f"  next events: {allowed}  judge rounds: {job.judge_rounds}/{state.MAX_JUDGE_ROUNDS}")
    for h in job.history[-5:]:
        extra = {k: v for k, v in h.items() if k not in ("at", "event", "stage")}
        print(f"  {h['at']}  {h['event']} -> {h['stage']}  {json.dumps(extra, ensure_ascii=False) if extra else ''}")
    return 0


def cmd_job_advance(a: argparse.Namespace) -> int:
    return _mutate(a.id, lambda j: state.apply_event(j, a.event, a.check, a.note or ""))


def cmd_job_link(a: argparse.Namespace) -> int:
    values = {k: str(getattr(a, k)) for k in LINK_FIELDS if getattr(a, k) is not None}
    if not values:
        print("nothing to link: pass --worktree, --terminal, --branch, --pr or --profile")
        return 1

    def link(job: state.Job):
        job.links.update(values)
        return job, []

    return _mutate(a.id, link)


def cmd_job_cost(a: argparse.Namespace) -> int:
    return _mutate(a.id, lambda j: state.add_cost(j, a.usd))


def cmd_gate_list(a: argparse.Namespace) -> int:
    gated = [j for j in store.all_jobs() if j.gate]
    for job in gated:
        assert job.gate
        print(f"{job.id}  {job.gate.reason}  {job.gate.detail}  (since {job.gate.opened_at})")
    if not gated:
        print("no open gates")
    return 0


def cmd_gate_open(a: argparse.Namespace) -> int:
    return _mutate(a.id, lambda j: (state.open_gate(j, a.reason, a.detail or ""), [f"gate:{a.reason}"]))


def cmd_gate_resolve(a: argparse.Namespace) -> int:
    return _mutate(a.id, lambda j: (state.resolve_gate(j, a.decision, a.note or ""), []))


def dash_data() -> dict:
    jobs = store.all_jobs()
    return {
        "generated_at": state.now_iso(),
        "jobs": [
            {
                "id": j.id,
                "repo": Path(j.repo).name,
                "title": j.title,
                "kind": j.kind,
                "stage": j.stage,
                "gate": j.gate.reason if j.gate else None,
                "judge_rounds": j.judge_rounds,
                "cost_usd": j.cost_usd,
                "budget_usd": j.budget_usd,
                "pr": j.links.get("pr"),
                "updated_at": j.history[-1]["at"] if j.history else j.created_at,
            }
            for j in jobs
        ],
        "totals": {
            "open": sum(j.stage not in state.TERMINAL for j in jobs),
            "gated": sum(j.gate is not None for j in jobs),
            "cost_usd": round(sum(j.cost_usd for j in jobs), 2),
        },
    }


def cmd_dash(a: argparse.Namespace) -> int:
    text = json.dumps(dash_data(), indent=2, ensure_ascii=False) + "\n"
    if a.out:
        Path(a.out).write_text(text)
        print(f"wrote {a.out}")
    else:
        sys.stdout.write(text)
    return 0


def cmd_plane_projects(a: argparse.Namespace) -> int:
    for p in plane_mod.Plane.projects(plane_mod.api_key_from_env(), a.url, a.workspace):
        print(f"{p['id']}  {p['identifier']:<6}  {p['name']}")
    return 0


def cmd_plane_import(a: argparse.Namespace) -> int:
    repo = Path(a.repo).expanduser().resolve()
    specs = specs_import.read_specs(repo / "docs" / "specs")
    tracker = None
    if a.apply:
        tracker = plane_mod.Plane(
            a.project, plane_mod.api_key_from_env(), a.url, a.workspace, identifier=a.identifier or ""
        )
    results = specs_import.import_specs(specs, repo.name, tracker)
    for r in results:
        print(f"{r.outcome:<8} {r.spec_id}  {r.ref}")
    print(f"{len(results)} open of {len(specs)} specs" + ("" if a.apply else "  (dry run: pass --apply to create)"))
    return 0


def cmd_plane_create_project(a: argparse.Namespace) -> int:
    project, created = plane_mod.Plane.create_project(
        plane_mod.api_key_from_env(), a.name, a.identifier, a.description or "", a.url, a.workspace
    )
    print(f"{'created' if created else 'exists '}  {project['id']}  {project['identifier']}  {project['name']}")
    return 0


def cmd_plane_add_item(a: argparse.Namespace) -> int:
    body = Path(a.body_file).read_text() if a.body_file else (a.body or "")
    client = plane_mod.Plane(a.project, plane_mod.api_key_from_env(), a.url, a.workspace)
    external_id = a.external_id or store.slug(a.title)
    try:
        item = client.create_item(a.title, specs_import.markdown_to_html(body), a.status, external_id)
        print(f"created  {external_id}  {item.ref}")
    except plane_mod.Duplicate as dup:
        print(f"exists   {external_id}  {dup.ref}")
    return 0


def plane_tracker(job: state.Job) -> plane_mod.Plane | None:
    t = job.tracker
    if t.get("kind") != "plane" or not t.get("project") or not t.get("ref"):
        return None
    return plane_mod.Plane(t["project"], plane_mod.api_key_from_env(), t.get("url") or plane_mod.DEFAULT_URL)


def cmd_sync(a: argparse.Namespace) -> int:
    """Advance jobs from their PR and CI, and mirror stage changes to the tracker."""
    jobs = [store.load(i) for i in a.ids] if a.ids else store.all_jobs()
    auto_merge = bool(store.config().get("auto_merge"))
    failed = False
    for job in jobs:
        if job.stage in state.TERMINAL or not job.links.get("pr"):
            continue
        try:
            pr = sync.fetch_pr(job.repo, job.links["pr"])
            with store.locked(job.id):
                current = store.load(job.id)
                found = sync.pr_event(current, pr)
                if found is None:
                    if auto_merge and sync.should_merge(current, pr):
                        sync.merge_pr(current.repo, current.links["pr"])
                        print(f"{current.id}  auto-merged PR {current.links['pr']}")
                    continue
                event, check = found
                updated, actions = state.apply_event(current, event, check, note="sync")
                store.save(updated)
            _report(updated, actions)
            if sync.STAGE_STATUS[updated.stage] != sync.STAGE_STATUS[current.stage]:
                tracker = plane_tracker(updated)
                if tracker:
                    tracker.set_status(updated.tracker["ref"], sync.STAGE_STATUS[updated.stage])
                    print(f"  tracker: {sync.STAGE_STATUS[updated.stage]}")
        except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as err:  # keep syncing the rest
            failed = True
            print(f"{job.id}  sync error: {err}")
    return 1 if failed else 0


def cmd_watch(a: argparse.Namespace) -> int:
    """Run sync every `--every` seconds. `--rounds 0` runs until interrupted (launchd, a terminal)."""
    if a.uninstall:
        print("watch agent removed" if launchd.uninstall() else "watch agent was not installed")
        return 0
    if a.install:
        log = store.factory_home() / "watch.log"
        print(f"watch agent installed: {launchd.install(log, a.every)}\nlog: {log}")
        return 0
    a.ids = []
    done = 0
    try:
        while a.rounds == 0 or done < a.rounds:
            if done:
                time.sleep(a.every)
            cmd_sync(a)
            sys.stdout.flush()
            done += 1
    except KeyboardInterrupt:
        print("watch stopped")
    return 0


def cmd_orch(a: argparse.Namespace) -> int:
    if not ORCH.exists():
        print(f"orch.py not found at {ORCH} (set FRACTORY_ORCH)")
        return 1
    os.execv(sys.executable, [sys.executable, str(ORCH), *a.args])
    return 1  # unreachable


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="fractory", description="Control plane of the agent factory.")
    sub = p.add_subparsers(dest="group", required=True)

    job = sub.add_parser("job", help="create and move jobs").add_subparsers(dest="cmd", required=True)
    s = job.add_parser("new", help="create a job")
    s.add_argument("--repo", required=True)
    s.add_argument("--title", required=True)
    s.add_argument("--stage", default="discovery", choices=list(state.TRANSITIONS))
    s.add_argument("--kind", choices=state.KINDS, help="default: able under ~/Factory/Able, else internal")
    s.add_argument("--budget", type=float, default=state.DEFAULT_BUDGET_USD)
    s.add_argument("--tracker", choices=("plane", "jira"))
    s.add_argument("--ref", help="the tracker item id")
    s.add_argument("--project", help="Plane project id, for --tracker plane")
    s.add_argument("--plane-url", default=plane_mod.DEFAULT_URL)
    s.set_defaults(fn=cmd_job_new)
    s = job.add_parser("list", help="open jobs")
    s.add_argument("--all", action="store_true", help="include done and cancelled")
    s.set_defaults(fn=cmd_job_list)
    s = job.add_parser("status", help="one job in detail")
    s.add_argument("id")
    s.add_argument("--json", action="store_true")
    s.set_defaults(fn=cmd_job_status)
    s = job.add_parser(
        "advance",
        help="apply an event: " + ", ".join(sorted({e for t in state.TRANSITIONS.values() for e in t} | {"cancel"})),
    )
    s.add_argument("id")
    s.add_argument("event")
    s.add_argument("--check", help="which check went red (red streaks are counted per check)")
    s.add_argument("--note")
    s.set_defaults(fn=cmd_job_advance)
    s = job.add_parser("link", help="record the job's worktree, terminal, branch, PR or worker profile")
    s.add_argument("id")
    for f in LINK_FIELDS:
        s.add_argument(f"--{f}")
    s.set_defaults(fn=cmd_job_link)
    s = job.add_parser("cost", help="add spend; over budget opens a cost gate")
    s.add_argument("id")
    s.add_argument("usd", type=float)
    s.set_defaults(fn=cmd_job_cost)

    gate = sub.add_parser("gate", help="human gates").add_subparsers(dest="cmd", required=True)
    gate.add_parser("list", help="open gates").set_defaults(fn=cmd_gate_list)
    s = gate.add_parser("open", help="stop a job until a person decides")
    s.add_argument("id")
    s.add_argument("--reason", required=True)
    s.add_argument("--detail")
    s.set_defaults(fn=cmd_gate_open)
    s = gate.add_parser("resolve", help="continue or cancel a gated job")
    s.add_argument("id")
    s.add_argument("decision", choices=("continue", "cancel"))
    s.add_argument("--note")
    s.set_defaults(fn=cmd_gate_resolve)

    s = sub.add_parser("dash", help="JSON summary of every job, for the dashboard")
    s.add_argument("--out")
    s.set_defaults(fn=cmd_dash)

    s = sub.add_parser("watch", help="run sync in a loop (what the supervisor does every minute)")
    s.add_argument("--every", type=float, default=60.0, help="seconds between rounds")
    s.add_argument("--rounds", type=int, default=0, help="stop after N rounds (0: forever)")
    s.add_argument("--install", action="store_true", help="run watch as a LaunchAgent (survives reboots)")
    s.add_argument("--uninstall", action="store_true", help="remove the LaunchAgent")
    s.set_defaults(fn=cmd_watch)
    s = sub.add_parser("sync", help="advance jobs from their PR and CI; mirror stage changes to the tracker")
    s.add_argument("ids", nargs="*", help="default: every open job with a PR")
    s.set_defaults(fn=cmd_sync)

    pl = sub.add_parser("plane", help="Plane tracker").add_subparsers(dest="cmd", required=True)
    commands = (
        ("projects", cmd_plane_projects),
        ("import-specs", cmd_plane_import),
        ("create-project", cmd_plane_create_project),
        ("add-item", cmd_plane_add_item),
    )
    for name, fn in commands:
        s = pl.add_parser(name)
        s.add_argument("--url", default=plane_mod.DEFAULT_URL)
        s.add_argument("--workspace", default=plane_mod.DEFAULT_WORKSPACE)
        s.set_defaults(fn=fn)
        if name == "import-specs":
            s.add_argument("--repo", required=True)
            s.add_argument("--project", required=True, help="Plane project id (fractory plane projects)")
            s.add_argument("--identifier", help="project key, for printed item keys")
            s.add_argument("--apply", action="store_true", help="create the issues (default: dry run)")
        elif name == "create-project":
            s.add_argument("--name", required=True)
            s.add_argument("--identifier", required=True, help="project key, up to 12 letters")
            s.add_argument("--description")
        elif name == "add-item":
            s.add_argument("--project", required=True)
            s.add_argument("--title", required=True)
            s.add_argument("--body", help="Markdown")
            s.add_argument("--body-file", help="Markdown file")
            s.add_argument("--status", default="backlog", choices=list(STATUS_GROUPS))
            s.add_argument("--external-id", help="dedupe key (default: slug of the title)")

    s = sub.add_parser("orch", help="passthrough to orch.py", add_help=False)
    s.add_argument("args", nargs=argparse.REMAINDER)
    s.set_defaults(fn=cmd_orch)
    return p


def main(argv: list[str] | None = None) -> int:
    a = build_parser().parse_args(argv)
    try:
        return a.fn(a)
    except (state.TransitionError, FileNotFoundError, ValueError, RuntimeError, OSError) as err:
        print(f"error: {err}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
