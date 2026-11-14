"""Spec import against a fake Plane API served over real HTTP."""

from __future__ import annotations

import contextlib
import io
import json
import os
import re
import tempfile
import threading
import unittest
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import ClassVar
from unittest import mock

from fractory import cli, specs_import
from fractory.trackers.plane import Plane, PlaneError

KEY = "test-key"
PROJECT = "11111111-1111-1111-1111-111111111111"
STATES = [
    {"id": "s-backlog", "group": "backlog", "sequence": 1},
    {"id": "s-todo", "group": "unstarted", "sequence": 2},
    {"id": "s-doing", "group": "started", "sequence": 3},
    {"id": "s-done", "group": "completed", "sequence": 4},
    {"id": "s-cancel", "group": "cancelled", "sequence": 5},
]


class FakePlane(BaseHTTPRequestHandler):
    issues: ClassVar[list[dict]] = []
    projects: ClassVar[list[dict]] = []
    patches: ClassVar[list[tuple[str, dict]]] = []
    comments: ClassVar[list[tuple[str, dict]]] = []
    labels: ClassVar[list[dict]] = []
    posts: ClassVar[list[str]] = []
    reject_project_patch: ClassVar[bool] = False
    page_size: ClassVar[int] = 100

    def log_message(self, format: str, *args: object) -> None:  # keep test output quiet
        pass

    def _send(self, code: int, body: object) -> None:
        raw = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _authed(self) -> bool:
        if self.headers.get("X-Api-Key") != KEY:
            self._send(401, {"detail": "bad key"})
            return False
        return True

    def do_GET(self) -> None:
        if not self._authed():
            return
        base = "/api/v1/workspaces/cortadas"
        if self.path == f"{base}/projects/":
            self._send(200, {"results": self.projects})
        elif self.path == f"{base}/projects/{PROJECT}/states/":
            self._send(200, {"results": STATES})
        elif re.fullmatch(f"{base}/projects/[^/]+/labels/", self.path):
            self._send(200, {"results": self.labels})
        elif m := re.fullmatch(f"{base}/projects/{PROJECT}/issues/\\?expand=state(?:&cursor=(\\d+))?", self.path):
            start = int(m.group(1) or 0)
            groups = {s["id"]: s for s in STATES}
            page = [{**i, "state": groups.get(i.get("state"), i.get("state"))} for i in self.issues]
            end = start + self.page_size
            more = end < len(page)
            self._send(
                200,
                {"results": page[start:end], "next_page_results": more, "next_cursor": str(end) if more else ""},
            )
        elif m := re.fullmatch(f"{base}/projects/{PROJECT}/issues/([^/]+)/", self.path):
            issue = next((i for i in self.issues if i["id"] == m.group(1)), None)
            self._send(200, issue) if issue else self._send(404, {"detail": "no issue"})
        else:
            self._send(404, {"detail": "not found"})

    def do_POST(self) -> None:
        if not self._authed():
            return
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.posts.append(self.path)
        if self.path == "/api/v1/workspaces/cortadas/projects/":
            project = {**body, "id": str(uuid.uuid4())}
            self.projects.append(project)
            self._send(201, project)
        elif self.path == f"/api/v1/workspaces/cortadas/projects/{PROJECT}/issues/":
            for issue in self.issues:
                if issue["external_id"] == body["external_id"] and issue["external_source"] == body["external_source"]:
                    self._send(409, {"error": "exists", "id": issue["id"]})
                    return
            issue = {**body, "id": str(uuid.uuid4()), "sequence_id": len(self.issues) + 1}
            self.issues.append(issue)
            self._send(201, issue)
        elif re.fullmatch("/api/v1/workspaces/cortadas/projects/[^/]+/labels/", self.path):
            label = {**body, "id": str(uuid.uuid4())}
            self.labels.append(label)
            self._send(201, label)
        elif re.fullmatch(f"/api/v1/workspaces/cortadas/projects/{PROJECT}/issues/[^/]+/comments/", self.path):
            self.comments.append((self.path, body))
            self._send(201, body)
        else:
            self._send(404, {"detail": "not found"})

    def do_PATCH(self) -> None:
        if not self._authed():
            return
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.patches.append((self.path, body))
        if m := re.fullmatch("/api/v1/workspaces/cortadas/projects/[^/]+/labels/([^/]+)/", self.path):
            label = next(lb for lb in self.labels if lb["id"] == m.group(1))
            label.update(body)
        elif self.reject_project_patch and re.fullmatch("/api/v1/workspaces/cortadas/projects/[^/]+/", self.path):
            self._send(400, {"error": "unknown field"})
            return
        self._send(200, body)


def reset_fake() -> None:
    FakePlane.issues = []
    FakePlane.patches = []
    FakePlane.comments = []
    FakePlane.labels = []
    FakePlane.posts = []
    FakePlane.reject_project_patch = False
    FakePlane.page_size = 100
    FakePlane.projects = [{"id": PROJECT, "identifier": "CORT", "name": "Cortadas"}]


def write_spec(d: Path, num: str, status: str, title: str = "Something") -> None:
    (d / f"{num}-x.md").write_text(
        f"---\ntype: Spec\nid: CORT-{num}\ntitle: {title}\nstatus: {status}   # comment\n---\n\n"
        f"# CORT-{num}\n\n## Context\n\nUses `code` and **bold**.\n\n- one\n- two\n\n```sh\necho <hi>\n```\n"
    )


class PlaneImport(unittest.TestCase):
    def setUp(self) -> None:
        reset_fake()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), FakePlane)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"

        self.repo = Path(tempfile.mkdtemp()) / "cortadas"
        specs = self.repo / "docs" / "specs"
        specs.mkdir(parents=True)
        write_spec(specs, "0001", "done")
        write_spec(specs, "0002", "draft", "Desktop E2E")
        write_spec(specs, "0003", "in-review")
        write_spec(specs, "0004", "ready")
        write_spec(specs, "0005", "dropped")
        (specs / "TEMPLATE.md").write_text("---\ntype: Spec\nstatus: draft\n---\n")
        (specs / "index.md").write_text("# index\n")
        env = mock.patch.dict(os.environ, {"PLANE_API_KEY": KEY})
        env.start()
        self.addCleanup(env.stop)

    def run_cli(self, *argv: str) -> tuple[int, str]:
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = cli.main(list(argv))
        return code, out.getvalue()

    def test_dry_run_lists_only_open_specs_and_creates_nothing(self) -> None:
        code, out = self.run_cli(
            "plane", "import-specs", "--repo", str(self.repo), "--project", PROJECT, "--url", self.url
        )
        self.assertEqual(code, 0, out)
        self.assertEqual(out.count("planned"), 3)
        self.assertIn("3 open of 5 specs", out)
        self.assertIn("dry run", out)
        self.assertEqual(FakePlane.issues, [])

    def test_apply_creates_issues_in_the_mapped_states_and_is_idempotent(self) -> None:
        code, out = self.run_cli(
            "plane", "import-specs", "--repo", str(self.repo), "--project", PROJECT, "--url", self.url, "--apply"
        )
        self.assertEqual(code, 0, out)
        by_id = {i["external_id"]: i for i in FakePlane.issues}
        self.assertEqual(set(by_id), {"CORT-0002", "CORT-0003", "CORT-0004"})
        self.assertEqual(by_id["CORT-0002"]["state"], "s-backlog")
        self.assertEqual(by_id["CORT-0003"]["state"], "s-doing")
        self.assertEqual(by_id["CORT-0004"]["state"], "s-todo")
        self.assertEqual(by_id["CORT-0002"]["name"], "CORT-0002 · Desktop E2E")
        html = by_id["CORT-0002"]["description_html"]
        self.assertIn("<code>code</code>", html)
        self.assertIn("<li>one</li>", html)
        self.assertIn("echo &lt;hi&gt;", html)

        _, out = self.run_cli(
            "plane", "import-specs", "--repo", str(self.repo), "--project", PROJECT, "--url", self.url, "--apply"
        )
        self.assertEqual(out.count("exists"), 3)
        self.assertEqual(len(FakePlane.issues), 3)

    def test_projects_lists_the_workspace(self) -> None:
        code, out = self.run_cli("plane", "projects", "--url", self.url)
        self.assertEqual(code, 0)
        self.assertIn("CORT", out)

    def test_bad_key_is_an_error(self) -> None:
        with mock.patch.dict(os.environ, {"PLANE_API_KEY": "wrong"}):
            code, out = self.run_cli("plane", "projects", "--url", self.url)
        self.assertEqual(code, 1)
        self.assertIn("401", out)

    def test_frontmatter_strips_inline_comments(self) -> None:
        meta, _ = specs_import.parse_frontmatter("---\nstatus: draft   # draft | ready\n---\nbody")
        self.assertEqual(meta["status"], "draft")

    def test_plane_error_carries_status(self) -> None:
        client = Plane(PROJECT, KEY, self.url)
        with self.assertRaises(PlaneError):
            client._call("GET", "/nope/")


if __name__ == "__main__":
    unittest.main()
