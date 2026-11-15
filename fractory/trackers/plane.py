"""Plane adapter over its REST API (/api/v1, X-Api-Key header).

The API key comes from $PLANE_API_KEY or, failing that, the macOS Keychain item `fractory-plane`
(the user stores it once with `security add-generic-password -s fractory-plane -a plane -w`).
"""

from __future__ import annotations

import json
import os
import re
import ssl
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable
from datetime import date

from .base import STATUS_GROUPS, Duplicate, Item

DEFAULT_URL = "https://plane.cortadas.com.br"
DEFAULT_WORKSPACE = "cortadas"
EXTERNAL_SOURCE = "fractory"

# Same labels in every project: they tell factory work from human work. name -> (colour, description)
STANDARD_LABELS: dict[str, tuple[str, str]] = {
    "fractory": ("#1f6f78", "A fábrica executa este card (gatilho do intake)."),
    "humano": ("#e3a35f", "Exige uma pessoa: decisão, acesso, conta ou revisão."),
    "design": ("#a83b5a", "Vem de uma decisão de design."),
}

# The saved views every project gets: (name, label it filters by, layout).
# Plane's views endpoints take only a browser session, so `views_script` renders these as a snippet.
STANDARD_VIEWS = (
    ("👤 Precisa de você", "humano", "list"),
    ("🤖 Fábrica", "fractory", "kanban"),
    ("🧭 Planejamento", None, "list"),
)


def standard_view_specs(label_ids: dict[str, str]) -> list[dict]:
    def rich(label: str | None) -> dict:
        if label == "humano":
            return {"and": [{"label_id__in": label_ids["humano"]}, {"state_group__in": "unstarted,started"}]}
        if label == "fractory":
            return {"label_id__in": label_ids["fractory"]}
        return {"state_group__in": "backlog"}

    return [
        {"name": name, "rich_filters": rich(label), "display_filters": {"layout": layout}}
        for name, label, layout in STANDARD_VIEWS
    ]


_VIEWS_JS = """(async () => {
  const views = %(views)s;
  const base = "/api/workspaces/%(workspace)s/projects/%(project)s/views/";
  const csrf = (await (await fetch("/auth/get-csrf-token/", { credentials: "include" })).json()).csrf_token;
  const send = async (method, url, body) => {
    const res = await fetch(url, {
      method, credentials: "include", body: JSON.stringify(body),
      headers: { "Content-Type": "application/json", "X-CSRFToken": csrf },
    });
    if (!res.ok) throw new Error(method + " " + url + " -> " + res.status + " " + (await res.text()).slice(0, 200));
    return res.json();
  };
  const listed = await (await fetch(base, { credentials: "include" })).json();
  const existing = Array.isArray(listed) ? listed : (listed.results || []);
  const summary = [];
  for (const view of views) {
    const found = existing.find((v) => v.name === view.name);
    if (found) {
      await send("PATCH", base + found.id + "/", view);
      summary.push({ name: view.name, outcome: "updated" });
    } else {
      await send("POST", base, view);
      summary.push({ name: view.name, outcome: "created" });
    }
  }
  return JSON.stringify(summary);
})()
"""


def views_script(workspace: str, project_id: str, label_ids: dict[str, str]) -> str:
    """Self-contained JS for a logged-in Plane tab: create the standard views, or update them by name."""
    return _VIEWS_JS % {
        "views": json.dumps(standard_view_specs(label_ids), ensure_ascii=False),
        "workspace": workspace,
        "project": project_id,
    }


RATE_LIMIT_RETRIES = 3
RATE_LIMIT_BASE_WAIT = 2.0
sleep = time.sleep  # swapped in tests

_cycle: dict | None = None


def begin_cycle() -> None:
    """Start a watch cycle: project list, labels and states are fetched once per project until the next call."""
    global _cycle
    _cycle = {}


def end_cycle() -> None:
    global _cycle
    _cycle = None


def _cached[T](key: tuple, fetch: Callable[[], T]) -> T:
    if _cycle is None:
        return fetch()
    if key not in _cycle:
        _cycle[key] = fetch()
    return _cycle[key]


def _invalidate(prefix: tuple) -> None:
    if _cycle is not None:
        for k in [k for k in _cycle if k[: len(prefix)] == prefix]:
            del _cycle[k]


# (method, url, headers, body) -> (status, parsed json)
Http = Callable[[str, str, dict, bytes | None], tuple[int, object]]


SYSTEM_CA_FILES = ("/etc/ssl/cert.pem", "/etc/ssl/certs/ca-certificates.crt")


def tls_context() -> ssl.SSLContext:
    """Python.org builds on macOS ship without CA certs; fall back to the system bundle."""
    ctx = ssl.create_default_context()
    if ctx.cert_store_stats()["x509_ca"] == 0:
        for path in SYSTEM_CA_FILES:
            if os.path.exists(path):
                ctx.load_verify_locations(cafile=path)
                break
    return ctx


def urllib_http(method: str, url: str, headers: dict, body: bytes | None) -> tuple[int, object]:
    req = urllib.request.Request(url, data=body, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30, context=tls_context()) as resp:
            raw = resp.read()
            return resp.status, json.loads(raw) if raw else None
    except urllib.error.HTTPError as err:
        raw = err.read()
        if err.code == 429:
            return 429, {"retry_after": err.headers.get("Retry-After"), "body": raw.decode(errors="replace")[:300]}
        try:
            return err.code, json.loads(raw) if raw else None
        except json.JSONDecodeError:
            return err.code, raw.decode(errors="replace")


def api_key_from_env() -> str:
    key = os.environ.get("PLANE_API_KEY")
    if key:
        return key
    try:
        out = subprocess.run(
            ["security", "find-generic-password", "-s", "fractory-plane", "-w"],
            capture_output=True,
            text=True,
            check=True,
        )
        return out.stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        raise RuntimeError("no Plane API key: set PLANE_API_KEY or the Keychain item fractory-plane") from None


class PlaneError(RuntimeError):
    pass


def _results(data: object) -> list[dict]:
    if isinstance(data, dict) and "results" in data:
        return list(data["results"])
    return list(data) if isinstance(data, list) else []


def _retry_after(data: object) -> float | None:
    raw = data.get("retry_after") if isinstance(data, dict) else None
    try:
        return max(float(raw), 0.0) if raw is not None else None
    except (TypeError, ValueError):
        return None  # an HTTP-date; fall back to the exponential backoff


class Plane:
    def __init__(
        self,
        project_id: str,
        api_key: str,
        base_url: str = DEFAULT_URL,
        workspace: str = DEFAULT_WORKSPACE,
        http: Http = urllib_http,
        identifier: str = "",
    ):
        self.base = base_url.rstrip("/")
        self.workspace = workspace
        self.project_id = project_id
        self.identifier = identifier
        self._key = api_key
        self._http = http
        self._states: dict[str, str] | None = None

    def _call(self, method: str, path: str, payload: dict | None = None) -> tuple[int, object]:
        url = f"{self.base}/api/v1/workspaces/{self.workspace}{path}"
        body = json.dumps(payload).encode() if payload is not None else None
        headers = {"X-Api-Key": self._key, "Content-Type": "application/json", "Accept": "application/json"}
        status, data = self._http(method, url, headers, body)
        for attempt in range(RATE_LIMIT_RETRIES):
            if status != 429:
                break
            wait = _retry_after(data)
            if wait is None:
                wait = RATE_LIMIT_BASE_WAIT * 2**attempt
            if attempt == 0:  # one line per call, not one per retry
                print(f"plane: rate limited, backing off {wait:g}s", flush=True)
            sleep(wait)
            status, data = self._http(method, url, headers, body)
        if status == 409:
            return status, data
        if status >= 400:
            raise PlaneError(f"{method} {path}: HTTP {status}: {str(data)[:300]}")
        return status, data

    @classmethod
    def projects(
        cls, api_key: str, base_url: str = DEFAULT_URL, workspace: str = DEFAULT_WORKSPACE, http: Http = urllib_http
    ) -> list[dict]:
        def fetch() -> list[dict]:
            _, data = cls("", api_key, base_url, workspace, http)._call("GET", "/projects/")
            return [
                {"id": p["id"], "identifier": p.get("identifier", ""), "name": p.get("name", "")}
                for p in _results(data)
            ]

        return list(_cached(("projects", base_url.rstrip("/"), workspace), fetch))

    @classmethod
    def resolve_project(
        cls,
        ref: str,
        api_key: str,
        base_url: str = DEFAULT_URL,
        workspace: str = DEFAULT_WORKSPACE,
        http: Http = urllib_http,
    ) -> tuple[str, str]:
        """(project id, identifier) from a UUID or an identifier like CUIDADO."""
        for p in cls.projects(api_key, base_url, workspace, http):
            if ref == p["id"] or ref.upper() == p["identifier"].upper():
                return p["id"], p["identifier"]
        raise PlaneError(f"no project {ref}; see `fractory plane projects`")

    @classmethod
    def create_project(
        cls,
        api_key: str,
        name: str,
        identifier: str,
        description: str = "",
        base_url: str = DEFAULT_URL,
        workspace: str = DEFAULT_WORKSPACE,
        http: Http = urllib_http,
    ) -> tuple[dict, bool]:
        """Create a project, or return the one that already has this identifier. (project, created)"""
        identifier = identifier.upper()
        for p in cls.projects(api_key, base_url, workspace, http):
            if p["identifier"] == identifier:
                return p, False
        _invalidate(("projects",))
        client = cls("", api_key, base_url, workspace, http)
        _, data = client._call(
            "POST", "/projects/", {"name": name, "identifier": identifier, "description": description}
        )
        if not isinstance(data, dict) or "id" not in data:
            raise PlaneError(f"could not create project {identifier}: {str(data)[:300]}")
        return {
            "id": data["id"],
            "identifier": data.get("identifier", identifier),
            "name": data.get("name", name),
        }, True

    def enable_views(self) -> bool:
        """Turn on the project's Views feature. False if the API refuses it (then it is a manual step)."""
        try:
            self._call("PATCH", f"/projects/{self.project_id}/", {"issue_views_view": True})
        except PlaneError:
            return False
        return True

    def ensure_labels(self, spec: dict[str, tuple[str, str]] = STANDARD_LABELS) -> dict[str, str]:
        """Create missing labels, fix colour/description of existing ones. Idempotent. name -> id"""
        existing = {lb["name"]: lb for lb in self.labels()}
        _invalidate(("labels", self.base, self.workspace, self.project_id))
        ids: dict[str, str] = {}
        for name, (color, description) in spec.items():
            wanted = {"color": color, "description": description}
            label = existing.get(name)
            if label is None:
                _, data = self._call("POST", f"/projects/{self.project_id}/labels/", {"name": name, **wanted})
                if not isinstance(data, dict) or "id" not in data:
                    raise PlaneError(f"could not create label {name!r}: {str(data)[:300]}")
                ids[name] = data["id"]
            else:
                ids[name] = label["id"]
                if any(label.get(k) != v for k, v in wanted.items()):
                    self._call("PATCH", f"/projects/{self.project_id}/labels/{label['id']}/", wanted)
        return ids

    def state_for(self, status: str) -> str:
        """The project's first state in the Plane group this Fractory status maps to."""
        if self._states is None:
            self._states = {}
            for s in sorted(self._state_rows(), key=lambda s: s.get("sequence", 0)):
                self._states.setdefault(s["group"], s["id"])
        group = STATUS_GROUPS[status]
        if group not in self._states:
            raise PlaneError(f"project {self.project_id} has no state in group {group!r}")
        return self._states[group]

    def create_item(
        self,
        title: str,
        body_html: str,
        status: str,
        external_id: str,
        labels: list[str] | None = None,
        assignees: list[str] | None = None,
    ) -> Item:
        payload: dict = {
            "name": title[:255],
            "description_html": body_html,
            "state": self.state_for(status),
            "external_id": external_id,
            "external_source": EXTERNAL_SOURCE,
        }
        if labels:
            payload["labels"] = labels
        if assignees:
            payload["assignees"] = assignees
        status_code, data = self._call("POST", f"/projects/{self.project_id}/issues/", payload)
        if status_code == 409:
            ref = data.get("id", "") if isinstance(data, dict) else ""
            raise Duplicate(str(ref))
        assert isinstance(data, dict)
        key = f"{self.identifier}-{data.get('sequence_id')}" if self.identifier else str(data.get("sequence_id", ""))
        return Item(
            ref=data["id"], key=key, url=f"{self.base}/{self.workspace}/projects/{self.project_id}/issues/{data['id']}"
        )

    def me(self) -> str:
        """Id of the user that owns the API key (not workspace-scoped)."""
        headers = {"X-Api-Key": self._key, "Accept": "application/json"}
        status, data = self._http("GET", f"{self.base}/api/v1/users/me/", headers, None)
        if status >= 400 or not isinstance(data, dict) or not data.get("id"):
            raise PlaneError(f"GET /users/me/: HTTP {status}: {str(data)[:300]}")
        return str(data["id"])

    def set_status(self, ref: str, status: str) -> None:
        payload: dict = {"state": self.state_for(status)}
        if status == "done" and not self.get_item(ref).get("target_date"):
            payload["target_date"] = date.today().isoformat()
        self._call("PATCH", f"/projects/{self.project_id}/issues/{ref}/", payload)
        if _cycle is not None and (groups := _cycle.get(("groups", self.base, self.workspace, self.project_id))):
            groups[ref] = STATUS_GROUPS[status]  # keep the per-cycle listing true without a refetch

    def start_item(self, ref: str, assignee: str) -> None:
        """Add `assignee` to the card, keeping the existing ones, and set the start date if empty."""
        issue = self.get_item(ref)
        payload: dict = {}
        current = [str(a.get("id") if isinstance(a, dict) else a) for a in issue.get("assignees") or []]
        if assignee not in current:
            payload["assignees"] = [*current, assignee]
        if not issue.get("start_date"):
            payload["start_date"] = date.today().isoformat()
        if payload:
            self._call("PATCH", f"/projects/{self.project_id}/issues/{ref}/", payload)

    def label_id(self, name: str) -> str:
        """Id of a standard label, created if the project lacks it."""
        if name not in STANDARD_LABELS:
            raise PlaneError(f"unknown label {name!r}; standard labels: {', '.join(STANDARD_LABELS)}")
        return self.ensure_labels({name: STANDARD_LABELS[name]})[name]

    def label_names(self, issue: dict) -> list[str]:
        """Names of the labels on an issue (the API lists ids, or objects when expanded)."""
        by_id = {lb["id"]: lb["name"] for lb in self.labels()}
        raw = issue.get("labels") or []
        return [str(lb["name"]) if isinstance(lb, dict) else by_id.get(lb, str(lb)) for lb in raw]

    def states(self) -> dict[str, dict]:
        """State id -> {name, group}."""
        return {s["id"]: {"name": s.get("name", ""), "group": s.get("group", "")} for s in self._state_rows()}

    def _state_rows(self) -> list[dict]:
        def fetch() -> list[dict]:
            _, data = self._call("GET", f"/projects/{self.project_id}/states/")
            return _results(data)

        return _cached(("states", self.base, self.workspace, self.project_id), fetch)

    def resolve_ref(self, ref: str) -> str:
        """Issue id from an id or a key like CUIDADO-12 (matched on the project's sequence ids)."""
        m = re.fullmatch(r"([A-Za-z][A-Za-z0-9]*)-(\d+)", ref)
        if not m:
            return ref
        for issue in self.list_issues():
            if issue.get("sequence_id") == int(m.group(2)):
                return str(issue["id"])
        raise PlaneError(f"no card {ref} in project {self.project_id}")

    def add_labels(self, ref: str, names: list[str]) -> None:
        """Add labels to a card, keeping the ones it has."""
        current = [str(lb["id"] if isinstance(lb, dict) else lb) for lb in self.get_item(ref).get("labels") or []]
        wanted = [i for i in (self.label_id(n) for n in names) if i not in current]
        if wanted:
            self._call("PATCH", f"/projects/{self.project_id}/issues/{ref}/", {"labels": [*current, *wanted]})

    def item_group(self, ref: str) -> str:
        """Plane state group of an issue: backlog | unstarted | started | completed | cancelled."""
        state = self.get_item(ref).get("state")
        if isinstance(state, dict):
            return str(state.get("group", ""))
        return next((str(s["group"]) for s in self._state_rows() if s["id"] == state), "")

    def issue_groups(self) -> dict[str, str]:
        """Issue id -> state group for the whole project; one fetch per watch cycle."""

        def fetch() -> dict[str, str]:
            return {
                str(i["id"]): str(i["state"].get("group", "")) if isinstance(i.get("state"), dict) else ""
                for i in self.list_issues()
            }

        return _cached(("groups", self.base, self.workspace, self.project_id), fetch)

    def comment_texts(self, ref: str) -> list[str]:
        _, data = self._call("GET", f"/projects/{self.project_id}/issues/{ref}/comments/")
        return [str(c.get("comment_stripped") or c.get("comment_html") or "") for c in _results(data)]

    def get_item(self, ref: str) -> dict:
        _, data = self._call("GET", f"/projects/{self.project_id}/issues/{ref}/")
        if not isinstance(data, dict):
            raise PlaneError(f"issue {ref}: unexpected response")
        return data

    def comment(self, ref: str, body_html: str) -> None:
        self._call("POST", f"/projects/{self.project_id}/issues/{ref}/comments/", {"comment_html": body_html})

    def labels(self) -> list[dict]:
        def fetch() -> list[dict]:
            _, data = self._call("GET", f"/projects/{self.project_id}/labels/")
            return _results(data)

        return list(_cached(("labels", self.base, self.workspace, self.project_id), fetch))

    def list_issues(self) -> list[dict]:
        """Every issue of the project, state expanded (`state["group"]`), following the cursor pagination."""
        issues: list[dict] = []
        cursor = ""
        while True:
            query = "?expand=state" + (f"&cursor={urllib.parse.quote(cursor)}" if cursor else "")
            _, data = self._call("GET", f"/projects/{self.project_id}/issues/{query}")
            issues += _results(data)
            if not (isinstance(data, dict) and data.get("next_page_results") and data.get("next_cursor")):
                return issues
            cursor = str(data["next_cursor"])
