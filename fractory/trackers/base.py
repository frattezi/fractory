"""One interface for every tracker (Plane for personal projects, Jira for Able in v2)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

# Fractory status -> Plane state group (Plane's fixed groups).
STATUS_GROUPS = {
    "backlog": "backlog",
    "ready": "unstarted",
    "in_progress": "started",
    "done": "completed",
    "cancelled": "cancelled",
}


@dataclass(frozen=True)
class Item:
    ref: str  # tracker id
    key: str  # human key, e.g. CORT-12
    url: str = ""


class Duplicate(Exception):
    """The tracker already holds an item with this external id."""

    def __init__(self, ref: str):
        super().__init__(ref)
        self.ref = ref


class Tracker(Protocol):
    def create_item(
        self,
        title: str,
        body_html: str,
        status: str,
        external_id: str,
        labels: list[str] | None = None,
        assignees: list[str] | None = None,
    ) -> Item: ...
    def set_status(self, ref: str, status: str) -> None: ...
    def comment(self, ref: str, body_html: str) -> None: ...
