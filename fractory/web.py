"""`fractory serve`: the factory board in a browser. Read-only, stdlib only.

GET /            the page (fractory/web/index.html)
GET /api/jobs    dash_data() plus tracker_url and pr_url per job
GET /api/jobs/<id>  one job: Job.to_dict() plus pr_url, tracker_url and the judge verdicts (404 if unknown)
GET /api/events  Server-Sent Events: `event: jobs` whenever a state.json changes, `: ping` every 15 s
"""

from __future__ import annotations

import json
import re
import subprocess
import time
from functools import lru_cache
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from . import cli, store
from .trackers.plane import DEFAULT_URL, DEFAULT_WORKSPACE

INDEX = Path(__file__).parent / "web" / "index.html"
POLL_SECONDS = 2.0
PING_SECONDS = 15.0


def plane_issue_url(tracker: dict) -> str | None:
    """Same URL shape `Plane.create_item` returns; falls back to the project when the job has no issue ref."""
    if tracker.get("kind") != "plane" or not tracker.get("project"):
        return None
    base = (tracker.get("url") or DEFAULT_URL).rstrip("/")
    project = f"{base}/{DEFAULT_WORKSPACE}/projects/{tracker['project']}"
    return f"{project}/issues/{tracker['ref']}" if tracker.get("ref") else f"{project}/issues"


def github_url(remote: str) -> str | None:
    """`git@github.com:o/r.git` or `https://github.com/o/r(.git)` -> `https://github.com/o/r`."""
    m = re.match(
        r"^(?:git@github\.com:|(?:ssh://git@|https?://)(?:[^@/]+@)?github\.com[:/])(.+?)(?:\.git)?/?$", remote.strip()
    )
    return f"https://github.com/{m.group(1)}" if m else None


@lru_cache(maxsize=64)
def repo_github_url(repo: str) -> str | None:
    try:
        out = subprocess.run(
            ["git", "remote", "get-url", "origin"], cwd=repo, capture_output=True, text=True, check=True, timeout=5
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    return github_url(out)


def jobs_payload() -> dict:
    data = cli.dash_data()
    by_id = {j.id: j for j in store.all_jobs()}
    for item in data["jobs"]:
        job = by_id.get(item["id"])
        if job is None:
            continue
        base = repo_github_url(job.repo) if item["pr"] else None
        item["pr_url"] = f"{base}/pull/{item['pr']}" if base else None
        item["tracker_url"] = plane_issue_url(job.tracker)
        item["gate_detail"] = job.gate.detail if job.gate else None
    return data


def job_payload(job_id: str) -> dict | None:
    """Full job state for the detail panel; None for an unknown or malformed id."""
    try:
        job = store.load(job_id)
    except (FileNotFoundError, ValueError):
        return None
    data = job.to_dict()
    pr = job.links.get("pr")
    base = repo_github_url(job.repo) if pr else None
    data["pr_url"] = f"{base}/pull/{pr}" if base else None
    data["tracker_url"] = plane_issue_url(job.tracker)
    # the Judge writes its reasons joined with "; " as the note of approved/rejected; `sync` and gates use other notes
    data["verdicts"] = [
        {"at": e["at"], "decision": e["event"], "reasons": e["note"].split("; ")}
        for e in job.history
        if e["event"] in ("approved", "rejected") and e.get("note") and e["note"] != "sync"
    ]
    return data


def _mtimes() -> dict[str, float]:
    out = {}
    for p in store.jobs_dir().glob("*/state.json"):
        try:
            out[str(p)] = p.stat().st_mtime_ns
        except OSError:  # removed between glob and stat
            pass
    return out


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args) -> None:  # quiet
        pass

    def _send(self, status: int, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        path = self.path.split("?", 1)[0]
        if path == "/":
            self._send(HTTPStatus.OK, INDEX.read_bytes(), "text/html; charset=utf-8")
        elif path == "/api/jobs":
            body = json.dumps(jobs_payload(), ensure_ascii=False).encode()
            self._send(HTTPStatus.OK, body, "application/json; charset=utf-8")
        elif path.startswith("/api/jobs/"):
            data = job_payload(path.removeprefix("/api/jobs/"))
            if data is None:
                self._send(HTTPStatus.NOT_FOUND, b"not found", "text/plain; charset=utf-8")
            else:
                self._send(
                    HTTPStatus.OK, json.dumps(data, ensure_ascii=False).encode(), "application/json; charset=utf-8"
                )
        elif path == "/api/events":
            self._events()
        else:
            self._send(HTTPStatus.NOT_FOUND, b"not found", "text/plain; charset=utf-8")

    def _events(self) -> None:
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        seen: dict[str, float] | None = None
        last_ping = time.monotonic()
        try:
            while True:
                current = _mtimes()
                if current != seen:  # first pass sends the snapshot so a new page needs no extra fetch
                    seen = current
                    payload = json.dumps(jobs_payload(), ensure_ascii=False)
                    self.wfile.write(f"event: jobs\ndata: {payload}\n\n".encode())
                    self.wfile.flush()
                    last_ping = time.monotonic()
                elif time.monotonic() - last_ping >= PING_SECONDS:
                    self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
                    last_ping = time.monotonic()
                time.sleep(POLL_SECONDS)
        except (BrokenPipeError, ConnectionResetError, OSError):
            return


class Server(ThreadingHTTPServer):
    daemon_threads = True


HOST = "127.0.0.1"  # local only: the board shows job state and links, never meant for the network
DEFAULT_PORT = 8777  # 8765 is taken by the Cortadas API on the same Mac


def make_server(port: int = DEFAULT_PORT) -> Server:
    return Server((HOST, port), Handler)


def serve(port: int) -> int:
    server = make_server(port)
    print(f"fractory board on http://{HOST}:{server.server_address[1]}  (ctrl-c to stop)", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("serve stopped")
    finally:
        server.server_close()
    return 0
