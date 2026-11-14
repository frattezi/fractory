"""Gates as Plane cards: an open gate becomes a 'Needs you' card labelled `humano`; the card decides it.

Done on the card resolves the gate with `continue`, Cancelled with `cancel` (the job is cancelled).
Comments on the card are copied into the gate's note. Closing a gate from the CLI moves the card to Done.
Each function is idempotent so the watch cycle can run it every minute.
"""

from __future__ import annotations

import html
import json
import re

from . import state, store, sync
from .trackers.base import Duplicate

LABEL = "humano"
WHAT_MOVING_DOES = (
    "Move this card to <b>Done</b> to let the job continue, or to <b>Cancelled</b> to cancel the job. "
    "A comment on the card is copied into the decision note."
)


def card_title(job: state.Job, gate: state.Gate) -> str:
    return f"Needs you: {gate.reason} · {job.title}"


def external_id(job: state.Job, gate: state.Gate) -> str:
    """`gate-<job>-<gate>-<n>`: n counts how many times this gate opened on the job, so a reopened gate gets a new card."""
    n = sum(1 for h in job.history if h["event"] == "gate_opened" and h.get("reason") == gate.reason)
    return f"gate-{job.id}-{gate.reason}-{max(n, 1)}"


def pr_link(job: state.Job) -> str:
    pr = job.links.get("pr")
    if not pr:
        return ""
    try:
        url = json.loads(sync.run_gh(["pr", "view", pr, "--json", "url"], job.repo)).get("url")
    except (OSError, ValueError, RuntimeError, AttributeError):
        url = None
    url = url or f"#{pr}"
    return f'<a href="{html.escape(url)}">{html.escape(url)}</a>' if url.startswith("http") else html.escape(url)


def card_body(job: state.Job, gate: state.Gate) -> str:
    esc = html.escape
    parts = [f"<p><b>Gate:</b> {esc(gate.reason)}</p>", f"<p>{esc(gate.detail or '(no detail)')}</p>"]
    if link := pr_link(job):
        parts.append(f"<p><b>PR:</b> {link}</p>")
    parts.append(f"<p><b>Job:</b> <code>{esc(job.id)}</code></p>")
    parts.append(f"<p>{WHAT_MOVING_DOES}</p>")
    return "".join(parts)


def ensure_card(job_id: str, plane_factory=None) -> None:
    """Create the card for the job's open gate if it has none. Duplicate external id adopts the existing card."""
    from . import cli  # late: cli imports this module

    job = store.load(job_id)
    if job.gate is None or job.gate.card:
        return
    tracker = (plane_factory or cli.plane_tracker)(job)
    if tracker is None:
        return
    gate = job.gate
    assignee = store.config().get("plane_assignee")
    try:
        item = tracker.create_item(
            card_title(job, gate),
            card_body(job, gate),
            "ready",
            external_id(job, gate),
            labels=[tracker.label_id(LABEL)],
            assignees=[assignee] if assignee else None,
        )
        card, key, url = item.ref, item.key, item.url
    except Duplicate as dup:
        card, key, url = dup.ref, "", ""
    if not card:
        return
    with store.locked(job_id):
        current = store.load(job_id)
        if current.gate and current.gate.opened_at == gate.opened_at:
            current.gate.card, current.gate.card_key, current.gate.card_url = card, key, url
            store.save(current)
    print(f"{job_id}  gate card {key or card}")


def card_decision(tracker, card: str) -> tuple[str, str] | None:
    """(decision, note) once the card is Done or Cancelled; None while a person has not decided."""
    group = tracker.item_group(card)
    if group not in ("completed", "cancelled"):
        return None
    comments = [re.sub(r"<[^>]+>", "", c).strip() for c in tracker.comment_texts(card)]
    note = " | ".join(html.unescape(c) for c in comments if c)
    return ("continue" if group == "completed" else "cancel"), note


def resolve_from_card(job_id: str, plane_factory=None) -> bool:
    """Resolve the job's gate if its card was moved to Done or Cancelled. True when it did."""
    from . import cli

    job = store.load(job_id)
    if job.gate is None or not job.gate.card:
        return False
    tracker = (plane_factory or cli.plane_tracker)(job)
    if tracker is None:
        return False
    gate = job.gate
    decided = card_decision(tracker, gate.card)
    if decided is None:
        return False
    decision, note = decided
    with store.locked(job_id):
        current = store.load(job_id)
        if current.gate is None or current.gate.opened_at != gate.opened_at:
            return False  # resolved by hand meanwhile
        resolved = state.resolve_gate(current, decision, note or "via Plane card")
        store.save(resolved)
    if decision == "cancel":
        tracker.set_status(job.tracker["ref"], "cancelled")
    print(f"{job_id}  gate {gate.reason} {decision} (card {gate.card_key or gate.card})")
    return True


def close_card(job: state.Job, gate: state.Gate, plane_factory=None) -> None:
    """After a CLI resolve: move the gate's card to Done. A Plane failure warns, never fails the resolve."""
    from . import cli

    if not gate.card:
        return
    try:
        tracker = (plane_factory or cli.plane_tracker)(job)
        if tracker:
            tracker.set_status(gate.card, "done")
    except (OSError, RuntimeError) as err:
        print(f"warning: could not move the gate card to Done: {err}")


def sync_gates(job_ids: list[str] | None = None) -> bool:
    """Watch step: create missing cards, then resolve gates whose card was decided. True if any step failed."""
    failed = False
    for job in store.all_jobs() if job_ids is None else [store.load(i) for i in job_ids]:
        if job.gate is None:
            continue
        try:
            ensure_card(job.id)
            resolve_from_card(job.id)
        except (OSError, ValueError, RuntimeError) as err:
            failed = True
            print(f"{job.id}  gate card error: {err}")
    return failed
