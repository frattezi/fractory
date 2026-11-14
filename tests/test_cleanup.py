"""`fractory cleanup` with a fake runner standing in for orca, git and gh."""

from __future__ import annotations

import contextlib
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from fractory import cleanup, cli, state, store

WT_PATH = "/orca/Fractory/wt-a"
WT_ID = f"repo1::{WT_PATH}"


class CleanupCli(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp())
        env = mock.patch.dict(os.environ, {"FACTORY_HOME": str(self.tmp / "factory")})
        env.start()
        self.addCleanup(env.stop)
        self.calls: list[list[str]] = []
        self.status = ""  # git status --porcelain
        self.ahead = "0"
        self.pr_state = "OPEN"
        self.stop_fails = False
        self.worktrees = [
            {"id": "repo1::/main", "path": "/main", "isMainWorktree": True, "displayName": "main"},
            {"id": WT_ID, "path": WT_PATH, "branch": "refs/heads/me/wt-a", "displayName": "wt-a"},
            {
                "id": "repo1::/orca/other",
                "path": "/orca/other",
                "branch": "refs/heads/me/other",
                "displayName": "other",
            },
        ]
        self.terminals = [
            {"handle": "term_worker", "worktreeId": WT_ID},
            {"handle": "term_shell", "worktreeId": WT_ID},
            {"handle": "term_other", "worktreeId": "repo1::/orca/other"},
        ]

    def run_fake(self, argv: list[str]) -> tuple[int, str]:
        self.calls.append(argv)
        if "worktree" in argv and "list" in argv:
            return 0, json.dumps({"result": {"worktrees": self.worktrees}})
        if "terminal" in argv and "list" in argv:
            return 0, json.dumps({"result": {"terminals": self.terminals}})
        if "worker-stop" in argv:
            return (1, "already released") if self.stop_fails else (0, "{}")
        if argv[0] == "git" and "status" in argv:
            return 0, self.status
        if argv[0] == "git" and "rev-list" in argv:
            return 0, self.ahead + "\n"
        if argv[0] == "sh":
            return 0, json.dumps({"state": self.pr_state})
        return 0, "{}"

    def make_job(self, stage: str = "done", **links) -> state.Job:
        job = state.new_job("repo-0001", "/repo", "t", "internal", stage="build")
        job.stage = stage
        job.links.update({"worktree": "wt-a", "dispatch": "d1", "pr": "7", **links})
        store.save(job)
        return job

    def run_cleanup(self, *argv: str) -> str:
        out = io.StringIO()
        with mock.patch.object(cleanup.launch, "run_cmd", side_effect=self.run_fake), contextlib.redirect_stdout(out):
            self.assertEqual(cli.main(["cleanup", *argv]), 0, out.getvalue())
        return out.getvalue()

    def verbs(self) -> list[str]:
        return [" ".join(c[1:3]) if c[0] != "git" else "git " + c[3] for c in self.calls if c[0] != "sh"]

    def test_done_job_is_fully_cleaned(self) -> None:
        self.make_job()
        self.run_cleanup()
        flat = [" ".join(c) for c in self.calls]
        self.assertTrue(any("worker-stop --dispatch d1" in c for c in flat))
        closed = [c[c.index("--terminal") + 1] for c in self.calls if "close" in c]
        self.assertEqual(closed, ["term_worker", "term_shell"])
        self.assertTrue(any(c[1:4] == ["worktree", "rm", "--worktree"] and f"id:{WT_ID}" in c for c in self.calls))
        self.assertIn(["git", "-C", "/repo", "branch", "-D", "me/wt-a"], self.calls)
        job = store.load("repo-0001")
        self.assertIn("cleaned_at", job.links)
        self.assertEqual(job.history[-1]["event"], "cleaned")

    def test_settled_dispatch_is_released_not_an_error(self) -> None:
        self.make_job()
        self.stop_fails = True
        self.run_cleanup()
        self.assertTrue(any("worker-release" in c for c in self.calls))
        self.assertIn("cleaned_at", store.load("repo-0001").links)

    def test_dirty_worktree_is_kept_with_the_reason(self) -> None:
        self.make_job()
        self.status = " M file.py\n"
        self.run_cleanup()
        self.assertFalse(any("rm" in c for c in self.calls if c[1:3] == ["worktree", "rm"]))
        self.assertFalse(any(c[:2] == ["git", "-C"] and "branch" in c for c in self.calls))
        job = store.load("repo-0001")
        self.assertNotIn("cleaned_at", job.links)
        self.assertIn("uncommitted", job.links["cleanup_skipped"])
        self.assertEqual(job.history[-1]["event"], "cleanup_skipped")

    def test_unmerged_commits_keep_the_worktree_unless_the_pr_is_merged(self) -> None:
        self.make_job()
        self.ahead = "3"
        self.run_cleanup()
        self.assertIn("not in origin/main", store.load("repo-0001").links["cleanup_skipped"])
        self.pr_state = "MERGED"  # squash merge: commits differ but the PR is merged
        self.run_cleanup("--job", "repo-0001")
        self.assertIn("cleaned_at", store.load("repo-0001").links)

    def test_second_run_does_nothing(self) -> None:
        self.make_job()
        self.run_cleanup()
        self.calls.clear()
        self.run_cleanup()
        self.assertEqual(self.calls, [])

    def test_watch_does_not_retry_a_kept_worktree_but_the_command_does(self) -> None:
        self.make_job()
        self.status = " M x\n"
        self.run_cleanup()
        self.calls.clear()
        cleanup.run_cleanup(store.all_jobs(), self.run_fake)
        self.assertEqual(self.calls, [])
        self.status = ""
        self.run_cleanup("--job", "repo-0001")
        self.assertIn("cleaned_at", store.load("repo-0001").links)

    def test_other_worktrees_terminals_and_running_jobs_are_untouched(self) -> None:
        self.make_job()
        self.run_cleanup()
        self.assertFalse(
            any("term_other" in c or "repo1::/orca/other" in " ".join(c) for c in self.calls if "list" not in c)
        )
        self.calls.clear()
        job = state.new_job("repo-0002", "/repo", "t", "internal", stage="build")
        job.links.update(worktree="wt-a")
        store.save(job)
        self.run_cleanup()
        self.assertEqual(self.calls, [])

    def test_dry_run_changes_nothing(self) -> None:
        self.make_job()
        out = self.run_cleanup("--dry-run")
        self.assertIn("would", out)
        self.assertNotIn("cleaned_at", store.load("repo-0001").links)
        self.assertFalse(any("close" in c or "rm" in c for c in self.calls))


if __name__ == "__main__":
    unittest.main()
