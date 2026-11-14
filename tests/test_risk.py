"""Risk scoring and the merge decision in `fractory sync` (gh stubbed)."""

from __future__ import annotations

import contextlib
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from fractory import cli, rework, risk, sync


class Assess(unittest.TestCase):
    def test_small_plain_diff_is_low(self) -> None:
        r = risk.assess([("fractory/cli.py", 10, 5)], {})
        self.assertEqual((r.level, r.reasons), ("low", ()))

    def test_sensitive_paths_are_high_with_reason(self) -> None:
        for path in ("src/auth/login.py", "db/migrations/1.sql", "infra/main.tf", ".github/ci.yml",
                     "fractory/rubric.md", "fractory/launchd.py", "app/secrets.py"):  # fmt: skip
            r = risk.assess([("README.md", 1, 0), (path, 1, 0)], {})
            self.assertEqual(r.level, "high", path)
            self.assertIn(path, r.reasons[0])

    def test_many_lines_or_files_is_medium(self) -> None:
        lines = risk.assess([("a.py", 300, 101)], {})
        self.assertEqual(lines.level, "medium")
        self.assertIn("401 lines", lines.reasons[0])
        files = risk.assess([(f"f{i}.py", 1, 0) for i in range(13)], {})
        self.assertEqual(files.level, "medium")
        self.assertIn("13 files", files.reasons[0])
        self.assertEqual(risk.assess([("a.py", 400, 0)], {}).level, "low")

    def test_high_beats_medium(self) -> None:
        self.assertEqual(risk.assess([("auth.py", 999, 0)], {}).level, "high")

    def test_config_overrides_patterns_and_thresholds(self) -> None:
        self.assertEqual(risk.assess([("auth.py", 1, 0)], {"sensitive": ["billing"]}).level, "low")
        self.assertEqual(risk.assess([("billing/x.py", 1, 0)], {"sensitive": ["billing"]}).level, "high")
        self.assertEqual(risk.assess([("a.py", 11, 0)], {"max_lines": 10}).level, "medium")
        self.assertEqual(risk.assess([("a.py", 1, 0), ("b.py", 1, 0)], {"max_files": 1}).level, "medium")


class PrFiles(unittest.TestCase):
    def test_parses_gh_files(self) -> None:
        out = json.dumps({"files": [{"path": "a.py", "additions": 3, "deletions": 1}]})
        gh = mock.Mock(return_value=out)
        self.assertEqual(sync.pr_files("/r", "7", gh), [("a.py", 3, 1)])
        gh.assert_called_once_with(["pr", "view", "7", "--json", "files"], "/r")


class MergeDecision(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp())
        self.repo = self.tmp / "cortadas"
        self.repo.mkdir()
        env = mock.patch.dict(os.environ, {"FACTORY_HOME": str(self.tmp / "factory")})
        env.start()
        self.addCleanup(env.stop)
        (self.tmp / "factory").mkdir()
        self.config("auto_merge = true\n")
        self.files: list[dict] = []
        self.merged: list[str] = []
        for target, name, fn in ((sync, "run_gh", self.fake_gh), (rework, "run_cmd", lambda *a, **k: (0, ""))):
            p = mock.patch.object(target, name, fn)
            p.start()
            self.addCleanup(p.stop)
        self.run_cli("job", "new", "--repo", str(self.repo), "--title", "x", "--stage", "judge")
        self.run_cli("job", "link", "cortadas-0001", "--pr", "42")
        self.run_cli("job", "advance", "cortadas-0001", "approved")

    def config(self, text: str) -> None:
        (self.tmp / "factory" / "config.toml").write_text(text)

    def fake_gh(self, args: list[str], cwd: str) -> str:
        if args[:2] == ["pr", "merge"]:
            self.merged.append(args[2])
            return ""
        if args[-1] == "files":
            return json.dumps({"files": self.files})
        checks = [{"__typename": "CheckRun", "name": "t", "status": "COMPLETED", "conclusion": "SUCCESS"}]
        return json.dumps({"state": "OPEN", "isDraft": False, "statusCheckRollup": checks})

    def run_cli(self, *argv: str) -> tuple[int, str]:
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = cli.main(list(argv))
        return code, out.getvalue()

    def state(self) -> dict:
        return json.loads((self.tmp / "factory" / "jobs" / "cortadas-0001" / "state.json").read_text())

    def risk_events(self) -> list[dict]:
        return [h for h in self.state()["history"] if h["event"] == "risk"]

    def test_low_risk_merges_and_records_event(self) -> None:
        self.files = [{"path": "a.py", "additions": 5, "deletions": 1}]
        _, out = self.run_cli("sync")
        self.assertEqual(self.merged, ["42"])
        self.assertIn("auto-merged", out)
        self.assertEqual([(e["level"], e["reasons"]) for e in self.risk_events()], [("low", [])])
        self.assertIsNone(self.state()["gate"])

    def test_high_risk_opens_merge_review_and_does_not_merge(self) -> None:
        self.files = [{"path": "infra/main.tf", "additions": 1, "deletions": 0}]
        self.run_cli("sync")
        self.assertEqual(self.merged, [])
        gate = self.state()["gate"]
        self.assertEqual(gate["reason"], "merge_review")
        self.assertTrue(gate["detail"].startswith("high: "))
        self.assertIn("infra/main.tf", gate["detail"])
        self.assertEqual(self.risk_events()[0]["level"], "high")
        self.run_cli("sync")  # gate open: no second assessment, still no merge
        self.assertEqual((self.merged, len(self.risk_events())), ([], 1))

    def test_medium_risk_opens_merge_review(self) -> None:
        self.files = [{"path": "a.py", "additions": 500, "deletions": 0}]
        self.run_cli("sync")
        self.assertEqual(self.merged, [])
        self.assertTrue(self.state()["gate"]["detail"].startswith("medium: "))

    def test_resolving_merge_review_with_continue_merges(self) -> None:
        self.files = [{"path": "auth.py", "additions": 1, "deletions": 0}]
        self.run_cli("sync")
        self.run_cli("gate", "resolve", "cortadas-0001", "continue")
        self.run_cli("sync")
        self.assertEqual(self.merged, ["42"])

    def test_risk_config_table_is_used(self) -> None:
        self.config('auto_merge = true\n[risk]\nsensitive = ["billing"]\n')
        self.files = [{"path": "auth.py", "additions": 1, "deletions": 0}]
        self.run_cli("sync")
        self.assertEqual(self.merged, ["42"])

    def test_without_auto_merge_nothing_is_assessed(self) -> None:
        self.config("")
        self.files = [{"path": "auth.py", "additions": 1, "deletions": 0}]
        self.run_cli("sync")
        self.assertEqual((self.merged, self.risk_events(), self.state()["gate"]), ([], [], None))

    def test_status_shows_last_risk(self) -> None:
        self.files = [{"path": "infra/main.tf", "additions": 1, "deletions": 0}]
        self.run_cli("sync")
        _, out = self.run_cli("job", "status", "cortadas-0001")
        self.assertIn("risk: high", out)
        self.assertIn("infra/main.tf", out)


if __name__ == "__main__":
    unittest.main()
