"""`fractory intake`: labelled Plane cards become jobs. Fake Plane over HTTP; orca/orch.py faked."""

from __future__ import annotations

import contextlib
import io
import json
import os
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest import mock

from fractory import briefcheck, cli, intake, launch, state, store
from tests.test_plane_import import KEY, PROJECT, FakePlane, reset_fake

LABEL = "label-fractory"


def card(n: int, st: str = "s-todo", labels: tuple[str, ...] = (LABEL,), html: str = "<p>Do it</p>") -> dict:
    return {
        "id": f"issue-{n}",
        "name": f"Card {n}",
        "description_html": html,
        "state": st,
        "labels": list(labels),
        "external_id": f"X-{n}",
        "external_source": "other",
    }


def job_for(ref: str, stage: str = "build") -> state.Job:
    job = state.new_job(f"j-{ref}", "/repo", "t", "internal", stage="build")
    job.tracker = {"kind": "plane", "ref": ref}
    job.stage = stage
    return job


class Candidates(unittest.TestCase):
    def issues(self) -> list[dict]:
        groups = {"s-backlog": "backlog", "s-todo": "unstarted", "s-doing": "started", "s-done": "completed"}
        return [
            {**c, "state": {"group": groups[c["state"]]}}
            for c in (
                card(1, "s-todo"),
                card(2, "s-backlog"),
                card(3, "s-doing"),
                card(4, "s-done"),
                card(5, labels=("other",)),
                card(6, labels=()),
                card(7),
            )
        ]

    def test_label_and_state_filters(self) -> None:
        found = intake.candidates(self.issues(), LABEL, [])
        self.assertEqual([i["id"] for i in found], ["issue-1", "issue-7"])

    def test_backlog_cards_are_parked_not_launched(self) -> None:
        parked: list[dict] = []
        intake.candidates(self.issues(), LABEL, [], parked=parked)
        self.assertEqual([i["id"] for i in parked], ["issue-2"])

    def test_a_card_with_any_job_is_skipped_even_cancelled(self) -> None:
        jobs = [job_for("issue-1", "cancelled"), job_for("issue-2", "done")]  # issue-2 is parked anyway
        found = intake.candidates(self.issues(), LABEL, jobs)
        self.assertEqual([i["id"] for i in found], ["issue-7"])


def with_deps(n: int, line: str, **kw) -> dict:
    return card(n, html=f"<p>Do it</p><p>{line}</p>", **kw)


class DependsOn(unittest.TestCase):
    def refs(self, html: str) -> list[str]:
        return intake.depends_on({"description_html": html})

    def test_plain(self) -> None:
        self.assertEqual(self.refs("<p>Intro</p><p>Depends on: 07, 08</p>"), ["07", "08"])

    def test_bold_and_case(self) -> None:
        self.assertEqual(self.refs("<p><strong>Depends on:</strong> 07</p>"), ["07"])
        self.assertEqual(self.refs("<p>**DEPENDS ON:** 07</p>"), ["07"])

    def test_none_and_empty(self) -> None:
        self.assertEqual(self.refs("<p>Depends on: none</p>"), [])
        self.assertEqual(self.refs("<p>Depends on:</p>"), [])

    def test_keys_and_prefixes(self) -> None:
        self.assertEqual(self.refs("<p>Depends on: CUIDADO-12, 07</p>"), ["CUIDADO-12", "07"])

    def test_missing(self) -> None:
        self.assertEqual(self.refs("<p>Nothing here</p>"), [])
        self.assertEqual(intake.depends_on({}), [])


class IntakeCli(unittest.TestCase):
    def setUp(self) -> None:
        reset_fake()
        FakePlane.labels = [{"id": "other", "name": "bug"}, {"id": LABEL, "name": "fractory"}]
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), FakePlane)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.tmp = Path(tempfile.mkdtemp())
        self.repo = self.tmp / "repo"
        self.repo.mkdir()
        self.home = self.tmp / "factory"
        self.home.mkdir()
        env = mock.patch.dict(os.environ, {"FACTORY_HOME": str(self.home), "PLANE_API_KEY": KEY})
        env.start()
        self.addCleanup(env.stop)
        self.write_config()
        for target, fake in ((briefcheck, "check"), (launch, "run_cmd")):
            patch = mock.patch.object(target, fake, side_effect=getattr(self, f"fake_{fake}"))
            patch.start()
            self.addCleanup(patch.stop)
        self.calls: list[list[str]] = []
        self.briefs: list[str] = []
        self.fail_worktree: set[str] = set()

    def write_config(self, extra: str = "") -> None:
        (self.home / "config.toml").write_text(
            f'orca_run = "run_1"\nplane_url = "{self.url}"\n{extra}\n[intake_repos]\n"{PROJECT}" = "{self.repo}"\n'
        )

    def fake_check(self, title: str, text: str, brief: str) -> briefcheck.Verdict:
        return briefcheck.Verdict(True, [])

    def fake_run_cmd(self, argv: list[str]) -> tuple[int, str]:
        self.calls.append(argv)
        if "worktree" in argv:
            if argv[argv.index("--name") + 1] in self.fail_worktree:
                return 1, "boom"
            return 0, json.dumps({"ok": True, "result": {"worktree": {"id": "repo::/wt/x"}}})
        if "run-show" in argv:
            return 0, json.dumps({"ok": True, "result": {"run": {"coordinator_handle": "term_coord"}}})
        self.briefs.append(Path(argv[argv.index("--spec-file") + 1]).read_text())
        return 0, "launched dispatch d1 in terminal term_abc (stage running)\n"

    def run_cli(self, *argv: str) -> tuple[int, str]:
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = cli.main(list(argv))
        return code, out.getvalue()

    def test_launches_labelled_cards_and_sets_in_progress(self) -> None:
        FakePlane.issues = [card(1, html="<p>Add <b>x</b></p>"), card(2, labels=()), card(3, "s-doing")]
        code, out = self.run_cli("intake")
        self.assertEqual(code, 0, out)
        jobs = store.all_jobs()
        self.assertEqual([j.tracker["ref"] for j in jobs], ["issue-1"])
        self.assertEqual(jobs[0].stage, "build")
        self.assertEqual(jobs[0].tracker["project"], PROJECT)
        self.assertEqual(FakePlane.patches[0][1].get("assignees"), ["user-me"])
        self.assertEqual(FakePlane.patches[-1][1], {"state": "s-doing"})
        self.assertIn("issue-1", FakePlane.patches[-1][0])
        brief = self.briefs[0]
        self.assertTrue(brief.startswith("# Card 1\n\nAdd x"))
        self.assertIn("worker_done", brief)
        self.assertIn("job advance <job id> built", brief)

    def test_second_run_makes_no_second_job_for_a_card(self) -> None:
        FakePlane.issues = [card(1)]
        self.run_cli("intake")
        FakePlane.issues[0]["state"] = "s-todo"  # moved back by hand
        self.run_cli("intake")
        self.assertEqual(len(store.all_jobs()), 1)

    def test_a_cancelled_job_is_not_relaunched(self) -> None:
        FakePlane.issues = [card(1)]
        store.save(job_for("issue-1", "cancelled"))
        self.run_cli("intake")
        self.assertEqual(self.calls, [])

    def test_max_parallel_jobs_counts_open_jobs_only(self) -> None:
        self.write_config("max_parallel_jobs = 2")
        store.save(job_for("old-a"))
        store.save(job_for("old-b", "done"))
        FakePlane.issues = [card(1), card(2), card(3)]
        _, out = self.run_cli("intake")
        refs = {j.tracker["ref"] for j in store.all_jobs()}
        self.assertEqual(refs, {"old-a", "old-b", "issue-1"})  # one open job + one new = the limit of 2
        self.assertIn("max_parallel_jobs", out)

    def test_default_limit_is_three(self) -> None:
        FakePlane.issues = [card(n) for n in range(1, 6)]
        self.run_cli("intake")
        self.assertEqual(len(store.all_jobs()), 3)

    def test_pagination_is_followed(self) -> None:
        FakePlane.page_size = 2
        FakePlane.issues = [card(n) for n in range(1, 6)]
        self.write_config("max_parallel_jobs = 10")
        self.run_cli("intake")
        self.assertEqual(len(store.all_jobs()), 5)

    def test_one_failing_launch_does_not_stop_the_next(self) -> None:
        FakePlane.issues = [card(1), card(2)]
        self.fail_worktree = {"card-1"}
        _, out = self.run_cli("intake")
        self.assertIn("launch failed", out)
        self.assertIn("launched 'Card 2'", out)
        # only the successful card was assigned and moved to In Progress
        self.assertEqual(len(FakePlane.patches), 2)
        self.assertTrue(all("issue-2" in path for path, _ in FakePlane.patches))

    def test_dry_run_launches_nothing(self) -> None:
        FakePlane.issues = [card(1)]
        code, out = self.run_cli("intake", "--dry-run")
        self.assertEqual(code, 0)
        self.assertIn("would launch 'Card 1'", out)
        self.assertEqual(self.calls, [])
        self.assertEqual(FakePlane.patches, [])
        self.assertEqual(store.all_jobs(), [])

    def test_backlog_card_waits_and_todo_launches(self) -> None:
        FakePlane.issues = [card(1, "s-backlog")]
        _, out = self.run_cli("intake", "--dry-run")
        self.assertIn("intake: Card 1 parked (backlog)", out)
        self.assertNotIn("would launch", out)
        self.run_cli("intake")
        self.assertEqual(store.all_jobs(), [])
        FakePlane.issues[0]["state"] = "s-todo"
        _, out = self.run_cli("intake", "--dry-run")
        self.assertIn("would launch 'Card 1'", out)
        self.assertNotIn("parked", out)
        self.run_cli("intake")
        self.assertEqual([j.tracker["ref"] for j in store.all_jobs()], ["issue-1"])

    def test_card_waits_for_its_dependency_then_launches(self) -> None:
        dep = card(1, "s-doing")
        dep["name"] = "07 · Tokens"
        FakePlane.issues = [dep, with_deps(2, "Depends on: 07")]
        _, out = self.run_cli("intake", "--dry-run")
        self.assertIn("intake: Card 2 waits for 07", out)
        self.assertNotIn("would launch 'Card 2'", out)
        self.run_cli("intake")
        self.assertEqual(store.all_jobs(), [])
        FakePlane.issues[0]["state"] = "s-done"
        self.run_cli("intake")
        self.assertEqual([j.tracker["ref"] for j in store.all_jobs()], ["issue-2"])

    def test_dependency_by_plane_key(self) -> None:
        dep = card(1, "s-done", labels=())
        dep["sequence_id"] = 12
        FakePlane.issues = [dep, with_deps(2, "Depends on: CORT-12")]
        self.run_cli("intake")
        self.assertEqual([j.tracker["ref"] for j in store.all_jobs()], ["issue-2"])

    def test_unknown_dependency_waits_and_is_reported_once(self) -> None:
        FakePlane.issues = [with_deps(1, "Depends on: 99")]
        _, out = self.run_cli("intake")
        self.assertEqual(out.count("unknown dependency 99"), 1)
        self.assertEqual(store.all_jobs(), [])

    def test_custom_label_name(self) -> None:
        self.write_config('intake_label = "bug"')
        FakePlane.issues = [card(1), card(2, labels=("other",))]
        self.run_cli("intake")
        self.assertEqual([j.tracker["ref"] for j in store.all_jobs()], ["issue-2"])

    def test_missing_label_is_reported(self) -> None:
        FakePlane.labels = []
        FakePlane.issues = [card(1)]
        code, out = self.run_cli("intake")
        self.assertEqual(code, 0)
        self.assertIn("no label 'fractory'", out)

    def test_no_repos_configured(self) -> None:
        (self.home / "config.toml").write_text("")
        _, out = self.run_cli("intake")
        self.assertIn("no intake_repos", out)


class WatchIntake(unittest.TestCase):
    def setUp(self) -> None:
        self.home = Path(tempfile.mkdtemp())
        env = mock.patch.dict(os.environ, {"FACTORY_HOME": str(self.home)})
        env.start()
        self.addCleanup(env.stop)

    def watch(self, config: str) -> mock.Mock:
        (self.home / "config.toml").write_text(config)
        with (
            mock.patch.object(intake, "run_intake") as run,
            contextlib.redirect_stdout(io.StringIO()),
        ):
            self.assertEqual(cli.main(["watch", "--rounds", "2", "--every", "0"]), 0)
        return run

    def test_watch_runs_intake_once_per_round_with_auto_intake(self) -> None:
        self.assertEqual(self.watch("auto_intake = true").call_count, 2)

    def test_watch_skips_intake_without_auto_intake(self) -> None:
        self.assertEqual(self.watch("").call_count, 0)
        self.assertEqual(self.watch("auto_intake = false").call_count, 0)


if __name__ == "__main__":
    unittest.main()
