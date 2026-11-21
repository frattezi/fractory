"""Worker asks: a worker that asks its coordinator a question gets a person, through a gate.

No coordinator answers a factory worker, so the ask used to wait forever (2026-11-20: the EP02 worker idled
about 2 hours on "bump Expo packages?"). The watch step reads Orca's inbox for `question` / `escalation`
messages from the job's dispatch and opens a `worker_asks` gate whose detail is the question. Answering on the
card (comment, then Done) types the comment into the worker's terminal. Each message opens at most one gate: its id
is recorded in the job history (`worker_ask`), so later cycles skip it.
"""

from __future__ import annotations

import json
import sys
import time
from datetime import UTC, datetime
from pathlib import Path

from . import launch, state, store

REASON = "worker_asks"
ASK_TYPES = ("question", "escalation")
TITLE_MAX = 80
# History events that mean the worker was given input or moved on: a question older than the latest of them
# was already answered (2026-11-21: questions answered in the terminal the day before were raised again).
INPUT_EVENTS = frozenset({e for stage in state.TRANSITIONS.values() for e in stage}) | {
    "gate_resolved",
    "rework_sent",
    "retry",
    "worker_input",
    "worker_ask",
}
DELIVERY_TIMEOUT = 180
CHECK_SECONDS = 5
CHECK_ROUNDS = 6


def question_text(message: dict) -> str:
    """The question in an inbox message: the payload's `question`, else the body."""
    try:
        payload = json.loads(message.get("payload") or "{}")
    except (TypeError, ValueError):
        payload = {}
    text = payload.get("question") if isinstance(payload, dict) else None
    return " ".join(str(text or message.get("body") or message.get("subject") or "").split())


def message_dispatch(message: dict) -> str:
    try:
        payload = json.loads(message.get("payload") or "{}")
    except (TypeError, ValueError):
        payload = {}
    found = payload.get("dispatchId") if isinstance(payload, dict) else None
    sender = str(message.get("from_handle") or "")
    return str(found or (sender.removeprefix("dispatch:") if sender.startswith("dispatch:") else ""))


def title_for(question: str) -> str:
    """Card title part: the question, cut to a readable length."""
    return question if len(question) <= TITLE_MAX else question[: TITLE_MAX - 1].rstrip() + "…"


def asked_ids(job: state.Job) -> set[str]:
    return {str(h.get("message")) for h in job.history if h["event"] == "worker_ask"}


def parse_time(value: object) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(str(value))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


def input_cursor(job: state.Job) -> datetime:
    """The last moment the worker got input (an answer, a nudge, a stage move); a question counts only after it."""
    times = [t for h in job.history if h["event"] in INPUT_EVENTS and (t := parse_time(h.get("at")))]
    times.append(parse_time(job.created_at) or datetime.min.replace(tzinfo=UTC))
    return max(times)


def pending_asks(job: state.Job, messages: list[dict]) -> list[dict]:
    """Ask messages from the job's current dispatch that no gate was opened for yet, oldest first."""
    dispatch = job.links.get("dispatch")
    if not dispatch:
        return []
    seen = asked_ids(job)
    cursor = input_cursor(job)
    found = [
        m
        for m in messages
        if m.get("type") in ASK_TYPES
        and not m.get("handled")
        and str(m.get("id")) not in seen
        and message_dispatch(m) == dispatch
        and (sent := parse_time(m.get("created_at"))) is not None
        and sent > cursor
    ]
    return sorted(found, key=lambda m: m.get("sequence") or 0)


def inbox(runner) -> list[dict] | None:
    """Messages of `orca orchestration inbox`; None when it failed (a failed read proves nothing)."""
    try:
        code, out = runner([launch.orca_exe(), "orchestration", "inbox", "--full", "--json", "--limit", "200"])
    except OSError:
        return None
    rows = (launch.json_payload(out).get("result") or {}).get("messages")
    return rows if code == 0 and isinstance(rows, list) else None


def open_gates(runner=None) -> None:
    """Watch step: one `worker_asks` gate per unanswered ask of a job without an open gate."""
    candidates = [
        j for j in store.all_jobs() if j.stage not in state.TERMINAL and not j.gate and j.links.get("dispatch")
    ]
    if not candidates:
        return
    messages = inbox(runner or launch.run_cmd)
    if messages is None:
        return
    for found in candidates:
        if not pending_asks(found, messages):
            continue
        with store.locked(found.id):
            job = store.load(found.id)
            asks = [] if job.gate else pending_asks(job, messages)
            if not asks:
                continue
            ask = asks[0]
            question = question_text(ask)
            job = state.open_gate(job, REASON, question)
            job.history.append(
                {"at": state.now_iso(), "event": "worker_ask", "stage": job.stage, "message": str(ask.get("id"))}
            )
            store.save(job)
        print(f"{job.id}  gate {REASON}: {title_for(question)}")


def answer_message(question: str, answer: str) -> str:
    """One line: it is typed into a terminal, where a newline would submit early."""
    return " ".join(f"[fractory] Answer to your question ({title_for(question)}): {answer}".split())


def screen_shows_delivery(terminal: str, text: str, orch: Path, runner) -> bool:
    """The worker is busy, or its screen echoes the typed answer: the answer landed whatever `nudge` said."""
    try:
        _, out = runner([sys.executable, str(orch), "stalls", terminal])
        if out.strip().startswith(f"{terminal}: busy"):
            return True
        code, raw = runner([launch.orca_exe(), "terminal", "read", "--terminal", terminal, "--json"])
    except OSError:
        return False
    tail = ((launch.json_payload(raw).get("result") or {}).get("terminal") or {}).get("tail") or []
    needle = text[:40]
    return code == 0 and any(needle in str(line) for line in tail)


def deliver_answer(job: state.Job, gate: state.Gate, note: str, orch: Path, runner=None, sleep=time.sleep) -> bool:
    """Type the person's answer into the worker's terminal. False (and a printed warning) only on a real miss:
    `nudge` exiting non-zero is re-checked against the screen for a while before it is reported."""
    terminal = job.links.get("terminal")
    answer = note if note and note != "via Plane card" else "approved, continue with your best judgement"
    if not terminal:
        print(f"{job.id}  worker_asks answered but the job has no terminal")
        return False
    runner = runner or launch.run_cmd
    text = answer_message(gate.detail, answer)
    try:
        code, _ = runner(
            [sys.executable, str(orch), "nudge", str(terminal), "--timeout", str(DELIVERY_TIMEOUT), "--text", text]
        )
    except OSError:
        code = 1
    for _ in range(CHECK_ROUNDS if code != 0 else 0):
        if screen_shows_delivery(str(terminal), text, orch, runner):
            return True
        sleep(CHECK_SECONDS)
    if code != 0:
        print(f"{job.id}  worker_asks answer was not picked up by {terminal}")
    return code == 0
