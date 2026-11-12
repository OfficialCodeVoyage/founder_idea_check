# ─────────────────────────────────────────────────────────────────────────────
# ADAPTED from mvanhorn/last30days-skill (MIT, Copyright (c) 2026 Matt Van Horn)
#   file:   skills/last30days/scripts/lib/schema.py
#   commit: 9243a32d823c7c8659e44b92f2dedcf1b7397137 (2026-08-18)
#   licence text: LICENSES/MIT-mvanhorn-last30days-skill.txt
#
# MODIFICATIONS: trimmed from 1,046 lines to the five types the pipeline touches
# (SubQuery, QueryPlan, SourceItem, Candidate, Cluster) and the helpers around
# them. The field names are upstream's, kept identical so the vendored modules run
# against them unchanged. `to_demand_signal` emits this app's own wire shape and
# never the author. The docstring below says why.
#
#   gh api "repos/mvanhorn/last30days-skill/commits?path=skills/last30days/scripts/lib/schema.py&since=2026-08-18" --jq '.[].commit.message'
# ─────────────────────────────────────────────────────────────────────────────
"""Evidence shapes.

Derived from `mvanhorn/last30days-skill` `lib/schema.py` @ 9243a32d (MIT), which
defines `SourceItem`, `Candidate`, `SubQuery`, `QueryPlan` and `Cluster` with
the same field names — kept identical so the vendored `dedupe`, `fusion` and
`cluster` modules run against them unchanged.

TRIMMED HARD. Upstream's file is 1,046 lines because it also carries a report
model, a discovery-mode model, an agent-export serialiser and a source-health
table for a CLI this service does not have. Only the five types the pipeline
actually touches are here.

ONE DELIBERATE OMISSION, and it is a legal one: `SourceItem.author` exists here
because the vendored dedupe and fusion code reads it (per-author capping is real
signal), but it NEVER crosses the wire. `to_demand_signal` does not emit it. See
`apps/chat/lib/signals/providers.ts` for the reasoning: a username plus a
verbatim quote is personal data, and the `DemandSignal` type on the TypeScript
side has no field to put it in, so the shape itself refuses to carry it.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

DateConfidence = Literal["high", "med", "low"]


@dataclass(frozen=True)
class SubQuery:
    """One retrieval unit: a search string plus the sources allowed to serve it."""

    label: str
    search_query: str
    ranking_query: str
    sources: list[str]
    weight: float = 1.0

    def __post_init__(self) -> None:
        if not self.sources:
            raise ValueError("SubQuery must name at least one source")
        if self.weight <= 0:
            raise ValueError(f"SubQuery weight must be positive, got {self.weight}")


@dataclass
class QueryPlan:
    """What the whole run is asking for."""

    raw_topic: str
    intent: str
    cluster_mode: str
    subqueries: list[SubQuery]
    source_weights: dict[str, float] = field(default_factory=dict)
    notes: list[str] = field(default_factory=list)


@dataclass
class SourceItem:
    """One normalized piece of evidence, as an adapter emits it."""

    item_id: str
    source: str
    title: str
    body: str
    url: str
    author: str | None = None
    container: str | None = None
    published_at: str | None = None
    date_confidence: DateConfidence = "low"
    engagement: dict[str, float | int] = field(default_factory=dict)
    relevance_hint: float = 0.5
    why_relevant: str = ""
    snippet: str = ""
    metadata: dict[str, Any] = field(default_factory=dict)
    # Filled in by the scoring pass, after construction.
    local_relevance: float | None = None
    freshness: int | None = None
    engagement_score: float | None = None
    source_quality: float | None = None


@dataclass
class Candidate:
    """A SourceItem after fusion has merged its duplicates across sources."""

    candidate_id: str
    item_id: str
    source: str
    title: str
    url: str
    snippet: str
    subquery_labels: list[str]
    native_ranks: dict[str, int]
    local_relevance: float
    freshness: int
    engagement: int | float | None
    source_quality: float
    rrf_score: float
    sources: list[str] = field(default_factory=list)
    source_items: list[SourceItem] = field(default_factory=list)
    final_score: float = 0.0
    explanation: str | None = None
    cluster_id: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class Cluster:
    """A group of candidates covering the same story."""

    cluster_id: str
    title: str
    candidate_ids: list[str]
    representative_ids: list[str]
    sources: list[str]
    score: float
    uncertainty: Literal["single-source", "thin-evidence"] | None = None

    def __post_init__(self) -> None:
        if not set(self.representative_ids) <= set(self.candidate_ids):
            raise ValueError("representative_ids must be a subset of candidate_ids")


def candidate_sources(candidate: Candidate) -> list[str]:
    """Every source that contributed to this candidate."""
    seen = list(candidate.sources) if candidate.sources else [candidate.source]
    for item in candidate.source_items:
        if item.source not in seen:
            seen.append(item.source)
    return seen


def candidate_source_label(candidate: Candidate) -> str:
    """Stable label for sorting. Multi-source candidates sort by their joined set."""
    return "+".join(sorted(candidate_sources(candidate)))


def candidate_out_of_window(candidate: Candidate) -> bool:
    """True when EVERY dated source item falls outside the run's window.

    Vendored behaviour, and the direction matters: a candidate with no dated
    items at all is NOT out of window. An undated item is unknown, and treating
    unknown as stale would silently demote every source that does not publish
    dates — which is most of them.
    """
    range_from = candidate.metadata.get("range_from")
    range_to = candidate.metadata.get("range_to")
    if not (range_from and range_to):
        return False

    dated = [
        item.published_at[:10]
        for item in candidate.source_items
        if item.published_at and item.date_confidence in ("high", "med")
    ]
    if not dated:
        return False
    return all(not (range_from <= day <= range_to) for day in dated)


def to_demand_signal(candidate: Candidate) -> dict[str, Any]:
    """Serialise for the wire.

    THE AUTHOR IS DROPPED HERE, and this is the only place it could leak from.
    `DemandSignal` in apps/chat/lib/signals/types.ts has no `author` field, so a
    future adapter cannot reintroduce one by accident — but a dict serialiser
    could, so the omission is explicit rather than incidental.
    """
    return {
        "id": candidate.candidate_id,
        "title": candidate.title,
        "url": candidate.url,
        # Capped to an excerpt, not the full body. A permalink plus a short
        # quote is a citation; a stored full copy is a republication.
        "snippet": candidate.snippet[:500],
        "published_at": _best_published_at(candidate),
        "engagement": float(candidate.engagement or 0.0),
        "relevance": round(candidate.local_relevance, 4),
    }


def _best_published_at(candidate: Candidate) -> str | None:
    dated = [
        item.published_at
        for item in candidate.source_items
        if item.published_at and item.date_confidence in ("high", "med")
    ]
    return max(dated) if dated else None
