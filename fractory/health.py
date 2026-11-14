"""Snapshots the watch leaves for the board: heartbeat.json (is the factory alive?) and queue.json (why do cards wait?).

Files live in $FACTORY_HOME and are written atomically, so a reader never sees a half-written file.
"""

from __future__ import annotations

import json
import os
import subprocess
import time
from datetime import UTC, datetime
from pathlib import Path

from . import store

ALIVE_FACTOR = 3  # alive = the last cycle ended less than this many `--every` ago
ERROR_MARKS = ("sync error", "intake error", "cleanup error", "launch failed")
RATE_LIMIT_MARK = "rate limited, backing off"
KEPT_ERROR_LINES = 10


def now_iso() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def write_json(name: str, data: dict) -> None:
    path = store.factory_home() / name
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2))
    os.replace(tmp, path)


def read_json(name: str) -> dict:
    try:
        return json.loads((store.factory_home() / name).read_text())
    except (OSError, ValueError):
        return {"missing": True}


def code_sha(repo_root: Path) -> str | None:
    try:
        return subprocess.run(
            ["git", "-C", str(repo_root), "rev-parse", "HEAD"], capture_output=True, text=True, check=True, timeout=10
        ).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return None


class Heartbeat:
    """Tee for stdout: counts the error and rate-limit lines of the current cycle, then writes heartbeat.json."""

    def __init__(self, out, every: float, repo_root: Path) -> None:
        self._out = out
        self.every = every
        self.pid = os.getpid()
        self.started_at = now_iso()
        self.sha = code_sha(repo_root)
        self.cycles = 0
        self._partial = ""
        self._begin()

    def _begin(self) -> None:
        self._t0 = time.monotonic()
        self._cycle_started = now_iso()
        self._errors: dict[str, int] = dict.fromkeys(ERROR_MARKS, 0)
        self._backoffs = 0
        self._lines: list[str] = []

    def write(self, text: str) -> int:
        self._out.write(text)
        *whole, self._partial = (self._partial + text).split("\n")
        for line in whole:
            self._see(line)
        return len(text)

    def _see(self, line: str) -> None:
        if RATE_LIMIT_MARK in line:
            self._backoffs += 1
        mark = next((m for m in ERROR_MARKS if m in line), None)
        if mark:
            self._errors[mark] += 1
            self._lines.append(line)

    def end_cycle(self) -> None:
        """Called after each cycle: write the snapshot and start counting the next one."""
        self.cycles += 1
        write_json(
            "heartbeat.json",
            {
                "cycle_started_at": self._cycle_started,
                "cycle_ended_at": now_iso(),
                "duration_seconds": round(time.monotonic() - self._t0, 2),
                "cycles": self.cycles,
                "every": self.every,
                "pid": self.pid,
                "started_at": self.started_at,
                "code_sha": self.sha,
                "errors": {m.replace(" ", "_"): n for m, n in self._errors.items()},
                "rate_limit_backoffs": self._backoffs,
                "last_errors": self._lines[-KEPT_ERROR_LINES:],
            },
        )
        self._begin()

    def __getattr__(self, name: str):
        return getattr(self._out, name)


def with_alive(beat: dict, now: datetime | None = None) -> dict:
    """The heartbeat plus `alive`: it ended less than 3x `every` ago. A missing heartbeat stays `{"missing": true}`."""
    if beat.get("missing"):
        return beat
    try:
        ended = datetime.strptime(beat["cycle_ended_at"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=UTC)
        age = ((now or datetime.now(UTC)) - ended).total_seconds()
        alive = age < ALIVE_FACTOR * float(beat["every"])
    except (KeyError, TypeError, ValueError):
        age, alive = None, False
    return {**beat, "alive": alive, "age_seconds": age}
