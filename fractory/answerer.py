"""Answerer: a worker's question is answered from the card, the brief, AGENTS.md and the docs the card points to.

Only what nothing written decides reaches a person (a gate). The model returns structured JSON; everything with a
right answer is code: parsing, the escalation categories (config `[answerer] escalate`), the override that sends a
listed category to a gate even when the model said `answer`, and routing. A malformed or failed reply escalates:
never a guess, never silence. The prompt is `answerer_prompt.md`.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path

from . import judge

PROMPT = Path(__file__).with_name("answerer_prompt.md")
CATEGORIES = (
    "product_copy",  # a product or copy decision with no written source
    "money",  # spending money
    "secrets",  # secrets or credentials
    "production_data",  # production data
    "rubric_risk",  # rubric or risk rules
    "delete_user_data",  # deleting user data
)
KEYS = {"decision", "answer", "source", "category"}
DOC_MAX_CHARS = 20_000
TOTAL_DOCS_MAX_CHARS = 60_000
DOC_PATH = re.compile(r"[\w./-]+\.(?:md|txt|rst|html|json|toml|ya?ml)\b")
_FENCE = re.compile(r"```(?:json)?\s*(.*?)\s*```", re.DOTALL)


class AnswererError(RuntimeError):
    pass


@dataclass(frozen=True)
class Decision:
    decision: str  # answer | escalate
    answer: str
    source: str
    category: str

    @property
    def answered(self) -> bool:
        return self.decision == "answer"


def settings(config: dict) -> tuple[bool, tuple[str, ...]]:
    """(enabled, escalation categories) from `[answerer]`; the category list is deterministic, from config."""
    section = config.get("answerer") or {}
    listed = section.get("escalate")
    cats = tuple(str(c) for c in listed) if isinstance(listed, list) and listed else CATEGORIES
    return bool(section.get("enabled", True)), cats


def docs_for(card_text: str, repo: Path) -> list[tuple[str, str]]:
    """Files under the repo that the card text names by path, read in order, capped. Never reads outside the repo."""
    root = repo.resolve()
    found: list[tuple[str, str]] = []
    seen: set[Path] = set()
    budget = TOTAL_DOCS_MAX_CHARS
    for m in DOC_PATH.finditer(card_text):
        path = (root / m.group(0).lstrip("./")).resolve()
        if path in seen or not path.is_relative_to(root) or not path.is_file() or budget <= 0:
            continue
        seen.add(path)
        text = path.read_text(errors="replace")[: min(DOC_MAX_CHARS, budget)]
        budget -= len(text)
        found.append((str(path.relative_to(root)), text))
    return found


def build_prompt(
    question: str,
    options: list[str],
    title: str,
    card: str,
    brief: str | None,
    agents: str | None,
    docs: list[tuple[str, str]],
    categories: tuple[str, ...],
) -> str:
    return PROMPT.read_text().format(
        categories="\n".join(f"  - {c}" for c in categories),
        question=question,
        options="\n".join(f"- {o}" for o in options) or "(none)",
        title=title,
        card=card.strip() or "(empty)",
        brief=(brief or "(none)").strip(),
        agents=(agents or "(none)").strip(),
        docs="\n\n".join(f"--- {p}\n{t}" for p, t in docs) or "(none)",
    )


def parse_decision(text: str, categories: tuple[str, ...]) -> Decision:
    """Strict parse. A listed category always escalates, even when the model said `answer`."""
    body = text.strip()
    if m := _FENCE.fullmatch(body):
        body = m.group(1)
    try:
        data = json.loads(body)
    except json.JSONDecodeError as err:
        raise AnswererError(f"answer is not JSON: {err}") from None
    if not isinstance(data, dict) or set(data) != KEYS:
        raise AnswererError(f"answer keys must be exactly {sorted(KEYS)}")
    if data["decision"] not in ("answer", "escalate"):
        raise AnswererError("decision must be answer or escalate")
    if not all(isinstance(data[k], str) for k in ("answer", "source", "category")):
        raise AnswererError("answer, source and category must be strings")
    answer, source, category = data["answer"].strip(), data["source"].strip(), data["category"].strip()
    if not answer:
        raise AnswererError("answer is empty")
    decision = data["decision"]
    if decision == "answer" and not source:
        raise AnswererError("an answer needs a source")
    if category in categories:
        decision = "escalate"
    elif decision == "escalate":
        # the model escalated outside the list: nothing allows that, but it gave no answer to send either
        category = category or "unlisted"
    return Decision(decision, answer, source, category)


def decide(prompt: str, categories: tuple[str, ...], runner=None) -> Decision:
    """Ask the model and route. Any failure (model, parse) is an escalation with the reason in `source`."""
    try:
        return parse_decision(judge.ask_model(prompt, runner), categories)
    except (judge.JudgeError, AnswererError) as err:
        return Decision("escalate", "", f"answerer failed: {err}", "answerer_error")


def gate_detail(question: str, options: list[str], d: Decision) -> str:
    """Gate text: the question on the first line, then the worker's options and the recommended default."""
    lines = [question]
    if options:
        lines += ["Options: " + "; ".join(options)]
    if d.answer:
        why = f"{d.category}; {d.source}" if d.source else d.category
        lines += [f"Recommended default: {d.answer} ({why})"]
    else:
        lines += [f"Not answered by the factory: {d.source}"]
    return "\n".join(lines)


def answered_comment(question: str, d: Decision) -> str:
    return f"Answered by the factory: {d.answer}, source: {d.source} (question: {question})"
