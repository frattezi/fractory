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


if __name__ == "__main__":
    unittest.main()
