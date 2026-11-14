"""Close what a finished job leaves open in Orca: its worker, terminals, worktree and local branch.

Every external call goes through `runner` (default `launch.run_cmd`), so tests inject a fake.
Only the job's own worktree is touched: terminals and worktrees are matched by that worktree's path, never by name
patterns. A worktree with unsaved or unmerged work is kept and the reason recorded.
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable
from pathlib import Path

from . import launch, state, store

Runner = Callable[[list[str]], tuple[int, str]]


def eligible(job: state.Job) -> bool:
    return job.stage in state.TERMINAL and bool(job.links.get("worktree")) and "cleaned_at" not in job.links


def pending(job: state.Job) -> bool:
    """What `watch` picks up: eligible and not already examined (a kept worktree is retried by hand only)."""
    return eligible(job) and "cleanup_skipped" not in job.links


def _rows(out: str, key: str) -> list[dict]:
    result = launch.json_payload(out).get("result") or {}
    rows = result.get(key)
    return [r for r in rows if isinstance(r, dict)] if isinstance(rows, list) else []


def find_worktree(job: state.Job, runner: Runner) -> dict | None:
    """The job's Orca worktree: same repo, never the main checkout, directory name or display name == links.worktree."""
    name = str(job.links["worktree"])
    code, out = runner([launch.orca_exe(), "worktree", "list", "--repo", f"path:{job.repo}", "--json"])
    if code != 0:
        raise RuntimeError(f"worktree list failed: {out.strip()[:200]}")
    for row in _rows(out, "worktrees"):
        if row.get("isMainWorktree") or not row.get("path"):
            continue
        if Path(str(row["path"])).name == name or row.get("displayName") == name:
            return row
    return None


def _stop_dispatch(dispatch: str, runner: Runner, log: list[str]) -> None:
    """Stop the open dispatch; a settled one is released instead. 'Already released' is not an error."""
    exe = launch.orca_exe()
    code, _ = runner([exe, "orchestration", "worker-stop", "--dispatch", dispatch, "--json"])
    if code == 0:
        log.append(f"stopped dispatch {dispatch}")
        return
    code, _ = runner([exe, "orchestration", "worker-release", "--dispatch", dispatch, "--json"])
    log.append(f"released dispatch {dispatch}" if code == 0 else f"dispatch {dispatch} already settled")


def _close_terminals(wt_id: str, runner: Runner, log: list[str]) -> None:
    exe = launch.orca_exe()
    code, out = runner([exe, "terminal", "list", "--json"])
    if code != 0:
        raise RuntimeError(f"terminal list failed: {out.strip()[:200]}")
    for row in _rows(out, "terminals"):
        if row.get("worktreeId") == wt_id and row.get("handle"):
            runner([exe, "terminal", "close", "--terminal", str(row["handle"])])
            log.append(f"closed terminal {row['handle']}")


def keep_reason(job: state.Job, wt: dict, runner: Runner) -> str | None:
    """Why the worktree must stay, or None when it is safe to remove."""
    path, repo = str(wt["path"]), job.repo
    code, out = runner(["git", "-C", path, "status", "--porcelain"])
    if code != 0:
        return f"git status failed: {out.strip()[:200]}"
    if out.strip():
        return "uncommitted changes in the worktree"
    pr = job.links.get("pr")
    if pr:
        code, out = runner(["sh", "-c", 'cd "$0" && gh pr view "$1" --json state', repo, str(pr)])
        if code == 0 and launch.json_payload(out).get("state") == "MERGED":
            return None
    runner(["git", "-C", repo, "fetch", "origin", "main"])
    code, out = runner(["git", "-C", path, "rev-list", "--count", "origin/main..HEAD"])
    if code != 0 or not out.strip().isdigit():
        return f"could not compare with origin/main: {out.strip()[:200]}"
    if int(out.strip()) > 0:
        return f"{out.strip()} commit(s) not in origin/main and the PR is not merged"
    return None


def cleanup_job(job: state.Job, runner: Runner | None = None, dry_run: bool = False) -> list[str]:
    """Clean one finished job and persist the outcome. Returns what was (or would be) done, one line each."""
    run = runner or launch.run_cmd
    if not eligible(job):
        return []
    log: list[str] = []
    wt = find_worktree(job, run)
    if dry_run:
        if job.links.get("dispatch"):
            log.append(f"would stop/release dispatch {job.links['dispatch']}")
        if wt:
            log.append(f"would close terminals of {wt['path']}, then remove the worktree if clean and merged")
        else:
            log.append("worktree already gone")
        return log

    if job.links.get("dispatch"):
        _stop_dispatch(str(job.links["dispatch"]), run, log)
    reason = None
    branch = None
    if wt:
        _close_terminals(str(wt["id"]), run, log)
        reason = keep_reason(job, wt, run)
        branch = re.sub(r"^refs/heads/", "", str(wt.get("branch") or "")) or None
        if reason is None:
            code, out = run([launch.orca_exe(), "worktree", "rm", "--worktree", f"id:{wt['id']}", "--json"])
            if code != 0:
                reason = f"worktree rm failed: {out.strip()[:200]}"
            else:
                log.append(f"removed worktree {wt['path']}")
    if reason is None and branch:
        code, out = run(["git", "-C", job.repo, "branch", "-D", branch])
        log.append(f"deleted branch {branch}" if code == 0 else f"branch {branch} not deleted: {out.strip()[:120]}")

    with store.locked(job.id):
        fresh = store.load(job.id)
        if reason:
            fresh.links["cleanup_skipped"] = reason
            fresh.history.append(
                {"at": state.now_iso(), "event": "cleanup_skipped", "stage": fresh.stage, "reason": reason}
            )
            log.append(f"kept worktree: {reason}")
        else:
            fresh.links.pop("cleanup_skipped", None)
            fresh.links["cleaned_at"] = state.now_iso()
            fresh.history.append({"at": state.now_iso(), "event": "cleaned", "stage": fresh.stage})
        store.save(fresh)
    return log


def run_cleanup(jobs: list[state.Job], runner: Runner | None = None, dry_run: bool = False, retry: bool = False) -> int:
    """Clean every eligible job (`retry`: also those whose worktree was kept earlier). 1 when any step raised."""
    failed = False
    for job in jobs:
        if not (eligible(job) if retry else pending(job)):
            continue
        try:
            for line in cleanup_job(job, runner, dry_run):
                print(f"{job.id}  {line}")
        except (OSError, ValueError, RuntimeError, json.JSONDecodeError) as err:
            failed = True
            print(f"{job.id}  cleanup error: {err}")
    return 1 if failed else 0
