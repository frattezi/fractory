"""`fractory launch` with a fake runner (orca, orch.py) and a fake Plane."""

from __future__ import annotations

import contextlib
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from fractory import briefcheck, cli, launch


class FakePlane:
    def get_item(self, ref: str) -> dict:
        return {"id": ref, "name": "Launch: job, worktree and worker!"}


class LaunchCli(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp())
        self.repo = self.tmp / "cortadas"
        self.repo.mkdir()
        self.brief = self.tmp / "brief.md"
        self.brief.write_text("# do the thing\n")
        env = mock.patch.dict(os.environ, {"FACTORY_HOME": str(self.tmp / "factory"), "PLANE_API_KEY": "k"})
        env.start()
        self.addCleanup(env.stop)
        plane = mock.patch.object(cli.plane_mod, "Plane", return_value=FakePlane())
        plane.start()
        self.addCleanup(plane.stop)
        self.verdict: briefcheck.Verdict | Exception = briefcheck.Verdict(True, [])
        self.checked: list[tuple[str, str, str]] = []
        check = mock.patch.object(briefcheck, "check", side_effect=self.fake_check)
        check.start()
        self.addCleanup(check.stop)
        self.calls: list[list[str]] = []
        self.fail_on: str | None = None
        runner = mock.patch.object(launch, "run_cmd", side_effect=self.fake_run)
        runner.start()
        self.addCleanup(runner.stop)

    def fake_check(self, title: str, text: str, brief: str) -> briefcheck.Verdict:
        self.checked.append((title, text, brief))
        if isinstance(self.verdict, Exception):
            raise self.verdict
        return self.verdict

    def fake_run(self, argv: list[str]) -> tuple[int, str]:
        self.calls.append(argv)
        if self.fail_on and self.fail_on in argv:
            return 1, "boom"
        if "worktree" in argv:
            return 0, json.dumps({"ok": True, "result": {"worktree": {"id": "repo::/wt/launch"}}})
        return 0, "launched dispatch d1 in terminal term_abc (stage running)\n"

    def run_cli(self, *extra: str, run: str | None = "run_1") -> tuple[int, str]:
        argv = ["launch", "--repo", str(self.repo), "--issue", "iss-1", "--project", "proj", "--brief", str(self.brief)]
        if run:
            argv += ["--run", run]
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = cli.main(argv + list(extra))
        return code, out.getvalue()

    def job(self, job_id: str = "cortadas-0001") -> dict:
        return json.loads((self.tmp / "factory" / "jobs" / job_id / "state.json").read_text())

    def test_happy_path_runs_six_steps_and_links_the_job(self) -> None:
        code, out = self.run_cli()
        self.assertEqual(code, 0, out)
        wt, orch = self.calls
        self.assertEqual(wt[1:3], ["worktree", "create"])
        self.assertEqual(wt[wt.index("--repo") + 1], f"path:{self.repo.resolve()}")
        self.assertEqual(wt[wt.index("--name") + 1], "launch-job-worktree-and-worker")
        self.assertIn("--no-parent", wt)
        brief = self.tmp / "factory" / "jobs" / "cortadas-0001" / "brief.md"
        self.assertEqual(brief.read_text(), "# do the thing\n")
        self.assertEqual(orch[2], "launch")
        for flag, value in {
            "--run": "run_1",
            "--worktree": "id:repo::/wt/launch",
            "--title": "cortadas-0001 Launch: job, worktree and worker!",
            "--spec-file": str(brief),
            "--profile": "strong",
        }.items():
            self.assertEqual(orch[orch.index(flag) + 1], value)
        self.assertIn("--trust", orch)
        job = self.job()
        self.assertEqual((job["stage"], job["gate"]), ("build", None))
        self.assertEqual(job["tracker"]["ref"], "iss-1")
        self.assertEqual(
            job["links"], {"worktree": "launch-job-worktree-and-worker", "terminal": "term_abc", "profile": "strong"}
        )

    def test_failing_worktree_opens_gate_and_does_not_launch(self) -> None:
        self.fail_on = "worktree"
        code, out = self.run_cli("--title", "x")
        self.assertEqual(code, 1)
        self.assertEqual(len(self.calls), 1)
        job = self.job()
        self.assertEqual(job["stage"], "build")
        self.assertEqual(job["gate"]["reason"], "launch_failed")
        self.assertIn("4 worktree create", job["gate"]["detail"])
        self.assertIn("done so far", out)

    def test_dry_run_creates_nothing(self) -> None:
        code, out = self.run_cli("--dry-run")
        self.assertEqual(code, 0, out)
        self.assertEqual(self.calls, [])
        self.assertFalse((self.tmp / "factory" / "jobs").exists())
        self.assertIn("worktree create", out)

    def test_missing_run_id_errors_before_any_step(self) -> None:
        code, out = self.run_cli(run=None)
        self.assertEqual(code, 1)
        self.assertIn("orca_run", out)
        self.assertEqual(self.calls, [])
        self.assertFalse((self.tmp / "factory" / "jobs").exists())

    def test_run_defaults_from_config(self) -> None:
        (self.tmp / "factory").mkdir()
        (self.tmp / "factory" / "config.toml").write_text('orca_run = "run_cfg"\n')
        code, _ = self.run_cli(run=None)
        self.assertEqual(code, 0)
        self.assertEqual(self.calls[1][self.calls[1].index("--run") + 1], "run_cfg")

    def test_brief_beyond_card_stops_before_creating_anything(self) -> None:
        self.verdict = briefcheck.Verdict(False, ["adds a --force flag"])
        code, out = self.run_cli()
        self.assertEqual(code, 1)
        self.assertIn("adds a --force flag", out)
        self.assertEqual(self.calls, [])
        self.assertFalse((self.tmp / "factory" / "jobs").exists())
        self.assertEqual(self.checked[0][0], "Launch: job, worktree and worker!")
        self.assertEqual(self.checked[0][2], "# do the thing\n")

    def test_force_continues_and_records_items_in_history(self) -> None:
        self.verdict = briefcheck.Verdict(False, ["adds a --force flag"])
        code, out = self.run_cli("--force")
        self.assertEqual(code, 0, out)
        self.assertEqual(len(self.calls), 2)
        events = [h for h in self.job()["history"] if h["event"] == "brief_beyond_card"]
        self.assertEqual(events[0]["extra"], ["adds a --force flag"])

    def test_ok_brief_records_nothing(self) -> None:
        code, _ = self.run_cli()
        self.assertEqual(code, 0)
        self.assertFalse([h for h in self.job()["history"] if h["event"] == "brief_beyond_card"])

    def test_dry_run_runs_the_check_too(self) -> None:
        self.verdict = briefcheck.Verdict(False, ["x"])
        code, out = self.run_cli("--dry-run")
        self.assertEqual(code, 1)
        self.assertEqual(len(self.checked), 1)
        self.assertIn("  - x", out)

    def test_checker_error_warns_and_continues(self) -> None:
        self.verdict = briefcheck.BriefCheckError("claude failed")
        code, out = self.run_cli()
        self.assertEqual(code, 0, out)
        self.assertIn("warning: brief check failed", out)
        self.assertEqual(len(self.calls), 2)


if __name__ == "__main__":
    unittest.main()
