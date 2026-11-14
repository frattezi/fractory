"""Self-reload: git is faked, `watch` and `serve` run through the real CLI and server."""

from __future__ import annotations

import contextlib
import http.client
import io
import os
import subprocess
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

from fractory import cli, reload, web

FETCH = (
    "-c",
    "credential.helper=",
    "-c",
    "credential.helper=!gh auth git-credential",
    "fetch",
    "-q",
    "https://github.com/o/r.git",
    "main",
)


class HttpsRemote(unittest.TestCase):
    def test_ssh_and_https_forms(self) -> None:
        for url in (
            "git@github.com:o/r.git",
            "ssh://git@github.com/o/r",
            "https://github.com/o/r.git",
            "https://github.com/o/r",
        ):
            self.assertEqual(reload.https_remote(url), "https://github.com/o/r.git")

    def test_non_github_remote_is_rejected(self) -> None:
        with self.assertRaises(ValueError):
            reload.https_remote("git@gitlab.com:o/r.git")


class FakeGit:
    def __init__(self, branch="main", dirty="", head="aaa111", remote="bbb222", fail_on=None):
        self.branch, self.dirty, self.head, self.remote, self.fail_on = branch, dirty, head, remote, fail_on
        self.calls: list[tuple[str, ...]] = []

    def __call__(self, repo_root, *args):
        self.calls.append(args)
        if self.fail_on and self.fail_on in args:
            raise subprocess.CalledProcessError(128, ["git", *args], stderr="fatal: boom\nmore\n")
        if args[:2] == ("rev-parse", "--abbrev-ref"):
            return self.branch
        if args[0] == "status":
            return self.dirty
        if args == ("rev-parse", "HEAD"):
            return self.head
        if args[:2] == ("remote", "get-url"):
            return "git@github.com:o/r.git"
        if args == ("rev-parse", "FETCH_HEAD"):
            return self.remote
        if args[0] == "merge":
            self.head = self.remote
            return ""
        if args[:2] == ("rev-parse", "--short"):
            return self.head
        return ""


class MainMoved(unittest.TestCase):
    root = Path("/repo")

    def test_moved_on_clean_main(self) -> None:
        git = FakeGit()
        self.assertTrue(reload.main_moved(self.root, git))
        self.assertIn(FETCH, git.calls)

    def test_same_sha_is_not_moved(self) -> None:
        self.assertFalse(reload.main_moved(self.root, FakeGit(remote="aaa111")))

    def test_other_branch_or_dirty_tree_never_reloads(self) -> None:
        for git in (FakeGit(branch="feature"), FakeGit(dirty=" M fractory/cli.py")):
            self.assertFalse(reload.main_moved(self.root, git))
            self.assertNotIn(FETCH, git.calls)

    def test_git_error_is_false_and_fast_forward_is_a_noop(self) -> None:
        with contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertFalse(reload.main_moved(self.root, FakeGit(fail_on="fetch")))
            self.assertIsNone(reload.fast_forward(self.root, FakeGit(fail_on="merge")))
        self.assertEqual(len(out.getvalue().splitlines()), 2)
        self.assertIn("fatal: boom more", out.getvalue())

    def test_pull_if_moved_returns_new_sha(self) -> None:
        self.assertEqual(reload.pull_if_moved(self.root, FakeGit()), "bbb222")
        self.assertIsNone(reload.pull_if_moved(self.root, FakeGit(remote="aaa111")))


class WatchReload(unittest.TestCase):
    def setUp(self) -> None:
        home = tempfile.mkdtemp()
        patcher = mock.patch.dict(os.environ, {"FACTORY_HOME": home})
        patcher.start()
        self.addCleanup(patcher.stop)

    def run_watch(self, git: FakeGit, *argv: str) -> tuple[int, str]:
        out = io.StringIO()
        with (
            mock.patch.object(reload, "run_git", git),
            mock.patch("fractory.cli.time.sleep"),
            contextlib.redirect_stdout(out),
        ):
            code = cli.main(["watch", *argv])
        return code, out.getvalue()

    def test_exits_zero_when_main_moved(self) -> None:
        git = FakeGit()
        code, out = self.run_watch(git)
        self.assertEqual(code, 0)
        self.assertIn("watch: main moved to bbb222, restarting", out)
        self.assertIn(("merge", "--ff-only", "FETCH_HEAD"), git.calls)

    def test_no_reload_and_rounds_runs_never_touch_git(self) -> None:
        for argv in (("--no-reload", "--rounds", "1"), ("--rounds", "1")):
            git = FakeGit()
            code, out = self.run_watch(git, *argv)
            self.assertEqual(code, 0)
            self.assertEqual(git.calls, [])
            self.assertNotIn("restarting", out)


class ServeReload(unittest.TestCase):
    def test_server_stops_when_main_moved(self) -> None:
        git = FakeGit()
        with (
            mock.patch.object(reload, "run_git", git),
            mock.patch.object(web, "RELOAD_SECONDS", 0.05),
            mock.patch.object(web, "make_server", lambda port: web.Server((web.HOST, 0), web.Handler)),
            contextlib.redirect_stdout(io.StringIO()) as out,
        ):
            result: list[int] = []
            t = threading.Thread(target=lambda: result.append(web.serve(0, reload_root=Path("/repo"))))
            t.start()
            t.join(timeout=5)
        self.assertFalse(t.is_alive())
        self.assertEqual(result, [0])
        self.assertIn("serve: main moved to bbb222, restarting", out.getvalue())

    def test_no_reload_root_keeps_serving(self) -> None:
        server = web.Server((web.HOST, 0), web.Handler)
        with mock.patch.object(web, "make_server", lambda port: server):
            t = threading.Thread(target=web.serve, args=(0,), daemon=True)
            t.start()
            conn = http.client.HTTPConnection(web.HOST, server.server_address[1], timeout=5)
            conn.request("GET", "/")
            self.assertEqual(conn.getresponse().status, 200)
            server.shutdown()
            t.join(timeout=5)


if __name__ == "__main__":
    unittest.main()
