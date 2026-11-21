"""Self-reload: a LaunchAgent exits when `main` has moved, and launchd KeepAlive restarts it on new code."""

from __future__ import annotations

import re
import subprocess
from collections.abc import Callable
from pathlib import Path

from . import store

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


def runtime_root() -> Path:
    """The checkout the LaunchAgents run from. Only the reloader touches it, so it is always reset, never merged."""
    return store.factory_home() / "runtime"


def is_runtime(repo_root: Path) -> bool:
    return repo_root.resolve() == runtime_root().resolve()


def ensure_runtime(source_root: Path, git: Git | None = None) -> Path:
    """Clone origin of `source_root` into the runtime checkout when missing, at origin/main. Idempotent."""
    git = git or run_git
    target = runtime_root()
    if not (target / ".git").exists():
        url = https_remote(git(source_root, "remote", "get-url", "origin"))
        target.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(
            ["git", "-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential",
             "clone", "-q", "--branch", "main", url, str(target)],
            check=True, capture_output=True, text=True, timeout=300,
        )  # fmt: skip
    return target


def main_moved(repo_root: Path, git: Git | None = None) -> bool:
    """True when remote main is ahead of the checkout. A dev checkout must be clean and on `main`; the runtime
    checkout is the reloader's own, so local state never blocks it. Any git error means False."""
    git = git or run_git
    try:
        if is_runtime(repo_root):
            fetch_main(repo_root, git)
            return git(repo_root, "rev-parse", "HEAD") != git(repo_root, "rev-parse", "FETCH_HEAD")
        branch = git(repo_root, "rev-parse", "--abbrev-ref", "HEAD")
        if branch != "main":
            print(f"reload: skipped, checkout is on {branch}, not main", flush=True)
            return False
        if git(repo_root, "status", "--porcelain"):
            print("reload: skipped, checkout has uncommitted changes", flush=True)
            return False
        fetch_main(repo_root, git)
        return git(repo_root, "rev-parse", "HEAD") != git(repo_root, "rev-parse", "FETCH_HEAD")
    except (OSError, subprocess.SubprocessError, ValueError) as err:
        print(f"reload: git failed, not reloading: {describe(err)}", flush=True)
        return False


def fast_forward(repo_root: Path, git: Git | None = None) -> str | None:
    """Move to FETCH_HEAD (set by main_moved): reset --hard in the runtime checkout, fast-forward in a dev one.
    The new short sha, or None when git refuses (logged; the next cycle retries)."""
    git = git or run_git
    try:
        if is_runtime(repo_root):
            git(repo_root, "reset", "--hard", "-q", "FETCH_HEAD")
        else:
            git(repo_root, "merge", "--ff-only", "FETCH_HEAD")
        return git(repo_root, "rev-parse", "--short", "HEAD")
    except (OSError, subprocess.SubprocessError) as err:
        print(f"reload: update failed, retrying next cycle: {describe(err)}", flush=True)
        return None


def pull_if_moved(repo_root: Path, git: Git | None = None) -> str | None:
    """The new sha when main moved and the checkout was fast-forwarded, else None."""
    return fast_forward(repo_root, git) if main_moved(repo_root, git) else None
