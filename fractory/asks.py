"""Worker asks: a worker that asks its coordinator a question gets a person, through a gate.

No coordinator answers a factory worker, so the ask used to wait forever (2026-11-20: the EP02 worker idled
about 2 hours on "bump Expo packages?"). The watch step reads Orca's inbox for `question` / `escalation`
messages from the job's dispatch and opens a `worker_asks` gate whose detail is the question. Answering on the
card (comment, then Done) types the comment into the worker's terminal. Each message opens at most one gate: its id
is recorded in the job history (`worker_ask`), so later cycles skip it.

Since FRACTORY-59 the answerer (`answerer.py`) goes first: a question that the card, the brief, AGENTS.md or the docs
the card points to decide is answered into the worker's terminal and logged (`worker_answered`, plus a Plane
comment), with no gate. Only the configured escalation categories, and anything the answerer could not decide
safely, open the gate, carrying the worker's options and the recommended default.
"""

from __future__ import annotations

import html
import json
import sys
from pathlib import Path

from . import answerer, judge, launch, state, store

REASON = "worker_asks"
ASK_TYPES = ("question", "escalation")
TITLE_MAX = 80


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


def options_of(message: dict) -> list[str]:
    try:
        payload = json.loads(message.get("payload") or "{}")
    except (TypeError, ValueError):
        payload = {}
    raw = payload.get("options") if isinstance(payload, dict) else None
    return [" ".join(str(o).split()) for o in raw if str(o).strip()] if isinstance(raw, list) else []


def title_for(question: str) -> str:
    """Card title part: the question's first line, cut to a readable length."""
    question = question.split("\n", 1)[0]
    return question if len(question) <= TITLE_MAX else question[: TITLE_MAX - 1].rstrip() + "…"


def asked_ids(job: state.Job) -> set[str]:
    return {str(h.get("message")) for h in job.history if h["event"] == "worker_ask"}


def pending_asks(job: state.Job, messages: list[dict]) -> list[dict]:
    """Ask messages from the job's current dispatch that no gate was opened for yet, oldest first."""
    dispatch = job.links.get("dispatch")
    if not dispatch:
        return []
    seen = asked_ids(job)
    found = [
        m
        for m in messages
        if m.get("type") in ASK_TYPES
        and not m.get("handled")
        and str(m.get("id")) not in seen
        and message_dispatch(m) == dispatch
        and str(m.get("created_at") or "") >= job.created_at
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


def _context(job: state.Job) -> tuple[str, str, str | None] | None:
    """(title, card text, AGENTS.md) for the answerer; None when the card could not be read."""
    from . import cli  # late: cli imports this module

    agents_file = Path(job.repo) / "AGENTS.md"
    agents = agents_file.read_text(errors="replace") if agents_file.is_file() else None
    tracker = cli.plane_tracker(job)
    if tracker is None:
        return job.title, "", agents
    try:
        issue = tracker.get_item(job.tracker["ref"])
        comments = tracker.comment_texts(job.tracker["ref"])
    except Exception:  # noqa: BLE001 - any tracker failure means "no card to answer from"
        return None
    text = judge.html_to_text(issue.get("description_html") or "")
    if comments:
        text += "\n\nComments:\n" + "\n---\n".join(judge.html_to_text(c) for c in comments)
    return str(issue.get("name") or job.title), text, agents


def decide(job: state.Job, question: str, options: list[str], runner=None) -> answerer.Decision:
    """Ask the answerer. Disabled, or no readable card: escalate without a model call."""
    enabled, categories = answerer.settings(store.config())
    if not enabled:
        return answerer.Decision("escalate", "", "answerer disabled", "answerer_disabled")
    context = _context(job)
    if context is None:
        return answerer.Decision("escalate", "", "the card could not be read", "answerer_error")
    title, card, agents = context
    prompt = answerer.build_prompt(
        question, options, title, card, store.brief(job.id), agents, answerer.docs_for(card, Path(job.repo)), categories
    )
    return answerer.decide(prompt, categories, runner)


def _comment_answer(job: state.Job, question: str, d: answerer.Decision) -> None:
    """Plane comment on the card. Skipped for work repos (their trackers are shared with the employer) and on failure."""
    from . import cli  # late: cli imports this module

    if store.repo_kind(Path(job.repo)) == "able":
        return
    tracker = cli.plane_tracker(job)
    if tracker is None:
        return
    try:
        tracker.comment(job.tracker["ref"], f"<p>{html.escape(answerer.answered_comment(question, d))}</p>")
    except Exception as err:  # noqa: BLE001 - the comment is a record, never a reason to lose the answer
        print(f"{job.id}  could not comment the answer on the card: {err}")


def open_gates(runner=None, orch: Path | None = None, model_runner=None) -> None:
    """Watch step: each unanswered ask of a job without an open gate is answered, or opens one `worker_asks` gate."""
    candidates = [
        j for j in store.all_jobs() if j.stage not in state.TERMINAL and not j.gate and j.links.get("dispatch")
    ]
    if not candidates:
        return
    messages = inbox(runner or launch.run_cmd)
    if messages is None:
        return
    for found in candidates:
        for ask in pending_asks(found, messages):
            question = question_text(ask)
            options = options_of(ask)
            d = decide(found, question, options, model_runner)
            if d.answered and not deliver_answer(found, question, d.answer, orch, runner):
                d = answerer.Decision("escalate", d.answer, f"{d.source}; delivery to the worker failed", d.category)
            with store.locked(found.id):
                job = store.load(found.id)
                if job.gate or str(ask.get("id")) in asked_ids(job):
                    break
                event = {
                    "at": state.now_iso(),
                    "event": "worker_ask",
                    "stage": job.stage,
                    "message": str(ask.get("id")),
                }
                if d.answered:
                    job.history.append(event)
                    job.history.append(
                        {
                            **event,
                            "event": "worker_answered",
                            "category": d.category,
                            "source": d.source,
                            "answer": d.answer,
                        }
                    )
                    store.save(job)
                else:
                    job = state.open_gate(job, REASON, answerer.gate_detail(question, options, d))
                    job.history.append(event)
                    store.save(job)
            if d.answered:
                _comment_answer(job, question, d)
                print(f"{job.id}  answered: {title_for(question)}")
                continue
            print(f"{job.id}  gate {REASON}: {title_for(question)}")
            break


def answer_message(question: str, answer: str) -> str:
    """One line: it is typed into a terminal, where a newline would submit early."""
    return " ".join(f"[fractory] Answer to your question ({title_for(question)}): {answer}".split())


def deliver_gate_answer(job: state.Job, gate: state.Gate, note: str, orch: Path, runner=None) -> bool:
    """Type the person's answer to a gate into the worker's terminal."""
    answer = note if note and note != "via Plane card" else "approved, continue with your best judgement"
    return deliver_answer(job, gate.detail, answer, orch, runner)


def deliver_answer(job: state.Job, question: str, answer: str, orch: Path | None, runner=None) -> bool:
    """Type an answer into the worker's terminal. False (and a printed warning) when it could not."""
    from . import cli  # late: cli imports this module

    orch = orch or cli.ORCH
    terminal = job.links.get("terminal")
    if not terminal:
        print(f"{job.id}  worker_asks answered but the job has no terminal")
        return False
    try:
        code, _ = (runner or launch.run_cmd)(
            [sys.executable, str(orch), "nudge", str(terminal), "--text", answer_message(question, answer)]
        )
    except OSError:
        code = 1
    if code != 0:
        print(f"{job.id}  worker_asks answer was not picked up by {terminal}")
    return code == 0
