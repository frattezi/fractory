"""Rework: when a job lands back in `build` (judge rejected, CI red), tell the worker that built it."""

from __future__ import annotations

import re
import subprocess
import sys
import tempfile
from pathlib import Path

from . import state, store

MAX_ROUNDS = state.MAX_JUDGE_ROUNDS


def run_cmd(argv: list[str]) -> tuple[int, str]:
    proc = subprocess.run(argv, check=False, capture_output=True, text=True)
    return proc.returncode, proc.stdout + proc.stderr


def rework_message(job: state.Job, event: str, detail: str) -> str:
    """One line: it is typed into a terminal, where a newline would submit early."""
    if event == "rejected":
        what = f"the Judge rejected it (round {job.judge_rounds}/{MAX_ROUNDS}): {detail}"
    else:
        what = f"CI is red on check {detail or 'ci'}"
    return (
        f"[fractory] Rework on {job.id}: {what}. "
        f"Fix it, merge origin/main, push, then run: "
        f"python3 -m fractory job advance {job.id} built --note '<what you fixed>'"
    )


def escalate_worker(job: state.Job, message: str, orch: Path, runner) -> str | None:
    """After a first Judge rejection on a worker whose profile has `escalate_to`, start a worker of that profile in
    the same worktree (same branch) with the rework message. Returns the new terminal, or None to nudge as usual."""
    from . import launch  # late: launch pulls in briefcheck/judge

    profile, wt = job.links.get("profile"), job.links.get("worktree_id")
    if not profile or not wt or any(h["event"] == "profile_escalated" for h in job.history):
        return None
    try:
        code, out = runner([sys.executable, str(orch), "route", "--escalate-from", profile, "--repo", job.repo])
        m = re.match(r"profile (\S+?):", out.strip()) if code == 0 else None
        if not m:
            return None
        brief = store.job_dir(job.id) / "brief.md"
        with tempfile.TemporaryDirectory() as tmp:
            spec = Path(tmp) / "rework.md"
            spec.write_text((brief.read_text() if brief.is_file() else f"# {job.title}\n") + f"\n\n---\n{message}\n")
            run = launch.run_id(None)
            coordinator = launch.coordinator_handle(run)
            cmd = ["env", f"ORCA_TERMINAL_HANDLE={coordinator}"] if coordinator else []
            cmd += [sys.executable, str(orch), "launch", "--run", run, "--worktree", f"id:{wt}"]
            cmd += ["--title", f"{job.id} {job.title}", "--task-title", f"{job.id} {job.title}"]
            cmd += ["--spec-file", str(spec), "--profile", m.group(1), "--repo", job.repo, "--trust"]
            code, out = runner(cmd)
        if code != 0:
            return None
        term = launch.terminal_handle(out)
    except (OSError, launch.LaunchError):
        return None
    job.history.append(
        {
            "at": state.now_iso(),
            "event": "profile_escalated",
            "stage": job.stage,
            "from": profile,
            "profile": m.group(1),
            "terminal": term,
        }
    )
    job.links.update(profile=m.group(1), terminal=term)
    return term


def notify(job_id: str, event: str, detail: str, orch: Path, runner=None) -> None:
    """Nudge the job's terminal and log `rework_sent`; with no terminal or a failed nudge, open `rework_needed`.
    `runner` defaults to the module's `run_cmd`, looked up now so tests can swap it."""
    runner = runner or run_cmd
    with store.locked(job_id):
        job = store.load(job_id)
        if job.stage != "build" or job.gate:
            return
        message = rework_message(job, event, detail)
        terminal = job.links.get("terminal")
        sent = False
        escalated = escalate_worker(job, message, orch, runner) if event == "rejected" else None
        if escalated:
            terminal, sent = escalated, True
        elif terminal:
            try:
                code, _ = runner([sys.executable, str(orch), "nudge", terminal, "--text", message])
                sent = code == 0
            except OSError:
                sent = False
        if sent:
            job.history.append(
                {"at": state.now_iso(), "event": "rework_sent", "stage": job.stage, "terminal": terminal}
            )
        else:
            job = state.open_gate(job, "rework_needed", message)
        store.save(job)


def conflict_message(job: state.Job) -> str:
    return (
        f"[fractory] Rework on {job.id}: PR #{job.links.get('pr')} conflicts with main. "
        f"Merge origin/main into your branch, resolve the conflicts, run the checks and push."
    )


def notify_conflict(job_id: str, orch: Path, runner=None) -> None:
    """Send the worker the conflict rework once; with no reachable worker, open `merge_conflict`.
    Later syncs stay silent until another event is logged (the worker pushes, the job moves)."""
    runner = runner or run_cmd
    with store.locked(job_id):
        job = store.load(job_id)
        if job.gate or (job.history and job.history[-1]["event"] == "conflict_sent"):
            return
        message = conflict_message(job)
        terminal = job.links.get("terminal")
        sent = False
        if terminal:
            try:
                code, _ = runner([sys.executable, str(orch), "nudge", terminal, "--text", message])
                sent = code == 0
            except OSError:
                sent = False
        if sent:
            job.history.append(
                {"at": state.now_iso(), "event": "conflict_sent", "stage": job.stage, "terminal": terminal}
            )
        else:
            job = state.open_gate(job, "merge_conflict", message)
        store.save(job)
