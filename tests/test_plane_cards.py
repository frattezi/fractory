"""plane add-item --label/--depends-on, items, show, move, comment; project identifier and card key. Fake Plane over HTTP."""

from __future__ import annotations

import contextlib
import io
import os
import threading
import unittest
from http.server import ThreadingHTTPServer
from unittest import mock

from fractory import cli, intake
from tests.test_plane_import import KEY, PROJECT, FakePlane, reset_fake


class PlaneCards(unittest.TestCase):
    def setUp(self) -> None:
        reset_fake()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), FakePlane)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        env = mock.patch.dict(os.environ, {"PLANE_API_KEY": KEY})
        env.start()
        self.addCleanup(env.stop)

    def run_cli(self, *argv: str, code: int = 0) -> str:
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(cli.main(["plane", argv[0], "--url", self.url, *argv[1:]]), code, out.getvalue())
        return out.getvalue()

    def add(self, title: str, *extra: str, project: str = "CORT") -> None:
        self.run_cli("add-item", "--project", project, "--title", title, *extra)

    def label_id(self, name: str) -> str:
        return next(lb["id"] for lb in FakePlane.labels if lb["name"] == name)

    def test_add_item_sets_labels_and_depends_on_line(self) -> None:
        self.add("A", "--body", "Do A.", "--label", "fractory", "--label", "design", "--depends-on", "CORT-1, CORT-2")
        card = FakePlane.issues[0]
        self.assertEqual(card["labels"], [self.label_id("fractory"), self.label_id("design")])
        self.assertTrue(card["description_html"].rstrip().endswith("Depends on: CORT-1, CORT-2</p>"))
        self.assertEqual(intake.depends_on(card), ["CORT-1", "CORT-2"])

    def test_items_filters_by_status_and_label(self) -> None:
        self.add("Ready one", "--status", "ready", "--label", "fractory")
        self.add("Backlog one", "--status", "backlog", "--label", "humano")
        self.add("Ready human", "--status", "ready", "--label", "humano")
        out = self.run_cli("items", "--project", "CORT")
        self.assertEqual(len(out.splitlines()), 3)
        out = self.run_cli("items", "--project", PROJECT, "--status", "ready", "--label", "humano")
        self.assertEqual(len(out.splitlines()), 1)
        self.assertIn("CORT-3  unstarted  humano  Ready human", out)
        self.assertIn(FakePlane.issues[2]["id"], out)

    def test_show_prints_state_labels_description_and_comments(self) -> None:
        self.add("Card", "--body", "Hello **world**", "--label", "fractory", "--status", "ready")
        self.run_cli("comment", "--project", "CORT", "--ref", "CORT-1", "--body", "first note")
        out = self.run_cli("show", "--project", "CORT", "--ref", "CORT-1")
        self.assertIn("CORT-1  Card", out)
        self.assertIn("(unstarted)", out)
        self.assertIn("labels:    fractory", out)
        self.assertIn("Hello world", out)
        self.assertIn("first note", out)

    def test_move_changes_state_and_adds_label_keeping_existing(self) -> None:
        self.add("Card", "--label", "design")
        out = self.run_cli(
            "move", "--project", "CORT", "--ref", "CORT-1", "--status", "ready", "--add-label", "fractory"
        )
        self.assertIn("moved", out)
        card = FakePlane.issues[0]
        self.assertEqual(card["state"], "s-todo")
        self.assertEqual(card["labels"], [self.label_id("design"), self.label_id("fractory")])

    def test_comment_from_file_and_resolution_by_key_and_id(self) -> None:
        self.add("Card")
        path = os.path.join(os.environ.get("TMPDIR", "/tmp"), "plane-cards-body.md")
        with open(path, "w") as f:
            f.write("from file")
        self.addCleanup(os.unlink, path)
        card_id = FakePlane.issues[0]["id"]
        self.run_cli("comment", "--project", PROJECT, "--ref", card_id, "--body-file", path)
        self.run_cli("comment", "--project", "cort", "--ref", "CORT-1", "--body", "by key")
        self.assertEqual(len(FakePlane.comments), 2)
        self.assertTrue(all(p.endswith(f"/issues/{card_id}/comments/") for p, _ in FakePlane.comments))

    def test_unknown_project_or_key_fails(self) -> None:
        self.assertIn("no project NOPE", self.run_cli("items", "--project", "NOPE", code=1))
        self.assertIn("no card CORT-9", self.run_cli("show", "--project", "CORT", "--ref", "CORT-9", code=1))


if __name__ == "__main__":
    unittest.main()
