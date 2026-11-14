"""The Judge: parse_verdict units, and `fractory judge` / auto_judge sync end to end (claude and gh stubbed)."""

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

from fractory import cli, judge, rework, sync
from tests.test_plane_import import KEY, PROJECT, FakePlane, reset_fake


def verdict_json(
    decision: str = "approved",
    spec_match: bool = True,
    scope_creep: bool = False,
    reasons=("ok",),
    unverified=None,
) -> str:
    data = {"decision": decision, "spec_match": spec_match, "scope_creep": scope_creep, "reasons": list(reasons)}
    if unverified is not None:
        data["unverified"] = list(unverified)
    return json.dumps(data)


GREEN = [("lint", "SUCCESS"), ("test", "SUCCESS")]
RED = [("lint", "FAILURE"), ("test", "SUCCESS")]


class ParseVerdict(unittest.TestCase):
    def test_plain_and_fenced_json(self) -> None:
        for text in (verdict_json(), f"```json\n{verdict_json()}\n```", f"```\n{verdict_json()}\n```"):
            self.assertEqual(judge.parse_verdict(text).decision, "approved")

    def test_scope_creep_or_spec_mismatch_downgrades_approval(self) -> None:
        for kwargs in ({"scope_creep": True}, {"spec_match": False}):
            v = judge.parse_verdict(verdict_json(**kwargs))
            self.assertEqual(v.decision, "rejected")
            self.assertIn("downgraded", v.reasons[-1])

    def test_rejected_stays_rejected(self) -> None:
        self.assertEqual(judge.parse_verdict(verdict_json("rejected", reasons=("no tests",))).reasons, ("no tests",))

    def test_invalid_verdicts_raise(self) -> None:
        good = json.loads(verdict_json())
        bad = [
            "not json",
            "here you go: " + verdict_json(),
            "[]",
            json.dumps({k: v for k, v in good.items() if k != "reasons"}),
            json.dumps({**good, "extra": 1}),
            json.dumps({**good, "decision": "maybe"}),
            json.dumps({**good, "spec_match": "yes"}),
            json.dumps({**good, "scope_creep": 0}),
            json.dumps({**good, "reasons": []}),
            json.dumps({**good, "reasons": ["", "x"]}),
            json.dumps({**good, "reasons": "because"}),
        ]
        for text in bad:
            with self.subTest(text=text[:40]), self.assertRaises(judge.JudgeError):
                judge.parse_verdict(text)

    def test_prompt_carries_rubric_issue_and_diff(self) -> None:
        prompt = judge.build_prompt("Title", "Body", "+line")
        for part in (judge.RUBRIC, "Title", "Body", "+line", "ONLY a JSON object"):
            self.assertIn(part, prompt)

    def test_prompt_lists_ci_results_only_when_given(self) -> None:
        prompt = judge.build_prompt("T", "B", "+x", checks=RED)
        self.assertIn("\nCI RESULTS\n", prompt)
        self.assertIn("- lint: FAILURE", prompt)
        self.assertIn("- test: SUCCESS", prompt)
        self.assertIn('"unverified"', prompt)
        self.assertNotIn("\nCI RESULTS\n", judge.build_prompt("T", "B", "+x"))

    def test_rejection_on_only_unverified_findings_is_approved_with_notes_when_ci_green(self) -> None:
        text = verdict_json(
            "rejected", reasons=("could not verify ruff passes",), unverified=["could not verify ruff passes"]
        )
        v = judge.parse_verdict(text, GREEN)
        self.assertEqual(v.decision, "approved")
        self.assertEqual(v.unverified, ("could not verify ruff passes",))
        self.assertIn("could not verify ruff passes", v.comment_markdown())
        self.assertIn("could not verify ruff passes", v.comment_html())

    def test_same_rejection_stays_rejected_with_red_pending_or_no_ci(self) -> None:
        text = verdict_json("rejected", reasons=("maybe lint",), unverified=["maybe lint"])
        for checks in (RED, [("lint", "PENDING")], [], None):
            with self.subTest(checks=checks):
                self.assertEqual(judge.parse_verdict(text, checks).decision, "rejected")

    def test_rejection_with_a_verified_reason_stays_rejected_on_green_ci(self) -> None:
        text = verdict_json("rejected", reasons=("no tests", "maybe lint"), unverified=["maybe lint"])
        self.assertEqual(judge.parse_verdict(text, GREEN).decision, "rejected")

    def test_unverified_must_be_a_list_of_strings(self) -> None:
        for bad in ("maybe", [""], [1]):
            with self.subTest(bad=bad), self.assertRaises(judge.JudgeError):
                judge.parse_verdict(
                    verdict_json("rejected", unverified=None).replace("}", f', "unverified": {json.dumps(bad)}}}')
                )

    def test_prompt_includes_brief_only_when_present(self) -> None:
        with_brief = judge.build_prompt("T", "B", "+x", brief="Touch only a.py")
        self.assertIn("\nBRIEF\n", with_brief)
        self.assertIn("Touch only a.py", with_brief)
        self.assertIn("beyond both", with_brief)
        for brief in (None, "", "  \n"):
            self.assertNotIn("\nBRIEF\n", judge.build_prompt("T", "B", "+x", brief=brief))

    def test_html_to_text(self) -> None:
        text = judge.html_to_text("<h2>Goal</h2><p>Do <code>x</code> &amp; y</p><ul><li>one</li><li>two</li></ul>")
        self.assertEqual(text, "Goal\n\nDo x & y\n\n\n- one\n- two".replace("\n\n\n", "\n\n"))

    def test_ask_model_reads_result_field(self) -> None:
        runner = mock.Mock(return_value=json.dumps({"result": "hi"}))
        self.assertEqual(judge.ask_model("p", runner), "hi")
        argv, stdin = runner.call_args.args
        self.assertEqual(argv, ["claude", "-p", "--model", "opus", "--output-format", "json"])
        self.assertEqual(stdin, "p")
        with self.assertRaises(judge.JudgeError):
            judge.ask_model("p", lambda *_: "garbage")


def file_diff(path: str, added: int = 2) -> str:
    body = "".join(f"+line {i}\n" for i in range(added))
    return f"diff --git a/{path} b/{path}\nindex 1..2 100644\n--- a/{path}\n+++ b/{path}\n@@ -0,0 +1,{added} @@\n{body}"


class TrimDiff(unittest.TestCase):
    def test_lockfile_dropped_with_stub_and_normal_file_kept_byte_for_byte(self) -> None:
        normal = file_diff("src/app.py")
        trimmed, dropped = judge.trim_diff(normal + file_diff("pnpm-lock.yaml", 50))
        self.assertEqual(dropped, ["pnpm-lock.yaml"])
        self.assertEqual(trimmed, normal + "# pnpm-lock.yaml: generated file, 50 lines changed, not shown\n")

    def test_no_generated_file_returns_diff_unchanged(self) -> None:
        diff = file_diff("a.py") + file_diff("b/c.ts")
        self.assertEqual(judge.trim_diff(diff), (diff, []))

    def test_default_generated_names_and_dirs(self) -> None:
        paths = ["web/package-lock.json", "uv.lock", "go.sum", "a/x.min.js", "x.snap", "dist/a.js", "pkg/build/b.js"]
        _, dropped = judge.trim_diff("".join(file_diff(p) for p in paths))
        self.assertEqual(dropped, paths)

    def test_svg_only_dropped_over_200_lines(self) -> None:
        _, dropped = judge.trim_diff(file_diff("small.svg", 200) + file_diff("big.svg", 201))
        self.assertEqual(dropped, ["big.svg"])

    def test_config_patterns_add_to_defaults(self) -> None:
        diff = file_diff("api/schema.generated.ts") + file_diff("src/app.py")
        self.assertEqual(judge.trim_diff(diff)[1], [])
        self.assertEqual(judge.trim_diff(diff, ["*.generated.ts"])[1], ["api/schema.generated.ts"])

    def test_prompt_lists_dropped_paths(self) -> None:
        self.assertIn("- pnpm-lock.yaml", judge.build_prompt("T", "B", "+x", dropped=["pnpm-lock.yaml"]))
        self.assertNotIn("GENERATED FILES", judge.build_prompt("T", "B", "+x"))


class JudgeCli(unittest.TestCase):
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

        self.diff = "+def feature(): ...\n"
        self.model_reply = verdict_json()
        self.pr_comments: list[str] = []
        for target, fake in (
            (sync, mock.patch.object(sync, "run_gh", side_effect=self.fake_gh)),
            (judge, mock.patch.object(judge, "run_claude", side_effect=self.fake_claude)),
        ):
            self.addCleanup(fake.stop)
            setattr(self, "gh" if target is sync else "claude", fake.start())

        orch = mock.patch.object(rework, "run_cmd", return_value=(0, ""))
        orch.start()
        self.addCleanup(orch.stop)

        FakePlane.issues.append(
            {"id": "issue-1", "name": "Add feature", "description_html": "<p>Add the feature.</p>", "external_id": "x",
             "external_source": "fractory"}
        )  # fmt: skip
        self.run_cli(
            "job", "new", "--repo", str(self.repo), "--title", "x", "--stage", "review",
            "--tracker", "plane", "--project", PROJECT, "--ref", "issue-1", "--plane-url", self.url,
        )  # fmt: skip
        self.run_cli("job", "link", "cortadas-0001", "--pr", "42", "--terminal", "term_1")

    def fake_gh(self, args: list[str], cwd: str) -> str:
        if args[:2] == ["pr", "diff"]:
            return self.diff
        if args[:2] == ["pr", "comment"]:
            self.pr_comments.append(args[-1])
            return ""
        return json.dumps({"state": "OPEN", "isDraft": False, "statusCheckRollup": []})

    def fake_claude(self, argv: list[str], stdin: str) -> str:
        self.prompt = stdin
        return json.dumps({"result": self.model_reply})

    def run_cli(self, *argv: str) -> tuple[int, str]:
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = cli.main(list(argv))
        return code, out.getvalue()

    def job(self) -> dict:
        return json.loads((self.tmp / "factory" / "jobs" / "cortadas-0001" / "state.json").read_text())

    def test_approved_ships_and_posts_both_comments(self) -> None:
        code, out = self.run_cli("judge", "cortadas-0001")
        self.assertEqual(code, 0, out)
        self.assertEqual(self.job()["stage"], "ship")
        self.assertIn("Add the feature.", self.prompt)
        self.assertIn("+def feature()", self.prompt)
        self.assertIn("Fractory judge: approved", self.pr_comments[0])
        ((path, body),) = FakePlane.comments
        self.assertTrue(path.endswith("/issues/issue-1/comments/"))
        self.assertIn("Fractory judge: approved", body["comment_html"])

    def test_rejected_goes_back_to_build_with_reasons_in_history(self) -> None:
        self.model_reply = verdict_json("rejected", reasons=("no tests", "skipped a test"))
        code, out = self.run_cli("judge", "cortadas-0001")
        self.assertEqual(code, 0, out)
        job = self.job()
        self.assertEqual(job["stage"], "build")
        self.assertEqual(job["history"][-2]["event"], "rejected")
        self.assertEqual(job["history"][-2]["note"], "no tests; skipped a test")
        self.assertEqual(job["history"][-1]["event"], "rework_sent")
        self.assertEqual(len(FakePlane.comments), 1)

    def test_approved_with_scope_creep_is_rejected(self) -> None:
        self.model_reply = verdict_json(scope_creep=True)
        self.run_cli("judge", "cortadas-0001")
        self.assertEqual(self.job()["stage"], "build")

    def test_malformed_output_opens_judge_error_gate_and_stays_in_review(self) -> None:
        self.model_reply = "I think it looks fine"
        code, out = self.run_cli("judge", "cortadas-0001")
        self.assertEqual(code, 0, out)
        job = self.job()
        self.assertEqual((job["stage"], job["gate"]["reason"]), ("review", "judge_error"))
        self.assertEqual((self.pr_comments, FakePlane.comments), ([], []))

    def test_huge_lockfile_does_not_open_judge_error(self) -> None:
        self.diff = file_diff("src/feature.py") + file_diff("pnpm-lock.yaml", judge.MAX_DIFF_CHARS)
        self.run_cli("judge", "cortadas-0001")
        self.assertEqual(self.job()["stage"], "ship")
        self.assertIn("+line 0", self.prompt)
        self.assertIn("- pnpm-lock.yaml", self.prompt)
        self.assertNotIn("+line 5000", self.prompt)

    def test_oversized_diff_gates_without_calling_the_model(self) -> None:
        self.diff = "x" * (judge.MAX_DIFF_CHARS + 1)
        self.run_cli("judge", "cortadas-0001")
        self.assertEqual(self.job()["gate"]["detail"], "diff too large")
        self.claude.assert_not_called()

    def write_brief(self, text: str) -> None:
        path = self.tmp / "factory" / "jobs" / "cortadas-0001" / "brief.md"
        path.write_text(text)

    def test_brief_reaches_the_prompt(self) -> None:
        self.write_brief("Also add the helper.")
        self.run_cli("judge", "cortadas-0001")
        self.assertIn("\nBRIEF\n", self.prompt)
        self.assertIn("Also add the helper.", self.prompt)

    def test_no_brief_file_means_no_brief_section(self) -> None:
        self.run_cli("judge", "cortadas-0001")
        self.assertNotIn("\nBRIEF\n", self.prompt)

    def test_oversized_brief_gates_without_calling_the_model(self) -> None:
        self.write_brief("x" * (judge.MAX_BRIEF_CHARS + 1))
        self.run_cli("judge", "cortadas-0001")
        self.assertEqual(self.job()["gate"]["detail"], "brief too large")
        self.claude.assert_not_called()

    def test_approval_beyond_card_but_within_brief_is_not_downgraded_by_code(self) -> None:
        self.write_brief("Also add the helper the card does not mention.")
        self.diff = "+def feature(): ...\n+def helper(): ...\n"
        self.model_reply = verdict_json(scope_creep=False, reasons=("helper is in the brief",))
        self.run_cli("judge", "cortadas-0001")
        job = self.job()
        self.assertEqual(job["stage"], "ship")
        self.assertEqual(job["history"][-1]["note"], "helper is in the brief")

    def test_second_rejection_opens_judge_rounds_gate(self) -> None:
        self.model_reply = verdict_json("rejected")
        self.run_cli("judge", "cortadas-0001")
        self.run_cli("job", "advance", "cortadas-0001", "built")
        self.run_cli("job", "advance", "cortadas-0001", "green")
        self.run_cli("judge", "cortadas-0001")
        self.assertEqual(self.job()["gate"]["reason"], "judge_rounds")

    def test_wrong_stage_is_refused(self) -> None:
        self.run_cli("judge", "cortadas-0001")  # now in ship
        code, _ = self.run_cli("judge", "cortadas-0001")
        self.assertEqual(code, 1)

    def test_sync_judges_only_with_auto_judge(self) -> None:
        self.run_cli("sync")
        self.assertEqual(self.job()["stage"], "review")
        self.claude.assert_not_called()
        (self.tmp / "factory" / "config.toml").write_text("auto_judge = true\n")
        code, out = self.run_cli("sync")
        self.assertEqual(code, 0, out)
        self.assertEqual(self.job()["stage"], "ship")
        self.claude.assert_called_once()


if __name__ == "__main__":
    unittest.main()
