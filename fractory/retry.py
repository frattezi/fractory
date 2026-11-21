"""Technical failures retry on their own; only decisions wait for a person.

A gate card should hold a decision (a budget, a sensitive PR, a question), not a retry. Gate reasons are classified
here: `DECISION` reasons always wait for Pedro, `TECHNICAL` ones are handled by the factory first, with backoff,
up to `[retry] max_attempts` times. Only then the gate opens, once, with the whole attempt history in its detail.

Three technical kinds: `judge_error` (the model call failed: the Judge runs again), `worker_stalled` (the worker sits
idle at its prompt with no question and no progress: it is nudged) and `ci_infra` (a red check whose log shows an
infrastructure failure: the failed jobs run again, once). Each attempt is a `retry` history entry; progress (a stage
event, a Judge verdict, a resolved gate) resets the count.

Config (`config.toml`): `[retry] max_attempts = 3, backoff_minutes = 2, stalled_minutes = 20`. Backoff doubles per attempt.
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path

from . import rework, state, store, sync

DECISION = frozenset(
    {
        "judge_rounds",
        "cost",
        "merge_review",
        "worker_asks",
        "pr_closed",
        "merge_needed",
        "rework_needed",
        "merge_conflict",
        "branch_sync_conflict",
        "launch_failed",
    }
)
TECHNICAL = frozenset({"judge_error", "worker_stalled", "ci_infra"})

# Events that mean the job moved: they end a run of failed attempts.
PROGRESS = frozenset({e for stage in state.TRANSITIONS.values() for e in stage} | {"judge_diff", "gate_resolved"})

STALL_MESSAGE = (
    "[fractory] You stopped without finishing. Continue from your brief; ask only if blocked. "
    "When done: push, then run python3 -m fractory job advance {job} built --note '<what you did>'"
)

# What an infrastructure failure looks like in a CI log (not a test or lint failure).
CI_INFRA = re.compile(
    r"runner has received a shutdown signal|lost communication with the server|no space left on device"
    r"|ECONNRESET|ETIMEDOUT|socket hang up|TLS handshake timeout|503 service unavailable|502 bad gateway"
    r"|rate limit exceeded|unable to (?:download|resolve|fetch)|could not resolve host|network is unreachable",
    re.IGNORECASE,
)
RUN_ID = re.compile(r"/runs/(\d+)")


def classify(reason: str) -> str:
    """`technical` when the factory retries it first; everything else, including an unknown reason, is a `decision`."""
    return "technical" if reason in TECHNICAL else "decision"


@dataclass(frozen=True)
class Settings:
    max_attempts: int = 3
    backoff_minutes: float = 2
    stalled_minutes: float = 20


def settings(config: dict | None = None) -> Settings:
    raw = (config or {}).get("retry") or {}
    out = {}
    for key, default in Settings().__dict__.items():
        value = raw.get(key, default)
        ok = isinstance(value, (int, float)) and not isinstance(value, bool) and value >= 0
        out[key] = value if ok else default
    return Settings(int(out["max_attempts"]), out["backoff_minutes"], out["stalled_minutes"])


def _since_progress(job: state.Job) -> list[dict]:
    """History entries after the last progress event, oldest first."""
    found: list[dict] = []
    for entry in reversed(job.history):
        if entry["event"] in PROGRESS:
            break
        found.append(entry)
    return found[::-1]


def attempts(job: state.Job, kind: str) -> list[dict]:
    return [h for h in _since_progress(job) if h["event"] == "retry" and h.get("kind") == kind]


def due_at(job: state.Job, kind: str) -> datetime | None:
    """When the latest attempt of `kind` may be followed by the next one; None with no attempt yet."""
    found = attempts(job, kind)
    return datetime.fromisoformat(found[-1]["due"]) if found else None


def waiting(job: state.Job, kind: str, now: datetime | None = None) -> bool:
    """An attempt of `kind` is logged and its backoff has not passed."""
    due = due_at(job, kind)
    return due is not None and (now or datetime.now(UTC)) < due


def retry_pending(job: state.Job, kind: str) -> bool:
    return due_at(job, kind) is not None


def attempt_log(job: state.Job, kind: str, detail: str, cfg: Settings, now: datetime | None = None) -> state.Job:
    """Log a failed attempt: the next one is due after `backoff_minutes * 2^(attempt - 1)`."""
    now = now or datetime.now(UTC)
    n = len(attempts(job, kind)) + 1
    due = now + timedelta(minutes=cfg.backoff_minutes * 2 ** (n - 1))
    job.history.append(
        {
            "at": now.replace(microsecond=0).isoformat(),
            "event": "retry",
            "stage": job.stage,
            "kind": kind,
            "attempt": n,
            "detail": detail[:300],
            "due": due.replace(microsecond=0).isoformat(),
        }
    )
    return job


def gate_detail(job: state.Job, kind: str, detail: str) -> str:
    past = [f"{h['attempt']}. {h['detail']}" for h in attempts(job, kind)]
    return "\n".join([f"{detail}", f"Failed after {len(past)} automatic retries:", *past])


def fail(job: state.Job, kind: str, detail: str, cfg: Settings, now: datetime | None = None) -> tuple[state.Job, bool]:
    """A technical failure: log a retry while attempts remain, else open the `kind` gate with the history.
    Returns the job and whether the gate opened."""
    if len(attempts(job, kind)) < cfg.max_attempts:
        return attempt_log(job, kind, detail, cfg, now), False
    return state.open_gate(job, kind, gate_detail(job, kind, detail)), True


# --- stalled workers ------------------------------------------------------------------------------------------


def last_progress(job: state.Job) -> datetime:
    for entry in reversed(job.history):
        if entry["event"] in PROGRESS or entry["event"] == "created":
            return datetime.fromisoformat(entry["at"])
    return datetime.fromisoformat(job.created_at)


def nudge_stalled(orch: Path, runner=None, now: datetime | None = None) -> None:
    """Watch step: a job in build whose worker sits idle at its prompt, with no question and no progress for
    `stalled_minutes`, is nudged; after `max_attempts` nudges it opens one `worker_stalled` gate."""
    runner = runner or rework.run_cmd
    cfg = settings(store.config())
    now = now or datetime.now(UTC)
    for found in store.all_jobs():
        terminal = found.links.get("terminal")
        if found.stage != "build" or found.gate or not terminal or not found.history:
            continue
        if (now - last_progress(found)) < timedelta(minutes=cfg.stalled_minutes) or waiting(
            found, "worker_stalled", now
        ):
            continue
        if not rework.terminal_is_idle(str(terminal), orch, runner):
            continue
        with store.locked(found.id):
            job = store.load(found.id)
            if job.stage != "build" or job.gate or waiting(job, "worker_stalled", now):
                continue
            if len(attempts(job, "worker_stalled")) < cfg.max_attempts:
                code, _ = runner(
                    [sys.executable, str(orch), "nudge", str(terminal), "--text", STALL_MESSAGE.format(job=job.id)]
                )
                if code != 0:
                    continue  # not delivered: not an attempt
            job, opened = fail(job, "worker_stalled", f"{job.id} idle at its prompt with no question", cfg, now)
            store.save(job)
        print(f"{job.id}  worker stalled: " + ("gate opened" if opened else "nudged"))


# --- CI infrastructure failures -------------------------------------------------------------------------------


def failed_run(repo: str, pr: str, check: str, gh=None) -> str | None:
    """The workflow run id of the failing check, from its details URL."""
    out = (gh or sync.run_gh)(["pr", "view", pr, "--json", "statusCheckRollup"], repo)
    for c in json.loads(out).get("statusCheckRollup") or []:
        if c.get("name") == check and (m := RUN_ID.search(c.get("detailsUrl") or "")):
            return m.group(1)
    return None


def hold_red_for_rerun(job: state.Job, check: str | None, gh=None, now: datetime | None = None) -> bool:
    """A red check in `checks`: True while the factory handles it (a rerun is running or just started), so the
    job is not sent back to build. A failure that is not infrastructure, or an infra failure that already had its
    one rerun, returns False and the usual red event applies."""
    cfg = settings(store.config())
    gh = gh or sync.run_gh
    pr = str(job.links.get("pr") or "")
    if not pr or not check or job.stage != "checks" or job.gate:
        return False
    if retry_pending(job, "ci_infra"):
        return waiting(job, "ci_infra", now)
    try:
        run = failed_run(job.repo, pr, check, gh)
        if not run or not CI_INFRA.search(gh(["run", "view", run, "--log-failed"], job.repo)):
            return False
        gh(["run", "rerun", run, "--failed"], job.repo)
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError):
        return False  # cannot tell: treat as a normal red
    once = Settings(1, cfg.backoff_minutes, cfg.stalled_minutes)
    with store.locked(job.id):
        current = store.load(job.id)
        store.save(
            attempt_log(current, "ci_infra", f"check {check} failed on infrastructure; run {run} rerun", once, now)
        )
    print(f"{job.id}  CI infra failure on {check}: rerunning run {run}")
    return True
