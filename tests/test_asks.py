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

from fractory import asks, cli, launch, retry, rework
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
        for module, fn in ((rework, "relaunch_dead_workers"), (retry, "nudge_stalled")):
            quiet = mock.patch.object(module, fn)
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

    def test_questions_answered_before_the_last_input_open_no_gate(self) -> None:
        # esquerda-nas-ruas-0007/-0008, 2026-11-21: asked, answered in the terminal, the worker moved on (a stage
        # event followed); the unhandled messages must not open a gate.
        self.inbox = [
            {**ask_message("msg_old7", question="Which route?"), "created_at": "2026-11-20T10:00:00Z"},
            {**ask_message("msg_old8", question="Keep the schema?"), "created_at": "2026-11-20T11:00:00Z"},
        ]
        path = self.tmp / "factory" / "jobs" / JOB / "state.json"
        data = json.loads(path.read_text())
        data["history"].append(
            {"at": "2026-11-20T12:00:00+00:00", "event": "worker_ask", "stage": "build", "message": "x"}
        )
        data["history"].append({"at": "2026-11-20T12:30:00+00:00", "event": "rework_sent", "stage": "build"})
        path.write_text(json.dumps(data))
        self.run_cli("sync")
        self.assertIsNone(self.job()["gate"])
        self.inbox.append({**ask_message("msg_new", question="Fresh?"), "created_at": "2026-11-21T09:00:00Z"})
        self.run_cli("sync")
        self.assertEqual(self.job()["gate"]["detail"], "Fresh?")


class DeliveryCheck(unittest.TestCase):
    ORCH = Path("orch.py")

    def deliver(self, nudge_code: int, stalls: str, tail: list[str]) -> tuple[bool, str]:
        job = mock.Mock(links={"terminal": "term_w"}, id="j-1")
        gate = mock.Mock(detail="Which route?")

        def runner(argv: list[str]) -> tuple[int, str]:
            if "nudge" in argv:
                return nudge_code, "NOT picked up"
            if "stalls" in argv:
                return 1, stalls
            return 0, json.dumps({"ok": True, "result": {"terminal": {"tail": tail}}})

        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            ok = asks.deliver_answer(job, gate, "route A", self.ORCH, runner, sleep=lambda _: None)
        return ok, out.getvalue()

    def test_a_nudge_that_timed_out_but_left_the_worker_busy_is_delivered(self) -> None:
        ok, out = self.deliver(1, "term_w: busy | Thinking", [])
        self.assertTrue(ok)
        self.assertNotIn("not picked up", out)

    def test_a_nudge_that_timed_out_but_is_echoed_on_screen_is_delivered(self) -> None:
        echo = "> [fractory] Answer to your question (Which route?): route A"
        ok, out = self.deliver(1, "term_w: idle | ❯", ["x", echo])
        self.assertTrue(ok)
        self.assertNotIn("not picked up", out)

    def test_a_real_miss_is_reported(self) -> None:
        ok, out = self.deliver(1, "term_w: idle | ❯", ["nothing here"])
        self.assertFalse(ok)
        self.assertIn("not picked up by term_w", out)


if __name__ == "__main__":
    unittest.main()
