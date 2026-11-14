"""briefcheck: strict parsing and the model call path (claude faked at the runner)."""

from __future__ import annotations

import json
import unittest

from fractory import briefcheck


def claude_out(result: str) -> str:
    return json.dumps({"result": result, "is_error": False})


class BriefCheck(unittest.TestCase):
    def run_check(self, answer: str, card_text: str = "<p>Do <b>X</b></p>"):
        calls: list[tuple[list[str], str]] = []

        def runner(argv: list[str], stdin: str) -> str:
            calls.append((argv, stdin))
            return claude_out(answer)

        return briefcheck.check("Card", card_text, "brief body", runner), calls

    def test_ok(self) -> None:
        verdict, calls = self.run_check('{"ok": true, "extra": []}')
        self.assertEqual(verdict, briefcheck.Verdict(True, []))
        argv, prompt = calls[0]
        self.assertEqual(argv[argv.index("--model") + 1], "sonnet")
        self.assertIn("CARD: Card\nDo X", prompt)  # card HTML is converted to text
        self.assertNotIn("<b>", prompt)
        self.assertIn("brief body", prompt)

    def test_extra_items_and_fenced_json(self) -> None:
        verdict, _ = self.run_check('```json\n{"ok": false, "extra": [" adds a flag "]}\n```')
        self.assertEqual(verdict, briefcheck.Verdict(False, ["adds a flag"]))

    def test_malformed_answers_raise(self) -> None:
        for bad in (
            "not json",
            '{"ok": true}',
            '{"ok": "yes", "extra": []}',
            '{"ok": true, "extra": ["x"]}',
            '{"ok": false, "extra": []}',
            '{"ok": false, "extra": [""]}',
            '{"ok": true, "extra": [], "more": 1}',
        ):
            with self.subTest(bad=bad), self.assertRaises(briefcheck.BriefCheckError):
                self.run_check(bad)

    def test_model_failure_raises_briefcheck_error(self) -> None:
        def runner(argv: list[str], stdin: str) -> str:
            return "garbage"

        with self.assertRaises(briefcheck.BriefCheckError):
            briefcheck.check("t", "", "b", runner)


if __name__ == "__main__":
    unittest.main()
