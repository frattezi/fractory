"""Self-reload: a LaunchAgent exits when `main` has moved, and launchd KeepAlive restarts it on new code."""

from __future__ import annotations

import subprocess
from collections.abc import Callable
from pathlib import Path

Git = Callable[..., str]


def run_git(repo_root: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(repo_root), *args], check=True, capture_output=True, text=True, timeout=60
    ).stdout.strip()


def main_moved(repo_root: Path, git: Git | None = None) -> bool:
    """True when origin/main is ahead of a clean checkout of `main`. Any git error means False."""
    git = git or run_git
    try:
        if git(repo_root, "rev-parse", "--abbrev-ref", "HEAD") != "main":
            return False
        if git(repo_root, "status", "--porcelain"):
            return False
        git(repo_root, "fetch", "-q", "origin", "main")
        return git(repo_root, "rev-parse", "HEAD") != git(repo_root, "rev-parse", "origin/main")
    except (OSError, subprocess.SubprocessError) as err:
        print(f"reload: git failed, not reloading: {err}", flush=True)
        return False


def fast_forward(repo_root: Path, git: Git | None = None) -> str | None:
    """Fast-forward to origin/main; the new short sha, or None when git refuses."""
    git = git or run_git
    try:
        git(repo_root, "merge", "--ff-only", "origin/main")
        return git(repo_root, "rev-parse", "--short", "HEAD")
    except (OSError, subprocess.SubprocessError) as err:
        print(f"reload: fast-forward failed: {err}", flush=True)
        return None


def pull_if_moved(repo_root: Path, git: Git | None = None) -> str | None:
    """The new sha when main moved and the checkout was fast-forwarded, else None."""
    return fast_forward(repo_root, git) if main_moved(repo_root, git) else None
