"""Job state machine: which stage a job is in and what an event does to it.

Pure: `apply_event` takes a Job and an event and returns the new Job plus the actions the caller must
carry out (open a gate, escalate the worker model). No I/O here; persistence lives in store.py.
"""

from __future__ import annotations

import copy
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime

STAGES = ("discovery", "spec", "build", "checks", "review", "judge", "ship", "done", "cancelled")
TERMINAL = ("done", "cancelled")
KINDS = ("able", "internal")

MAX_JUDGE_ROUNDS = 2
MAX_RED_SAME_CHECK = 2
DEFAULT_BUDGET_USD = 50.0

# stage -> event -> next stage
TRANSITIONS: dict[str, dict[str, str]] = {
    "discovery": {"scoped": "spec"},
    "spec": {"planned": "build"},
    "build": {"built": "checks"},
    "checks": {"green": "review", "red": "build"},
    "review": {"reviewed": "judge"},
    "judge": {"approved": "ship", "rejected": "build"},
    "ship": {"draft_pr": "done", "merged": "done"},
}


class TransitionError(ValueError):
    pass


def now_iso() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat()


@dataclass
class Gate:
    reason: str
    detail: str = ""
    opened_at: str = field(default_factory=now_iso)
    card: str = ""  # Plane card id of the 'Needs you' card, once created
    card_key: str = ""
    card_url: str = ""


@dataclass
class Job:
    id: str
    repo: str
    title: str
    kind: str = "internal"
    stage: str = "discovery"
    gate: Gate | None = None
    judge_rounds: int = 0
    red_streak: dict[str, int] = field(default_factory=dict)
    cost_usd: float = 0.0
    budget_usd: float = DEFAULT_BUDGET_USD
    tracker: dict = field(default_factory=dict)  # {"kind": "plane"|"jira", "ref": "..."}
    links: dict = field(default_factory=dict)  # worktree, terminal, branch, pr
    history: list[dict] = field(default_factory=list)
    created_at: str = field(default_factory=now_iso)

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict) -> Job:
        data = dict(data)
        gate = data.pop("gate", None)
        job = cls(**data)
        job.gate = Gate(**gate) if gate else None
        return job


def new_job(
    job_id: str, repo: str, title: str, kind: str, budget: float = DEFAULT_BUDGET_USD, stage: str = "discovery"
) -> Job:
    if kind not in KINDS:
        raise TransitionError(f"kind must be one of {KINDS}, got {kind!r}")
    if stage not in TRANSITIONS:
        raise TransitionError(f"a job starts in a working stage, got {stage!r}")
    job = Job(id=job_id, repo=repo, title=title, kind=kind, budget_usd=budget, stage=stage)
    job.history.append({"at": now_iso(), "event": "created", "stage": stage})
    return job


def _log(job: Job, event: str, **extra) -> None:
    job.history.append({"at": now_iso(), "event": event, "stage": job.stage, **extra})


def open_gate(job: Job, reason: str, detail: str = "") -> Job:
    job = copy.deepcopy(job)
    job.gate = Gate(reason, detail)
    _log(job, "gate_opened", reason=reason, detail=detail)
    return job


def resolve_gate(job: Job, decision: str, note: str = "") -> Job:
    """`continue` clears the gate and resets the counter that opened it; `cancel` ends the job."""
    if job.gate is None:
        raise TransitionError(f"{job.id} has no open gate")
    if decision not in ("continue", "cancel"):
        raise TransitionError("decision must be continue or cancel")
    reason = job.gate.reason
    job = copy.deepcopy(job)
    job.gate = None
    if decision == "cancel":
        job.stage = "cancelled"
    elif reason == "judge_rounds":
        job.judge_rounds = 0
    elif reason == "cost":
        job.budget_usd = max(job.budget_usd, job.cost_usd) + DEFAULT_BUDGET_USD
    _log(job, "gate_resolved", reason=reason, decision=decision, note=note)
    return job


def apply_event(job: Job, event: str, check: str | None = None, note: str = "") -> tuple[Job, list[str]]:
    """Move `job` by `event`. Returns the new job and actions: `escalate_model`, `gate:<reason>`."""
    if event == "cancel":
        if job.stage in TERMINAL:
            raise TransitionError(f"{job.id} already {job.stage}")
        job = copy.deepcopy(job)
        job.stage = "cancelled"
        job.gate = None
        _log(job, "cancel", note=note)
        return job, []
    if job.stage in TERMINAL:
        raise TransitionError(f"{job.id} is {job.stage}")
    if job.gate is not None:
        raise TransitionError(f"{job.id} is waiting on gate {job.gate.reason!r}: resolve it first")
    allowed = TRANSITIONS[job.stage]
    if event not in allowed:
        raise TransitionError(f"{job.id} in {job.stage}: event {event!r} not allowed (allowed: {', '.join(allowed)})")
    if event == "draft_pr" and job.kind != "able":
        raise TransitionError("draft_pr ends Able jobs; internal jobs end with merged")
    if event == "merged" and job.kind == "able":
        raise TransitionError("Able jobs stop at a draft PR: use draft_pr")

    job = copy.deepcopy(job)
    actions: list[str] = []
    if event == "red":
        name = check or "ci"
        job.red_streak[name] = job.red_streak.get(name, 0) + 1
        if job.red_streak[name] >= MAX_RED_SAME_CHECK:
            actions.append("escalate_model")
            job.red_streak[name] = 0
    elif event == "green":
        job.red_streak = {}
    elif event == "rejected":
        job.judge_rounds += 1

    job.stage = allowed[event]
    _log(job, event, **({"check": check} if check else {}), **({"note": note} if note else {}))

    if event == "rejected" and job.judge_rounds >= MAX_JUDGE_ROUNDS:
        job = open_gate(job, "judge_rounds", f"{job.judge_rounds} judge rounds without passing")
        actions.append("gate:judge_rounds")
    return job, actions


def add_cost(job: Job, usd: float) -> tuple[Job, list[str]]:
    if usd < 0:
        raise TransitionError("cost must be positive")
    job = copy.deepcopy(job)
    job.cost_usd = round(job.cost_usd + usd, 4)
    _log(job, "cost", usd=usd, total=job.cost_usd)
    if job.cost_usd > job.budget_usd and job.gate is None and job.stage not in TERMINAL:
        job = open_gate(job, "cost", f"US$ {job.cost_usd:.2f} over budget US$ {job.budget_usd:.2f}")
        return job, ["gate:cost"]
    return job, []
