"""Plane adapter: 429 backoff and the per-cycle cache, with a fake HTTP function."""

from __future__ import annotations

import contextlib
import io
import unittest
from unittest import mock

from fractory.trackers import plane as plane_mod
from fractory.trackers.plane import Plane, PlaneError

PROJECT = "p1"


class FakeHttp:
    def __init__(self, responses: list[tuple[int, object]] | None = None):
        self.responses = list(responses or [])
        self.calls: list[str] = []

    def __call__(self, method: str, url: str, headers: dict, body: bytes | None) -> tuple[int, object]:
        self.calls.append(url)
        if self.responses:
            return self.responses.pop(0)
        if url.endswith("/labels/"):
            return 200, {"results": [{"id": "l1", "name": "fractory"}]}
        if url.endswith("/states/"):
            return 200, {"results": [{"id": "s1", "group": "started", "name": "Doing"}]}
        if url.endswith("/projects/"):
            return 200, {"results": [{"id": PROJECT, "identifier": "P"}]}
        return 200, {}


class RateLimitTest(unittest.TestCase):
    def setUp(self) -> None:
        patcher = mock.patch.object(plane_mod, "sleep")
        self.sleep = patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(plane_mod.end_cycle)

    def call(self, http: FakeHttp) -> tuple[str, int]:
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            status, _ = Plane(PROJECT, "k", http=http)._call("GET", "/x/")
        return out.getvalue(), status

    def test_429_then_200_succeeds_after_one_retry(self) -> None:
        http = FakeHttp([(429, None), (200, {})])
        out, status = self.call(http)
        self.assertEqual(status, 200)
        self.assertEqual(len(http.calls), 2)
        self.sleep.assert_called_once_with(2.0)
        self.assertEqual(out, "plane: rate limited, backing off 2s\n")

    def test_retry_after_is_respected(self) -> None:
        self.call(FakeHttp([(429, {"retry_after": "7"}), (200, {})]))
        self.sleep.assert_called_once_with(7.0)

    def test_repeated_429_fails_after_three_retries(self) -> None:
        http = FakeHttp([(429, None)] * 10)
        with self.assertRaisesRegex(PlaneError, "HTTP 429"), contextlib.redirect_stdout(io.StringIO()) as out:
            Plane(PROJECT, "k", http=http)._call("GET", "/x/")
        self.assertEqual(len(http.calls), 4)
        self.assertEqual([c.args[0] for c in self.sleep.call_args_list], [2.0, 4.0, 8.0])
        self.assertEqual(out.getvalue().count("rate limited"), 1)

    def test_labels_and_states_are_fetched_once_per_cycle(self) -> None:
        http = FakeHttp()
        plane_mod.begin_cycle()
        for _ in range(5):  # five jobs of one project, each with its own client
            p = Plane(PROJECT, "k", http=http)
            p.labels()
            p.states()
            Plane.projects("k", http=http)
        self.assertEqual(sum(u.endswith("/labels/") for u in http.calls), 1)
        self.assertEqual(sum(u.endswith("/states/") for u in http.calls), 1)
        self.assertEqual(sum(u.endswith("/projects/") for u in http.calls), 1)

    def test_next_cycle_refetches(self) -> None:
        http = FakeHttp()
        plane_mod.begin_cycle()
        Plane(PROJECT, "k", http=http).labels()
        plane_mod.begin_cycle()
        Plane(PROJECT, "k", http=http).labels()
        self.assertEqual(sum(u.endswith("/labels/") for u in http.calls), 2)

    def test_no_cache_outside_a_cycle(self) -> None:
        http = FakeHttp()
        Plane(PROJECT, "k", http=http).labels()
        Plane(PROJECT, "k", http=http).labels()
        self.assertEqual(sum(u.endswith("/labels/") for u in http.calls), 2)


if __name__ == "__main__":
    unittest.main()
