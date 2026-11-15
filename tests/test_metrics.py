"""fractory.metrics over hand-built histories (no disk)."""

from __future__ import annotations

import unittest
from datetime import UTC, datetime, timedelta

from fractory import metrics, state

NOW = datetime(2026, 11, 14, 12, 0, tzinfo=UTC)


def ago(**kw) -> str:
    return (NOW - timedelta(**kw)).isoformat()


def job(job_id="a-1", repo="/r/a", stage="build", created=None, history=(), **kw) -> state.Job:
    j = state.Job(id=job_id, repo=repo, title="t", stage=stage, created_at=created or ago(days=1), **kw)
    j.history = [{"at": at, "event": ev, "stage": st, **extra} for at, ev, st, extra in history]
    return j


def e(at, event, stage, **extra):
    return (at, event, stage, extra)


class StageTime(unittest.TestCase):
    def test_per_stage_and_current_age(self) -> None:
        j = job(
            stage="checks",
            history=[
                e(ago(minutes=100), "created", "build"),
                e(ago(minutes=40), "built", "checks"),
                e(ago(minutes=10), "red", "build"),
                e(ago(minutes=5), "built", "checks"),
            ],
        )
        self.assertEqual(metrics.stage_minutes(j, NOW), {"build": 65.0, "checks": 35.0})
        self.assertEqual(metrics.stage_age_minutes(j, NOW), 5)

    def test_age_counts_from_first_entry_of_the_stage_run(self) -> None:
        j = job(
            stage="build",
            history=[e(ago(minutes=90), "created", "build"), e(ago(minutes=30), "cost", "build", usd=1)],
        )
        self.assertEqual(metrics.stage_age_minutes(j, NOW), 90)

    def test_terminal_job_stops_counting(self) -> None:
        j = job(stage="done", history=[e(ago(minutes=60), "created", "ship"), e(ago(minutes=50), "merged", "done")])
        self.assertEqual(metrics.stage_minutes(j, NOW), {"ship": 10.0})

    def test_no_history(self) -> None:
        self.assertEqual(metrics.stage_minutes(job(), NOW), {})


class Stuck(unittest.TestCase):
    def build(self, minutes, **kw):
        return job(stage="build", history=[e(ago(minutes=minutes), "created", "build")], **kw)

    def test_thresholds_per_stage(self) -> None:
        for stage, limit in metrics.DEFAULT_STUCK_MINUTES.items():
            under = job(stage=stage, history=[e(ago(minutes=limit - 1), "x", stage)])
            over = job(stage=stage, history=[e(ago(minutes=limit + 1), "x", stage)])
            self.assertIsNone(metrics.stuck_item(under, NOW), stage)
            self.assertEqual(metrics.stuck_item(over, NOW)["stage"], stage)

    def test_reasons(self) -> None:
        self.assertEqual(metrics.stuck_item(self.build(130), NOW)["reason"], "build for 2h10 with no PR")
        with_pr = self.build(130, links={"pr": "7"})
        self.assertEqual(metrics.stuck_item(with_pr, NOW)["reason"], "build for 2h10")
        ci = job(stage="checks", history=[e(ago(minutes=45), "built", "checks")])
        self.assertEqual(metrics.stuck_item(ci, NOW)["reason"], "CI running 45 min")

    def test_open_gate_counts_at_any_age(self) -> None:
        j = job(stage="ship", history=[e(ago(minutes=1), "approved", "ship")])
        j.gate = state.Gate("merge_review", opened_at=ago(hours=3))
        item = metrics.stuck_item(j, NOW)
        self.assertEqual((item["kind"], item["reason"]), ("gate", "gate merge_review open 3h"))
        j.gate.opened_at = ago(seconds=30)
        self.assertEqual(metrics.stuck_item(j, NOW)["kind"], "gate")

    def test_config_override(self) -> None:
        j = self.build(30)
        self.assertIsNone(metrics.stuck_item(j, NOW))
        limits = metrics.thresholds({"stuck": {"build": 10, "bogus": 1, "ship": "x", "judge": -5}})
        self.assertEqual(limits["build"], 10)
        self.assertEqual((limits["ship"], limits["judge"]), (15, 20))
        self.assertIsNotNone(metrics.stuck_item(j, NOW, limits))

    def test_terminal_and_early_stages_never_stuck(self) -> None:
        self.assertIsNone(metrics.stuck_item(job(stage="done", history=[e(ago(days=9), "x", "done")]), NOW))
        self.assertIsNone(metrics.stuck_item(job(stage="spec", history=[e(ago(days=9), "x", "spec")]), NOW))

    def test_sorted_oldest_first(self) -> None:
        a, b = self.build(70), self.build(200, job_id="a-2")
        self.assertEqual([i["job"] for i in metrics.stuck_items([a, b], NOW)], ["a-2", "a-1"])


class Flow(unittest.TestCase):
    def merged(self, job_id, repo, lead_min, merged_ago):
        done = NOW - merged_ago
        created = (done - timedelta(minutes=lead_min)).isoformat()
        return job(job_id, repo, "done", created, [e(done.isoformat(), "merged", "done")])

    def test_lead_time_throughput_wip(self) -> None:
        jobs = [
            self.merged("a-1", "/r/a", 60, timedelta(days=1)),
            self.merged("a-2", "/r/a", 120, timedelta(days=2)),
            self.merged("a-3", "/r/a", 600, timedelta(days=3)),
            self.merged("b-1", "/r/b", 30, timedelta(days=10)),  # outside 7d
            job("a-4", "/r/a", "build"),
            job("b-2", "/r/b", "review"),
            job("a-5", "/r/a", "cancelled"),
        ]
        f7 = metrics.flow(jobs, NOW, 7)
        self.assertEqual(f7["lead_time"]["overall"], {"count": 3, "median_min": 120, "p90_min": 600})
        self.assertEqual(list(f7["lead_time"]["by_repo"]), ["/r/a"])
        self.assertEqual(f7["throughput_per_day"]["by_repo"]["/r/a"], round(3 / 7, 3))
        self.assertEqual(f7["wip"], {"overall": 2, "by_repo": {"/r/a": 1, "/r/b": 1}})
        f30 = metrics.flow(jobs, NOW, 30)
        self.assertEqual(f30["lead_time"]["by_repo"]["/r/b"]["median_min"], 30)
        self.assertEqual(f30["lead_time"]["overall"]["count"], 4)

    def test_merged_per_day_and_stage_summary(self) -> None:
        jobs = [
            self.merged("a-1", "/r/a", 60, timedelta(hours=1)),
            self.merged("a-2", "/r/a", 60, timedelta(hours=2)),
            self.merged("b-1", "/r/b", 60, timedelta(days=2)),
            self.merged("b-2", "/r/b", 60, timedelta(days=20)),
        ]
        days = metrics.flow(jobs, NOW, 7)["merged_per_day"]
        self.assertEqual(len(days), 7)
        self.assertEqual(days[-1], {"date": "2026-11-14", "total": 2, "by_repo": {"/r/a": 2}})
        self.assertEqual(days[-3]["by_repo"], {"/r/b": 1})
        self.assertEqual(sum(d["total"] for d in metrics.flow(jobs, NOW, 30)["merged_per_day"]), 4)
        j = job(
            stage="checks",
            history=[e(ago(minutes=100), "created", "build"), e(ago(minutes=40), "built", "checks")],
        )
        got = metrics.compute([j], NOW, 7)["stage_summary"]
        self.assertEqual(got["build"], {"count": 1, "median_min": 60.0})
        self.assertEqual(got["checks"]["median_min"], 40.0)

    def test_empty(self) -> None:
        f = metrics.flow([], NOW, 7)
        self.assertEqual(f["lead_time"]["overall"], {"count": 0, "median_min": None, "p90_min": None})
        self.assertEqual(f["wip"], {"overall": 0, "by_repo": {}})

    def test_percentile(self) -> None:
        self.assertEqual(metrics.percentile(list(range(1, 11)), 90), 9)
        self.assertIsNone(metrics.percentile([], 90))


class Quality(unittest.TestCase):
    def test_job_with_gates_and_rework(self) -> None:
        reworked = job(
            "a-1",
            stage="done",
            history=[
                e(ago(days=2), "created", "build"),
                e(ago(days=2, minutes=-10), "red", "build", check="ci"),
                e(ago(days=1, hours=5), "rejected", "build", note="no tests"),
                e(ago(days=1, hours=4), "gate_opened", "build", reason="judge_rounds"),
                e(ago(days=1, hours=3), "gate_resolved", "build", reason="judge_rounds", decision="continue"),
                e(ago(days=1, hours=2), "conflict_sent", "build"),
                e(ago(days=1), "approved", "ship", note="ok"),
                e(ago(hours=20), "merged", "done"),
            ],
        )
        clean = job("a-2", stage="ship", history=[e(ago(days=1), "approved", "ship", note="ok")])
        still_open = job("a-3", stage="ship", history=[e(ago(hours=2), "gate_opened", "ship", reason="merge_review")])
        synced = job("a-4", stage="done", history=[e(ago(hours=1), "approved", "done", note="sync")])
        q = metrics.quality([reworked, clean, still_open, synced], NOW, 7)
        self.assertEqual(q["jobs"], 4)
        self.assertEqual(q["judge_first_pass_rate"], 0.5)
        self.assertEqual(q["mean_rework_rounds"], 0.5)
        self.assertEqual(q["ci_red_rate"], 0.25)
        self.assertEqual(q["conflicts_sent"], 1)
        self.assertEqual(q["gates_opened"]["judge_rounds"], {"count": 1, "median_resolve_min": 60})
        self.assertEqual(q["gates_opened"]["merge_review"], {"count": 1, "median_resolve_min": None})

    def test_window_excludes_old_events(self) -> None:
        old = job(history=[e(ago(days=20), "red", "build"), e(ago(days=20), "gate_opened", "build", reason="cost")])
        q = metrics.quality([old], NOW, 7)
        self.assertEqual((q["jobs"], q["red_events"], q["gates_opened"]), (0, 0, {}))
        self.assertEqual(metrics.quality([old], NOW, 30)["red_events"], 1)

    def test_empty(self) -> None:
        q = metrics.quality([], NOW, 7)
        self.assertIsNone(q["judge_first_pass_rate"])
        self.assertIsNone(q["mean_rework_rounds"])
        self.assertIsNone(q["ci_red_rate"])


class Cost(unittest.TestCase):
    def test_sum_per_repo_and_window(self) -> None:
        jobs = [
            job(
                "a-1",
                "/r/a",
                history=[e(ago(days=1), "cost", "build", usd=1.5), e(ago(days=2), "cost", "build", usd=0.5)],
            ),
            job("b-1", "/r/b", history=[e(ago(days=10), "cost", "build", usd=3.0)]),
            job("a-2", "/r/a"),
        ]
        self.assertEqual(metrics.cost(jobs, NOW, 7), {"total_usd": 2.0, "by_repo": {"/r/a": 2.0, "/r/b": 0.0}})
        self.assertEqual(metrics.cost(jobs, NOW, 30)["total_usd"], 5.0)

    def test_zero_today(self) -> None:
        self.assertEqual(metrics.cost([job()], NOW, 7)["total_usd"], 0)
        self.assertEqual(metrics.cost([], NOW, 7), {"total_usd": 0, "by_repo": {}})


class Compute(unittest.TestCase):
    def test_empty_data(self) -> None:
        out = metrics.compute([], NOW, 7)
        self.assertEqual(out["stuck"], [])
        self.assertEqual(out["stage_minutes"], {})
        self.assertEqual(out["flow"]["wip"]["overall"], 0)

    def test_duration_format(self) -> None:
        self.assertEqual(
            [metrics.fmt_duration(m) for m in (5, 45, 60, 130, 180)], ["5 min", "45 min", "1h", "2h10", "3h"]
        )


if __name__ == "__main__":
    unittest.main()
