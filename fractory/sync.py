"""Turn a job's PR and CI state into job events, so no one has to type `job advance` for them.

`pr_event` is pure: the same job and PR always give the same event. `fetch_pr` shells out to `gh`.
The supervisor runs `fractory sync` every minute; a person can run it too.
"""

from __future__ import annotations

import json
import subprocess
from collections.abc import Callable
from dataclasses import dataclass

from .state import Job

FAILED = {"FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "ERROR"}
PASSED = {"SUCCESS", "NEUTRAL", "SKIPPED"}

# job stage -> tracker status
STAGE_STATUS = {
    "discovery": "ready",
    "spec": "ready",
    "build": "in_progress",
    "checks": "in_progress",
    "review": "in_progress",
    "judge": "in_progress",
    "ship": "in_progress",
    "done": "done",
    "cancelled": "cancelled",
}


@dataclass(frozen=True)
class Pr:
    state: str  # OPEN | CLOSED | MERGED
    draft: bool
    checks: tuple[tuple[str, str], ...]  # (name, PENDING|SUCCESS|FAILURE|...)


def parse_pr(data: dict) -> Pr:
    """`gh pr view --json state,isDraft,statusCheckRollup` -> Pr. CheckRuns and StatusContexts differ."""
    checks = []
    for c in data.get("statusCheckRollup") or []:
        if c.get("__typename") == "StatusContext":
            name, result = c.get("context", "status"), (c.get("state") or "PENDING").upper()
            result = "PENDING" if result in ("EXPECTED", "PENDING") else result
        else:
            name = c.get("name", "check")
            result = (c.get("conclusion") or "").upper() if c.get("status") == "COMPLETED" else "PENDING"
            result = result or "PENDING"
        checks.append((name, result))
    return Pr(state=data.get("state", "OPEN"), draft=bool(data.get("isDraft")), checks=tuple(checks))


def ci_result(pr: Pr) -> tuple[str, str | None]:
    """('red', first failing check) | ('green', None) | ('pending', None)."""
    for name, result in pr.checks:
        if result in FAILED:
            return "red", name
    if pr.checks and all(result in PASSED for _, result in pr.checks):
        return "green", None
    return "pending", None


def pr_event(job: Job, pr: Pr) -> tuple[str, str | None] | None:
    """The event this PR state means for the job, or None when nothing changed."""
    if job.gate is not None:
        return None
    if job.stage == "checks":
        result, check = ci_result(pr)
        if result == "red":
            return "red", check
        if result == "green":
            return "green", None
    if job.stage == "ship":
        if job.kind == "internal" and pr.state == "MERGED":
            return "merged", None
        if job.kind == "able" and pr.state == "OPEN" and pr.draft:
            return "draft_pr", None
    return None


Gh = Callable[[list[str], str], str]


def run_gh(args: list[str], cwd: str) -> str:
    return subprocess.run(["gh", *args], cwd=cwd, capture_output=True, text=True, check=True).stdout


def fetch_pr(repo: str, pr: str, gh: Gh | None = None) -> Pr:
    out = (gh or run_gh)(["pr", "view", pr, "--json", "state,isDraft,statusCheckRollup"], repo)
    return parse_pr(json.loads(out))


def should_merge(job: Job, pr: Pr) -> bool:
    """An approved internal job whose open PR has green CI. Able jobs never auto-merge."""
    return (
        job.gate is None
        and job.stage == "ship"
        and job.kind == "internal"
        and pr.state == "OPEN"
        and not pr.draft
        and ci_result(pr)[0] == "green"
    )


def pr_files(repo: str, pr: str, gh: Gh | None = None) -> list[tuple[str, int, int]]:
    """`gh pr view --json files` -> [(path, additions, deletions)]."""
    out = (gh or run_gh)(["pr", "view", pr, "--json", "files"], repo)
    return [
        (f["path"], int(f.get("additions", 0)), int(f.get("deletions", 0))) for f in json.loads(out).get("files", [])
    ]


def merge_pr(repo: str, pr: str, gh: Gh | None = None) -> None:
    (gh or run_gh)(["pr", "merge", pr, "--squash", "--delete-branch"], repo)


def pr_diff(repo: str, pr: str, gh: Gh | None = None) -> str:
    return (gh or run_gh)(["pr", "diff", pr], repo)


def pr_comment(repo: str, pr: str, body: str, gh: Gh | None = None) -> None:
    (gh or run_gh)(["pr", "comment", pr, "--body", body], repo)
