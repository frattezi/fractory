"""Portuguese wording for the board: gate reasons and stuck reasons. Pure: strings in, strings out.

The board shows `text`; the raw English detail the code wrote stays available behind a details/title.
"""

from __future__ import annotations

import re

STAGE = {
    "discovery": "descoberta",
    "spec": "especificação",
    "build": "construção",
    "checks": "CI",
    "review": "revisão",
    "judge": "Judge",
    "ship": "entrega",
}

# `risk.SENSITIVE` patterns -> what the PR touches
SENSITIVE = {
    "auth": "autenticação",
    "secret": "segredos",
    "migrat": "migração",
    "schema": "schema do banco",
    "infra/": "infraestrutura",
    ".github/": "workflows do GitHub",
    "fractory/rubric.md": "o rubric do Judge",
    "fractory/launchd.py": "o launchd",
}

_SENSITIVE = re.compile(r"sensitive path (\S+) \(matches '(.*)'\)")
_LINES = re.compile(r"(\d+) lines changed \(limit (\d+)\)")
_FILES = re.compile(r"(\d+) files changed \(limit (\d+)\)")


def risk_reason(reason: str) -> str:
    """One `risk.assess` reason in Portuguese; an unknown shape is kept as written."""
    if m := _SENSITIVE.fullmatch(reason):
        return f"mexe em {SENSITIVE.get(m.group(2), 'caminho sensível')}"
    if m := _LINES.fullmatch(reason):
        return f"{m.group(1)} linhas (limite {m.group(2)})"
    if m := _FILES.fullmatch(reason):
        return f"{m.group(1)} arquivos (limite {m.group(2)})"
    return reason


def merge_review(detail: str) -> str:
    """`Risk.summary()` ("medium: 689 lines changed (limit 400); ...") -> "Revisar merge: 689 linhas (limite 400)"."""
    _, _, body = detail.partition(": ")
    reasons = [risk_reason(r) for r in body.split("; ") if r and not r.startswith("small, no sensitive")]
    return "Revisar merge" + (": " + "; ".join(dict.fromkeys(reasons)) if reasons else "")


def gate_text(reason: str, detail: str = "") -> str:
    """Plain-Portuguese sentence for a gate the code opens; an unknown reason says so and names it."""
    detail = detail or ""
    if reason == "merge_review":
        return merge_review(detail)
    if reason == "cost":
        m = re.fullmatch(r"US\$ ([\d.]+) over budget US\$ ([\d.]+)", detail)
        return f"Orçamento estourado: US$ {m.group(1)} de US$ {m.group(2)}" if m else "Orçamento estourado"
    if reason == "judge_rounds":
        m = re.match(r"(\d+) judge rounds", detail)
        return (
            f"O Judge reprovou {m.group(1)} vezes: decidir como seguir"
            if m
            else "O Judge reprovou várias vezes: decidir como seguir"
        )
    if reason == "judge_error":
        return "O Judge falhou ao revisar o PR, mesmo após novas tentativas"
    if reason == "worker_stalled":
        return "O worker parou sem perguntar nada, mesmo após ser cutucado"
    if reason == "launch_failed":
        return "Falha ao lançar o job: o worker não subiu"
    if reason == "rework_needed":
        return "Retrabalho pendente: não consegui avisar o worker"
    if reason == "merge_conflict":
        return "O PR tem conflito com a main e o worker não foi avisado"
    return f"Decisão pendente ({reason})"


def stuck_reason(kind: str, stage: str, span: str, gate: str | None = None, has_pr: bool = False) -> str:
    """Portuguese twin of the `reason` in `metrics.stuck_item`; `span` is already formatted ("2h10", "45 min")."""
    if kind == "gate":
        return f"gate {gate} aberto há {span}"
    if stage == "build":
        return f"em construção há {span}" + ("" if has_pr else " sem PR")
    if stage == "checks":
        return f"CI rodando há {span}"
    return f"em {STAGE.get(stage, stage)} há {span}"


def queue_text(entry: dict, max_parallel: int) -> str:
    """Why a Plane card has not started, in Portuguese; `entry` is one card of queue.json (see intake._queue_entries)."""
    decision = entry.get("decision")
    if decision == "launched":
        return "vai começar"
    if decision == "waits_for":
        return "espera " + ", ".join(entry.get("waits_for") or ["outro card"])
    if decision == "max_parallel":
        return f"limite de {max_parallel} jobs"
    if decision == "parked":
        return "em Backlog"
    if decision == "launch_failed":
        return f"falhou ao iniciar: {entry.get('error') or 'erro desconhecido'}"
    if decision == "has_job":
        return "já tem job"
    return f"decisão desconhecida ({decision})"
