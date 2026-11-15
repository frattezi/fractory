"""Rework: when a job lands back in `build` (judge rejected, CI red), tell the worker that built it."""

from __future__ import annotations

import re
import subprocess
import sys
import tempfile
from datetime import UTC, datetime, timedelta
from pathlib import Path

from . import guard, state, store

MAX_ROUNDS = state.MAX_JUDGE_ROUNDS


def run_cmd(argv: list[str]) -> tuple[int, str]:
    proc = subprocess.run(argv, check=False, capture_output=True, text=True)
    return proc.returncode, proc.stdout + proc.stderr


def rework_message(job: state.Job, event: str, detail: str) -> str:
    """One line: it is typed into a terminal, where a newline would submit early."""
    if event == "rejected":
        what = f"the Judge rejected it (round {job.judge_rounds}/{MAX_ROUNDS}): {detail}"
    elif event == "resumed":
        what = f"the Judge rejected it and a person let it continue: {detail or 'see the Judge comment on the PR'}"
    elif event == "stuck":
        return (
            f"[fractory] You have an open job, {job.id}: finish it, push, then run: "
            f"python3 -m fractory job advance {job.id} built --note '<what you did>'"
        )
    else:
        what = f"CI is red on check {detail or 'ci'}"
    return (
        f"[fractory] Rework on {job.id}: {what}. "
        f"Fix it, merge origin/main, push, then run: "
        f"python3 -m fractory job advance {job.id} built --note '<what you fixed>'"
    )


def start_worker(job: state.Job, profile: str, note: str, orch: Path, runner) -> str | None:
    """Start a worker of `profile` in the job's existing worktree with the job's brief plus `note`.
    Returns the new terminal, or None when `orch.py launch` fails."""
    from . import launch  # late: launch pulls in briefcheck/judge

    try:
        guard.install(guard.worktree_path(str(job.links["worktree_id"])))
    except guard.GuardError as err:
        raise launch.LaunchError(str(err)) from err
    brief = store.job_dir(job.id) / "brief.md"
    with tempfile.TemporaryDirectory() as tmp:
        spec = Path(tmp) / "rework.md"
        spec.write_text((brief.read_text() if brief.is_file() else f"# {job.title}\n") + f"\n\n---\n{note}\n")
        run = launch.run_id(None)
        coordinator = launch.coordinator_handle(run)
        cmd = ["env", f"ORCA_TERMINAL_HANDLE={coordinator}"] if coordinator else []
        cmd += [sys.executable, str(orch), "launch", "--run", run, "--worktree", f"id:{job.links['worktree_id']}"]
        cmd += ["--title", f"{job.id} {job.title}", "--task-title", f"{job.id} {job.title}"]
        cmd += ["--spec-file", str(spec), "--profile", profile, "--repo", job.repo, "--trust"]
        code, out = runner(cmd)
    return launch.terminal_handle(out) if code == 0 else None


RELAUNCH_STAGES = ("build", "checks", "review")
RELAUNCH_INTERVAL = timedelta(hours=1)
RESUME_NOTE = (
    "[fractory] You are resumed after the previous terminal died. Check the PR, CI and any pending rework, "
    "finish what is open, push, then run: python3 -m fractory job advance {id} built --note '<what you did>'"
)


def terminal_is_gone(terminal: str, runner) -> bool:
    """True only when `orca terminal list` worked and does not list `terminal`; a failed list proves nothing."""
    from . import launch

    try:
        code, out = runner([launch.orca_exe(), "terminal", "list", "--json"])
    except OSError:
        return False
    rows = (launch.json_payload(out).get("result") or {}).get("terminals")
    if code != 0 or not isinstance(rows, list):
        return False
    return terminal not in {str(r.get("handle")) for r in rows if isinstance(r, dict)}


def relaunched_recently(job: state.Job, now: datetime | None = None) -> bool:
    from . import metrics

    now = now or datetime.now(UTC)
    return any(h["event"] == "relaunched" and now - metrics.parse(h["at"]) < RELAUNCH_INTERVAL for h in job.history)


def relaunch(job: state.Job, orch: Path, runner, extra: str = "") -> str | None:
    """New worker (same profile) in the job's worktree for a job whose terminal is gone. Mutates `job`
    (history `relaunched`, links.terminal) and returns the terminal; None when it cannot or must not (hourly cap)."""
    from . import launch

    profile = job.links.get("profile")
    if not profile or not job.links.get("worktree_id") or relaunched_recently(job):
        return None
    note = RESUME_NOTE.format(id=job.id) + (f" Pending: {extra}" if extra else "")
    try:
        term = start_worker(job, str(profile), note, orch, runner)
    except (OSError, launch.LaunchError):
        return None
    if not term:
        return None
    job.history.append(
        {
            "at": state.now_iso(),
            "event": "relaunched",
            "stage": job.stage,
            "from": job.links.get("terminal"),
            "terminal": term,
            "profile": profile,
        }
    )
    job.links["terminal"] = term
    print(f"{job.id}  relaunched: new worker in {term}")
    return term


def relaunch_dead_workers(orch: Path, runner=None) -> None:
    """Watch step: a job in build/checks/review whose linked terminal is gone from Orca gets a new worker."""
    runner = runner or run_cmd
    for found in store.all_jobs():
        terminal = found.links.get("terminal")
        if found.stage not in RELAUNCH_STAGES or found.gate or not terminal or relaunched_recently(found):
            continue
        if not terminal_is_gone(str(terminal), runner):
            continue
        with store.locked(found.id):
            job = store.load(found.id)
            if job.stage in RELAUNCH_STAGES and not job.gate and relaunch(job, orch, runner):
                store.save(job)


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
        term = start_worker(job, m.group(1), message, orch, runner)
    except (OSError, launch.LaunchError):
        return None
    if not term:
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
        if event == "stuck" and not _nudge_stuck(job, message, orch, runner):
            return
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
        if not sent and terminal and terminal_is_gone(str(terminal), runner):
            relaunched = relaunch(job, orch, runner, message)  # the new worker's brief carries the rework
            if relaunched:
                terminal, sent = relaunched, True
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


def last_rejection_note(job: state.Job) -> str:
    for entry in reversed(job.history):
        if entry["event"] == "rejected":
            return entry.get("note", "")
    return ""


def resume_after_rounds(job_id: str, orch: Path, runner=None) -> None:
    """A person resolved `judge_rounds` with continue: the worker was never told, so send it the last rejection."""
    job = store.load(job_id)
    if job.stage == "build" and not job.gate:
        notify(job_id, "resumed", last_rejection_note(job), orch, runner)


def terminal_is_idle(terminal: str, orch: Path, runner) -> bool:
    """`orch.py stalls` prints `<term>: idle | <last line>` for an agent sitting at its prompt."""
    try:
        _, out = runner([sys.executable, str(orch), "stalls", terminal])
    except OSError:
        return False
    return out.strip().startswith(f"{terminal}: idle")


def _nudge_stuck(job: state.Job, message: str, orch: Path, runner) -> bool:
    """For a stuck build: nudge once (logs `nudged`), the second time open `rework_needed`.
    Returns False when notify() has nothing more to do (it already logged or saved here)."""
    terminal = job.links.get("terminal")
    if not terminal or not terminal_is_idle(terminal, orch, runner):
        return False
    if job.history[-1]["event"] == "nudged":
        store.save(state.open_gate(job, "rework_needed", f"{job.id} is idle in build after a nudge"))
        return False
    code, _ = runner([sys.executable, str(orch), "nudge", terminal, "--text", message])
    if code == 0:
        job.history.append({"at": state.now_iso(), "event": "nudged", "stage": job.stage, "terminal": terminal})
        store.save(job)
    return False


def nudge_stuck_builds(orch: Path, runner=None) -> None:
    """Watch step: a job in build with a PR, quiet for longer than the `[stuck]` build threshold."""
    from . import metrics  # late: keeps rework importable on its own

    limit = metrics.thresholds(store.config())["build"]
    now = datetime.now(UTC)
    for job in store.all_jobs():
        if job.stage != "build" or job.gate or not job.links.get("pr") or not job.history:
            continue
        if (now - metrics.parse(job.history[-1]["at"])).total_seconds() / 60 > limit:
            notify(job.id, "stuck", "", orch, runner)
