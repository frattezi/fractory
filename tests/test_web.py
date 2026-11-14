"""`fractory serve` over real HTTP with a temp FACTORY_HOME; git is stubbed, no network."""

from __future__ import annotations

import http.client
import json
import os
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

from fractory import state, store, web


class UrlHelpers(unittest.TestCase):
    def test_github_url_from_remotes(self) -> None:
        for remote in (
            "git@github.com:acme/app.git",
            "https://github.com/acme/app.git\n",
            "https://github.com/acme/app",
            "ssh://git@github.com/acme/app.git",
            "https://user:tok@github.com/acme/app.git",
        ):
            self.assertEqual(web.github_url(remote), "https://github.com/acme/app", remote)
        self.assertIsNone(web.github_url("git@gitlab.com:acme/app.git"))

    def test_plane_issue_url(self) -> None:
        t = {"kind": "plane", "project": "P1", "ref": "R1", "url": "https://plane.example.com/"}
        self.assertEqual(web.plane_issue_url(t), "https://plane.example.com/cortadas/projects/P1/issues/R1")
        self.assertEqual(
            web.plane_issue_url({"kind": "plane", "project": "P1"}), f"{web.DEFAULT_URL}/cortadas/projects/P1/issues"
        )
        self.assertIsNone(web.plane_issue_url({"kind": "jira", "ref": "X-1"}))
        self.assertIsNone(web.plane_issue_url({}))


class ServerCase(unittest.TestCase):
    def setUp(self) -> None:
        self.home = Path(tempfile.mkdtemp()) / "factory"
        for patcher in (
            mock.patch.dict(os.environ, {"FACTORY_HOME": str(self.home)}),
            mock.patch.object(web, "repo_github_url", lambda repo: "https://github.com/acme/app"),
            mock.patch.object(web, "POLL_SECONDS", 0.05),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)
        job = state.new_job("app-0001", "/work/app", "Ship it", "internal", 50.0, "review")
        job.tracker = {"kind": "plane", "ref": "R1", "project": "P1", "url": web.DEFAULT_URL}
        job.links = {"pr": "7"}
        job.gate = state.Gate("cost", "over budget")
        self.save(job)
        self.server = web.make_server(0)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.port = self.server.server_address[1]

    def save(self, job: state.Job) -> None:
        with store.locked(job.id):
            store.save(job)

    def get(self, path: str) -> tuple[int, str, bytes]:
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        conn.request("GET", path)
        r = conn.getresponse()
        return r.status, r.getheader("Content-Type") or "", r.read()


class Routes(ServerCase):
    def test_binds_loopback_only(self) -> None:
        self.assertEqual(self.server.server_address[0], "127.0.0.1")

    def test_index_is_html(self) -> None:
        status, ctype, body = self.get("/")
        self.assertEqual(status, 200)
        self.assertIn("text/html", ctype)
        self.assertIn(b"EventSource", body)

    def test_jobs_api(self) -> None:
        status, _, body = self.get("/api/jobs")
        data = json.loads(body)
        self.assertEqual(status, 200)
        self.assertEqual(data["totals"], {"open": 1, "gated": 1, "cost_usd": 0.0})
        [job] = data["jobs"]
        self.assertEqual(job["pr_url"], "https://github.com/acme/app/pull/7")
        self.assertEqual(job["tracker_url"], f"{web.DEFAULT_URL}/cortadas/projects/P1/issues/R1")
        self.assertEqual((job["gate"], job["gate_detail"]), ("cost", "over budget"))

    def test_unknown_path_is_404(self) -> None:
        self.assertEqual(self.get("/nope")[0], 404)

    def test_job_detail(self) -> None:
        job = store.load("app-0001")
        job.gate = None
        job.links = {"pr": "7", "worktree": "wt", "branch": "b", "terminal": "term_1"}
        job, _ = state.apply_event(job, "reviewed", note="judge")
        job, _ = state.apply_event(job, "rejected", note="no tests; scope creep")
        job, _ = state.add_cost(job, 1.5)
        self.save(job)
        status, ctype, body = self.get("/api/jobs/app-0001")
        data = json.loads(body)
        self.assertEqual(status, 200)
        self.assertIn("json", ctype)
        self.assertEqual(data["links"]["terminal"], "term_1")
        self.assertEqual(data["pr_url"], "https://github.com/acme/app/pull/7")
        self.assertEqual(data["tracker_url"], f"{web.DEFAULT_URL}/cortadas/projects/P1/issues/R1")
        self.assertEqual(data["verdicts"][0]["decision"], "rejected")
        self.assertEqual(data["verdicts"][0]["reasons"], ["no tests", "scope creep"])
        self.assertEqual([e["event"] for e in data["history"]][-3:], ["reviewed", "rejected", "cost"])
        self.assertEqual(data["history"][-1]["total"], 1.5)

    def test_job_detail_unknown_and_malformed_ids_are_404(self) -> None:
        for path in (
            "/api/jobs/x",
            "/api/jobs/",
            "/api/jobs/..",
            "/api/jobs/..%2F..%2Fetc",
            "/api/jobs/App-1",
            "/api/jobs/a/b",
        ):
            self.assertEqual(self.get(path)[0], 404, path)


class Events(ServerCase):
    def test_event_follows_state_change(self) -> None:
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        conn.request("GET", "/api/events")
        r = conn.getresponse()
        self.assertIn("text/event-stream", r.getheader("Content-Type"))

        def next_jobs() -> dict:
            assert r.readline().strip() == b"event: jobs"
            payload = json.loads(r.readline().split(b"data: ", 1)[1])
            r.readline()
            return payload

        self.assertEqual(next_jobs()["jobs"][0]["stage"], "review")
        time.sleep(0.05)
        job = store.load("app-0001")
        job.stage = "judge"
        self.save(job)
        self.assertEqual(next_jobs()["jobs"][0]["stage"], "judge")
        conn.close()


if __name__ == "__main__":
    unittest.main()
