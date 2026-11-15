"""Portuguese wording of gates and stuck reasons, from the exact strings the code produces."""

from __future__ import annotations

import unittest

from fractory import pt, risk


class GateText(unittest.TestCase):
    def test_merge_review_from_real_risk_summaries(self) -> None:
        sensitive = risk.assess([("db/migrations/001.sql", 10, 0)])
        self.assertEqual(pt.gate_text("merge_review", sensitive.summary()), "Revisar merge: mexe em migração")
        big = risk.assess([("a.py", 600, 89)])
        self.assertEqual(pt.gate_text("merge_review", big.summary()), "Revisar merge: 689 linhas (limite 400)")
        many = risk.assess([(f"f{i}.py", 100, 0) for i in range(13)])
        self.assertEqual(
            pt.gate_text("merge_review", many.summary()),
            "Revisar merge: 1300 linhas (limite 400); 13 arquivos (limite 12)",
        )

    def test_merge_review_has_no_english_left(self) -> None:
        for path, word in (("src/auth/x.py", "autenticação"), ("infra/main.tf", "infraestrutura")):
            text = pt.gate_text("merge_review", risk.assess([(path, 1, 1)]).summary())
            self.assertIn(word, text)
            self.assertNotIn("sensitive", text)
        self.assertEqual(pt.gate_text("merge_review", "low: small, no sensitive paths"), "Revisar merge")
        self.assertEqual(pt.gate_text("merge_review", ""), "Revisar merge")

    def test_every_gate_the_code_opens(self) -> None:
        cases = {
            ("cost", "US$ 52.00 over budget US$ 50.00"): "Orçamento estourado: US$ 52.00 de US$ 50.00",
            ("judge_rounds", "2 judge rounds without passing"): "O Judge reprovou 2 vezes: decidir como seguir",
            ("judge_error", "claude exited 1"): "O Judge falhou ao revisar o PR",
            ("launch_failed", "worktree: boom"): "Falha ao lançar o job: o worker não subiu",
            ("rework_needed", "[fractory] Rework on x"): "Retrabalho pendente: não consegui avisar o worker",
            ("merge_conflict", "[fractory] Rework on x"): "O PR tem conflito com a main e o worker não foi avisado",
            ("whatever", "x"): "Decisão pendente (whatever)",
        }
        for (reason, detail), expected in cases.items():
            self.assertEqual(pt.gate_text(reason, detail), expected, reason)

    def test_odd_details_fall_back_without_raising(self) -> None:
        self.assertEqual(pt.gate_text("cost", "???"), "Orçamento estourado")
        self.assertEqual(pt.gate_text("judge_rounds", ""), "O Judge reprovou várias vezes: decidir como seguir")


class StuckReason(unittest.TestCase):
    def test_reasons(self) -> None:
        self.assertEqual(pt.stuck_reason("stage", "build", "2h10"), "em construção há 2h10 sem PR")
        self.assertEqual(pt.stuck_reason("stage", "build", "2h10", has_pr=True), "em construção há 2h10")
        self.assertEqual(pt.stuck_reason("stage", "checks", "45 min"), "CI rodando há 45 min")
        self.assertEqual(pt.stuck_reason("stage", "review", "30 min"), "em revisão há 30 min")
        self.assertEqual(pt.stuck_reason("gate", "review", "5 min", "cost"), "gate cost aberto há 5 min")


if __name__ == "__main__":
    unittest.main()
