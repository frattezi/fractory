"""`fractory sync` and the new Plane commands, end to end (gh stubbed, Plane faked over HTTP)."""

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


def check_run(name: str, status: str = "COMPLETED", conclusion: str | None = "SUCCESS") -> dict:
    return {"__typename": "CheckRun", "name": name, "status": status, "conclusion": conclusion}


def pr_json(state: str = "OPEN", draft: bool = False, checks: list[dict] | None = None) -> str:
    return json.dumps({"state": state, "isDraft": draft, "statusCheckRollup": checks or []})


class ParsePr(unittest.TestCase):
    def test_check_runs_and_status_contexts(self) -> None:
        pr = sync.parse_pr(
            json.loads(
                pr_json(
                    checks=[
                        check_run("lint"),
                        check_run("tests", "IN_PROGRESS", None),
                        {"__typename": "StatusContext", "context": "deploy", "state": "PENDING"},
                    ]
                )
            )
        )
        self.assertEqual(pr.checks, (("lint", "SUCCESS"), ("tests", "PENDING"), ("deploy", "PENDING")))
        self.assertEqual(sync.ci_result(pr), ("pending", None))

    def test_any_failure_is_red_with_its_name(self) -> None:
        pr = sync.parse_pr(json.loads(pr_json(checks=[check_run("lint"), check_run("e2e", conclusion="FAILURE")])))
        self.assertEqual(sync.ci_result(pr), ("red", "e2e"))

    def test_no_checks_is_pending_not_green(self) -> None:
        self.assertEqual(sync.ci_result(sync.parse_pr(json.loads(pr_json()))), ("pending", None))


class SyncCli(unittest.TestCase):
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
        gh = mock.patch.object(sync, "run_gh", side_effect=lambda args, cwd: self.pr)
        self.gh = gh.start()
        self.addCleanup(gh.stop)

    def run_cli(self, *argv: str) -> tuple[int, str]:
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = cli.main(list(argv))
        return code, out.getvalue()

    def stage(self, job_id: str = "cortadas-0001") -> str:
        return json.loads((self.tmp / "factory" / "jobs" / job_id / "state.json").read_text())["stage"]

    def new_job(self, stage: str = "build") -> None:
        self.run_cli(
            "job", "new", "--repo", str(self.repo), "--title", "x", "--stage", stage,
            "--tracker", "plane", "--project", PROJECT, "--ref", "issue-1", "--plane-url", self.url,
        )  # fmt: skip
        self.run_cli("job", "link", "cortadas-0001", "--pr", "42")

    def test_green_ci_moves_checks_to_review(self) -> None:
        self.new_job()
        self.run_cli("job", "advance", "cortadas-0001", "built")
        self.pr = pr_json(checks=[check_run("lint"), check_run("tests")])
        code, out = self.run_cli("sync")
        self.assertEqual(code, 0, out)
        self.assertEqual(self.stage(), "review")
        self.assertEqual(self.gh.call_args.args[0][:3], ["pr", "view", "42"])

    def test_red_ci_goes_back_to_build_and_escalates_on_the_second_time(self) -> None:
        self.new_job()
        self.pr = pr_json(checks=[check_run("lint", conclusion="FAILURE")])
        for expect_escalation in (False, True):
            self.run_cli("job", "advance", "cortadas-0001", "built")
            _, out = self.run_cli("sync")
            self.assertEqual(self.stage(), "build")
            self.assertEqual("escalate_model" in out, expect_escalation, out)

    def test_pending_ci_and_unlinked_jobs_do_nothing(self) -> None:
        self.new_job()
        self.run_cli("job", "advance", "cortadas-0001", "built")
        self.pr = pr_json(checks=[check_run("tests", "IN_PROGRESS", None)])
        _, out = self.run_cli("sync")
        self.assertEqual(out, "")
        self.assertEqual(self.stage(), "checks")

    def test_merged_pr_finishes_internal_job_and_marks_the_issue_done(self) -> None:
        self.new_job(stage="judge")
        self.run_cli("job", "advance", "cortadas-0001", "approved")
        self.pr = pr_json(state="MERGED")
        code, out = self.run_cli("sync")
        self.assertEqual(code, 0, out)
        self.assertEqual(self.stage(), "done")
        path, body = FakePlane.patches[-1]
        self.assertTrue(path.endswith(f"/projects/{PROJECT}/issues/issue-1/"))
        self.assertEqual(body, {"state": "s-done"})

    def test_gated_job_is_left_alone(self) -> None:
        self.new_job()
        self.run_cli("job", "advance", "cortadas-0001", "built")
        self.run_cli("gate", "open", "cortadas-0001", "--reason", "scope")
        self.pr = pr_json(checks=[check_run("lint")])
        self.run_cli("sync")
        self.assertEqual(self.stage(), "checks")

    def test_create_project_is_idempotent_by_identifier(self) -> None:
        code, out = self.run_cli("plane", "create-project", "--name", "Fractory", "--identifier", "fractory",
                                 "--url", self.url)  # fmt: skip
        self.assertEqual(code, 0, out)
        self.assertIn("created", out)
        _, out = self.run_cli("plane", "create-project", "--name", "Fractory", "--identifier", "FRACTORY",
                              "--url", self.url)  # fmt: skip
        self.assertIn("exists", out)
        self.assertEqual([p["identifier"] for p in FakePlane.projects], ["CORT", "FRACTORY"])

    def test_add_item_renders_markdown_and_dedupes(self) -> None:
        args = ("plane", "add-item", "--project", PROJECT, "--title", "Sync from CI", "--body", "- one\n- two",
                "--status", "ready", "--url", self.url)  # fmt: skip
        _, out = self.run_cli(*args)
        self.assertIn("created  sync-from-ci", out)
        self.assertEqual(FakePlane.issues[0]["state"], "s-todo")
        self.assertIn("<li>one</li>", FakePlane.issues[0]["description_html"])
        _, out = self.run_cli(*args)
        self.assertIn("exists", out)


if __name__ == "__main__":
    unittest.main()
