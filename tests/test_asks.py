"""Worker asks open one gate; answering the card types the answer into the worker's terminal."""

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

from fractory import asks, cli, launch, rework
from tests.test_plane_import import KEY, PROJECT, FakePlane, reset_fake

JOB = "cortadas-0001"
QUESTION = "Should I bump the Expo packages to SDK 55 or keep the pinned versions?"


def ask_message(msg_id: str = "msg_1", dispatch: str = "ctx_1", question: str = QUESTION) -> dict:
    return {
        "id": msg_id,
        "type": "question",
        "from_handle": f"dispatch:{dispatch}",
        "to_handle": "run:run_1",
        "subject": "Question",
        "body": question,
        "payload": json.dumps({"dispatchId": dispatch, "question": question, "options": []}),
        "created_at": "2999-01-01T00:00:00Z",
        "sequence": 1,
    }


class WorkerAsks(unittest.TestCase):
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
        self.inbox: list[dict] = [ask_message()]
        self.nudges: list[list[str]] = []
        patch = mock.patch.object(launch, "run_cmd", side_effect=self.fake_run)
        patch.start()
        self.addCleanup(patch.stop)
        # sync also relaunches dead workers and nudges stuck builds: keep those out of the way
        for fn in ("relaunch_dead_workers", "nudge_stuck_builds"):
            quiet = mock.patch.object(rework, fn)
            quiet.start()
            self.addCleanup(quiet.stop)
        self.run_cli(
            "job", "new", "--repo", str(self.repo), "--title", "Build the thing", "--stage", "build",
            "--tracker", "plane", "--project", PROJECT, "--ref", "issue-1", "--plane-url", self.url,
        )  # fmt: skip
        self.run_cli("job", "link", JOB, "--terminal", "term_worker")
        path = self.tmp / "factory" / "jobs" / JOB / "state.json"
        data = json.loads(path.read_text())
        data["links"]["dispatch"] = "ctx_1"
        data["created_at"] = "2000-01-01T00:00:00+00:00"
        path.write_text(json.dumps(data))

    def fake_run(self, argv: list[str]) -> tuple[int, str]:
        if "inbox" in argv:
            return 0, json.dumps({"ok": True, "result": {"messages": self.inbox}})
        if "nudge" in argv:
            self.nudges.append(argv)
            return 0, "term_worker: picked up"
        return 1, "unexpected"

    def run_cli(self, *argv: str) -> tuple[int, str]:
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = cli.main(list(argv))
        return code, out.getvalue()

    def job(self) -> dict:
        return json.loads((self.tmp / "factory" / "jobs" / JOB / "state.json").read_text())

    def cards(self) -> list[dict]:
        return [i for i in FakePlane.issues if i["external_id"].startswith("gate-")]

    def test_an_ask_opens_one_gate_with_the_question_not_one_per_cycle(self) -> None:
        for _ in range(3):
            self.run_cli("sync")
        gate = self.job()["gate"]
        self.assertEqual((gate["reason"], gate["detail"]), ("worker_asks", QUESTION))
        (card,) = self.cards()
        self.assertTrue(card["name"].startswith("Needs you: worker asks: Should I bump the Expo packages"))
        self.assertIn(QUESTION, card["description_html"])
        self.assertEqual(len([h for h in self.job()["history"] if h["event"] == "worker_ask"]), 1)

    def test_answered_gate_is_not_reopened_by_the_same_message(self) -> None:
        self.run_cli("sync")
        self.run_cli("gate", "resolve", JOB, "continue", "--note", "keep pinned")
        self.run_cli("sync")
        self.assertIsNone(self.job()["gate"])

    def test_a_new_ask_opens_a_new_gate_after_the_first_is_answered(self) -> None:
        self.run_cli("sync")
        self.run_cli("gate", "resolve", JOB, "continue", "--note", "keep pinned")
        self.inbox.append(ask_message("msg_2", question="And the lockfile?"))
        self.run_cli("sync")
        self.assertEqual(self.job()["gate"]["detail"], "And the lockfile?")

    def test_resolving_the_card_sends_the_answer_to_the_worker_terminal(self) -> None:
        self.run_cli("sync")
        (card,) = self.cards()
        FakePlane.comments.append((f"/x/{card['id']}/comments/", {"comment_html": "<p>Keep the pinned versions.</p>"}))
        card["state"] = "s-done"
        self.run_cli("sync")
        self.assertIsNone(self.job()["gate"])
        (nudge,) = self.nudges
        self.assertEqual(nudge[nudge.index("nudge") + 1], "term_worker")
        text = nudge[nudge.index("--text") + 1]
        self.assertIn("Keep the pinned versions.", text)
        self.assertNotIn("\n", text)

    def test_cli_resolve_sends_the_answer_too(self) -> None:
        self.run_cli("sync")
        self.run_cli("gate", "resolve", JOB, "continue", "--note", "bump to 55")
        (nudge,) = self.nudges
        self.assertIn("bump to 55", nudge[nudge.index("--text") + 1])

    def test_cancelled_card_sends_nothing(self) -> None:
        self.run_cli("sync")
        (card,) = self.cards()
        card["state"] = "s-cancel"
        self.run_cli("sync")
        self.assertEqual(self.nudges, [])
        self.assertEqual(self.job()["stage"], "cancelled")

    def test_other_dispatch_other_type_and_failed_inbox_open_nothing(self) -> None:
        self.inbox = [ask_message(dispatch="ctx_other"), {**ask_message("m3"), "type": "worker_done"}]
        self.run_cli("sync")
        self.assertIsNone(self.job()["gate"])
        self.inbox = [ask_message()]
        with mock.patch.object(launch, "run_cmd", return_value=(1, "boom")):
            self.run_cli("sync")
        self.assertIsNone(self.job()["gate"])

    def test_question_text_falls_back_to_the_body(self) -> None:
        self.assertEqual(asks.question_text({"body": "a\n b", "payload": "not json"}), "a b")


if __name__ == "__main__":
    unittest.main()
