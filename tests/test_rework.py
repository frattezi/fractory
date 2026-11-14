"""Rework: a job back in build (CI red, Judge rejected) is relayed to its worker's terminal, no person in between."""

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

from fractory import cli, judge, launch, rework, state, sync
from tests.test_judge import verdict_json
from tests.test_plane_import import KEY, PROJECT, FakePlane, reset_fake

JOB = "cortadas-0001"


def pr_json(conclusion: str = "FAILURE") -> str:
    check = {"__typename": "CheckRun", "name": "lint", "status": "COMPLETED", "conclusion": conclusion}
    return json.dumps({"state": "OPEN", "isDraft": False, "statusCheckRollup": [check]})


class ReworkMessage(unittest.TestCase):
    def test_judge_message_has_round_reasons_and_steps(self) -> None:
        job = state.new_job("cortadas-0007", "/r", "x", "internal")
        job.judge_rounds = 1
        msg = rework.rework_message(job, "rejected", "no tests")
        self.assertNotIn("\n", msg)
        for part in (
            "cortadas-0007",
            "round 1/2",
            "no tests",
            "merge origin/main",
            "push",
            "job advance cortadas-0007 built --note",
        ):
            self.assertIn(part, msg)

    def test_red_message_names_the_check(self) -> None:
        job = state.new_job("cortadas-0007", "/r", "x", "internal")
        self.assertIn("check lint", rework.rework_message(job, "red", "lint"))


class ReworkCli(unittest.TestCase):
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
        self.pr = pr_json()
        self.model_reply = verdict_json("rejected", reasons=("no tests",))
        self.nudges: list[list[str]] = []
        self.nudge_code = 0
        for target, name, fake in (
            (sync, "run_gh", self.fake_gh),
            (judge, "run_claude", self.fake_claude),
            (rework, "run_cmd", self.fake_orch),
            (judge, "pr_checkout", mock.MagicMock(return_value=contextlib.nullcontext("/pr"))),
        ):
            patcher = (
                mock.patch.object(target, name, new=fake)
                if isinstance(fake, mock.MagicMock)
                else mock.patch.object(target, name, side_effect=fake)
            )
            patcher.start()
            self.addCleanup(patcher.stop)
        FakePlane.issues.append(
            {"id": "issue-1", "name": "Add feature", "description_html": "<p>x</p>", "external_id": "x",
             "external_source": "fractory"}
        )  # fmt: skip

    def fake_gh(self, args: list[str], cwd: str) -> str:
        return "" if args[:2] in (["pr", "comment"], ["pr", "diff"]) else self.pr

    def fake_claude(self, argv: list[str], stdin: str, cwd: str | None = None) -> str:
        return json.dumps({"result": self.model_reply})

    def fake_orch(self, argv: list[str]) -> tuple[int, str]:
        self.nudges.append(argv)
        return self.nudge_code, ""

    def run_cli(self, *argv: str) -> tuple[int, str]:
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = cli.main(list(argv))
        return code, out.getvalue()

    def job(self) -> dict:
        return json.loads((self.tmp / "factory" / "jobs" / JOB / "state.json").read_text())

    def new_job(self, stage: str, terminal: str | None = "term_1") -> None:
        self.run_cli(
            "job", "new", "--repo", str(self.repo), "--title", "x", "--stage", stage,
            "--tracker", "plane", "--project", PROJECT, "--ref", "issue-1", "--plane-url", self.url,
        )  # fmt: skip
        self.run_cli("job", "link", JOB, "--pr", "42")
        if terminal:
            self.run_cli("job", "link", JOB, "--terminal", terminal)

    def events(self) -> list[str]:
        return [h["event"] for h in self.job()["history"]]

    def test_rejection_nudges_the_terminal_and_logs_rework_sent(self) -> None:
        self.new_job("review")
        self.run_cli("judge", JOB)
        (argv,) = self.nudges
        self.assertEqual(argv[2:5], ["nudge", "term_1", "--text"])
        self.assertIn("no tests", argv[5])
        self.assertIn("round 1/2", argv[5])
        self.assertEqual(self.job()["stage"], "build")
        self.assertIsNone(self.job()["gate"])
        self.assertEqual(self.events()[-1], "rework_sent")

    def test_red_ci_nudges_the_terminal(self) -> None:
        self.new_job("build")
        self.run_cli("job", "advance", JOB, "built")
        self.run_cli("sync")
        (argv,) = self.nudges
        self.assertIn("check lint", argv[5])
        self.assertEqual(self.job()["stage"], "build")
        self.assertEqual(self.events()[-1], "rework_sent")

    def test_no_terminal_opens_rework_needed_with_the_message(self) -> None:
        self.new_job("review", terminal=None)
        self.run_cli("judge", JOB)
        self.assertEqual(self.nudges, [])
        gate = self.job()["gate"]
        self.assertEqual(gate["reason"], "rework_needed")
        self.assertIn("no tests", gate["detail"])

    def test_red_ci_without_a_terminal_opens_rework_needed(self) -> None:
        self.new_job("build", terminal=None)
        self.run_cli("job", "advance", JOB, "built")
        self.run_cli("sync")
        self.assertEqual(self.nudges, [])
        self.assertEqual(self.job()["gate"]["reason"], "rework_needed")

    def test_failed_nudge_opens_rework_needed(self) -> None:
        self.new_job("review")
        self.nudge_code = 1
        self.run_cli("judge", JOB)
        self.assertEqual(self.job()["gate"]["reason"], "rework_needed")
        self.assertNotIn("rework_sent", self.events())

    def test_second_rejection_waits_for_a_person(self) -> None:
        self.new_job("review")
        self.run_cli("judge", JOB)
        self.run_cli("job", "advance", JOB, "built")
        self.run_cli("job", "advance", JOB, "green")
        self.run_cli("judge", JOB)
        self.assertEqual(self.job()["gate"]["reason"], "judge_rounds")
        self.assertEqual(len(self.nudges), 1)

    def test_approval_sends_nothing(self) -> None:
        self.new_job("review")
        self.model_reply = verdict_json()
        self.run_cli("judge", JOB)
        self.assertEqual(self.nudges, [])


class EscalateOnRejection(ReworkCli):
    """A pi worker that the Judge rejects is replaced once by its profile's escalate_to, in the same worktree."""

    route_reply: tuple[int, str] = (0, "profile strong: --agent claude --model sonnet  (step up from backend)\n")

    def fake_orch(self, argv: list[str]) -> tuple[int, str]:
        self.nudges.append(argv)
        if "route" in argv:
            return self.route_reply
        if "launch" in argv:
            return 0, "launched dispatch d9 in terminal term_strong (stage running)\n"
        return self.nudge_code, ""

    def setUp(self) -> None:
        super().setUp()
        (self.tmp / "factory").mkdir(exist_ok=True)
        (self.tmp / "factory" / "config.toml").write_text('orca_run = "run_1"\n')
        patch = mock.patch.object(launch, "run_cmd", return_value=(1, ""))
        patch.start()
        self.addCleanup(patch.stop)

    def new_pi_job(self) -> None:
        self.new_job("review")
        self.run_cli("job", "link", JOB, "--profile", "backend")
        path = self.tmp / "factory" / "jobs" / JOB / "state.json"
        data = json.loads(path.read_text())
        data["links"]["worktree_id"] = "repo::/wt/x"
        path.write_text(json.dumps(data))

    def test_rejection_calls_escalate_from_and_relaunches_on_the_same_worktree(self) -> None:
        self.new_pi_job()
        self.run_cli("judge", JOB)
        route = next(a for a in self.nudges if "route" in a)
        self.assertEqual(route[route.index("--escalate-from") + 1], "backend")
        launch_cmd = next(a for a in self.nudges if "launch" in a)
        self.assertEqual(launch_cmd[launch_cmd.index("--worktree") + 1], "id:repo::/wt/x")
        self.assertEqual(launch_cmd[launch_cmd.index("--profile") + 1], "strong")
        self.assertFalse(any("nudge" in a for a in self.nudges))
        job = self.job()
        self.assertEqual((job["links"]["profile"], job["links"]["terminal"]), ("strong", "term_strong"))
        self.assertIn("profile_escalated", self.events())
        self.assertEqual(self.events()[-1], "rework_sent")

    def test_no_step_up_falls_back_to_a_nudge(self) -> None:
        self.route_reply = (0, "no step up from backend: escalate to the main session\n")
        self.new_pi_job()
        self.run_cli("judge", JOB)
        self.assertFalse(any("launch" in a for a in self.nudges))
        self.assertTrue(any("nudge" in a for a in self.nudges))
        self.assertNotIn("profile_escalated", self.events())

    def test_a_job_without_profile_is_nudged(self) -> None:
        self.new_job("review")
        self.run_cli("judge", JOB)
        self.assertFalse(any("route" in a for a in self.nudges))

    def test_escalates_only_once(self) -> None:
        self.new_pi_job()
        self.run_cli("judge", JOB)
        self.run_cli("job", "advance", JOB, "built")
        self.run_cli("job", "advance", JOB, "green")
        self.run_cli("judge", JOB)
        self.assertEqual(sum("route" in a for a in self.nudges), 1)


if __name__ == "__main__":
    unittest.main()
