"""`fractory serve` over real HTTP with a temp FACTORY_HOME; git is stubbed, no network."""

from __future__ import annotations

import http.client
import json
import os
import tempfile
import threading
import time
import unittest
from datetime import UTC, datetime, timedelta
from pathlib import Path
from unittest import mock

from fractory import health, state, store, web


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

    def test_index_has_the_sections_and_calls_the_endpoints(self) -> None:
        page = self.get("/")[2].decode()
        for section in ('id="strip"', "Precisa de você", "Parado"):
            self.assertIn(section, page)
        for endpoint in ("/api/health", "/api/metrics"):
            self.assertIn(endpoint, page)
            self.assertEqual(self.get(endpoint)[0], 200)
        self.assertIn("/api/events", page)  # SSE: served by Events.test_event_follows_state_change
        self.assertIn("prefers-color-scheme: dark", page)
        self.assertNotIn("http://", page.replace("http://www.w3.org", ""))  # no CDN, no external assets

    def test_jobs_api_has_what_the_board_needs(self) -> None:
        job = store.load("app-0001")
        job.links = {"pr": "7", "terminal": "term_9"}
        self.save(job)
        data = json.loads(self.get("/api/jobs")[2])
        [item] = data["jobs"]
        self.assertEqual(item["terminal"], "term_9")
        self.assertTrue(item["gate_opened_at"])
        self.assertEqual(data["wip"], {"open": 1, "max": 3})

    def test_jobs_api(self) -> None:
        status, _, body = self.get("/api/jobs")
        data = json.loads(body)
        self.assertEqual(status, 200)
        self.assertEqual(data["totals"], {"open": 1, "gated": 1, "cost_usd": 0.0})
        [job] = data["jobs"]
        self.assertEqual(job["pr_url"], "https://github.com/acme/app/pull/7")
        self.assertEqual(job["tracker_url"], f"{web.DEFAULT_URL}/cortadas/projects/P1/issues/R1")
        self.assertEqual((job["gate"], job["gate_detail"]), ("cost", "over budget"))

    def test_jobs_api_includes_stuck(self) -> None:
        [job] = json.loads(self.get("/api/jobs")[2])["jobs"]
        self.assertEqual(job["stuck"]["kind"], "gate")  # the fixture job has an open gate

    def test_metrics_api(self) -> None:
        now = datetime.now(UTC)
        old = state.new_job("app-0002", "/work/app", "Old", "internal", 50.0, "build")
        old.created_at = old.history[0]["at"] = (now - timedelta(hours=3)).isoformat()
        merged = state.new_job("app-0003", "/work/app", "Done", "internal", 50.0, "ship")
        merged.created_at = merged.history[0]["at"] = (now - timedelta(hours=2)).isoformat()
        merged, _ = state.apply_event(merged, "merged")
        merged, _ = state.add_cost(merged, 2.0)
        self.save(old)
        self.save(merged)
        status, ctype, body = self.get("/api/metrics?window=30")
        data = json.loads(body)
        self.assertEqual((status, data["window_days"]), (200, 30))
        self.assertIn("json", ctype)
        self.assertEqual({i["job"] for i in data["stuck"]}, {"app-0001", "app-0002"})
        self.assertEqual(data["flow"]["lead_time"]["overall"]["count"], 1)
        self.assertEqual(data["flow"]["wip"]["overall"], 2)
        self.assertEqual(data["cost"]["total_usd"], 2.0)
        self.assertEqual(json.loads(self.get("/api/metrics?window=99")[2])["window_days"], 7)
        self.assertEqual(json.loads(self.get("/api/metrics")[2])["window_days"], 7)

    def test_metrics_stuck_threshold_from_config(self) -> None:
        old = state.new_job("app-0002", "/work/app", "Old", "internal", 50.0, "build")
        old.history[0]["at"] = (datetime.now(UTC) - timedelta(minutes=30)).isoformat()
        self.save(old)
        stuck = lambda: {i["job"] for i in json.loads(self.get("/api/metrics")[2])["stuck"]}
        self.assertNotIn("app-0002", stuck())
        self.home.mkdir(parents=True, exist_ok=True)
        (self.home / "config.toml").write_text("[stuck]\nbuild = 10\n")
        self.assertIn("app-0002", stuck())

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


class Activity(ServerCase):
    def add_events(self, job_id: str, events: list[tuple[str, str]]) -> None:
        job = state.new_job(job_id, "/work/app", f"Job {job_id}", "internal", 50.0, "build")
        job.history = [{"at": at, "event": ev, "stage": "build", "note": f"n-{ev}"} for at, ev in events]
        self.save(job)

    def test_events_across_jobs_newest_first_with_highlights(self) -> None:
        self.add_events("app-0002", [("2030-01-01T10:00:00+00:00", "created"), ("2030-01-01T12:00:00+00:00", "red")])
        self.add_events("app-0003", [("2030-01-01T11:00:00+00:00", "reviewed")])
        _, ctype, body = self.get("/api/activity")
        data = json.loads(body)
        self.assertIn("json", ctype)
        top = data["events"][:3]
        self.assertEqual(
            [(e["job"], e["event"]) for e in top],
            [("app-0002", "red"), ("app-0003", "reviewed"), ("app-0002", "created")],
        )
        self.assertEqual([e["highlight"] for e in top], [True, False, True])
        self.assertEqual(top[0]["title"], "Job app-0002")
        self.assertEqual((top[0]["stage"], top[0]["note"]), ("build", "n-red"))

    def test_limit_is_clamped(self) -> None:
        self.add_events("app-0002", [(f"2030-01-01T10:{i:02d}:00+00:00", "cost") for i in range(60)])
        count = lambda q: len(json.loads(self.get("/api/activity" + q)[2])["events"])
        self.assertEqual(count(""), 50)
        self.assertEqual(count("?limit=5"), 5)
        self.assertEqual(count("?limit=0"), 1)
        self.assertEqual(count("?limit=-3"), 1)
        self.assertEqual(count("?limit=9999"), 61)
        self.assertEqual(count("?limit=abc"), 50)

    def test_missing_log_is_empty_list(self) -> None:
        self.assertEqual(json.loads(self.get("/api/activity")[2])["log"], [])

    def test_log_tail_is_last_40_lines(self) -> None:
        (self.home / "watch.log").write_text("\n".join(f"line {i}" for i in range(100)) + "\n")
        log = json.loads(self.get("/api/activity")[2])["log"]
        self.assertEqual(len(log), 40)
        self.assertEqual((log[0], log[-1]), ("line 60", "line 99"))


class Health(ServerCase):
    def beat(self, ended: datetime, every: float = 60) -> dict:
        return {"cycle_ended_at": ended.strftime("%Y-%m-%dT%H:%M:%SZ"), "every": every, "cycles": 4}

    def test_missing_files(self) -> None:
        for path in ("/api/health", "/api/queue"):
            status, _, body = self.get(path)
            self.assertEqual((status, json.loads(body)), (200, {"missing": True}))

    def test_alive_while_the_last_cycle_is_recent(self) -> None:
        health.write_json("heartbeat.json", self.beat(datetime.now(UTC) - timedelta(seconds=100)))
        data = json.loads(self.get("/api/health")[2])
        self.assertTrue(data["alive"])
        self.assertEqual(data["cycles"], 4)

    def test_not_alive_when_the_heartbeat_is_old(self) -> None:
        health.write_json("heartbeat.json", self.beat(datetime.now(UTC) - timedelta(seconds=181)))
        self.assertFalse(json.loads(self.get("/api/health")[2])["alive"])

    def test_queue_is_served_as_written(self) -> None:
        health.write_json("queue.json", {"at": "t", "projects": {"P": {"cards": []}}})
        self.assertEqual(json.loads(self.get("/api/queue")[2]), {"at": "t", "projects": {"P": {"cards": []}}})


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
