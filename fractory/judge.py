"""The Judge: an Opus verdict on a PR diff against its issue, under a fixed rubric.

Everything with a right answer is code here: parsing, validation, the downgrade rule, the size limit.
The model only judges. `parse_verdict` and `build_prompt` are pure; `ask_model` shells out to `claude`.
"""

from __future__ import annotations

import json
import re
import subprocess
from collections.abc import Callable
from dataclasses import dataclass
from html import escape
from html.parser import HTMLParser
from pathlib import Path
from typing import ClassVar

RUBRIC = (Path(__file__).parent / "rubric.md").read_text().strip()
MAX_DIFF_CHARS = 60_000
CLAUDE_TIMEOUT_S = 900
KEYS = {"decision", "spec_match", "scope_creep", "reasons"}

Runner = Callable[[list[str], str], str]  # (argv, stdin) -> stdout


class JudgeError(RuntimeError):
    pass


@dataclass(frozen=True)
class Verdict:
    decision: str  # approved | rejected
    spec_match: bool
    scope_creep: bool
    reasons: tuple[str, ...]

    @property
    def approved(self) -> bool:
        return self.decision == "approved"

    def note(self) -> str:
        return "; ".join(self.reasons)

    def comment_markdown(self) -> str:
        bullets = "\n".join(f"- {r}" for r in self.reasons)
        return (
            f"**Fractory judge: {self.decision}**\n\n"
            f"spec match: {self.spec_match} · scope creep: {self.scope_creep}\n\n{bullets}"
        )

    def comment_html(self) -> str:
        items = "".join(f"<li>{escape(r)}</li>" for r in self.reasons)
        return (
            f"<p><strong>Fractory judge: {self.decision}</strong></p>"
            f"<p>spec match: {self.spec_match} · scope creep: {self.scope_creep}</p><ul>{items}</ul>"
        )


def build_prompt(issue_title: str, issue_text: str, diff: str) -> str:
    return (
        "You are a strict code reviewer. Judge the diff against the issue using this rubric.\n\n"
        f"RUBRIC\n{RUBRIC}\n\n"
        f"ISSUE: {issue_title}\n{issue_text}\n\n"
        f"DIFF\n{diff}\n\n"
        "Reply with ONLY a JSON object, no prose, in exactly this shape:\n"
        '{"decision": "approved" | "rejected", "spec_match": true | false, '
        '"scope_creep": true | false, "reasons": ["short reason", ...]}\n'
        "`reasons` must be non-empty."
    )


_FENCE = re.compile(r"```(?:json)?\s*(.*?)\s*```", re.DOTALL)


def parse_verdict(text: str) -> Verdict:
    body = text.strip()
    if m := _FENCE.fullmatch(body):
        body = m.group(1)
    try:
        data = json.loads(body)
    except json.JSONDecodeError as err:
        raise JudgeError(f"verdict is not JSON: {err}") from None
    if not isinstance(data, dict) or set(data) != KEYS:
        raise JudgeError(f"verdict keys must be exactly {sorted(KEYS)}")
    if data["decision"] not in ("approved", "rejected"):
        raise JudgeError(f"bad decision {data['decision']!r}")
    for key in ("spec_match", "scope_creep"):
        if not isinstance(data[key], bool):
            raise JudgeError(f"{key} must be a boolean")
    reasons = data["reasons"]
    if not isinstance(reasons, list) or not reasons or not all(isinstance(r, str) and r.strip() for r in reasons):
        raise JudgeError("reasons must be a non-empty list of non-empty strings")
    decision = data["decision"]
    if decision == "approved" and (not data["spec_match"] or data["scope_creep"]):
        decision = "rejected"
        reasons = [*reasons, "downgraded: approved with spec_match false or scope_creep true"]
    return Verdict(decision, data["spec_match"], data["scope_creep"], tuple(r.strip() for r in reasons))


def run_claude(argv: list[str], stdin: str) -> str:
    try:
        return subprocess.run(
            argv, input=stdin, capture_output=True, text=True, check=True, timeout=CLAUDE_TIMEOUT_S
        ).stdout
    except (OSError, subprocess.SubprocessError) as err:
        raise JudgeError(f"claude failed: {err}") from None


def ask_model(prompt: str, runner: Runner | None = None) -> str:
    out = (runner or run_claude)(["claude", "-p", "--model", "opus", "--output-format", "json"], prompt)
    try:
        data = json.loads(out)
        result = data["result"]
    except (json.JSONDecodeError, KeyError, TypeError):
        raise JudgeError("claude output has no JSON 'result' field") from None
    if data.get("is_error") or not isinstance(result, str):
        raise JudgeError(f"claude reported an error: {str(result)[:200]}")
    return result


def check_diff_size(diff: str) -> None:
    if len(diff) > MAX_DIFF_CHARS:
        raise JudgeError("diff too large")


class _Text(HTMLParser):
    BLOCKS: ClassVar[set[str]] = {"p", "div", "br", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "pre", "tr"}

    def __init__(self) -> None:
        super().__init__()
        self.parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list) -> None:
        if tag == "li":
            self.parts.append("\n- ")
        elif tag in self.BLOCKS:
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in self.BLOCKS:
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        self.parts.append(data)


def html_to_text(html: str) -> str:
    parser = _Text()
    parser.feed(html or "")
    parser.close()
    return re.sub(r"\n{3,}", "\n\n", "".join(parser.parts)).strip()


def judge_diff(issue_title: str, issue_html: str, diff: str, runner: Runner | None = None) -> Verdict:
    """Size check, prompt, model, parse. Raises JudgeError before any model call if the diff is too big."""
    check_diff_size(diff)
    return parse_verdict(ask_model(build_prompt(issue_title, html_to_text(issue_html), diff), runner))
