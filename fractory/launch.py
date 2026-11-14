"""`fractory launch`: a job, its worktree and its worker in one command.

Every external call goes through `run_cmd`, resolved at call time so tests can swap it.
A failing step stops the command; the job stays in `build` with a `launch_failed` gate that names the step.
"""

from __future__ import annotations

import json
import os
import re
import shlex
import subprocess
import sys
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from . import briefcheck, state, store

Runner = Callable[[list[str]], tuple[int, str]]
NAME_MAX = 30


class LaunchError(RuntimeError):
    pass


def run_cmd(argv: list[str]) -> tuple[int, str]:
    proc = subprocess.run(argv, check=False, capture_output=True, text=True)
    return proc.returncode, proc.stdout + proc.stderr


def orca_exe() -> str:
    return os.environ.get("ORCA") or os.environ.get("ORCA_CLI_COMMAND") or "orca"


def worktree_name(title: str) -> str:
    return store.slug(title)[:NAME_MAX].strip("-") or "job"


def run_id(explicit: str | None) -> str:
    value = explicit or store.config().get("orca_run")
    if not value:
        raise LaunchError("no Orca run id: pass --run or set orca_run in $FACTORY_HOME/config.toml")
    return str(value)


def json_payload(output: str) -> dict:
    """The last JSON object in a command's output (Orca may print notices before it)."""
    for line in reversed(output.strip().splitlines()):
        try:
            data = json.loads(line)
        except ValueError:
            continue
        if isinstance(data, dict):
            return data
    try:
        data = json.loads(output)
    except ValueError:
        return {}
    return data if isinstance(data, dict) else {}


def worktree_id(output: str) -> str:
    result = json_payload(output).get("result") or {}
    wt = result.get("worktree") if isinstance(result.get("worktree"), dict) else result
    found = wt.get("id") if isinstance(wt, dict) else None
    if not found:
        raise LaunchError(f"no worktree id in orca output: {output.strip()[:200]}")
    return str(found)


def coordinator_handle(run: str) -> str | None:
    """The terminal bound as the Run's coordinator. Orca only lets that terminal start workers, and under launchd
    `watch` runs in no terminal at all, so the worker launch borrows this identity through ORCA_TERMINAL_HANDLE."""
    code, out = run_cmd([orca_exe(), "orchestration", "run-show", "--id", run, "--json"])
    if code != 0:
        return None
    found = ((json_payload(out).get("result") or {}).get("run") or {}).get("coordinator_handle")
    return str(found) if found else None


def terminal_handle(output: str) -> str:
    m = re.search(r"in terminal (term_[A-Za-z0-9_-]+)", output)
    if not m:
        raise LaunchError(f"no terminal handle in orch.py output: {output.strip()[:200]}")
    return m.group(1)


@dataclass
class Args:
    repo: Path
    issue: str
    project: str
    brief: Path
    title: str | None = None
    profile: str = "strong"
    name: str | None = None
    run: str | None = None
    dry_run: bool = False
    plane_url: str | None = None
    force: bool = False


def _fail(job_id: str | None, step: str, detail: str, done: list[str]) -> int:
    print(f"launch failed at {step}: {detail}")
    if done:
        print("done so far: " + ", ".join(done))
    if job_id:
        with store.locked(job_id):
            job = store.load(job_id)
            store.save(state.open_gate(job, "launch_failed", f"{step}: {detail}"[:500]))
        print(f"{job_id}: gate launch_failed opened (job stays in build)")
    return 1


def _brief_beyond_card(issue: dict, title: str, brief: str) -> list[str]:
    """Extra items the brief asks beyond the card. A checker failure warns and returns none: never blocks a launch."""
    try:
        verdict = briefcheck.check(title, str(issue.get("description_html") or ""), brief)
    except briefcheck.BriefCheckError as err:
        print(f"warning: brief check failed, continuing: {err}")
        return []
    print("   brief check: " + ("ok" if verdict.ok else "brief goes beyond the card"))
    return verdict.extra


def owner_id(plane) -> str:
    """The card owner: `plane_assignee` from config, else the owner of the Plane API key."""
    return str(store.config().get("plane_assignee") or plane.me())


def launch(a: Args, plane, orch: Path) -> int:
    """`plane` has `get_item(ref)`; `orch` is the orch.py path (cli.ORCH)."""
    try:
        run = run_id(a.run)
        brief = a.brief.expanduser().resolve()
        if not brief.is_file():
            raise LaunchError(f"no such brief file: {brief}")
        repo = a.repo.expanduser().resolve()
        if not repo.is_dir():
            raise LaunchError(f"no such repo dir: {repo}")
    except LaunchError as err:
        print(f"error: {err}")
        return 1

    done: list[str] = []
    job_id: str | None = None
    step = "1 title"
    try:
        issue = plane.get_item(a.issue)
        title = a.title or str(issue.get("name") or "").strip()
        if not title:
            raise LaunchError(f"Plane issue {a.issue} has no name; pass --title")
        name = a.name or worktree_name(title)
        done.append(f"1 title: {title}")
        print(f"1. title: {title}")

        extra = _brief_beyond_card(issue, title, brief.read_text())
        if extra and not a.force:
            print("brief goes beyond its card; nothing created (--force to launch anyway):")
            print("\n".join(f"  - {item}" for item in extra))
            return 1

        job_id = "<job id>" if a.dry_run else store.next_job_id(repo)
        step = "2 job new"
        print(f"2. job new {job_id} at stage build (plane {a.project}/{a.issue})")
        if not a.dry_run:
            job = state.new_job(job_id, str(repo), title, store.repo_kind(repo), stage="build")
            job.tracker = {"kind": "plane", "ref": a.issue, "project": a.project, "url": a.plane_url or ""}
            with store.locked(job_id):
                store.save(job)
        done.append(f"2 job new {job_id}")

        step = "3 brief"
        dest = store.job_dir(job_id) / "brief.md" if not a.dry_run else Path("$FACTORY_HOME/jobs/<job id>/brief.md")
        print(f"3. copy brief to {dest}")
        if not a.dry_run:
            dest.write_text(brief.read_text())
        done.append("3 brief")

        step = "4 worktree create"
        cmd = [orca_exe(), "worktree", "create", "--repo", f"path:{repo}", "--name", name, "--no-parent", "--json"]
        print("4. " + shlex.join(cmd))
        wt = "<worktree id>"
        if not a.dry_run:
            code, out = run_cmd(cmd)
            if code != 0:
                raise LaunchError(f"exit {code}: {out.strip()[:300]}")
            wt = worktree_id(out)
        done.append(f"4 worktree {wt}")

        step = "5 launch worker"
        task_title = f"{job_id} {title}"
        coordinator = None if a.dry_run else coordinator_handle(run)
        cmd = ["env", f"ORCA_TERMINAL_HANDLE={coordinator}"] if coordinator else []
        cmd += [sys.executable, str(orch), "launch", "--run", run, "--worktree", f"id:{wt}", "--title", task_title]
        cmd += ["--task-title", task_title, "--spec-file", str(dest), "--profile", a.profile]
        cmd += ["--repo", str(repo), "--trust"]
        print("5. " + shlex.join(cmd))
        term = "<terminal>"
        if not a.dry_run:
            code, out = run_cmd(cmd)
            if code != 0:
                raise LaunchError(f"exit {code}: {out.strip()[:300]}")
            term = terminal_handle(out)
        done.append(f"5 worker in {term}")

        step = "6 job link"
        print(f"6. job link {job_id} --worktree {name} --terminal {term} --profile {a.profile}")
        if not a.dry_run:
            with store.locked(job_id):
                job = store.load(job_id)
                if extra:
                    job.history.append(
                        {"at": state.now_iso(), "event": "brief_beyond_card", "stage": job.stage, "extra": extra}
                    )
                job.links.update(worktree=name, terminal=term, profile=a.profile)
                store.save(job)
        done.append("6 job link")
    except (LaunchError, OSError, ValueError, RuntimeError) as err:
        return _fail(None if a.dry_run or job_id in (None, "<job id>") else job_id, step, str(err), done)

    if not a.dry_run:
        try:
            plane.start_item(a.issue, owner_id(plane))
            print("7. card: assignee and start date set")
        except (RuntimeError, OSError) as err:  # the job is already running; a card without owner is not fatal
            print(f"warning: could not assign the card: {err}")

    print(f"launched {job_id}" + (" (dry run, nothing created)" if a.dry_run else f" in {term}"))
    return 0
