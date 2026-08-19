# ─────────────────────────────────────────────────────────────────────────────
# ADAPTED from mvanhorn/last30days-skill (MIT)
#   file:   skills/last30days/scripts/lib/cluster.py
#   commit: 9243a32d823c7c8659e44b92f2dedcf1b7397137 (2026-08-18)
#
# MODIFICATIONS: the greedy leader clustering, the MMR representative selection,
# the entity-overlap merge pass and the uncertainty labels are upstream's, with
# upstream's thresholds and the comments that justify them. Removed: the
# `polymarket` special case and the discover-mode `min_shared_entities` switch,
# neither of which has a counterpart here.
#
#   gh api "repos/mvanhorn/last30days-skill/commits?path=skills/last30days/scripts/lib/cluster.py&since=2026-08-18" --jq '.[].commit.message'
# ─────────────────────────────────────────────────────────────────────────────
"""Group candidates that cover the same story, and pick representatives."""

from __future__ import annotations

from .. import schema
from . import dedupe, entity_extract

#: Upstream's thresholds. The looser one is for fast-moving topics: related
#: threads about one event share fewer exact words than two posts about one
#: product, so a single threshold either over-merges products or under-merges
#: events.
_THRESHOLD_BY_INTENT = {"breaking_news": 0.42}
_DEFAULT_THRESHOLD = 0.48

#: Below this final score a cluster is labelled thin-evidence. Surfaced rather
#: than dropped: "we found something, but only just" is information the founder
#: needs, and silently discarding it would make the report look more confident
#: than the evidence supports.
_THIN_EVIDENCE_SCORE = 55.0

CLUSTERABLE_INTENTS = {"breaking_news", "opinion", "comparison", "prediction"}


def _cluster_sort_key(candidate: schema.Candidate) -> tuple:
    """Stale candidates sort below fresh ones, so they never lead a cluster."""
    return (
        1 if schema.candidate_out_of_window(candidate) else 0,
        -candidate.final_score,
        candidate.candidate_id,
    )


def _candidate_text(candidate: schema.Candidate) -> str:
    return " ".join(part for part in (candidate.title, candidate.snippet) if part).strip()


def _mmr_representatives(
    candidates: list[schema.Candidate],
    text_cache: dict[str, dedupe._PreparedText],
    limit: int = 3,
    diversity_lambda: float = 0.75,
) -> list[str]:
    """Maximal marginal relevance: pick the best, then the best DIFFERENT one.

    Without the diversity penalty the three representatives of a cluster are
    routinely three near-copies of the same post, which makes a cluster of
    twelve look like a cluster of one.
    """
    selected: list[schema.Candidate] = []
    remaining = list(candidates)

    while remaining and len(selected) < limit:
        if not selected:
            best = min(remaining, key=_cluster_sort_key)
        else:
            selected_preps = [text_cache[c.candidate_id] for c in selected]

            # `preps` is bound as a default rather than closed over. The closure
            # is only called inside this iteration so the late-binding bug
            # cannot fire today — but a future refactor that defers the call
            # would silently score against the WRONG selection set, and that
            # failure would look like slightly worse representatives rather
            # than an error.
            def score(candidate: schema.Candidate, preps=selected_preps) -> tuple:
                prep = text_cache[candidate.candidate_id]
                penalty = max(dedupe.prepared_similarity(prep, sp) for sp in preps)
                blended = (diversity_lambda * candidate.final_score) - (
                    (1 - diversity_lambda) * penalty * 100
                )
                return (
                    0 if schema.candidate_out_of_window(candidate) else 1,
                    blended,
                )

            best = max(remaining, key=score)

        selected.append(best)
        remaining = [c for c in remaining if c.candidate_id != best.candidate_id]

    return [c.candidate_id for c in selected]


def _cluster_uncertainty(group: list[schema.Candidate]) -> str | None:
    """Label a cluster the reader should not over-trust.

    `single-source` is the one that matters for demand validation: one forum
    agreeing with a founder is not corroboration, and a report that does not say
    so is actively misleading.
    """
    sources = {source for c in group for source in schema.candidate_sources(c)}
    if len(sources) == 1:
        return "single-source"
    if max(c.final_score for c in group) < _THIN_EVIDENCE_SCORE:
        return "thin-evidence"
    return None


def _singleton_clusters(candidates: list[schema.Candidate]) -> list[schema.Cluster]:
    clusters: list[schema.Cluster] = []
    for index, candidate in enumerate(candidates, start=1):
        cluster_id = f"cluster-{index}"
        candidate.cluster_id = cluster_id
        clusters.append(
            schema.Cluster(
                cluster_id=cluster_id,
                title=candidate.title,
                candidate_ids=[candidate.candidate_id],
                representative_ids=[candidate.candidate_id],
                sources=sorted(schema.candidate_sources(candidate)),
                score=candidate.final_score,
                uncertainty=_cluster_uncertainty([candidate]),
            )
        )
    return clusters


def cluster_candidates(
    candidates: list[schema.Candidate],
    plan: schema.QueryPlan,
) -> list[schema.Cluster]:
    """Greedy clustering around high-ranked leaders, then an entity merge pass."""
    if plan.intent not in CLUSTERABLE_INTENTS or plan.cluster_mode == "none":
        return _singleton_clusters(candidates)

    text_cache = {c.candidate_id: dedupe._PreparedText(_candidate_text(c)) for c in candidates}
    threshold = _THRESHOLD_BY_INTENT.get(plan.intent, _DEFAULT_THRESHOLD)

    groups: list[list[schema.Candidate]] = []
    for candidate in candidates:
        prep = text_cache[candidate.candidate_id]
        for group in groups:
            leader_prep = text_cache[group[0].candidate_id]
            if dedupe.prepared_similarity(prep, leader_prep) >= threshold:
                group.append(candidate)
                break
        else:
            groups.append([candidate])

    clusters: list[schema.Cluster] = []
    for index, group in enumerate(groups, start=1):
        group.sort(key=_cluster_sort_key)
        cluster_id = f"cluster-{index}"
        for candidate in group:
            candidate.cluster_id = cluster_id
        clusters.append(
            schema.Cluster(
                cluster_id=cluster_id,
                title=group[0].title,
                candidate_ids=[c.candidate_id for c in group],
                representative_ids=_mmr_representatives(group, text_cache),
                sources=sorted({s for c in group for s in schema.candidate_sources(c)}),
                score=max(c.final_score for c in group),
                uncertainty=_cluster_uncertainty(group),
            )
        )

    clusters = _merge_entity_clusters(clusters, candidates)
    return sorted(clusters, key=lambda c: c.score, reverse=True)


def _merge_entity_clusters(
    clusters: list[schema.Cluster],
    all_candidates: list[schema.Candidate],
    *,
    min_shared_entities: int = 1,
    overlap_floor: float = 0.45,
) -> list[schema.Cluster]:
    """Second pass: merge small clusters that name the same entities.

    The greedy text pass misses cross-source matches where the phrasing differs
    — one forum writing "the scheduling problem" and another writing "booking
    hassle" about the same product. Entity overlap catches those.

    Only clusters of three or fewer are merged: merging two already-large
    clusters usually means the threshold was wrong, and doing it silently would
    produce one enormous cluster that means nothing.
    """
    if len(clusters) < 2:
        return clusters

    candidate_map = {c.candidate_id: c for c in all_candidates}
    entities: list[set[str]] = []
    for cluster in clusters:
        found: set[str] = set()
        for cid in cluster.candidate_ids:
            candidate = candidate_map.get(cid)
            if candidate:
                found |= entity_extract.extract_text_entities(_candidate_text(candidate))
        entities.append(found)

    merged_into: dict[int, int] = {}
    for i in range(len(clusters)):
        if i in merged_into or len(clusters[i].candidate_ids) > 3:
            continue
        for j in range(i + 1, len(clusters)):
            if j in merged_into or len(clusters[j].candidate_ids) > 3:
                continue
            sources_i = set(clusters[i].sources)
            sources_j = set(clusters[j].sources)
            # Same single source should already have been grouped by the text
            # pass; merging there would paper over a bad threshold.
            if sources_i == sources_j and len(sources_i) == 1:
                continue
            shared = entities[i] & entities[j]
            overlap = entity_extract.entity_overlap(entities[i], entities[j])
            if len(shared) >= min_shared_entities and overlap >= overlap_floor:
                merged_into[j] = i

    if not merged_into:
        return clusters

    result: list[schema.Cluster] = []
    for i, cluster in enumerate(clusters):
        if i in merged_into:
            continue
        members = [i] + [j for j, target in merged_into.items() if target == i]
        if len(members) == 1:
            result.append(cluster)
            continue

        combined_ids: list[str] = []
        combined_sources: set[str] = set()
        best_score = 0.0
        for index in members:
            combined_ids.extend(clusters[index].candidate_ids)
            combined_sources.update(clusters[index].sources)
            best_score = max(best_score, clusters[index].score)

        combined = [candidate_map[cid] for cid in combined_ids if cid in candidate_map]
        combined.sort(key=_cluster_sort_key)
        cache = {c.candidate_id: dedupe._PreparedText(_candidate_text(c)) for c in combined}
        for cid in combined_ids:
            found_candidate = candidate_map.get(cid)
            if found_candidate:
                found_candidate.cluster_id = cluster.cluster_id

        result.append(
            schema.Cluster(
                cluster_id=cluster.cluster_id,
                title=combined[0].title if combined else cluster.title,
                candidate_ids=combined_ids,
                representative_ids=_mmr_representatives(combined, cache),
                sources=sorted(combined_sources),
                score=best_score,
                uncertainty=_cluster_uncertainty(combined) if combined else cluster.uncertainty,
            )
        )

    return result
