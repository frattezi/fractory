"""The card names its owner: launch assigns, add-item --assign-me, done sets the target date. Fake Plane over HTTP."""

from __future__ import annotations

import contextlib
import io
import json
import os
import tempfile
import threading
import unittest
from datetime import date
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest import mock

from fractory import briefcheck, cli, launch, store
from fractory.trackers.plane import Plane
from tests.test_plane_import import KEY, PROJECT, FakePlane, reset_fake


class PlaneOwner(unittest.TestCase):
    def setUp(self) -> None:
        reset_fake()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), FakePlane)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.tmp = Path(tempfile.mkdtemp())
        self.repo = self.tmp / "cortadas"
        self.repo.mkdir()
        self.brief = self.tmp / "brief.md"
        self.brief.write_text("# do it\n")
        env = mock.patch.dict(os.environ, {"FACTORY_HOME": str(self.tmp / "factory"), "PLANE_API_KEY": KEY})
        env.start()
        self.addCleanup(env.stop)
        FakePlane.issues.append(
            {
                "id": "iss-1",
                "external_id": "",
                "external_source": "",
                "name": "Card",
                "assignees": ["someone-else"],
                "state": "s-todo",
            }
        )
        self.plane = Plane(PROJECT, KEY, self.url)
        for target, kwargs in (
            (briefcheck, {"check": mock.Mock(return_value=briefcheck.Verdict(True, []))}),
            (launch, {"run_cmd": mock.Mock(side_effect=self.fake_run)}),
        ):
            patch = mock.patch.multiple(target, **kwargs)
            patch.start()
            self.addCleanup(patch.stop)

    @staticmethod
    def fake_run(argv: list[str]) -> tuple[int, str]:
        if "worktree" in argv:
            return 0, json.dumps({"ok": True, "result": {"worktree": {"id": "repo::/wt/x"}}})
        return 0, "launched dispatch d1 in terminal term_abc (stage running)\n"

    def launch_card(self) -> int:
        args = launch.Args(self.repo, "iss-1", PROJECT, self.brief, run="run_1")
        with contextlib.redirect_stdout(io.StringIO()):
            return launch.launch(args, self.plane, Path("orch.py"))

    def card(self) -> dict:
        return FakePlane.issues[0]

    def test_launch_adds_the_owner_without_dropping_existing_assignees(self) -> None:
        self.assertEqual(self.launch_card(), 0)
        self.assertEqual(self.card()["assignees"], ["someone-else", "user-me"])
        self.assertEqual(self.card()["start_date"], date.today().isoformat())

    def test_config_plane_assignee_wins_over_me(self) -> None:
        (self.tmp / "factory").mkdir(exist_ok=True)
        (store.factory_home() / "config.toml").write_text('plane_assignee = "user-config"\n')
        self.assertEqual(self.launch_card(), 0)
        self.assertEqual(self.card()["assignees"], ["someone-else", "user-config"])

    def test_launch_keeps_an_existing_start_date_and_does_not_duplicate_the_owner(self) -> None:
        self.card().update(assignees=["user-me"], start_date="2020-01-01")
        self.assertEqual(self.launch_card(), 0)
        self.assertEqual(self.card()["assignees"], ["user-me"])
        self.assertEqual(self.card()["start_date"], "2020-01-01")
        self.assertEqual(FakePlane.patches, [])

    def test_done_sets_the_target_date_only_when_empty(self) -> None:
        self.plane.set_status("iss-1", "done")
        self.assertEqual(self.card()["target_date"], date.today().isoformat())
        self.card()["target_date"] = "2030-01-01"
        self.plane.set_status("iss-1", "done")
        self.assertEqual(self.card()["target_date"], "2030-01-01")

    def test_add_item_assign_me(self) -> None:
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = cli.main(
                ["plane", "add-item", "--project", PROJECT, "--title", "New", "--assign-me", "--url", self.url]
            )
        self.assertEqual(code, 0, out.getvalue())
        self.assertEqual(FakePlane.issues[-1]["assignees"], ["user-me"])


if __name__ == "__main__":
    unittest.main()
