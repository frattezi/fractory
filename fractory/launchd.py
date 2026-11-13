"""Keep `fractory watch` running as a macOS LaunchAgent, across reboots and closed sessions."""

from __future__ import annotations

import os
import plistlib
import shutil
import subprocess
import sys
from pathlib import Path

LABEL = "com.fractory.watch"
REPO_ROOT = Path(__file__).resolve().parents[1]


def agent_path() -> Path:
    return Path.home() / "Library" / "LaunchAgents" / f"{LABEL}.plist"


def plist_bytes(python: str, repo_root: Path, log: Path, path_env: str, every: float) -> bytes:
    return plistlib.dumps(
        {
            "Label": LABEL,
            "ProgramArguments": [python, "-m", "fractory", "watch", "--every", str(every)],
            "WorkingDirectory": str(repo_root),
            "EnvironmentVariables": {"PATH": path_env, "PYTHONPATH": str(repo_root), "PYTHONUNBUFFERED": "1"},
            "RunAtLoad": True,
            "KeepAlive": True,
            "ThrottleInterval": 30,
            "StandardOutPath": str(log),
            "StandardErrorPath": str(log),
        }
    )


def _path_env() -> str:
    # gh must be reachable: launchd starts agents with a bare PATH.
    dirs = [str(Path(p).parent) for p in (shutil.which("gh"), sys.executable) if p]
    dirs += ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]
    return ":".join(dict.fromkeys(dirs))


def install(log: Path, every: float = 60.0) -> Path:
    path = agent_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    log.parent.mkdir(parents=True, exist_ok=True)
    uninstall()
    path.write_bytes(plist_bytes(sys.executable, REPO_ROOT, log, _path_env(), every))
    subprocess.run(["launchctl", "bootstrap", f"gui/{os.getuid()}", str(path)], check=True)
    return path


def uninstall() -> bool:
    path = agent_path()
    if not path.exists():
        return False
    subprocess.run(["launchctl", "bootout", f"gui/{os.getuid()}", str(path)], check=False, capture_output=True)
    path.unlink()
    return True
