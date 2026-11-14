"""Risk of a PR's diff, from its files alone. Pure: no I/O, no model. Decides if `sync` may auto-merge."""

from __future__ import annotations

import tomllib
from dataclasses import dataclass
from pathlib import Path

SENSITIVE = ("auth", "secret", "migrat", "schema", "infra/", ".github/", "fractory/rubric.md", "fractory/launchd.py")
MAX_LINES = 400
MAX_FILES = 12


@dataclass(frozen=True)
class Risk:
    level: str  # low | medium | high
    reasons: tuple[str, ...]

    def summary(self) -> str:
        return f"{self.level}: {'; '.join(self.reasons) or 'small, no sensitive paths'}"


def repo_config(repo: str) -> dict:
    """The `[risk]` table of `<repo>/fractory.toml` (the local checkout); {} when absent or unreadable."""
    path = Path(repo).expanduser() / "fractory.toml"
    try:
        return tomllib.loads(path.read_text()).get("risk", {})
    except (OSError, tomllib.TOMLDecodeError):
        return {}


def assess(files: list[tuple[str, int, int]], config: dict | None = None, repo: dict | None = None) -> Risk:
    """high: a path matches a sensitive pattern. medium: too many lines or files. Otherwise low.

    `config` is the factory's `[risk]` table: `sensitive` (list of substrings), `max_lines`, `max_files`.
    `repo` is the repo's own `[risk]` table (`repo_config`): its `sensitive` extends the patterns, never replaces
    them; its `max_lines` / `max_files` override.
    """
    cfg = {**(config or {}), **{k: v for k, v in (repo or {}).items() if k in ("max_lines", "max_files")}}
    patterns = [p.lower() for p in [*cfg.get("sensitive", SENSITIVE), *(repo or {}).get("sensitive", [])]]
    max_lines = int(cfg.get("max_lines", MAX_LINES))
    max_files = int(cfg.get("max_files", MAX_FILES))

    sensitive = [
        f"sensitive path {path} (matches {p!r})" for path, _, _ in files for p in patterns if p in path.lower()
    ]
    if sensitive:
        return Risk("high", tuple(dict.fromkeys(sensitive)))
    reasons = []
    lines = sum(add + dele for _, add, dele in files)
    if lines > max_lines:
        reasons.append(f"{lines} lines changed (limit {max_lines})")
    if len(files) > max_files:
        reasons.append(f"{len(files)} files changed (limit {max_files})")
    return Risk("medium", tuple(reasons)) if reasons else Risk("low", ())


def reviews_merges(repo: str, config: dict | None = None) -> bool:
    """False for a repo listed in `[risk] no_merge_review`: its PRs merge at any risk level (risk is still recorded).

    For dev-only projects whose owner chose not to review merges, e.g. `no_merge_review = ["~/Factory/app"]`.
    """
    listed = (config or {}).get("no_merge_review", [])
    target = Path(repo).expanduser().resolve()
    return all(Path(r).expanduser().resolve() != target for r in listed)
