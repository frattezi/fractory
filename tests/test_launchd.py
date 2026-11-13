"""The LaunchAgent plist keeps watch alive with a PATH that reaches gh."""

from __future__ import annotations

import plistlib
import unittest
from pathlib import Path

from fractory import launchd


class Plist(unittest.TestCase):
    def test_plist_runs_watch_forever_with_logs_and_path(self) -> None:
        data = plistlib.loads(
            launchd.plist_bytes("/py/python3", Path("/repo"), Path("/home/.factory/watch.log"), "/opt/bin:/usr/bin", 60)
        )
        self.assertEqual(data["Label"], launchd.LABEL)
        self.assertEqual(data["ProgramArguments"], ["/py/python3", "-m", "fractory", "watch", "--every", "60"])
        self.assertTrue(data["KeepAlive"])
        self.assertTrue(data["RunAtLoad"])
        self.assertEqual(data["EnvironmentVariables"]["PYTHONPATH"], "/repo")
        self.assertEqual(data["EnvironmentVariables"]["PATH"], "/opt/bin:/usr/bin")
        self.assertEqual(data["StandardErrorPath"], "/home/.factory/watch.log")


class PathEnv(unittest.TestCase):
    def test_path_has_every_tool_dir_first_then_defaults(self) -> None:
        where = {"gh": "/opt/homebrew/bin/gh", "git": "/usr/bin/git", "claude": "/Users/x/.local/bin/claude"}
        dirs = launchd.path_env(which=where.get, python="/py/bin/python3").split(":")
        self.assertEqual(dirs[:4], ["/opt/homebrew/bin", "/usr/bin", "/Users/x/.local/bin", "/py/bin"])
        self.assertIn(str(Path.home() / ".local" / "bin"), dirs)
        self.assertEqual(len(dirs), len(set(dirs)))

    def test_missing_tool_is_skipped(self) -> None:
        dirs = launchd.path_env(which=lambda tool: None, python="/py/bin/python3").split(":")
        self.assertEqual(dirs[0], "/py/bin")


if __name__ == "__main__":
    unittest.main()
