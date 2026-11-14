"""Where jobs live: $FACTORY_HOME/jobs/<id>/state.json (default ~/.factory). Never inside a repo."""

from __future__ import annotations

import contextlib
import fcntl
import json
import os
import re
import tomllib
from collections.abc import Generator
from pathlib import Path

from .state import Job


def factory_home() -> Path:
    return Path(os.environ.get("FACTORY_HOME", Path.home() / ".factory"))


def jobs_dir() -> Path:
    return factory_home() / "jobs"


def job_dir(job_id: str) -> Path:
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]*", job_id):
        raise ValueError(f"bad job id {job_id!r}")
    return jobs_dir() / job_id


def brief(job_id: str) -> str | None:
    """The worker's brief (`jobs/<id>/brief.md`), or None when the job has none."""
    path = job_dir(job_id) / "brief.md"
    return path.read_text() if path.is_file() else None


def repo_kind(repo: Path) -> str:
    """Able repos (work) stop at a draft PR; everything else is internal."""
    able = Path(os.environ.get("FRACTORY_ABLE_ROOT", Path.home() / "Factory" / "Able")).resolve()
    return "able" if repo.resolve().is_relative_to(able) else "internal"


def slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-") or "repo"


def next_job_id(repo: Path) -> str:
    prefix = slug(repo.name)
    used = [
        int(m.group(1))
        for p in jobs_dir().glob(f"{prefix}-*")
        if (m := re.fullmatch(re.escape(prefix) + r"-(\d+)", p.name))
    ]
    return f"{prefix}-{max(used, default=0) + 1:04d}"


def save(job: Job) -> Path:
    d = job_dir(job.id)
    (d / "holdout").mkdir(parents=True, exist_ok=True)
    path = d / "state.json"
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(job.to_dict(), indent=2, ensure_ascii=False) + "\n")
    os.replace(tmp, path)
    return path


def load(job_id: str) -> Job:
    path = job_dir(job_id) / "state.json"
    if not path.exists():
        raise FileNotFoundError(f"no job {job_id} ({path})")
    return Job.from_dict(json.loads(path.read_text()))


def all_jobs() -> list[Job]:
    if not jobs_dir().exists():
        return []
    return [load(p.parent.name) for p in sorted(jobs_dir().glob("*/state.json"))]


@contextlib.contextmanager
def locked(job_id: str) -> Generator[None]:
    """Serialise read-modify-write of one job between the CLI and the supervisor."""
    d = job_dir(job_id)
    d.mkdir(parents=True, exist_ok=True)
    with open(d / ".lock", "w") as fh:
        fcntl.flock(fh, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(fh, fcntl.LOCK_UN)


def config() -> dict:
    """$FACTORY_HOME/config.toml, e.g. `auto_merge = true`. Missing file: defaults."""
    path = factory_home() / "config.toml"
    return tomllib.loads(path.read_text()) if path.exists() else {}
