# ─────────────────────────────────────────────────────────────────────────────
# ADAPTED from mvanhorn/last30days-skill (MIT)
#   file:   skills/last30days/scripts/lib/fusion.py
#   commit: 9243a32d823c7c8659e44b92f2dedcf1b7397137 (2026-08-18)
#
# MODIFICATIONS: the weighted-RRF core, the URL normaliser, the per-author cap
# and the per-source diversity floor are upstream's, with upstream's comments
# retained where they explain WHY a constant has the value it has. Removed: the
# `first_party_handles` allowance (that exists for person/company topics on X,
# and this service has no X adapter) and the `fun_score` path.
#
#   gh api "repos/mvanhorn/last30days-skill/commits?path=skills/last30days/scripts/lib/fusion.py&since=2026-08-18" --jq '.[].commit.message'
# ─────────────────────────────────────────────────────────────────────────────
"""Weighted reciprocal rank fusion across per-(subquery, source) result streams."""

from __future__ import annotations

from urllib.parse import parse_qs, urlencode, urlparse, urlunparse

from .. import schema

#: Standard RRF smoothing constant (Cormack et al. 2009). Upstream's value.
RRF_K = 60

#: A source only earns reserved slots in the diversity pass if its BEST item
#: clears this. Low-relevance sources compete on merit alone — otherwise a
#: source that returned nothing useful still displaces two good results.
_DIVERSITY_RELEVANCE_THRESHOLD = 0.25

#: No single author may dominate the pool. One prolific complainer is one data
#: point, not a market — and for the Verifying Demand phase specifically, an
#: uncapped pool would let one person's posting history read as widespread pain.
_MAX_ITEMS_PER_AUTHOR = 3


def _candidate_sort_key(candidate: schema.Candidate) -> tuple:
    # Out-of-window evidence sorts strictly BELOW anything in the window. A
    # "last 30 days" brief that ranks a nine-month-old thread at #1 breaks its
    # own contract, however relevant that thread is; it still appears, just
    # never above in-window evidence.
    return (
        1 if schema.candidate_out_of_window(candidate) else 0,
        -candidate.rrf_score,
        -candidate.local_relevance,
        -candidate.freshness,
        schema.candidate_source_label(candidate),
        candidate.title,
    )


def normalize_url(url: str) -> str:
    """Lowercase, strip www/old/m prefixes, drop utm_* tracking params.

    This is the identity function for dedupe: `old.reddit.com/r/x/1?utm_source=y`
    and `www.reddit.com/r/x/1/` are one piece of evidence, and counting them
    twice would make a single thread look like corroboration.
    """
    parsed = urlparse(url.strip().lower())
    netloc = parsed.netloc
    for prefix in ("www.", "old.", "m."):
        if netloc.startswith(prefix):
            netloc = netloc[len(prefix) :]
    params = parse_qs(parsed.query)
    clean = {k: v for k, v in params.items() if not k.startswith("utm_")}
    return urlunparse(
        (parsed.scheme, netloc, parsed.path.rstrip("/"), "", urlencode(clean, doseq=True), "")
    )


def candidate_key(item: schema.SourceItem) -> str:
    if item.url:
        return normalize_url(item.url)
    return f"{item.source}:{item.item_id}"


def _extract_author(candidate: schema.Candidate) -> str | None:
    for item in candidate.source_items:
        if item.author:
            return item.author.strip().lower()
    return None


def _apply_per_author_cap(
    candidates: list[schema.Candidate],
    max_per_author: int = _MAX_ITEMS_PER_AUTHOR,
) -> list[schema.Candidate]:
    """Keep at most *max_per_author* items from any single author.

    Candidates must already be sorted by quality, so the first N per author are
    the best ones.
    """
    counts: dict[str, int] = {}
    result: list[schema.Candidate] = []
    for candidate in candidates:
        author = _extract_author(candidate)
        if author is None:
            result.append(candidate)
            continue
        seen = counts.get(author, 0)
        if seen < max_per_author:
            result.append(candidate)
            counts[author] = seen + 1
    return result


def _diversify_pool(
    fused: list[schema.Candidate],
    pool_limit: int,
    min_per_source: int = 2,
) -> list[schema.Candidate]:
    """Guarantee *min_per_source* survivors per qualifying source.

    Without this, one high-volume source wins every slot and the report has a
    single point of failure — which is precisely the shape a demand-validation
    tool must not have, because "one forum agrees with you" is not evidence.
    """
    max_relevance: dict[str, float] = {}
    for candidate in fused:
        current = max_relevance.get(candidate.source, 0.0)
        if candidate.local_relevance > current:
            max_relevance[candidate.source] = candidate.local_relevance

    reserved: dict[str, list[schema.Candidate]] = {}
    remainder: list[schema.Candidate] = []
    for candidate in fused:
        qualifies = max_relevance.get(candidate.source, 0.0) >= _DIVERSITY_RELEVANCE_THRESHOLD
        bucket = reserved.setdefault(candidate.source, [])
        if qualifies and len(bucket) < min_per_source:
            bucket.append(candidate)
        else:
            remainder.append(candidate)

    pool = [c for per_source in reserved.values() for c in per_source]
    seen = {c.candidate_id for c in pool}
    for candidate in remainder:
        if len(pool) >= pool_limit:
            break
        if candidate.candidate_id not in seen:
            pool.append(candidate)
            seen.add(candidate.candidate_id)
    pool.sort(key=_candidate_sort_key)
    return pool[:pool_limit]


def _new_candidate(
    key: str,
    item: schema.SourceItem,
    label: str,
    source: str,
    rank: int,
    score: float,
    range_from: str | None,
    range_to: str | None,
) -> schema.Candidate:
    metadata: dict = {
        "provenance": [
            {
                "source": source,
                "subquery_label": label,
                "native_rank": rank,
                "item_id": item.item_id,
            }
        ]
    }
    if range_from:
        metadata["range_from"] = range_from
    if range_to:
        metadata["range_to"] = range_to

    return schema.Candidate(
        candidate_id=key,
        item_id=item.item_id,
        source=item.source,
        title=item.title,
        url=item.url,
        snippet=item.snippet,
        subquery_labels=[label],
        native_ranks={f"{label}:{source}": rank},
        local_relevance=item.local_relevance
        if item.local_relevance is not None
        else item.relevance_hint,
        freshness=item.freshness if item.freshness is not None else 0,
        engagement=item.engagement_score,
        source_quality=item.source_quality if item.source_quality is not None else 0.6,
        rrf_score=score,
        sources=[item.source],
        source_items=[item],
        metadata=metadata,
    )


def weighted_rrf(
    streams: dict[tuple[str, str], list[schema.SourceItem]],
    plan: schema.QueryPlan,
    *,
    pool_limit: int,
    range_from: str | None = None,
    range_to: str | None = None,
) -> list[schema.Candidate]:
    """Fuse ranked lists from several (subquery, source) pairs into one pool.

    RRF is used rather than score normalisation because the sources' native
    scores are incomparable: an HN points count, a GitHub reaction count and a
    keyless search engine's ordinal position have no common scale, and any
    attempt to map them onto one invents a weighting nobody validated. Rank is
    the only thing every source genuinely agrees on.
    """
    subqueries = {sub.label: sub for sub in plan.subqueries}
    candidates: dict[str, schema.Candidate] = {}
    seen_source_items: dict[str, set[tuple[str, str]]] = {}

    for (label, source), items in streams.items():
        subquery = subqueries.get(label)
        if subquery is None:
            # An unplanned stream is a bug in the caller, and quietly fusing it
            # would attribute results to a subquery that was never asked.
            raise KeyError(f"stream labelled {label!r} has no matching subquery in the plan")
        weight = subquery.weight * plan.source_weights.get(source, 1.0)

        for rank, item in enumerate(items, start=1):
            key = candidate_key(item)
            score = weight / (RRF_K + rank)
            item_relevance = (
                item.local_relevance if item.local_relevance is not None else item.relevance_hint
            )

            if key not in candidates:
                candidates[key] = _new_candidate(
                    key, item, label, source, rank, score, range_from, range_to
                )
                seen_source_items[key] = {(item.source, item.item_id)}
                continue

            candidate = candidates[key]
            candidate.rrf_score += score
            candidate.local_relevance = max(candidate.local_relevance, item_relevance)
            candidate.freshness = max(candidate.freshness, item.freshness or 0)
            if item.engagement_score is not None:
                candidate.engagement = (
                    item.engagement_score
                    if candidate.engagement is None
                    else max(candidate.engagement, item.engagement_score)
                )
            if item.source_quality is not None:
                candidate.source_quality = max(candidate.source_quality, item.source_quality)
            candidate.native_ranks[f"{label}:{source}"] = rank
            if label not in candidate.subquery_labels:
                candidate.subquery_labels.append(label)
            if item.source not in candidate.sources:
                candidate.sources.append(item.source)

            pair = (item.source, item.item_id)
            if pair not in seen_source_items[key]:
                seen_source_items[key].add(pair)
                candidate.source_items.append(item)
            candidate.metadata.setdefault("provenance", []).append(
                {
                    "source": source,
                    "subquery_label": label,
                    "native_rank": rank,
                    "item_id": item.item_id,
                }
            )
            # Prefer the longer snippet: two sources describing the same thread
            # rarely quote the same amount, and the fuller excerpt is the more
            # useful citation.
            if len(candidate.snippet.split()) < len(item.snippet.split()):
                candidate.snippet = item.snippet

    fused = sorted(candidates.values(), key=_candidate_sort_key)
    fused = _apply_per_author_cap(fused)
    return _diversify_pool(fused, pool_limit)
