"""Per-worktree push guard: a worker's worktree refuses pushes to the default branch.

`git config --worktree core.hooksPath` points the worktree at $FACTORY_HOME/hooks. Every hook there is the same
dispatcher: it runs the repo's own hook of that name (the previous hooksPath, kept in the worktree config as
`fractory.chainHooksPath`), and pre-push first refuses `refs/heads/main|master`. The main checkout's config is
never written, only `extensions.worktreeConfig` (a repo-level switch that changes nothing for checkouts without a
config.worktree file).
"""

from __future__ import annotations

import subprocess
from pathlib import Path

from . import store

HOOKS = [
    "applypatch-msg",
    "pre-applypatch",
    "post-applypatch",
    "pre-commit",
    "pre-merge-commit",
    "prepare-commit-msg",
    "commit-msg",
    "post-commit",
    "pre-rebase",
    "post-checkout",
    "post-merge",
    "pre-push",
    "pre-auto-gc",
    "post-rewrite",
    "post-index-change",
]
CHAIN_KEY = "fractory.chainHooksPath"

SCRIPT = """#!/bin/sh
# Installed by fractory (guard.py). Do not edit: rewritten on every launch.
hook=$(basename "$0")
chain=$(git config --get fractory.chainHooksPath)
if [ "$hook" = pre-push ]; then
  input=$(cat)
  printf '%s\\n' "$input" | while read -r _ _ remote_ref _; do
    case "$remote_ref" in
      refs/heads/main|refs/heads/master)
        echo "fractory: pushing to ${remote_ref#refs/heads/} is blocked in a worker worktree." >&2
        echo "Push your job branch and open a pull request instead." >&2
        exit 1;;
    esac
  done || exit 1
  if [ -n "$chain" ] && [ -x "$chain/pre-push" ]; then
    printf '%s\\n' "$input" | "$chain/pre-push" "$@" || exit $?
  fi
  exit 0
fi
if [ -n "$chain" ] && [ -x "$chain/$hook" ]; then exec "$chain/$hook" "$@"; fi
exit 0
"""


class GuardError(RuntimeError):
    pass


def hooks_dir() -> Path:
    return store.factory_home() / "hooks"


def _git(path: Path, *args: str, check: bool = True) -> str:
    proc = subprocess.run(["git", "-C", str(path), *args], capture_output=True, text=True, check=False)
    if check and proc.returncode != 0:
        raise GuardError(f"git {' '.join(args)}: {(proc.stdout + proc.stderr).strip()[:200]}")
    return proc.stdout.strip()


def write_hooks() -> Path:
    directory = hooks_dir()
    directory.mkdir(parents=True, exist_ok=True)
    for name in HOOKS:
        hook = directory / name
        if not hook.is_file() or hook.read_text() != SCRIPT:
            hook.write_text(SCRIPT)
        hook.chmod(0o755)
    return directory


def worktree_path(worktree_id: str) -> Path:
    """Orca worktree ids are `<repo id>::<absolute path>`."""
    path = worktree_id.split("::", 1)[1] if "::" in worktree_id else ""
    if not path:
        raise GuardError(f"no path in worktree id: {worktree_id}")
    return Path(path)


def install(path: Path) -> None:
    """Guard the worktree at `path` (idempotent). Raises GuardError when it cannot."""
    if not path.is_dir():
        raise GuardError(f"no such worktree dir: {path}")
    ours = str(write_hooks())
    _git(path, "config", "extensions.worktreeConfig", "true")
    current = _git(path, "config", "--get", "core.hooksPath", check=False)
    if current != ours:
        if not current:
            common = _git(path, "rev-parse", "--path-format=absolute", "--git-common-dir")
            current = str(Path(common) / "hooks")
        elif not Path(current).is_absolute():
            current = str(Path(_git(path, "rev-parse", "--show-toplevel")) / current)
        _git(path, "config", "--worktree", CHAIN_KEY, current)
        _git(path, "config", "--worktree", "core.hooksPath", ours)
