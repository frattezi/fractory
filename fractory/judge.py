"""The Judge: an Opus verdict on a PR diff against its issue, under a fixed rubric.

Everything with a right answer is code here: parsing, validation, the downgrade rule, the size limit.
The model only judges. `parse_verdict` and `build_prompt` are pure; `ask_model` shells out to `claude`.
"""

from __future__ import annotations

import contextlib
import fnmatch
import json
import re
import shutil
import subprocess
import tempfile
from collections.abc import Callable, Iterator
from dataclasses import dataclass, replace
from html import escape
from html.parser import HTMLParser
from pathlib import Path
from typing import ClassVar

RUBRIC = (Path(__file__).parent / "rubric.md").read_text().strip()
MAX_DIFF_CHARS = 600_000  # default; `[judge] max_diff_chars` in config.toml overrides. Opus takes a 1M-token context
MIN_FILE_CHARS = 400
MAX_BRIEF_CHARS = 20_000
CLAUDE_TIMEOUT_S = 900
KEYS = {"decision", "spec_match", "scope_creep", "reasons"}
OPTIONAL_KEYS = {"unverified"}
PASSED = {"SUCCESS", "NEUTRAL", "SKIPPED"}
Checks = list[tuple[str, str]]  # (name, conclusion)

GENERATED_NAMES = (
    "pnpm-lock.yaml", "package-lock.json", "yarn.lock", "poetry.lock", "uv.lock", "Cargo.lock", "go.sum",
    "*.min.js", "*.min.css", "*.snap",
)  # fmt: skip
GENERATED_DIRS = ("dist", "build", "coverage")
BIG_SVG_LINES = 200

Runner = Callable[..., str]  # (argv, stdin, cwd=None) -> stdout
READ_ONLY_TOOLS = "Read,Grep,Glob"


class JudgeError(RuntimeError):
    cost_usd: float = 0.0


@dataclass(frozen=True)
class Verdict:
    decision: str  # approved | rejected
    spec_match: bool
    scope_creep: bool
    reasons: tuple[str, ...]
    unverified: tuple[str, ...] = ()  # findings the model is unsure of; notes when they do not block
    cost_usd: float = 0.0  # what the model call cost, from claude's total_cost_usd
    partial: bool = False  # the model saw a reduced diff: the code never lets such a PR auto-merge

    @property
    def approved(self) -> bool:
        return self.decision == "approved"

    def note(self) -> str:
        return "; ".join(self.reasons)

    def comment_markdown(self) -> str:
        bullets = "\n".join(f"- {r}" for r in self.reasons)
        notes = "\n".join(f"- {n}" for n in self.unverified)
        notes_md = f"\n\nUnverified notes (not verified, did not block):\n{notes}" if self.unverified else ""
        return (
            f"**Fractory judge: {self.decision}**\n\n"
            f"spec match: {self.spec_match} · scope creep: {self.scope_creep}\n\n{bullets}{notes_md}"
            + (f"\n\n{PARTIAL_NOTE}" if self.partial else "")
        )

    def comment_html(self) -> str:
        items = "".join(f"<li>{escape(r)}</li>" for r in self.reasons)
        notes = "".join(f"<li>{escape(n)}</li>" for n in self.unverified)
        notes_html = f"<p>Unverified notes (not verified, did not block):</p><ul>{notes}</ul>" if notes else ""
        return (
            f"<p><strong>Fractory judge: {self.decision}</strong></p>"
            f"<p>spec match: {self.spec_match} · scope creep: {self.scope_creep}</p><ul>{items}</ul>{notes_html}"
            + (f"<p>{escape(PARTIAL_NOTE)}</p>" if self.partial else "")
        )


PARTIAL_NOTE = "The diff was too large: the judge saw a reduced diff (large files truncated), so this PR needs a human merge review."


def _file_path(header: str) -> str:
    rest = header.removeprefix("diff --git ").rstrip("\n")
    return rest.rsplit(" b/", 1)[1] if " b/" in rest else rest


def _changed_lines(section: list[str]) -> int:
    return sum(1 for line in section if line[:1] in "+-" and not line.startswith(("+++", "---")))


def _is_generated(path: str, changed: int, extra: tuple[str, ...]) -> bool:
    parts = path.split("/")
    name = parts[-1]
    if any(d in GENERATED_DIRS for d in parts[:-1]):
        return True
    if any(fnmatch.fnmatchcase(name, pat) or fnmatch.fnmatchcase(path, pat) for pat in (*GENERATED_NAMES, *extra)):
        return True
    return name.endswith(".svg") and changed > BIG_SVG_LINES


def trim_diff(diff: str, extra_patterns: tuple[str, ...] | list[str] = ()) -> tuple[str, list[str]]:
    """Drop the bodies of generated files (lockfiles, minified, snapshots, build output) from a `gh pr diff`.

    Each dropped file becomes one stub line; every other file is kept byte for byte.
    Returns the trimmed diff and the dropped paths.
    """
    sections: list[list[str]] = []
    for line in diff.splitlines(keepends=True):
        if line.startswith("diff --git ") or not sections:
            sections.append([])
        sections[-1].append(line)
    out: list[str] = []
    dropped: list[str] = []
    extra = tuple(extra_patterns)
    for section in sections:
        if not section[0].startswith("diff --git "):
            out.extend(section)
            continue
        path = _file_path(section[0])
        changed = _changed_lines(section)
        if _is_generated(path, changed, extra):
            dropped.append(path)
            out.append(f"# {path}: generated file, {changed} lines changed, not shown\n")
        else:
            out.extend(section)
    return "".join(out), dropped


def _sections(diff: str) -> list[list[str]]:
    sections: list[list[str]] = []
    for line in diff.splitlines(keepends=True):
        if line.startswith("diff --git ") or not sections:
            sections.append([])
        sections[-1].append(line)
    return sections


def _is_binary(section: list[str]) -> bool:
    return any(line.startswith(("Binary files ", "GIT binary patch")) for line in section)


def reduce_diff(diff: str, max_chars: int) -> str:
    """Fit a diff into `max_chars`: stub binary files, cut each remaining file to an equal share, stub what is left.

    Called after `trim_diff` dropped generated files. The result carries a note on every cut, and is always <= max_chars.
    """
    sections = _sections(diff)
    kept: list[str] = []
    for section in sections:
        if section[0].startswith("diff --git ") and _is_binary(section):
            kept.append(f"# {_file_path(section[0])}: binary file, not shown\n")
        else:
            kept.append("".join(section))
    if sum(map(len, kept)) <= max_chars:
        return "".join(kept)
    share = max(MIN_FILE_CHARS, max_chars // max(len(kept), 1) - 100)
    cut = []
    for text in kept:
        if len(text) > share and text.startswith("diff --git "):
            path = _file_path(text.split("\n", 1)[0])
            text = f"{text[:share].rsplit(chr(10), 1)[0]}\n# {path}: truncated, {len(text) - share} chars not shown\n"
        cut.append(text)
    out: list[str] = []
    used = 0
    for i, text in enumerate(cut):
        if used + len(text) > max_chars - 200:
            omitted = [_file_path(t.split("\n", 1)[0]) for t in cut[i:] if t.startswith("diff --git ")]
            out.append(f"# {len(cut) - i} more sections not shown: {', '.join(omitted)}"[:200] + "\n")
            break
        out.append(text)
        used += len(text)
    return "".join(out)


def build_prompt(
    issue_title: str,
    issue_text: str,
    diff: str,
    brief: str | None = None,
    checks: Checks | None = None,
    dropped: list[str] | None = None,
    repo_access: bool = False,
    partial: bool = False,
) -> str:
    partial_section = (
        "PARTIAL DIFF\nThe diff was too large to show in full: binary files are stubbed and big files truncated "
        "(each cut is marked). You are judging part of the change; say in `unverified` what you could not see, and "
        "do not approve with more confidence than that allows.\n\n"
        if partial
        else ""
    )
    dropped_section = (
        "GENERATED FILES NOT SHOWN\nChanged in the PR, left out of the diff as generated:\n"
        + "\n".join(f"- {p}" for p in dropped)
        + "\n\n"
        if dropped
        else ""
    )
    brief_section = (
        "BRIEF\nThe detailed scope the worker was given. The issue is the goal; the brief says how far to go. "
        f"Scope creep means beyond both.\n{brief.strip()}\n\n"
        if brief and brief.strip()
        else ""
    )
    ci_section = (
        "CI RESULTS\nFacts from the PR's CI run, not guesses. Do not contradict them.\n"
        + "\n".join(f"- {name}: {conclusion}" for name, conclusion in checks)
        + "\n\n"
        if checks
        else ""
    )
    access_section = (
        "REPOSITORY ACCESS\nYour working directory is a checkout of the PR head, with read-only tools (Read, Grep, "
        "Glob). The diff shows only what changed: before rejecting for something missing, read the files outside the "
        "diff (imports, shared styles, helpers, config) to confirm the requirement is not already met there.\n\n"
        if repo_access
        else ""
    )
    return (
        "You are a strict code reviewer. Judge the diff against the issue using this rubric.\n\n"
        f"RUBRIC\n{RUBRIC}\n\n"
        f"ISSUE: {issue_title}\n{issue_text}\n\n"
        f"{brief_section}"
        f"{ci_section}"
        f"{dropped_section}"
        f"{partial_section}"
        f"{access_section}"
        f"DIFF\n{diff}\n\n"
        "Reply with ONLY a JSON object, no prose, in exactly this shape:\n"
        '{"decision": "approved" | "rejected", "spec_match": true | false, '
        '"scope_creep": true | false, "reasons": ["short reason", ...], "unverified": ["finding you could not verify", ...]}\n'
        "`reasons` must be non-empty. List a finding you are not sure of in `unverified` as well as in `reasons`; "
        "use `[]` when there is none."
    )


_FENCE = re.compile(r"```(?:json)?\s*(.*?)\s*```", re.DOTALL)


def ci_green(checks: Checks | None) -> bool:
    return bool(checks) and all(conclusion.upper() in PASSED for _, conclusion in checks)


def parse_verdict(text: str, checks: Checks | None = None) -> Verdict:
    """Validate the model's JSON and apply the two code rules.

    - approved with spec_match false or scope_creep true is downgraded to rejected;
    - rejected where every reason is also listed in `unverified` (the model guessed) is approved when CI is
      all green, spec_match is true and scope_creep is false; the guesses stay as notes in the comment.
      With red, pending or unknown CI it stays rejected.
    """
    body = text.strip()
    if m := _FENCE.fullmatch(body):
        body = m.group(1)
    try:
        data = json.loads(body)
    except json.JSONDecodeError as err:
        raise JudgeError(f"verdict is not JSON: {err}") from None
    if not isinstance(data, dict) or not KEYS <= set(data) <= KEYS | OPTIONAL_KEYS:
        raise JudgeError(f"verdict keys must be exactly {sorted(KEYS)} plus optional {sorted(OPTIONAL_KEYS)}")
    if data["decision"] not in ("approved", "rejected"):
        raise JudgeError(f"bad decision {data['decision']!r}")
    for key in ("spec_match", "scope_creep"):
        if not isinstance(data[key], bool):
            raise JudgeError(f"{key} must be a boolean")
    reasons = data["reasons"]
    if not isinstance(reasons, list) or not reasons or not all(isinstance(r, str) and r.strip() for r in reasons):
        raise JudgeError("reasons must be a non-empty list of non-empty strings")
    unverified = data.get("unverified", [])
    if not isinstance(unverified, list) or not all(isinstance(u, str) and u.strip() for u in unverified):
        raise JudgeError("unverified must be a list of non-empty strings")
    unverified = [u.strip() for u in unverified]
    decision = data["decision"]
    if (
        decision == "rejected"
        and unverified
        and all(r.strip() in unverified for r in reasons)
        and data["spec_match"]
        and not data["scope_creep"]
        and ci_green(checks)
    ):
        return Verdict("approved", True, False, tuple(r.strip() for r in reasons), tuple(unverified))
    if decision == "approved" and (not data["spec_match"] or data["scope_creep"]):
        decision = "rejected"
        reasons = [*reasons, "downgraded: approved with spec_match false or scope_creep true"]
    return Verdict(
        decision, data["spec_match"], data["scope_creep"], tuple(r.strip() for r in reasons), tuple(unverified)
    )


def run_claude(argv: list[str], stdin: str, cwd: str | None = None) -> str:
    try:
        return subprocess.run(
            argv, input=stdin, capture_output=True, text=True, check=True, timeout=CLAUDE_TIMEOUT_S, cwd=cwd
        ).stdout
    except (OSError, subprocess.SubprocessError) as err:
        raise JudgeError(f"claude failed: {err}") from None


def ask_model(prompt: str, runner: Runner | None = None, cwd: str | None = None) -> str:
    return ask_model_with_cost(prompt, runner, cwd)[0]


def ask_model_with_cost(prompt: str, runner: Runner | None = None, cwd: str | None = None) -> tuple[str, float]:
    """Run `claude -p`. With a `cwd` (a checkout of the PR head) the model gets read-only tools there."""
    argv = ["claude", "-p", "--model", "opus", "--output-format", "json"]
    if cwd:
        argv += ["--allowedTools", READ_ONLY_TOOLS]
    out = (runner or run_claude)(argv, prompt, cwd=cwd) if cwd else (runner or run_claude)(argv, prompt)
    try:
        data = json.loads(out)
        result = data["result"]
    except (json.JSONDecodeError, KeyError, TypeError):
        raise JudgeError("claude output has no JSON 'result' field") from None
    if data.get("is_error") or not isinstance(result, str):
        raise JudgeError(f"claude reported an error: {str(result)[:200]}")
    cost = data.get("total_cost_usd")
    usable = isinstance(cost, (int, float)) and not isinstance(cost, bool) and cost > 0
    return result, float(cost) if usable else 0.0


def check_brief_size(brief: str | None) -> None:
    if brief is not None and len(brief) > MAX_BRIEF_CHARS:
        raise JudgeError("brief too large")


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


def judge_diff(
    issue_title: str,
    issue_html: str,
    diff: str,
    runner: Runner | None = None,
    brief: str | None = None,
    checks: Checks | None = None,
    generated: list[str] | None = None,
    checkout: str | None = None,
    max_diff_chars: int = MAX_DIFF_CHARS,
) -> Verdict:
    """Trim generated files, reduce a diff over `max_diff_chars`, prompt, model, parse.

    Raises JudgeError before any model call only if the brief is too big. A reduced diff marks the verdict `partial`.
    """
    diff, dropped = trim_diff(diff, generated or ())
    partial = len(diff) > max_diff_chars
    if partial:
        diff = reduce_diff(diff, max_diff_chars)
    check_brief_size(brief)
    prompt = build_prompt(
        issue_title, html_to_text(issue_html), diff, brief, checks, dropped, repo_access=bool(checkout), partial=partial
    )
    text, cost = ask_model_with_cost(prompt, runner, checkout)
    try:
        verdict = parse_verdict(text, checks)
    except JudgeError as err:
        err.cost_usd = cost  # the call was paid for even though the verdict is unusable
        raise
    return replace(verdict, cost_usd=cost, partial=partial)


@contextlib.contextmanager
def pr_checkout(repo: str, pr: str) -> Iterator[str]:
    """A temporary detached git worktree of the PR head, removed on exit.

    Always the PR head from GitHub, so it works when the worker's own worktree is gone or holds unpushed commits.
    """
    tmp = tempfile.mkdtemp(prefix="fractory-judge-")
    path = str(Path(tmp) / "pr")
    try:
        for args in (
            ["fetch", "--quiet", "origin", f"pull/{pr}/head"],
            ["worktree", "add", "--quiet", "--detach", path, "FETCH_HEAD"],
        ):
            subprocess.run(["git", "-C", repo, *args], capture_output=True, text=True, check=True, timeout=120)
        yield path
    except (OSError, subprocess.SubprocessError) as err:
        raise JudgeError(f"cannot check out PR {pr}: {err}") from None
    finally:
        subprocess.run(["git", "-C", repo, "worktree", "remove", "--force", path], check=False, capture_output=True)
        shutil.rmtree(tmp, ignore_errors=True)
