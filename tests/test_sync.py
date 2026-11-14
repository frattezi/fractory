"""`fractory sync` and the new Plane commands, end to end (gh stubbed, Plane faked over HTTP)."""

from __future__ import annotations

import contextlib
import io
import json
import os
import tempfile
import threading
import unittest
from datetime import date
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest import mock

from fractory import cli, rework, sync
from fractory.trackers import plane as plane_mod
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
        self.merged: list[str] = []
        gh = mock.patch.object(sync, "run_gh", side_effect=self.fake_gh)
        self.gh = gh.start()
        self.addCleanup(gh.stop)
        orch = mock.patch.object(rework, "run_cmd", return_value=(0, ""))
        orch.start()
        self.addCleanup(orch.stop)

    def fake_gh(self, args: list[str], cwd: str) -> str:
        if args[:2] == ["pr", "merge"]:
            self.merged.append(args[2])
            self.pr = pr_json(state="MERGED")
            return ""
        return self.pr

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
        self.run_cli("job", "link", "cortadas-0001", "--terminal", "term_1")

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
        FakePlane.issues.append({"id": "issue-1", "external_id": "", "external_source": ""})
        self.new_job(stage="judge")
        self.run_cli("job", "advance", "cortadas-0001", "approved")
        self.pr = pr_json(state="MERGED")
        code, out = self.run_cli("sync")
        self.assertEqual(code, 0, out)
        self.assertEqual(self.stage(), "done")
        path, body = FakePlane.patches[-1]
        self.assertTrue(path.endswith(f"/projects/{PROJECT}/issues/issue-1/"))
        self.assertEqual(body, {"state": "s-done", "target_date": date.today().isoformat()})

    def test_gated_job_is_left_alone(self) -> None:
        self.new_job()
        self.run_cli("job", "advance", "cortadas-0001", "built")
        self.run_cli("gate", "open", "cortadas-0001", "--reason", "scope")
        self.pr = pr_json(checks=[check_run("lint")])
        self.run_cli("sync")
        self.assertEqual(self.stage(), "checks")

    def test_watch_runs_sync_each_round_until_the_job_is_done(self) -> None:
        self.new_job()
        self.run_cli("job", "advance", "cortadas-0001", "built")
        self.pr = pr_json(checks=[check_run("lint")])
        with mock.patch.object(cli.time, "sleep") as sleep:
            code, out = self.run_cli("watch", "--every", "5", "--rounds", "3")
        self.assertEqual(code, 0, out)
        self.assertEqual(self.stage(), "review")
        self.assertEqual(self.gh.call_count, 3)
        self.assertEqual([c.args for c in sleep.call_args_list], [(5.0,), (5.0,)])

    def enable_auto_merge(self) -> None:
        (self.tmp / "factory").mkdir(exist_ok=True)
        (self.tmp / "factory" / "config.toml").write_text("auto_merge = true\n")

    def approved_with_green_ci(self) -> None:
        self.new_job(stage="judge")
        self.run_cli("job", "advance", "cortadas-0001", "approved")
        self.pr = pr_json(checks=[check_run("tests")])

    def test_auto_merge_merges_approved_internal_job_then_finishes_it(self) -> None:
        self.enable_auto_merge()
        self.approved_with_green_ci()
        _, out = self.run_cli("sync")
        self.assertIn("auto-merged PR 42", out)
        self.assertEqual(self.merged, ["42"])
        self.assertEqual(self.stage(), "ship")
        self.run_cli("sync")
        self.assertEqual(self.stage(), "done")

    def test_no_auto_merge_without_config(self) -> None:
        self.approved_with_green_ci()
        self.run_cli("sync")
        self.assertEqual(self.merged, [])

    def test_no_auto_merge_on_red_ci_or_before_approval(self) -> None:
        self.enable_auto_merge()
        self.new_job(stage="review")
        self.pr = pr_json(checks=[check_run("tests")])
        self.run_cli("sync")
        self.run_cli("job", "advance", "cortadas-0001", "reviewed")
        self.run_cli("job", "advance", "cortadas-0001", "approved")
        self.pr = pr_json(checks=[check_run("tests", conclusion="FAILURE")])
        self.run_cli("sync")
        self.assertEqual(self.merged, [])

    def test_create_project_is_idempotent_by_identifier(self) -> None:
        code, out = self.run_cli("plane", "create-project", "--name", "Fractory", "--identifier", "fractory",
                                 "--url", self.url)  # fmt: skip
        self.assertEqual(code, 0, out)
        self.assertIn("created", out)
        _, out = self.run_cli("plane", "create-project", "--name", "Fractory", "--identifier", "FRACTORY",
                              "--url", self.url)  # fmt: skip
        self.assertIn("exists", out)
        self.assertEqual([p["identifier"] for p in FakePlane.projects], ["CORT", "FRACTORY"])

    def label_names(self) -> list[str]:
        return [lb["name"] for lb in FakePlane.labels]

    def test_create_project_applies_standard_labels_and_views(self) -> None:
        _, out = self.run_cli("plane", "create-project", "--name", "Fractory", "--identifier", "FRACTORY",
                              "--url", self.url)  # fmt: skip
        self.assertEqual(self.label_names(), list(plane_mod.STANDARD_LABELS))
        self.assertIn(("fractory", "#1f6f78"), [(lb["name"], lb["color"]) for lb in FakePlane.labels])
        self.assertTrue(any(body == {"issue_views_view": True} for _, body in FakePlane.patches))
        self.assertNotIn("manual", out)

    def test_views_refused_by_the_api_prints_the_manual_step(self) -> None:
        FakePlane.reject_project_patch = True
        code, out = self.run_cli("plane", "create-project", "--name", "Fractory", "--identifier", "FRACTORY",
                                 "--url", self.url)  # fmt: skip
        self.assertEqual(code, 0, out)
        self.assertIn("manual", out)
        self.assertEqual(self.label_names(), list(plane_mod.STANDARD_LABELS))

    def test_setup_project_is_idempotent_and_fixes_drift(self) -> None:
        FakePlane.labels = [{"id": "x", "name": "humano", "color": "#000000", "description": "old"}]
        args = ("plane", "setup-project", "--project", PROJECT, "--url", self.url)
        code, out = self.run_cli(*args)
        self.assertEqual(code, 0, out)
        self.assertEqual(self.label_names(), list(plane_mod.STANDARD_LABELS)[2:3] + ["fractory", "automação", "design"])
        self.assertEqual(FakePlane.labels[0]["color"], "#e3a35f")
        FakePlane.posts.clear()
        self.run_cli(*args)
        self.assertEqual(FakePlane.posts, [])
        self.assertEqual(len(FakePlane.labels), 4)

    def test_setup_project_all_and_unknown_project(self) -> None:
        code, _ = self.run_cli("plane", "setup-project", "--all", "--url", self.url)
        self.assertEqual(code, 0)
        self.assertEqual(len(FakePlane.labels), 4)
        code, _ = self.run_cli("plane", "setup-project", "--project", "nope", "--url", self.url)
        self.assertEqual(code, 1)

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
