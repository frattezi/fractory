"""Keep `fractory watch` and `fractory serve` running as macOS LaunchAgents, across reboots and closed sessions."""

from __future__ import annotations

import os
import plistlib
import shutil
import subprocess
import sys
from collections.abc import Mapping
from pathlib import Path

LABEL = "com.fractory.watch"
REPO_ROOT = Path(__file__).resolve().parents[1]


def label(name: str) -> str:
    return f"com.fractory.{name}"


def agent_path(name: str = "watch") -> Path:
    return Path.home() / "Library" / "LaunchAgents" / f"{label(name)}.plist"


# The only variables copied from the installer into the agent: where Orca's runtime lives. Never tokens or keys.
ORCA_ENV = ("ORCA_USER_DATA_PATH", "ORCA_CLI_COMMAND")


def orca_env(environ: Mapping[str, str] | None = None) -> dict[str, str]:
    environ = os.environ if environ is None else environ
    return {key: environ[key] for key in ORCA_ENV if environ.get(key)}


def plist_bytes(
    name: str,
    python: str,
    repo_root: Path,
    log: Path,
    path_env: str,
    args: list[str],
    extra_env: Mapping[str, str] | None = None,
) -> bytes:
    return plistlib.dumps(
        {
            "Label": label(name),
            "ProgramArguments": [python, "-m", "fractory", name, *args],
            "WorkingDirectory": str(repo_root),
            "EnvironmentVariables": {
                **(extra_env or {}),
                "PATH": path_env,
                "PYTHONPATH": str(repo_root),
                "PYTHONUNBUFFERED": "1",
            },
            "RunAtLoad": True,
            "KeepAlive": True,
            "ThrottleInterval": 30,
            "StandardOutPath": str(log),
            "StandardErrorPath": str(log),
        }
    )


# CLIs watch shells out to: gh (PRs, CI), git, claude (the Judge).
TOOLS = ("gh", "git", "claude")


def path_env(which=None, python: str | None = None) -> str:
    """launchd starts agents with a bare PATH: put every tool watch needs on it, found where the installer sees them."""
    which = which or shutil.which
    found = [which(tool) for tool in TOOLS] + [python or sys.executable]
    dirs = [str(Path(p).parent) for p in found if p]
    dirs += [str(Path.home() / ".local" / "bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]
    return ":".join(dict.fromkeys(dirs))


def install(name: str, args: list[str], log: Path, environ: Mapping[str, str] | None = None) -> Path:
    env = orca_env(environ)
    if "ORCA_USER_DATA_PATH" not in env:
        print(
            "warning: ORCA_USER_DATA_PATH is not set, so the rework hook will not reach workers "
            "(`orca` answers runtime_unavailable under launchd). Install the agents from an Orca terminal.",
            file=sys.stderr,
        )
    path = agent_path(name)
    path.parent.mkdir(parents=True, exist_ok=True)
    log.parent.mkdir(parents=True, exist_ok=True)
    uninstall(name)
    path.write_bytes(plist_bytes(name, sys.executable, REPO_ROOT, log, path_env(), args, env))
    subprocess.run(["launchctl", "bootstrap", f"gui/{os.getuid()}", str(path)], check=True)
    return path


def uninstall(name: str) -> bool:
    path = agent_path(name)
    if not path.exists():
        return False
    subprocess.run(["launchctl", "bootout", f"gui/{os.getuid()}", str(path)], check=False, capture_output=True)
    path.unlink()
    return True
