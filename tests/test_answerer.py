"""Answerer: strict parsing, the deterministic category override, docs lookup."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from fractory import answerer, judge

CATS = answerer.CATEGORIES


def reply(decision="answer", answer="a", source="card", category="none") -> str:
    return json.dumps({"decision": decision, "answer": answer, "source": source, "category": category})


class ParseDecision(unittest.TestCase):
    def test_answer_and_fenced_answer(self) -> None:
        self.assertTrue(answerer.parse_decision(reply(), CATS).answered)
        self.assertTrue(answerer.parse_decision(f"```json\n{reply()}\n```", CATS).answered)

    def test_listed_category_escalates_whatever_the_model_decided(self) -> None:
        d = answerer.parse_decision(reply(category="money"), CATS)
        self.assertEqual((d.decision, d.answer), ("escalate", "a"))

    def test_malformed_replies_raise(self) -> None:
        for bad in (
            "nope",
            "[]",
            "{}",
            reply(decision="maybe"),
            reply(answer=" "),
            reply(source=""),
            '{"decision": 1}',
        ):
            with self.assertRaises(answerer.AnswererError, msg=bad):
                answerer.parse_decision(bad, CATS)

    def test_decide_turns_malformed_and_model_failures_into_escalations(self) -> None:
        def run(argv, stdin, cwd=None):
            return json.dumps({"result": "I think so"})

        def boom(argv, stdin, cwd=None):
            raise judge.JudgeError("down")

        for runner in (run, boom):
            d = answerer.decide("p", CATS, runner)
            self.assertEqual((d.decision, d.category), ("escalate", "answerer_error"))


class Settings(unittest.TestCase):
    def test_defaults_and_config(self) -> None:
        self.assertEqual(answerer.settings({}), (True, CATS))
        self.assertEqual(answerer.settings({"answerer": {"enabled": False, "escalate": ["x"]}}), (False, ("x",)))


class Docs(unittest.TestCase):
    def test_only_existing_files_inside_the_repo(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp) / "repo"
            (repo / "docs").mkdir(parents=True)
            (repo / "docs" / "a.md").write_text("A")
            (Path(tmp) / "secret.md").write_text("S")
            found = answerer.docs_for("see docs/a.md, ../secret.md, docs/missing.md, docs/a.md", repo)
            self.assertEqual(found, [("docs/a.md", "A")])


if __name__ == "__main__":
    unittest.main()
