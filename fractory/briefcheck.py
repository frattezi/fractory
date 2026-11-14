"""Brief check: does the brief ask for work its Plane card does not mention?

Same style as the Judge: the model only answers a JSON-only question, parsing is strict code.
Catches a stale or narrower card before launch, instead of a Judge rejection after the work.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass

from . import judge

MODEL = "sonnet"  # cheaper than the Judge's opus
KEYS = {"ok", "extra"}


class BriefCheckError(RuntimeError):
    pass


@dataclass(frozen=True)
class Verdict:
    ok: bool
    extra: list[str]


def build_prompt(card_title: str, card_text: str, brief: str) -> str:
    return (
        "A worker will be given the BRIEF below for the work tracked by the CARD. "
        "Does the brief ask for work that the card does not mention (extra deliverables, files, behaviours "
        "or goals)? Detail that only says how to do what the card asks is not extra.\n\n"
        f"CARD: {card_title}\n{card_text}\n\n"
        f"BRIEF\n{brief.strip()}\n\n"
        "Reply with ONLY a JSON object, no prose, in exactly this shape:\n"
        '{"ok": true | false, "extra": ["short description of each item beyond the card", ...]}\n'
        "`ok` is true only when `extra` is empty."
    )


_FENCE = re.compile(r"```(?:json)?\s*(.*?)\s*```", re.DOTALL)


def parse_verdict(text: str) -> Verdict:
    body = text.strip()
    if m := _FENCE.fullmatch(body):
        body = m.group(1)
    try:
        data = json.loads(body)
    except json.JSONDecodeError as err:
        raise BriefCheckError(f"answer is not JSON: {err}") from None
    if not isinstance(data, dict) or set(data) != KEYS:
        raise BriefCheckError(f"answer keys must be exactly {sorted(KEYS)}")
    ok, extra = data["ok"], data["extra"]
    if not isinstance(ok, bool):
        raise BriefCheckError("ok must be a boolean")
    if not isinstance(extra, list) or not all(isinstance(e, str) and e.strip() for e in extra):
        raise BriefCheckError("extra must be a list of non-empty strings")
    if ok != (not extra):
        raise BriefCheckError("ok must be true exactly when extra is empty")
    return Verdict(ok, [e.strip() for e in extra])


def _sonnet(runner: judge.Runner | None) -> judge.Runner:
    run = runner or judge.run_claude
    return lambda argv, stdin: run([MODEL if part == "opus" else part for part in argv], stdin)


def check(card_title: str, card_text: str, brief: str, runner: judge.Runner | None = None) -> Verdict:
    """`card_text` may be HTML (Plane's description_html). Raises BriefCheckError on any model or parse failure."""
    try:
        answer = judge.ask_model(build_prompt(card_title, judge.html_to_text(card_text), brief), _sonnet(runner))
    except judge.JudgeError as err:
        raise BriefCheckError(str(err)) from None
    return parse_verdict(answer)
