"""The per-worktree push guard, against real git repos and a bare remote."""

from __future__ import annotations

import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from fractory import guard

GIT_ENV = {
    "GIT_AUTHOR_NAME": "t",
    "GIT_AUTHOR_EMAIL": "t@t",
    "GIT_COMMITTER_NAME": "t",
    "GIT_COMMITTER_EMAIL": "t@t",
}


def git(cwd: Path, *args: str) -> subprocess.CompletedProcess:
    env = {**os.environ, **GIT_ENV}
    return subprocess.run(["git", "-C", str(cwd), *args], capture_output=True, text=True, check=False, env=env)


class PushGuard(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp())
        env = mock.patch.dict(os.environ, {"FACTORY_HOME": str(self.tmp / "factory")})
        env.start()
        self.addCleanup(env.stop)
        remote = self.tmp / "remote.git"
        subprocess.run(["git", "init", "-q", "--bare", "-b", "main", str(remote)], check=True)
        self.repo = self.tmp / "repo"
        subprocess.run(["git", "init", "-q", "-b", "main", str(self.repo)], check=True)
        git(self.repo, "remote", "add", "origin", str(remote))
        git(self.repo, "commit", "-q", "--allow-empty", "-m", "init")
        self.repo_hooks = self.repo / "repo-hooks"
        self.repo_hooks.mkdir()
        self.marker = self.tmp / "repo-pre-push-ran"
        hook = self.repo_hooks / "pre-push"
        hook.write_text(f"#!/bin/sh\ncat >> {self.marker}\n")
        hook.chmod(0o755)
        git(self.repo, "config", "core.hooksPath", str(self.repo_hooks))
        self.assertEqual(git(self.repo, "push", "-q", "origin", "main").returncode, 0)
        self.marker.unlink()
        self.wt = self.tmp / "wt"
        git(self.repo, "worktree", "add", "-q", "-b", "job-branch", str(self.wt))

    def test_push_to_main_is_refused_and_job_branch_passes_through_the_repo_hook(self) -> None:
        guard.install(self.wt)
        git(self.wt, "commit", "-q", "--allow-empty", "-m", "work")
        refused = git(self.wt, "push", "origin", "HEAD:refs/heads/main")
        self.assertNotEqual(refused.returncode, 0)
        self.assertIn("open a pull request", refused.stderr)
        self.assertFalse(self.marker.exists())
        self.assertNotEqual(git(self.wt, "push", "origin", "HEAD:refs/heads/master").returncode, 0)

        ok = git(self.wt, "push", "origin", "job-branch")
        self.assertEqual(ok.returncode, 0, ok.stderr)
        self.assertIn("refs/heads/job-branch", self.marker.read_text())

    def test_other_hooks_still_chain_to_the_repo_and_install_is_idempotent(self) -> None:
        commit_hook = self.repo_hooks / "pre-commit"
        commit_hook.write_text("#!/bin/sh\nexit 1\n")
        commit_hook.chmod(0o755)
        guard.install(self.wt)
        guard.install(self.wt)
        self.assertNotEqual(git(self.wt, "commit", "-q", "--allow-empty", "-m", "x").returncode, 0)
        commit_hook.unlink()
        self.assertEqual(git(self.wt, "commit", "-q", "--allow-empty", "-m", "x").returncode, 0)
        self.assertEqual(git(self.wt, "push", "origin", "job-branch").returncode, 0)

    def test_main_checkout_hooks_are_unchanged(self) -> None:
        guard.install(self.wt)
        self.assertEqual(git(self.repo, "config", "--get", "core.hooksPath").stdout.strip(), str(self.repo_hooks))
        self.assertEqual(git(self.repo, "config", "--worktree", "--get", "core.hooksPath").returncode, 1)
        git(self.repo, "commit", "-q", "--allow-empty", "-m", "on main")
        self.assertEqual(git(self.repo, "push", "origin", "main").returncode, 0)
        self.assertTrue(self.marker.exists())

    def test_default_hooks_dir_when_the_repo_sets_none(self) -> None:
        git(self.repo, "config", "--unset", "core.hooksPath")
        guard.install(self.wt)
        git(self.wt, "commit", "-q", "--allow-empty", "-m", "work")
        self.assertNotEqual(git(self.wt, "push", "origin", "HEAD:refs/heads/main").returncode, 0)
        self.assertEqual(git(self.wt, "push", "origin", "job-branch").returncode, 0)

    def test_worktree_path_comes_from_the_orca_id(self) -> None:
        self.assertEqual(guard.worktree_path("repo-1::/a/b"), Path("/a/b"))
        with self.assertRaises(guard.GuardError):
            guard.worktree_path("no-path")


if __name__ == "__main__":
    unittest.main()
