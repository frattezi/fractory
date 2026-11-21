"""Technical failures retry with backoff and open one gate at the end; decisions never retry."""

from __future__ import annotations

import json
import subprocess
from datetime import UTC, datetime, timedelta
from pathlib import Path
from unittest import mock

from fractory import retry, state, store, sync
from tests.test_judge import verdict_json
from tests.test_plane_import import FakePlane
from tests.test_rework import JOB, ReworkBase

ORCH = Path("orch.py")
RETRY_CONFIG = "auto_judge = true\n[retry]\nmax_attempts = 2\nbackoff_minutes = 5\nstalled_minutes = 20\n"


class Classify(ReworkBase):
    def test_every_reason_is_classified(self) -> None:
        for reason in ("judge_rounds", "cost", "merge_review", "worker_asks", "pr_closed", "merge_needed"):
            self.assertEqual(retry.classify(reason), "decision", reason)
        for reason in ("judge_error", "worker_stalled", "ci_infra"):
            self.assertEqual(retry.classify(reason), "technical", reason)
        self.assertEqual(retry.classify("brand_new_reason"), "decision")  # unknown waits for a person

    def test_settings_defaults_and_bad_values(self) -> None:
        self.assertEqual(retry.settings({}), retry.Settings(3, 2, 20))
        self.assertEqual(
            retry.settings({"retry": {"max_attempts": 5, "backoff_minutes": "x", "stalled_minutes": -1}}),
            retry.Settings(5, 2, 20),
        )


class JudgeRetries(ReworkBase):
    def setUp(self) -> None:
        super().setUp()
        (self.tmp / "factory").mkdir(exist_ok=True)
        (self.tmp / "factory" / "config.toml").write_text(RETRY_CONFIG)
        self.new_job("review")
        self.replies = ["not json", "not json"]

    def fake_claude(self, argv, stdin, cwd=None) -> str:
        return json.dumps({"result": self.replies.pop(0) if self.replies else self.model_reply})

    def make_due(self) -> None:
        path = self.tmp / "factory" / "jobs" / JOB / "state.json"
        data = json.loads(path.read_text())
        for h in data["history"]:
            if h["event"] == "retry":
                h["due"] = "2020-01-01T00:00:00+00:00"
        path.write_text(json.dumps(data))

    def test_transient_failure_clears_without_a_person(self) -> None:
        self.model_reply = verdict_json()
        self.run_cli("judge", JOB)
        self.assertIsNone(self.job()["gate"])
        self.assertEqual(self.job()["stage"], "review")
        self.assertEqual(self.events().count("retry"), 1)
        self.run_cli("sync")  # backoff has not passed: no second attempt
        self.assertEqual(self.events().count("retry"), 1)
        self.make_due()
        self.run_cli("sync")  # 2nd failure: another retry
        self.make_due()
        self.run_cli("sync")  # 3rd call gets the real verdict
        self.assertEqual(self.job()["stage"], "ship")
        self.assertIsNone(self.job()["gate"])
        self.assertEqual(FakePlane.issues[-1]["external_id"], "x")  # no gate card

    def test_runs_again_without_auto_judge_once_a_retry_is_pending(self) -> None:
        (self.tmp / "factory" / "config.toml").write_text(RETRY_CONFIG.replace("auto_judge = true\n", ""))
        self.replies = ["not json"]
        self.model_reply = verdict_json()
        self.run_cli("judge", JOB)
        self.run_cli("sync")
        self.assertEqual(self.job()["stage"], "review")  # still backing off
        self.make_due()
        self.run_cli("sync")
        self.assertEqual(self.job()["stage"], "ship")

    def test_after_the_last_retry_there_is_one_gate_card_with_the_history(self) -> None:
        self.replies = ["bad"] * 10
        self.run_cli("judge", JOB)
        for _ in range(4):
            self.make_due()
            self.run_cli("sync")
        job = self.job()
        self.assertEqual(job["gate"]["reason"], "judge_error")
        self.assertEqual(self.events().count("retry"), 2)
        self.assertIn("Failed after 2 automatic retries", job["gate"]["detail"])
        cards = [i for i in FakePlane.issues if i["external_id"].startswith("gate-")]
        self.assertEqual(len(cards), 1)
        self.assertIn("Failed after 2 automatic retries", cards[0]["description_html"])

    def test_a_verdict_resets_the_count(self) -> None:
        job = store.load(JOB)
        retry.attempt_log(job, "judge_error", "x", retry.settings(store.config()))
        job.history.append({"at": state.now_iso(), "event": "judge_diff", "stage": "review"})
        self.assertEqual(retry.attempts(job, "judge_error"), [])


class StalledWorker(ReworkBase):
    idle = True

    def fake_orch(self, argv: list[str]) -> tuple[int, str]:
        if argv[1:3] == ["terminal", "list"]:
            return 1, ""
        self.nudges.append(argv)
        if "stalls" in argv:
            return 1, f"{argv[-1]}: {'idle' if self.idle else 'busy'} | >\n"
        return self.nudge_code, ""

    def setUp(self) -> None:
        super().setUp()
        (self.tmp / "factory").mkdir(exist_ok=True)
        (self.tmp / "factory" / "config.toml").write_text(RETRY_CONFIG)
        self.new_job("build")
        self.now = datetime.now(UTC) + timedelta(minutes=30)  # the job was created 30 minutes ago

    def texts(self) -> list[str]:
        return [a[a.index("--text") + 1] for a in self.nudges if "--text" in a]

    def step(self, minutes: float = 0) -> None:
        retry.nudge_stalled(ORCH, now=self.now + timedelta(minutes=minutes))

    def test_idle_worker_is_nudged_to_continue(self) -> None:
        self.step()
        (text,) = self.texts()
        self.assertIn("Continue from your brief; ask only if blocked", text)
        self.assertEqual(self.events()[-1], "retry")
        self.assertIsNone(self.job()["gate"])

    def test_backoff_then_one_gate_after_the_last_nudge(self) -> None:
        self.step()
        self.step(1)  # inside the 5 min backoff
        self.assertEqual(len(self.texts()), 1)
        self.step(6)
        self.step(30)  # attempts exhausted: the gate
        self.assertEqual(len(self.texts()), 2)
        gate = self.job()["gate"]
        self.assertEqual(gate["reason"], "worker_stalled")
        self.assertIn("Failed after 2 automatic retries", gate["detail"])
        self.step(90)  # a gated job is left alone
        self.assertEqual(len(self.texts()), 2)

    def test_fresh_busy_or_asking_worker_is_left_alone(self) -> None:
        retry.nudge_stalled(ORCH, now=datetime.now(UTC) + timedelta(minutes=5))  # under 20 min
        self.idle = False
        self.step()
        self.assertEqual(self.texts(), [])
        self.assertNotIn("retry", self.events())

    def test_job_with_an_open_gate_is_left_alone(self) -> None:
        self.run_cli("gate", "open", JOB, "--reason", "worker_asks", "--detail", "bump packages?")
        self.step()
        self.assertEqual(self.texts(), [])

    def test_undelivered_nudge_is_not_an_attempt(self) -> None:
        self.nudge_code = 1
        self.step()
        self.assertNotIn("retry", self.events())

    def test_progress_resets_the_attempts(self) -> None:
        self.step()
        self.run_cli("job", "advance", JOB, "built")
        self.assertEqual(retry.attempts(store.load(JOB), "worker_stalled"), [])


class CiInfra(ReworkBase):
    def setUp(self) -> None:
        super().setUp()
        self.new_job("checks")
        self.log = "Error: The runner has received a shutdown signal"
        self.calls: list[list[str]] = []
        check = {
            "__typename": "CheckRun", "name": "lint", "status": "COMPLETED", "conclusion": "FAILURE",
            "detailsUrl": "https://github.com/o/r/actions/runs/777/job/1",
        }  # fmt: skip
        self.pr = json.dumps({"state": "OPEN", "isDraft": False, "statusCheckRollup": [check]})
        patcher = mock.patch.object(sync, "run_gh", side_effect=self.gh)
        patcher.start()
        self.addCleanup(patcher.stop)

    def gh(self, args: list[str], cwd: str) -> str:
        self.calls.append(args)
        if args[:2] == ["run", "view"]:
            return self.log
        return "" if args[:2] in (["run", "rerun"], ["pr", "comment"]) else self.pr

    def reran(self) -> int:
        return sum(1 for c in self.calls if c[:2] == ["run", "rerun"])

    def test_infra_failure_reruns_the_failed_jobs_once(self) -> None:
        self.run_cli("sync")
        self.assertEqual(self.reran(), 1)
        self.assertIn("--failed", next(c for c in self.calls if c[:2] == ["run", "rerun"]))
        self.assertEqual(self.job()["stage"], "checks")  # not sent back to build
        self.run_cli("sync")  # rerun just started: still held
        self.assertEqual((self.reran(), self.job()["stage"]), (1, "checks"))

    def test_second_infra_failure_goes_to_the_worker_as_usual(self) -> None:
        self.run_cli("sync")
        path = self.tmp / "factory" / "jobs" / JOB / "state.json"
        data = json.loads(path.read_text())
        for h in data["history"]:
            if h["event"] == "retry":
                h["due"] = "2020-01-01T00:00:00+00:00"
        path.write_text(json.dumps(data))
        self.run_cli("sync")
        self.assertEqual(self.reran(), 1)
        self.assertEqual(self.job()["stage"], "build")

    def test_a_real_test_failure_is_not_rerun(self) -> None:
        self.log = "FAILED tests/test_x.py::test_y - AssertionError"
        self.run_cli("sync")
        self.assertEqual(self.reran(), 0)
        self.assertEqual(self.job()["stage"], "build")

    def test_failure_to_read_the_log_is_a_normal_red(self) -> None:
        def broken(args: list[str], cwd: str) -> str:
            if args[:2] == ["run", "view"]:
                raise subprocess.CalledProcessError(1, "gh")
            return self.pr

        with mock.patch.object(sync, "run_gh", side_effect=broken):
            self.run_cli("sync")
        self.assertEqual(self.job()["stage"], "build")
