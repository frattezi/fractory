"""The LaunchAgent plist keeps watch alive with a PATH that reaches gh."""

from __future__ import annotations

import contextlib
import io
import os
import plistlib
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from fractory import cli, launchd


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


class FakeLaunchctl(unittest.TestCase):
    """install/uninstall and the CLI flags, with $HOME in a temp dir and launchctl recorded, never run."""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp())
        for patcher in (
            mock.patch.object(Path, "home", return_value=self.tmp / "home"),
            mock.patch.dict(os.environ, {"FACTORY_HOME": str(self.tmp / "factory")}),
            mock.patch.object(launchd.subprocess, "run"),
        ):
            self.addCleanup(patcher.stop)
            started = patcher.start()
        self.run = started

    def launchctl_calls(self) -> list[list[str]]:
        return [c.args[0] for c in self.run.call_args_list]

    def plist(self, name: str) -> dict:
        return plistlib.loads(launchd.agent_path(name).read_bytes())

    def main(self, *argv: str) -> tuple[int, str]:
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = cli.main(list(argv))
        return code, out.getvalue()

    def test_install_writes_plist_and_bootstraps(self) -> None:
        log = self.tmp / "logs" / "x.log"
        path = launchd.install("serve", ["--port", "9000"], log)
        self.assertEqual(path, launchd.agent_path("serve"))
        self.assertEqual(self.plist("serve")["ProgramArguments"][-3:], ["serve", "--port", "9000"])
        self.assertEqual(self.launchctl_calls()[-1], ["launchctl", "bootstrap", f"gui/{os.getuid()}", str(path)])

    def test_uninstall_boots_out_and_removes_plist(self) -> None:
        self.assertFalse(launchd.uninstall("serve"))
        self.assertEqual(self.launchctl_calls(), [])
        path = launchd.install("serve", [], self.tmp / "x.log")
        self.run.reset_mock()
        self.assertTrue(launchd.uninstall("serve"))
        self.assertFalse(path.exists())
        self.assertEqual(self.launchctl_calls(), [["launchctl", "bootout", f"gui/{os.getuid()}", str(path)]])

    def test_serve_install_and_uninstall_through_cli(self) -> None:
        code, out = self.main("serve", "--install", "--port", "8123")
        self.assertEqual(code, 0)
        self.assertIn("http://127.0.0.1:8123", out)
        data = self.plist("serve")
        self.assertEqual(data["Label"], "com.fractory.serve")
        self.assertEqual(data["ProgramArguments"][-3:], ["serve", "--port", "8123"])
        self.assertEqual(data["StandardOutPath"], str(self.tmp / "factory" / "serve.log"))
        self.assertEqual(self.launchctl_calls()[-1][:2], ["launchctl", "bootstrap"])
        code, out = self.main("serve", "--uninstall")
        self.assertEqual(code, 0)
        self.assertIn("serve agent removed", out)
        self.assertFalse(launchd.agent_path("serve").exists())
        self.assertEqual(self.launchctl_calls()[-1][:2], ["launchctl", "bootout"])

    def test_serve_install_defaults_to_8777(self) -> None:
        _, out = self.main("serve", "--install")
        self.assertIn("http://127.0.0.1:8777", out)
        self.assertEqual(self.plist("serve")["ProgramArguments"][-2:], ["--port", "8777"])

    def test_watch_install_and_uninstall_through_cli(self) -> None:
        code, _ = self.main("watch", "--install", "--every", "30")
        self.assertEqual(code, 0)
        data = self.plist("watch")
        self.assertEqual(data["Label"], launchd.LABEL)
        self.assertEqual(data["ProgramArguments"][-3:], ["watch", "--every", "30.0"])
        self.assertEqual(data["StandardErrorPath"], str(self.tmp / "factory" / "watch.log"))
        self.assertEqual(self.launchctl_calls()[-1][:2], ["launchctl", "bootstrap"])
        code, out = self.main("watch", "--uninstall")
        self.assertEqual(code, 0)
        self.assertIn("watch agent removed", out)
        self.assertFalse(launchd.agent_path("watch").exists())

    def test_uninstall_when_absent_says_so(self) -> None:
        self.assertIn("serve agent was not installed", self.main("serve", "--uninstall")[1])
        self.assertIn("watch agent was not installed", self.main("watch", "--uninstall")[1])


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
