"""PR-review and settled-worker cleanup with a fake runner and a fixture pr-triage DB."""

from __future__ import annotations

import contextlib
import io
import json
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from fractory import prcleanup, state, store

ROOT = "/orca/modmon"


def wt_id(n: int) -> str:
    return f"r1::{ROOT}/pr-{n}"


class PrCleanup(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp())
        env = mock.patch.dict(os.environ, {"FACTORY_HOME": str(self.tmp / "factory")})
        env.start()
        self.addCleanup(env.stop)
        self.db = self.tmp / "pr_triage.db"
        con = sqlite3.connect(self.db)
        con.execute("CREATE TABLE pr_reviews (repo TEXT, number INTEGER, state TEXT, worktree TEXT, terminal TEXT)")
        con.commit()
        con.close()
        self.calls: list[list[str]] = []
        self.status: dict[str, str] = {}
        self.unpushed: dict[str, str] = {}
        self.gh_state = "OPEN"
        self.worktrees = [{"id": "r1::/main", "path": "/main", "isMainWorktree": True}]
        self.terminals: list[dict] = []
        self.workers: list[dict] = []

    def add_review(self, n: int, st: str) -> None:
        con = sqlite3.connect(self.db)
        con.execute("INSERT INTO pr_reviews VALUES ('o/mm', ?, ?, ?, ?)", (n, st, wt_id(n), f"term_{n}"))
        con.commit()
        con.close()
        self.worktrees.append({"id": wt_id(n), "path": f"{ROOT}/pr-{n}"})
        self.terminals.append({"handle": f"term_{n}", "worktreeId": wt_id(n)})

    def fake(self, argv: list[str]) -> tuple[int, str]:
        self.calls.append(argv)
        if argv[:3] == ["orca", "worktree", "list"]:
            assert "--limit" in argv, "an unbounded listing is truncated by Orca"
            return 0, json.dumps({"result": {"worktrees": self.worktrees}})
        if argv[:3] == ["orca", "terminal", "list"]:
            return 0, json.dumps({"result": {"terminals": self.terminals}})
        if "worker-list" in argv:
            return 0, json.dumps({"result": {"workers": self.workers}})
        if argv[0] == "gh":
            return 0, json.dumps({"state": self.gh_state})
        if argv[0] == "git" and "status" in argv:
            return 0, self.status.get(argv[2], "")
        if argv[0] == "git" and "rev-list" in argv:
            return 0, self.unpushed.get(argv[2], "0") + "\n"
        return 0, "{}"

    def run_reviews(self, dry_run: bool = False) -> str:
        out = io.StringIO()
        with (
            mock.patch.dict(os.environ, {"ORCA": "orca", "PR_TRIAGE_DB": str(self.db)}),
            contextlib.redirect_stdout(out),
        ):
            self.assertEqual(prcleanup.run([], self.fake, dry_run), 0, out.getvalue())
        return out.getvalue()

    def closed(self) -> list[str]:
        return [c[c.index("--terminal") + 1] for c in self.calls if c[1:3] == ["terminal", "close"]]

    def removed(self) -> list[str]:
        return [c[c.index("--worktree") + 1] for c in self.calls if c[1:3] == ["worktree", "rm"]]

    def test_merged_pr_closes_terminal_and_removes_worktree(self) -> None:
        self.add_review(1, "new")
        self.gh_state = "MERGED"
        out = self.run_reviews()
        self.assertEqual(self.closed(), ["term_1"])
        self.assertEqual(self.removed(), [f"id:{wt_id(1)}"])
        self.assertIn("PR merged", out)

    def test_reviewed_state_is_finished_without_asking_github(self) -> None:
        self.add_review(2, "reviewed")
        self.run_reviews()
        self.assertEqual(self.closed(), ["term_2"])
        self.assertFalse([c for c in self.calls if c[0] == "gh"])

    def test_awaiting_input_and_reviewing_are_untouched_even_when_merged(self) -> None:
        self.add_review(3, "awaiting_input")
        self.add_review(4, "reviewing")
        self.gh_state = "MERGED"
        self.run_reviews()
        self.assertEqual(self.closed(), [])
        self.assertEqual(self.removed(), [])

    def test_open_pr_in_unfinished_state_is_untouched(self) -> None:
        self.add_review(5, "new")
        self.run_reviews()
        self.assertEqual(self.closed() + self.removed(), [])

    def test_uncommitted_changes_keep_the_worktree_with_the_reason(self) -> None:
        self.add_review(6, "done")
        self.status[f"{ROOT}/pr-6"] = " M a.py\n"
        out = self.run_reviews()
        self.assertEqual(self.closed(), ["term_6"])
        self.assertEqual(self.removed(), [])
        self.assertIn("kept worktree", out)
        self.assertIn("uncommitted", out)

    def test_unpushed_commits_keep_the_worktree(self) -> None:
        self.add_review(7, "skipped")
        self.unpushed[f"{ROOT}/pr-7"] = "2"
        out = self.run_reviews()
        self.assertEqual(self.removed(), [])
        self.assertIn("2 unpushed", out)

    def test_dry_run_changes_nothing_and_the_db_is_never_written(self) -> None:
        self.add_review(8, "done")
        before = self.db.read_bytes()
        out = self.run_reviews(dry_run=True)
        self.assertEqual(self.closed() + self.removed(), [])
        self.assertIn("would close terminal term_8", out)
        self.assertIn("would remove worktree", out)
        self.assertEqual(self.db.read_bytes(), before)

    def test_already_cleaned_review_costs_no_calls_beyond_the_listings(self) -> None:
        self.add_review(9, "done")
        self.worktrees = [w for w in self.worktrees if w["id"] != wt_id(9)]
        self.terminals = []
        self.run_reviews()
        self.assertEqual([c for c in self.calls if c[0] in ("gh", "git")], [])
        self.assertEqual(self.closed() + self.removed(), [])

    def test_main_checkout_is_never_touched(self) -> None:
        con = sqlite3.connect(self.db)
        con.execute("INSERT INTO pr_reviews VALUES ('o/mm', 10, 'done', 'r1::/main', NULL)")
        con.commit()
        con.close()
        out = self.run_reviews()
        self.assertEqual(self.removed(), [])
        self.assertIn("main checkout", out)

    def test_missing_db_is_a_no_op(self) -> None:
        self.db.unlink()
        self.assertEqual(self.run_reviews(), "")

    def worker(self, dispatch: str, st: str, workspace: str, terminal_state: str = "retained") -> dict:
        return {"dispatchId": dispatch, "state": st, "terminalState": terminal_state, "workspace": workspace}

    def test_settled_workers_are_released_when_worktree_gone_or_job_done(self) -> None:
        job = state.new_job("repo-0001", "/repo", "t", "internal", stage="build")
        job.stage = "done"
        job.links["dispatch"] = "d_job"
        store.save(job)
        self.worktrees.append({"id": "r1::/alive", "path": "/alive"})
        self.workers = [
            self.worker("d_gone", "succeeded", "r1::/removed"),
            self.worker("d_job", "failed", "r1::/alive"),
            self.worker("d_alive", "succeeded", "r1::/alive"),  # worktree exists, job not done: keep
            self.worker("d_running", "ready", "r1::/removed"),  # not settled
            self.worker("d_released", "abandoned", "r1::/removed", "released"),
        ]
        # the full record shape: workerState + resource.worktreeId instead of state + workspace
        self.workers.append(
            {
                "dispatchId": "d_full",
                "workerState": "succeeded",
                "terminalState": "retained",
                "resource": {"worktreeId": "r1::/removed"},
            }
        )
        out = io.StringIO()
        with (
            mock.patch.dict(os.environ, {"ORCA": "orca", "PR_TRIAGE_DB": str(self.db)}),
            contextlib.redirect_stdout(out),
        ):
            prcleanup.run(store.all_jobs(), self.fake)
        released = [c[c.index("--dispatch") + 1] for c in self.calls if "worker-release" in c]
        self.assertEqual(sorted(released), ["d_full", "d_gone", "d_job"])
        self.assertIn("worktree is gone", out.getvalue())


if __name__ == "__main__":
    unittest.main()
