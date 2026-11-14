"""The LaunchAgent plist keeps watch alive with a PATH that reaches gh."""

from __future__ import annotations

import plistlib
import unittest
from pathlib import Path

from fractory import launchd


class Plist(unittest.TestCase):
    def plist(self, name: str, args: list[str]) -> dict:
        return plistlib.loads(
            launchd.plist_bytes(
                name, "/py/python3", Path("/repo"), Path(f"/home/.factory/{name}.log"), "/opt/bin:/usr/bin", args
            )
        )

    def test_watch_plist_unchanged(self) -> None:
        data = self.plist("watch", ["--every", "60.0"])
        self.assertEqual(data["Label"], "com.fractory.watch")
        self.assertEqual(data["Label"], launchd.LABEL)
        self.assertEqual(data["ProgramArguments"], ["/py/python3", "-m", "fractory", "watch", "--every", "60.0"])
        self.assertTrue(data["KeepAlive"])
        self.assertTrue(data["RunAtLoad"])
        self.assertEqual(data["EnvironmentVariables"]["PYTHONPATH"], "/repo")
        self.assertEqual(data["EnvironmentVariables"]["PATH"], "/opt/bin:/usr/bin")
        self.assertEqual(data["StandardErrorPath"], "/home/.factory/watch.log")

    def test_serve_plist_runs_serve_on_the_port(self) -> None:
        data = self.plist("serve", ["--port", "8123"])
        self.assertEqual(data["Label"], "com.fractory.serve")
        self.assertEqual(data["ProgramArguments"], ["/py/python3", "-m", "fractory", "serve", "--port", "8123"])
        self.assertTrue(data["KeepAlive"])
        self.assertEqual(data["EnvironmentVariables"]["PATH"], "/opt/bin:/usr/bin")
        self.assertEqual(data["StandardOutPath"], "/home/.factory/serve.log")

    def test_agent_paths_differ_per_agent(self) -> None:
        self.assertEqual(launchd.agent_path("serve").name, "com.fractory.serve.plist")
        self.assertEqual(launchd.agent_path("watch").name, "com.fractory.watch.plist")


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
