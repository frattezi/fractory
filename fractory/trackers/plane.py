"""Plane adapter over its REST API (/api/v1, X-Api-Key header).

The API key comes from $PLANE_API_KEY or, failing that, the macOS Keychain item `fractory-plane`
(the user stores it once with `security add-generic-password -s fractory-plane -a plane -w`).
"""

from __future__ import annotations

import json
import os
import ssl
import subprocess
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable

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
        if status == 409:
            return status, data
        if status >= 400:
            raise PlaneError(f"{method} {path}: HTTP {status}: {str(data)[:300]}")
        return status, data

    @classmethod
    def projects(
        cls, api_key: str, base_url: str = DEFAULT_URL, workspace: str = DEFAULT_WORKSPACE, http: Http = urllib_http
    ) -> list[dict]:
        client = cls("", api_key, base_url, workspace, http)
        _, data = client._call("GET", "/projects/")
        return [
            {"id": p["id"], "identifier": p.get("identifier", ""), "name": p.get("name", "")} for p in _results(data)
        ]

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
            _, data = self._call("GET", f"/projects/{self.project_id}/states/")
            self._states = {}
            for s in sorted(_results(data), key=lambda s: s.get("sequence", 0)):
                self._states.setdefault(s["group"], s["id"])
        group = STATUS_GROUPS[status]
        if group not in self._states:
            raise PlaneError(f"project {self.project_id} has no state in group {group!r}")
        return self._states[group]

    def create_item(self, title: str, body_html: str, status: str, external_id: str) -> Item:
        status_code, data = self._call(
            "POST",
            f"/projects/{self.project_id}/issues/",
            {
                "name": title[:255],
                "description_html": body_html,
                "state": self.state_for(status),
                "external_id": external_id,
                "external_source": EXTERNAL_SOURCE,
            },
        )
        if status_code == 409:
            ref = data.get("id", "") if isinstance(data, dict) else ""
            raise Duplicate(str(ref))
        assert isinstance(data, dict)
        key = f"{self.identifier}-{data.get('sequence_id')}" if self.identifier else str(data.get("sequence_id", ""))
        return Item(
            ref=data["id"], key=key, url=f"{self.base}/{self.workspace}/projects/{self.project_id}/issues/{data['id']}"
        )

    def set_status(self, ref: str, status: str) -> None:
        self._call("PATCH", f"/projects/{self.project_id}/issues/{ref}/", {"state": self.state_for(status)})

    def get_item(self, ref: str) -> dict:
        _, data = self._call("GET", f"/projects/{self.project_id}/issues/{ref}/")
        if not isinstance(data, dict):
            raise PlaneError(f"issue {ref}: unexpected response")
        return data

    def comment(self, ref: str, body_html: str) -> None:
        self._call("POST", f"/projects/{self.project_id}/issues/{ref}/comments/", {"comment_html": body_html})

    def labels(self) -> list[dict]:
        _, data = self._call("GET", f"/projects/{self.project_id}/labels/")
        return _results(data)

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
