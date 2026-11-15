"""Factory metrics computed from job histories: stage time, stuck work, flow, quality and cost.

Pure: functions take `state.Job` lists (and `now`), never read the disk. `web.py` feeds them.
In a history entry, `stage` is the stage the job is in *after* that event.
"""

from __future__ import annotations

import math
import statistics
from collections import defaultdict
from datetime import UTC, datetime, timedelta

from . import pt
from .state import TERMINAL, Job

DEFAULT_STUCK_MINUTES = {"build": 60, "checks": 30, "review": 20, "judge": 20, "ship": 15}
WINDOWS = (7, 30)


def parse(at: str) -> datetime:
    dt = datetime.fromisoformat(at)
    return dt if dt.tzinfo else dt.replace(tzinfo=UTC)


def _minutes(delta: timedelta) -> float:
    return delta.total_seconds() / 60


def fmt_duration(minutes: float) -> str:
    m = int(minutes)
    if m < 60:
        return f"{m} min"
    h, rest = divmod(m, 60)
    return f"{h}h{rest:02d}" if rest else f"{h}h"


def thresholds(config: dict | None = None) -> dict[str, float]:
    """Defaults overridden by `[stuck]` in config.toml (minutes per stage); unknown stages and bad values ignored."""
    out = dict(DEFAULT_STUCK_MINUTES)
    for stage, value in ((config or {}).get("stuck") or {}).items():
        if stage in out and isinstance(value, (int, float)) and not isinstance(value, bool) and value > 0:
            out[stage] = value
    return out


def percentile(values: list[float], pct: float) -> float | None:
    """Nearest-rank percentile; None for no data."""
    if not values:
        return None
    ordered = sorted(values)
    return ordered[max(1, math.ceil(pct / 100 * len(ordered))) - 1]


def median(values: list[float]) -> float | None:
    return statistics.median(values) if values else None


# --- stage time -----------------------------------------------------------------------------------------------


def stage_minutes(job: Job, now: datetime) -> dict[str, float]:
    """Minutes spent per stage: each history entry holds its stage until the next entry; the last one until now."""
    totals: dict[str, float] = defaultdict(float)
    for cur, nxt in zip(job.history, job.history[1:], strict=False):
        totals[cur["stage"]] += _minutes(parse(nxt["at"]) - parse(cur["at"]))
    if job.history and job.stage not in TERMINAL:
        last = job.history[-1]
        totals[last["stage"]] += max(0.0, _minutes(now - parse(last["at"])))
    return {stage: round(m, 1) for stage, m in totals.items()}


def stage_entered_at(job: Job) -> datetime:
    """When the job entered its current stage: the start of the trailing run of entries in that stage."""
    at = job.created_at
    for entry in reversed(job.history):
        if entry["stage"] != job.stage:
            break
        at = entry["at"]
    return parse(at)


def stage_age_minutes(job: Job, now: datetime) -> float:
    return max(0.0, _minutes(now - stage_entered_at(job)))


# --- stuck ----------------------------------------------------------------------------------------------------


def stuck_item(job: Job, now: datetime, limits: dict[str, float] | None = None) -> dict | None:
    """None when the job is moving; otherwise {kind, stage, age_min, reason}. An open gate always counts."""
    limits = limits or DEFAULT_STUCK_MINUTES
    if job.stage in TERMINAL:
        return None
    if job.gate is not None:
        age = max(0.0, _minutes(now - parse(job.gate.opened_at)))
        reason = f"gate {job.gate.reason} open {fmt_duration(age)}"
        return {
            "kind": "gate",
            "stage": job.stage,
            "age_min": round(age, 1),
            "reason": reason,
            "reason_pt": pt.stuck_reason("gate", job.stage, fmt_duration(age), job.gate.reason),
        }
    limit = limits.get(job.stage)
    age = stage_age_minutes(job, now)
    if limit is None or age <= limit:
        return None
    span = fmt_duration(age)
    if job.stage == "build":
        reason = f"build for {span}" + ("" if job.links.get("pr") else " with no PR")
    elif job.stage == "checks":
        reason = f"CI running {span}"
    else:
        reason = f"{job.stage} for {span}"
    return {
        "kind": "stage",
        "stage": job.stage,
        "age_min": round(age, 1),
        "reason": reason,
        "reason_pt": pt.stuck_reason("stage", job.stage, span, has_pr=bool(job.links.get("pr"))),
    }


def stuck_items(jobs: list[Job], now: datetime, limits: dict[str, float] | None = None) -> list[dict]:
    items = []
    for job in jobs:
        if item := stuck_item(job, now, limits):
            items.append({"job": job.id, "repo": job.repo, "title": job.title, **item})
    return sorted(items, key=lambda i: i["age_min"], reverse=True)


# --- flow -----------------------------------------------------------------------------------------------------


def merged_at(job: Job) -> datetime | None:
    for entry in reversed(job.history):
        if entry["event"] == "merged":
            return parse(entry["at"])
    return None


def _lead_stats(minutes: list[float]) -> dict:
    return {"count": len(minutes), "median_min": median(minutes), "p90_min": percentile(minutes, 90)}


def flow(jobs: list[Job], now: datetime, window_days: int) -> dict:
    cutoff = now - timedelta(days=window_days)
    leads: dict[str, list[float]] = defaultdict(list)
    for job in jobs:
        done = merged_at(job)
        if done is not None and done >= cutoff:
            leads[job.repo].append(_minutes(done - parse(job.created_at)))
    wip: dict[str, int] = defaultdict(int)
    for job in jobs:
        if job.stage not in TERMINAL:
            wip[job.repo] += 1
    every = [m for repo_leads in leads.values() for m in repo_leads]
    return {
        "lead_time": {"overall": _lead_stats(every), "by_repo": {r: _lead_stats(m) for r, m in sorted(leads.items())}},
        "throughput_per_day": {
            "overall": round(len(every) / window_days, 3),
            "by_repo": {r: round(len(m) / window_days, 3) for r, m in sorted(leads.items())},
        },
        "wip": {"overall": sum(wip.values()), "by_repo": dict(sorted(wip.items()))},
        "merged_per_day": merged_per_day(jobs, now, window_days),
    }


def merged_per_day(jobs: list[Job], now: datetime, window_days: int) -> list[dict]:
    """One row per UTC day of the window, oldest first: {date, total, by_repo} of jobs merged that day."""
    today = now.astimezone(UTC).date()
    days = [today - timedelta(days=n) for n in range(window_days - 1, -1, -1)]
    rows = {d: defaultdict(int) for d in days}
    for job in jobs:
        done = merged_at(job)
        if done is not None and (day := done.astimezone(UTC).date()) in rows:
            rows[day][job.repo] += 1
    return [
        {"date": d.isoformat(), "total": sum(r.values()), "by_repo": dict(sorted(r.items()))} for d, r in rows.items()
    ]


def stage_summary(jobs: list[Job], now: datetime, window_days: int) -> dict[str, dict]:
    """Median minutes per stage over jobs with activity in the window: where does work wait?"""
    cutoff = now - timedelta(days=window_days)
    per_stage: dict[str, list[float]] = defaultdict(list)
    for job in jobs:
        if any(_in_window(e, cutoff) for e in job.history):
            for stage, minutes in stage_minutes(job, now).items():
                if minutes > 0:
                    per_stage[stage].append(minutes)
    return {s: {"count": len(m), "median_min": median(m)} for s, m in per_stage.items()}


# --- quality --------------------------------------------------------------------------------------------------


def _in_window(entry: dict, cutoff: datetime) -> bool:
    return parse(entry["at"]) >= cutoff


def gate_resolutions(job: Job) -> list[tuple[str, datetime, float | None]]:
    """(reason, opened_at, minutes to resolve or None while open) for every gate_opened in the history."""
    out: list[tuple[str, datetime, float | None]] = []
    open_idx: int | None = None
    for entry in job.history:
        if entry["event"] == "gate_opened":
            out.append((entry.get("reason", ""), parse(entry["at"]), None))
            open_idx = len(out) - 1
        elif entry["event"] == "gate_resolved" and open_idx is not None:
            reason, opened, _ = out[open_idx]
            out[open_idx] = (reason, opened, _minutes(parse(entry["at"]) - opened))
            open_idx = None
    return out


def quality(jobs: list[Job], now: datetime, window_days: int) -> dict:
    cutoff = now - timedelta(days=window_days)
    active = [j for j in jobs if any(_in_window(e, cutoff) for e in j.history)]
    first_pass = judged = rework_total = reds = conflicts = 0
    for job in active:
        verdicts = [
            e
            for e in job.history
            if e["event"] in ("approved", "rejected") and e.get("note") != "sync" and _in_window(e, cutoff)
        ]
        if verdicts:
            judged += 1
            first_pass += verdicts[0]["event"] == "approved"
            rework_total += sum(e["event"] == "rejected" for e in verdicts)
        reds += sum(e["event"] == "red" and _in_window(e, cutoff) for e in job.history)
        conflicts += sum(e["event"] == "conflict_sent" and _in_window(e, cutoff) for e in job.history)
    by_reason: dict[str, list[float | None]] = defaultdict(list)
    for job in jobs:
        for reason, opened, minutes in gate_resolutions(job):
            if opened >= cutoff:
                by_reason[reason].append(minutes)
    gates = {
        reason: {
            "count": len(times),
            "median_resolve_min": median([m for m in times if m is not None]),
        }
        for reason, times in sorted(by_reason.items())
    }
    return {
        "jobs": len(active),
        "judge_first_pass_rate": first_pass / judged if judged else None,
        "mean_rework_rounds": rework_total / judged if judged else None,
        "ci_red_rate": reds / len(active) if active else None,
        "red_events": reds,
        "conflicts_sent": conflicts,
        "gates_opened": gates,
    }


# --- cost -----------------------------------------------------------------------------------------------------


def cost(jobs: list[Job], now: datetime, window_days: int) -> dict:
    """Sum of `cost` events inside the window, per repo."""
    cutoff = now - timedelta(days=window_days)
    by_repo: dict[str, float] = defaultdict(float)
    for job in jobs:
        by_repo[job.repo] += sum(
            e.get("usd", 0.0) for e in job.history if e["event"] == "cost" and _in_window(e, cutoff)
        )
    rounded = {r: round(v, 4) for r, v in sorted(by_repo.items())}
    return {"total_usd": round(sum(rounded.values()), 4), "by_repo": rounded}


# --- everything -----------------------------------------------------------------------------------------------


def compute(jobs: list[Job], now: datetime, window_days: int, config: dict | None = None) -> dict:
    limits = thresholds(config)
    return {
        "window_days": window_days,
        "generated_at": now.replace(microsecond=0).isoformat(),
        "stuck": stuck_items(jobs, now, limits),
        "stage_minutes": {j.id: stage_minutes(j, now) for j in jobs},
        "stage_summary": stage_summary(jobs, now, window_days),
        "flow": flow(jobs, now, window_days),
        "quality": quality(jobs, now, window_days),
        "cost": cost(jobs, now, window_days),
    }
