"""Gates as Plane cards, against the fake Plane over real HTTP."""

from __future__ import annotations

import contextlib
import io
import json
import os
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest import mock

from fractory import cli, sync
from tests.test_plane_import import KEY, PROJECT, FakePlane, reset_fake

JOB = "cortadas-0001"


class GateCards(unittest.TestCase):
    def setUp(self) -> None:
        reset_fake()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), FakePlane)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.tmp = Path(tempfile.mkdtemp())
        self.repo = self.tmp / "cortadas"
        self.repo.mkdir()
        (self.tmp / "factory").mkdir()
        (self.tmp / "factory" / "config.toml").write_text('plane_assignee = "user-pedro"\n')
        env = mock.patch.dict(
            os.environ,
            {
                "FACTORY_HOME": str(self.tmp / "factory"),
                "FRACTORY_ABLE_ROOT": str(self.tmp / "Able"),
                "PLANE_API_KEY": KEY,
            },
        )
        env.start()
        self.addCleanup(env.stop)
        gh = mock.patch.object(sync, "run_gh", return_value=json.dumps({"url": "https://github.com/o/r/pull/42"}))
        gh.start()
        self.addCleanup(gh.stop)
        self.run_cli(
            "job", "new", "--repo", str(self.repo), "--title", "Build the thing", "--stage", "build",
            "--tracker", "plane", "--project", PROJECT, "--ref", "issue-1", "--plane-url", self.url,
        )  # fmt: skip
        self.run_cli("job", "link", JOB, "--pr", "42")
        self.run_cli("job", "cost", JOB, "60")  # over the US$ 50 budget: opens the cost gate

    def run_cli(self, *argv: str) -> tuple[int, str]:
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = cli.main(list(argv))
        return code, out.getvalue()

    def job(self) -> dict:
        return json.loads((self.tmp / "factory" / "jobs" / JOB / "state.json").read_text())

    def cards(self) -> list[dict]:
        return [i for i in FakePlane.issues if i["external_id"].startswith("gate-")]

    def test_open_gate_creates_one_card_and_no_duplicate(self) -> None:
        self.run_cli("sync")
        self.run_cli("sync")
        (card,) = self.cards()
        self.assertEqual(card["external_id"], f"gate-{JOB}-cost-1")
        self.assertEqual(card["name"], "Needs you: cost · Build the thing")
        self.assertEqual(card["state"], "s-todo")
        self.assertEqual(card["assignees"], ["user-pedro"])
        self.assertEqual(card["labels"], [FakePlane.labels[0]["id"]])
        self.assertEqual(FakePlane.labels[0]["name"], "humano")
        for text in ("cost", "over budget", "https://github.com/o/r/pull/42", JOB, "Done"):
            self.assertIn(text, card["description_html"])
        self.assertEqual(self.job()["gate"]["card"], card["id"])

    def test_card_done_resolves_gate_and_job_continues(self) -> None:
        self.run_cli("sync")
        (card,) = self.cards()
        self.run_cli("sync")
        self.assertEqual(self.job()["gate"]["reason"], "cost")  # still waiting
        FakePlane.comments.append((f"/x/{card['id']}/comments/", {"comment_html": "<p>ok, raise it</p>"}))
        card["state"] = "s-done"
        self.run_cli("sync")
        job = self.job()
        self.assertIsNone(job["gate"])
        self.assertEqual(job["stage"], "build")
        resolved = [h for h in job["history"] if h["event"] == "gate_resolved"][-1]
        self.assertEqual((resolved["decision"], resolved["note"]), ("continue", "ok, raise it"))
        self.assertEqual(len(self.cards()), 1)

    def test_card_cancelled_cancels_job(self) -> None:
        self.run_cli("sync")
        (card,) = self.cards()
        card["state"] = "s-cancel"
        self.run_cli("sync")
        self.assertEqual(self.job()["stage"], "cancelled")
        self.assertIsNone(self.job()["gate"])

    def test_cli_resolve_moves_card_to_done(self) -> None:
        self.run_cli("sync")
        (card,) = self.cards()
        code, _ = self.run_cli("gate", "resolve", JOB, "continue")
        self.assertEqual(code, 0)
        self.assertEqual(card["state"], "s-done")
        self.assertIsNone(self.job()["gate"])

    def test_no_card_for_job_without_plane_tracker(self) -> None:
        self.run_cli("job", "new", "--repo", str(self.tmp), "--title", "plain", "--stage", "build")
        self.run_cli("job", "cost", "tmp-0001", "60")
        self.run_cli("sync")
        self.assertEqual(len(self.cards()), 1)  # only the Plane-tracked job's card


if __name__ == "__main__":
    unittest.main()
