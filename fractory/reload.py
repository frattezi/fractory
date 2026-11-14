"""Self-reload: a LaunchAgent exits when `main` has moved, and launchd KeepAlive restarts it on new code."""

from __future__ import annotations

import re
import subprocess
from collections.abc import Callable
from pathlib import Path

Git = Callable[..., str]


def run_git(repo_root: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(repo_root), *args], check=True, capture_output=True, text=True, timeout=60
    ).stdout.strip()


def https_remote(url: str) -> str:
    """https://github.com/<owner>/<repo>.git for an SSH or HTTPS GitHub remote URL."""
    match = re.fullmatch(
        r"(?:git@github\.com:|ssh://git@github\.com/|https://github\.com/)([^/]+)/([^/]+?)(?:\.git)?/?", url.strip()
    )
    if not match:
        raise ValueError(f"not a GitHub remote: {url}")
    return f"https://github.com/{match[1]}/{match[2]}.git"


def fetch_main(repo_root: Path, git: Git) -> None:
    """Fetch main into FETCH_HEAD over HTTPS with gh credentials; launchd has no SSH agent."""
    url = https_remote(git(repo_root, "remote", "get-url", "origin"))
    git(
        repo_root,
        "-c",
        "credential.helper=",
        "-c",
        "credential.helper=!gh auth git-credential",
        "fetch",
        "-q",
        url,
        "main",
    )


def describe(err: Exception) -> str:
    stderr = getattr(err, "stderr", None)
    return " ".join(str(stderr).split()) if stderr else str(err)


def main_moved(repo_root: Path, git: Git | None = None) -> bool:
    """True when remote main is ahead of a clean checkout of `main`. Any git error means False."""
    git = git or run_git
    try:
        if git(repo_root, "rev-parse", "--abbrev-ref", "HEAD") != "main":
            return False
        if git(repo_root, "status", "--porcelain"):
            return False
        fetch_main(repo_root, git)
        return git(repo_root, "rev-parse", "HEAD") != git(repo_root, "rev-parse", "FETCH_HEAD")
    except (OSError, subprocess.SubprocessError, ValueError) as err:
        print(f"reload: git failed, not reloading: {describe(err)}", flush=True)
        return False


def fast_forward(repo_root: Path, git: Git | None = None) -> str | None:
    """Fast-forward to FETCH_HEAD (set by main_moved); the new short sha, or None when git refuses."""
    git = git or run_git
    try:
        git(repo_root, "merge", "--ff-only", "FETCH_HEAD")
        return git(repo_root, "rev-parse", "--short", "HEAD")
    except (OSError, subprocess.SubprocessError) as err:
        print(f"reload: fast-forward failed: {describe(err)}", flush=True)
        return None


def pull_if_moved(repo_root: Path, git: Git | None = None) -> str | None:
    """The new sha when main moved and the checkout was fast-forwarded, else None."""
    return fast_forward(repo_root, git) if main_moved(repo_root, git) else None
