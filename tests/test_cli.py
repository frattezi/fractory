"""End-to-end through `fractory` with a temporary FACTORY_HOME."""

from __future__ import annotations

import contextlib
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from fractory import cli


class CliCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp())
        self.home = self.tmp / "factory"
        self.able = self.tmp / "Able"
        self.repo = self.tmp / "cortadas"
        self.repo.mkdir()
        (self.able / "portal").mkdir(parents=True)
        patcher = mock.patch.dict(os.environ, {"FACTORY_HOME": str(self.home), "FRACTORY_ABLE_ROOT": str(self.able)})
        patcher.start()
        self.addCleanup(patcher.stop)

    def run_cli(self, *argv: str) -> tuple[int, str]:
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = cli.main(list(argv))
        return code, out.getvalue()

    def state(self, job_id: str) -> dict:
        return json.loads((self.home / "jobs" / job_id / "state.json").read_text())

    def walk(self, job_id: str, *events: str) -> None:
        for event in events:
            code, out = self.run_cli("job", "advance", job_id, event)
            self.assertEqual(code, 0, out)


class JobLifecycle(CliCase):
    def test_internal_job_runs_from_discovery_to_merged(self) -> None:
        code, out = self.run_cli("job", "new", "--repo", str(self.repo), "--title", "Chat no Plane")
        self.assertEqual(code, 0, out)
        self.assertIn("cortadas-0001", out)
        self.assertTrue((self.home / "jobs" / "cortadas-0001" / "holdout").is_dir())

        self.walk("cortadas-0001", "scoped", "planned", "built", "green", "reviewed", "approved", "merged")
        st = self.state("cortadas-0001")
        self.assertEqual(st["stage"], "done")
        self.assertEqual(st["kind"], "internal")
        self.assertEqual([h["event"] for h in st["history"]][-1], "merged")

    def test_ids_increment_per_repo(self) -> None:
        self.run_cli("job", "new", "--repo", str(self.repo), "--title", "a")
        _, out = self.run_cli("job", "new", "--repo", str(self.repo), "--title", "b")
        self.assertIn("cortadas-0002", out)

    def test_able_job_must_end_in_draft_pr(self) -> None:
        self.run_cli("job", "new", "--repo", str(self.able / "portal"), "--title", "x", "--stage", "build")
        self.walk("portal-0001", "built", "green", "reviewed", "approved")
        code, out = self.run_cli("job", "advance", "portal-0001", "merged")
        self.assertEqual(code, 1)
        self.assertIn("draft PR", out)
        self.walk("portal-0001", "draft_pr")
        self.assertEqual(self.state("portal-0001")["stage"], "done")

    def test_internal_job_cannot_end_in_draft_pr(self) -> None:
        self.run_cli("job", "new", "--repo", str(self.repo), "--title", "x", "--stage", "build")
        self.walk("cortadas-0001", "built", "green", "reviewed", "approved")
        code, _ = self.run_cli("job", "advance", "cortadas-0001", "draft_pr")
        self.assertEqual(code, 1)

    def test_event_not_allowed_in_stage_is_refused_and_state_unchanged(self) -> None:
        self.run_cli("job", "new", "--repo", str(self.repo), "--title", "x")
        code, out = self.run_cli("job", "advance", "cortadas-0001", "approved")
        self.assertEqual(code, 1)
        self.assertIn("not allowed", out)
        self.assertEqual(self.state("cortadas-0001")["stage"], "discovery")

    def test_cancel_from_any_working_stage(self) -> None:
        self.run_cli("job", "new", "--repo", str(self.repo), "--title", "x")
        self.walk("cortadas-0001", "scoped", "cancel")
        self.assertEqual(self.state("cortadas-0001")["stage"], "cancelled")
        _, out = self.run_cli("job", "list")
        self.assertIn("no jobs", out)
        _, out = self.run_cli("job", "list", "--all")
        self.assertIn("cortadas-0001", out)


class Escalation(CliCase):
    def setUp(self) -> None:
        super().setUp()
        self.run_cli("job", "new", "--repo", str(self.repo), "--title", "x", "--stage", "build")
        self.run_cli("job", "link", "cortadas-0001", "--profile", "backend")

    def test_same_check_red_twice_escalates_the_model(self) -> None:
        self.walk("cortadas-0001", "built")
        _, out = self.run_cli("job", "advance", "cortadas-0001", "red", "--check", "lint")
        self.assertNotIn("escalate_model", out)
        self.walk("cortadas-0001", "built")
        _, out = self.run_cli("job", "advance", "cortadas-0001", "red", "--check", "lint")
        self.assertIn("escalate_model", out)
        self.assertIn("--escalate-from backend", out)

    def test_different_checks_do_not_add_up(self) -> None:
        self.walk("cortadas-0001", "built")
        self.run_cli("job", "advance", "cortadas-0001", "red", "--check", "lint")
        self.walk("cortadas-0001", "built")
        _, out = self.run_cli("job", "advance", "cortadas-0001", "red", "--check", "tests")
        self.assertNotIn("escalate_model", out)

    def test_two_judge_rejections_open_a_gate_that_blocks_events(self) -> None:
        for _ in range(2):
            self.walk("cortadas-0001", "built", "green", "reviewed", "rejected")
        st = self.state("cortadas-0001")
        self.assertEqual(st["gate"]["reason"], "judge_rounds")
        code, out = self.run_cli("job", "advance", "cortadas-0001", "built")
        self.assertEqual(code, 1)
        self.assertIn("gate", out)
        _, out = self.run_cli("gate", "list")
        self.assertIn("judge_rounds", out)

        code, _ = self.run_cli("gate", "resolve", "cortadas-0001", "continue", "--note", "spec ajustada")
        self.assertEqual(code, 0)
        st = self.state("cortadas-0001")
        self.assertIsNone(st["gate"])
        self.assertEqual(st["judge_rounds"], 0)
        self.walk("cortadas-0001", "built")

    def test_spend_over_budget_opens_cost_gate_and_continue_extends_it(self) -> None:
        self.run_cli("job", "cost", "cortadas-0001", "30")
        self.assertIsNone(self.state("cortadas-0001")["gate"])
        _, out = self.run_cli("job", "cost", "cortadas-0001", "25")
        self.assertIn("gate opened (cost)", out)
        self.run_cli("gate", "resolve", "cortadas-0001", "continue")
        st = self.state("cortadas-0001")
        self.assertGreater(st["budget_usd"], st["cost_usd"])

    def test_gate_cancel_ends_the_job(self) -> None:
        self.run_cli("gate", "open", "cortadas-0001", "--reason", "scope", "--detail", "pedido mudou")
        self.run_cli("gate", "resolve", "cortadas-0001", "cancel")
        self.assertEqual(self.state("cortadas-0001")["stage"], "cancelled")


class Dash(CliCase):
    def test_dash_summarises_jobs(self) -> None:
        self.run_cli("job", "new", "--repo", str(self.repo), "--title", "a")
        self.run_cli("job", "new", "--repo", str(self.repo), "--title", "b")
        self.run_cli("gate", "open", "cortadas-0002", "--reason", "scope")
        self.run_cli("job", "cost", "cortadas-0001", "4.5")
        out_file = self.tmp / "dash.json"
        code, _ = self.run_cli("dash", "--out", str(out_file))
        self.assertEqual(code, 0)
        data = json.loads(out_file.read_text())
        self.assertEqual(data["totals"], {"open": 2, "gated": 1, "cost_usd": 4.5})
        self.assertEqual({j["id"] for j in data["jobs"]}, {"cortadas-0001", "cortadas-0002"})


if __name__ == "__main__":
    unittest.main()
