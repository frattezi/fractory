"""Import a repo's open docs/specs into a tracker. Done specs stay in the repo as frozen history."""

from __future__ import annotations

import html
import re
from dataclasses import dataclass
from pathlib import Path

from .trackers.base import Duplicate, Tracker

# spec status -> Fractory tracker status
OPEN_STATUSES = {
    "draft": "backlog",
    "blocked": "backlog",
    "ready": "ready",
    "in-progress": "in_progress",
    "in-review": "in_progress",
}


@dataclass(frozen=True)
class Spec:
    path: Path
    id: str
    title: str
    status: str
    body: str


def parse_frontmatter(text: str) -> tuple[dict[str, str], str]:
    if not text.startswith("---\n"):
        return {}, text
    end = text.find("\n---", 4)
    if end < 0:
        return {}, text
    meta: dict[str, str] = {}
    for line in text[4:end].splitlines():
        m = re.match(r"^([A-Za-z_][\w-]*):\s*(.*)$", line)
        if not m:
            continue
        value = re.sub(r"\s+#.*$", "", m.group(2)).strip().strip("'\"")
        meta[m.group(1)] = value
    return meta, text[end + 4 :].lstrip("\n")


def read_specs(specs_dir: Path) -> list[Spec]:
    out = []
    for path in sorted(specs_dir.glob("*.md")):
        meta, body = parse_frontmatter(path.read_text())
        if meta.get("type") != "Spec" or not meta.get("id"):
            continue  # TEMPLATE.md, index.md, log.md
        out.append(Spec(path, meta["id"], meta.get("title", path.stem), meta.get("status", ""), body))
    return out


def open_specs(specs: list[Spec]) -> list[Spec]:
    return [s for s in specs if s.status in OPEN_STATUSES]


def _inline(text: str) -> str:
    text = html.escape(text, quote=False)
    text = re.sub(r"`([^`]+)`", r"<code>\1</code>", text)
    text = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", text)
    return re.sub(r"\[([^\]]+)\]\(([^)\s]+)\)", r'<a href="\2">\1</a>', text)


def markdown_to_html(md: str) -> str:
    """Enough Markdown for spec bodies: headings, lists, code fences, paragraphs."""
    out: list[str] = []
    para: list[str] = []
    items: list[str] = []
    code: list[str] | None = None

    def flush() -> None:
        if para:
            out.append(f"<p>{_inline(' '.join(para))}</p>")
            para.clear()
        if items:
            out.append("<ul>" + "".join(f"<li>{_inline(i)}</li>" for i in items) + "</ul>")
            items.clear()

    for line in md.splitlines():
        if code is not None:
            if line.startswith("```"):
                out.append(f"<pre><code>{html.escape(chr(10).join(code))}</code></pre>")
                code = None
            else:
                code.append(line)
            continue
        if line.startswith("```"):
            flush()
            code = []
        elif m := re.match(r"^(#{1,6})\s+(.*)$", line):
            flush()
            level = len(m.group(1))
            out.append(f"<h{level}>{_inline(m.group(2))}</h{level}>")
        elif m := re.match(r"^\s*(?:[-*]|\d+\.)\s+(.*)$", line):
            if para:
                flush()
            items.append(m.group(1))
        elif not line.strip():
            flush()
        elif items:
            items[-1] += " " + line.strip()
        else:
            para.append(line.strip())
    if code is not None:
        out.append(f"<pre><code>{html.escape(chr(10).join(code))}</code></pre>")
    flush()
    return "\n".join(out)


def spec_html(spec: Spec, repo_name: str) -> str:
    source = (
        f"<p><em>Imported by Fractory from {html.escape(repo_name)}/{html.escape(spec.path.name)} "
        f"(status {html.escape(spec.status)}).</em></p>\n"
    )
    return source + markdown_to_html(spec.body)


@dataclass(frozen=True)
class ImportResult:
    spec_id: str
    outcome: str  # planned | created | exists
    ref: str = ""


def import_specs(specs: list[Spec], repo_name: str, tracker: Tracker | None) -> list[ImportResult]:
    """tracker=None is a dry run: report what would be created."""
    results = []
    for spec in open_specs(specs):
        if tracker is None:
            results.append(ImportResult(spec.id, "planned"))
            continue
        try:
            item = tracker.create_item(
                f"{spec.id} · {spec.title}", spec_html(spec, repo_name), OPEN_STATUSES[spec.status], external_id=spec.id
            )
            results.append(ImportResult(spec.id, "created", item.ref))
        except Duplicate as dup:
            results.append(ImportResult(spec.id, "exists", dup.ref))
    return results
