"""Close what finished PR-review agents and settled Orca workers leave open.

PR-review state is read (never written) from the pr-triage DB. A review is finished when its PR is merged or
closed, or its state is reviewed / done / skipped; awaiting_input and reviewing are Pedro's and never touched.
Terminals and worktrees are matched by the worktree id recorded in the DB, never by name patterns, and a worktree
with uncommitted or unpushed work is kept with the reason logged. Every external call goes through `runner`.
"""

from __future__ import annotations

import json
import os
import sqlite3
from pathlib import Path

from . import cleanup, launch, state

Runner = cleanup.Runner

DEFAULT_DB = Path.home() / ".harness" / "pr_triage.db"
FINISHED_STATES = {"reviewed", "done", "skipped"}
PROTECTED_STATES = {"awaiting_input", "reviewing"}
LIST_LIMIT = 10000
SETTLED_WORKER_STATES = {"succeeded", "failed", "abandoned"}


def db_path() -> Path:
    return Path(os.environ.get("PR_TRIAGE_DB") or DEFAULT_DB)


def read_reviews(path: Path | None = None) -> list[dict]:
    """PR reviews that have a worktree recorded. Read-only connection; a missing DB means nothing to do."""
    path = path or db_path()
    if not path.exists():
        return []
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    try:
        rows = con.execute(
            "SELECT repo, number, state, worktree, terminal FROM pr_reviews "
            "WHERE worktree IS NOT NULL AND worktree != ''"
        ).fetchall()
    finally:
        con.close()
    return [dict(r) for r in rows]


def _worktrees(runner: Runner) -> dict[str, dict]:
    # Orca caps the listing (20 by default); a truncated one would make live worktrees look gone.
    code, out = runner([launch.orca_exe(), "worktree", "list", "--limit", str(LIST_LIMIT), "--json"])
    if code != 0:
        raise RuntimeError(f"worktree list failed: {out.strip()[:200]}")
    return {str(r["id"]): r for r in cleanup._rows(out, "worktrees") if r.get("id")}


def _terminals(runner: Runner) -> list[dict]:
    code, out = runner([launch.orca_exe(), "terminal", "list", "--json"])
    if code != 0:
        raise RuntimeError(f"terminal list failed: {out.strip()[:200]}")
    return cleanup._rows(out, "terminals")


def pr_state(repo: str, number: int, runner: Runner) -> str | None:
    code, out = runner(["gh", "pr", "view", str(number), "--repo", repo, "--json", "state"])
    if code != 0:
        return None
    return launch.json_payload(out).get("state")


def is_finished(review: dict, runner: Runner) -> str | None:
    """Why the review is finished, or None (still in use, or GitHub could not say)."""
    st = review["state"]
    if st in PROTECTED_STATES:
        return None
    if st in FINISHED_STATES:
        return f"state {st}"
    gh = pr_state(review["repo"], review["number"], runner)
    return f"PR {gh.lower()}" if gh in ("MERGED", "CLOSED") else None


def keep_reason(path: str, runner: Runner) -> str | None:
    """Why the worktree must stay: uncommitted changes or commits that exist on no remote."""
    code, out = runner(["git", "-C", path, "status", "--porcelain"])
    if code != 0:
        return f"git status failed: {out.strip()[:200]}"
    if out.strip():
        return "uncommitted changes in the worktree"
    code, out = runner(["git", "-C", path, "rev-list", "--count", "HEAD", "--not", "--remotes"])
    if code != 0 or not out.strip().isdigit():
        return f"could not check unpushed commits: {out.strip()[:200]}"
    if int(out.strip()) > 0:
        return f"{out.strip()} unpushed commit(s)"
    return None


def close_review(
    review: dict, why: str, worktrees: dict[str, dict], terminals: list[dict], runner: Runner, dry_run: bool
) -> list[str]:
    exe = launch.orca_exe()
    wt_id = str(review["worktree"])
    wt = worktrees.get(wt_id)
    handles = [
        str(t["handle"])
        for t in terminals
        if t.get("handle") and (t.get("worktreeId") == wt_id or t.get("handle") == review.get("terminal"))
    ]
    if wt and wt.get("isMainWorktree"):
        return [f"kept: {wt_id} is a main checkout"]
    log: list[str] = []
    for handle in handles:
        if dry_run:
            log.append(f"would close terminal {handle}")
        else:
            runner([exe, "terminal", "close", "--terminal", handle])
            log.append(f"closed terminal {handle}")
    if wt:
        reason = keep_reason(str(wt["path"]), runner)
        if reason:
            log.append(f"kept worktree {wt['path']}: {reason}")
        elif dry_run:
            log.append(f"would remove worktree {wt['path']}")
        else:
            code, out = runner([exe, "worktree", "rm", "--worktree", f"id:{wt_id}", "--json"])
            log.append(f"removed worktree {wt['path']}" if code == 0 else f"worktree rm failed: {out.strip()[:200]}")
    return [f"PR-review finished ({why}): {line}" for line in log]


def close_finished_reviews(runner: Runner, dry_run: bool = False, db: Path | None = None) -> list[str]:
    reviews = read_reviews(db)
    if not reviews:
        return []
    worktrees = _worktrees(runner)
    terminals = _terminals(runner)
    live = {r["worktree"] for r in reviews if r["state"] in PROTECTED_STATES}
    lines: list[str] = []
    for review in reviews:
        wt_id = str(review["worktree"])
        has_terminal = review.get("terminal") and any(t.get("handle") == review["terminal"] for t in terminals)
        if wt_id not in worktrees and not has_terminal and not any(t.get("worktreeId") == wt_id for t in terminals):
            continue  # already cleaned
        if wt_id in live and review["state"] not in PROTECTED_STATES:
            continue  # another review still works in this worktree
        why = is_finished(review, runner)
        if why:
            tag = f"{review['repo']}#{review['number']}"
            lines += [f"{tag}  {line}" for line in close_review(review, why, worktrees, terminals, runner, dry_run)]
    return lines


def _worker_state(w: dict) -> str | None:
    """The concise record says `state`, the full one `workerState`."""
    return w.get("state") or w.get("workerState")


def _worker_workspace(w: dict) -> str | None:
    """Worktree id of the worker: `workspace` (concise) or `resource.worktreeId` (full)."""
    resource = w.get("resource")
    found = w.get("workspace") or (resource.get("worktreeId") if isinstance(resource, dict) else None)
    return str(found) if found else None


def release_settled_workers(jobs: list[state.Job], runner: Runner, dry_run: bool = False) -> list[str]:
    """Release the retained terminal of settled supervised workers whose worktree is gone or whose job is done."""
    code, out = runner([launch.orca_exe(), "orchestration", "worker-list", "--json"])
    if code != 0:
        raise RuntimeError(f"worker-list failed: {out.strip()[:200]}")
    settled = [
        w
        for w in cleanup._rows(out, "workers")
        if _worker_state(w) in SETTLED_WORKER_STATES and w.get("terminalState") == "retained" and w.get("dispatchId")
    ]
    if not settled:
        return []
    worktrees = _worktrees(runner)
    done_dispatches = {str(j.links["dispatch"]) for j in jobs if j.stage in state.TERMINAL and j.links.get("dispatch")}
    lines: list[str] = []
    for w in settled:
        dispatch = str(w["dispatchId"])
        if dispatch in done_dispatches:
            why = "its job is done"
        elif (workspace := _worker_workspace(w)) and workspace not in worktrees:
            why = "its worktree is gone"
        else:
            continue
        if dry_run:
            lines.append(f"worker {dispatch}  would release terminal ({why})")
            continue
        code, _ = runner([launch.orca_exe(), "orchestration", "worker-release", "--dispatch", dispatch, "--json"])
        lines.append(
            f"worker {dispatch}  released terminal ({why})" if code == 0 else f"worker {dispatch}  release failed"
        )
    return lines


def run(jobs: list[state.Job], runner: Runner | None = None, dry_run: bool = False) -> int:
    """Both steps; each logs its lines and a failure in one does not skip the other. 1 when any step raised."""
    run_ = runner or launch.run_cmd
    failed = False
    for name, step in (
        ("pr-review cleanup", lambda: close_finished_reviews(run_, dry_run)),
        ("worker cleanup", lambda: release_settled_workers(jobs, run_, dry_run)),
    ):
        try:
            for line in step():
                print(line)
        except (OSError, ValueError, RuntimeError, sqlite3.Error, json.JSONDecodeError) as err:
            failed = True
            print(f"cleanup error: {name}: {err}")
    return 1 if failed else 0
