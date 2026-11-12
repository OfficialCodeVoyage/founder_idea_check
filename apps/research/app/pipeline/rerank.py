# ─────────────────────────────────────────────────────────────────────────────
# REIMPLEMENTED, with material from mvanhorn/last30days-skill (MIT, Copyright (c)
# 2026 Matt Van Horn)
#   file:   skills/last30days/scripts/lib/rerank.py
#   commit: 9243a32d823c7c8659e44b92f2dedcf1b7397137 (2026-08-18)
#   licence text: LICENSES/MIT-mvanhorn-last30days-skill.txt
#
# WHAT IS UPSTREAM'S: the arithmetic and two constants, including the
# out-of-window multiplier (0.35) with the comment quoted beside it. NOT here:
# upstream's LLM judge, which this service deliberately does not have. The
# docstring below says more.
#
#   gh api "repos/mvanhorn/last30days-skill/commits?path=skills/last30days/scripts/lib/rerank.py&since=2026-08-18" --jq '.[].commit.message'
# ─────────────────────────────────────────────────────────────────────────────
"""Deterministic final scoring and window grounding.

REIMPLEMENTED, not vendored. `mvanhorn/last30days-skill` `lib/rerank.py`
@ 9243a32d is 968 lines and is mostly an LLM judge: it builds a prompt, calls a
reasoning model, and falls back to a local blend when that fails. This service
deliberately has no model call — the LLM half of research lives in
`apps/chat/lib/research/loop.ts`, behind an injected seam, so it can be tested
with no API key.

What IS taken is the arithmetic, and specifically two constants that upstream
learned the hard way and documented in the comments quoted below.

Everything in this module is PURE: no clock, no network, no model. That is what
makes `tests/test_pipeline.py` meaningful.
"""

from __future__ import annotations

import math

from .. import schema

# ─────────────────────────────────────────────────────────────────────────────
# Upstream's constants, with upstream's reasoning.
# ─────────────────────────────────────────────────────────────────────────────

#: From lib/rerank.py:780. Upstream's comment, verbatim in substance:
#:
#:   "The tool's whole promise is the window, so a stale item must not lead the
#:    ranked clusters however relevant it reads — a 2025-10 video ranked #1 in a
#:    2026-07 brief, and a 2025-12 one ranked #5, both correctly flagged
#:    [date:low] and both ranked anyway. Scaling rather than subtracting keeps
#:    the ordering *among* older items intact."
#:
#: Multiply, do not subtract. Subtracting would flatten the ordering of old
#: items against each other and lose the "still worth reading" signal.
OUT_OF_WINDOW_FINAL_MULTIPLIER = 0.35

#: Engagement is log-normalised to 0-100 by `engagement_score` below, so a
#: thread with 2,000 upvotes scores about twice a thread with 45. The weight is
#: small on purpose: for demand validation, ONE person describing the problem
#: precisely is worth more than a thousand people upvoting a joke about it, and
#: a heavier engagement term would invert exactly that.
_WEIGHTS = {
    "relevance": 0.60,
    "rrf": 0.20,
    "freshness": 0.10,
    "source_quality": 0.05,
    "engagement": 0.05,
}


def engagement_score(engagement: dict[str, float | int]) -> float:
    """Collapse a source's native counters into a 0-100 scale.

    log1p rather than linear because engagement is power-law distributed: a
    linear scale makes one viral thread worth more than every other result
    combined, and the report becomes a summary of that one thread.
    """
    total = 0.0
    for key, value in engagement.items():
        if key in ("score", "points", "num_comments", "comments", "reactions", "stars"):
            try:
                total += max(0.0, float(value))
            except (TypeError, ValueError):
                continue
    if total <= 0:
        return 0.0
    # log1p(10_000) is about 9.2, so the /9.2 puts a very popular thread near
    # 100 and keeps the scale bounded for anything larger.
    return min(100.0, (math.log1p(total) / 9.21) * 100.0)


def freshness_score(published_at: str | None, range_from: str, range_to: str) -> int:
    """0-100 by position in the window; 0 for undated or out-of-window items.

    Undated scores 0 rather than a midpoint. A midpoint would let an item with
    no date outrank a dated item from the middle of the window, which promotes
    the absence of information over its presence.
    """
    if not published_at:
        return 0
    day = published_at[:10]
    if not (range_from <= day <= range_to):
        return 0
    try:
        from datetime import date

        start = date.fromisoformat(range_from)
        end = date.fromisoformat(range_to)
        current = date.fromisoformat(day)
    except ValueError:
        return 0
    span = (end - start).days
    if span <= 0:
        return 100
    return round(((current - start).days / span) * 100)


def final_score(candidate: schema.Candidate, max_rrf: float) -> float:
    """PURE. Blend the signals into one 0-100-ish score.

    `max_rrf` normalises the RRF term against the best candidate in THIS pool.
    RRF scores are tiny and pool-dependent (weight / (60 + rank)), so an
    absolute scale would make the term contribute essentially nothing.
    """
    normalized_rrf = (candidate.rrf_score / max_rrf * 100.0) if max_rrf > 0 else 0.0
    engagement = float(candidate.engagement or 0.0)

    base = (
        _WEIGHTS["relevance"] * (candidate.local_relevance * 100.0)
        + _WEIGHTS["rrf"] * normalized_rrf
        + _WEIGHTS["freshness"] * candidate.freshness
        + _WEIGHTS["source_quality"] * (candidate.source_quality * 100.0)
        + _WEIGHTS["engagement"] * engagement
    )

    if schema.candidate_out_of_window(candidate):
        base *= OUT_OF_WINDOW_FINAL_MULTIPLIER
    return round(base, 4)


def score_candidates(candidates: list[schema.Candidate]) -> list[schema.Candidate]:
    """PURE. Scores in place and returns the list sorted best-first."""
    max_rrf = max((c.rrf_score for c in candidates), default=0.0)
    for candidate in candidates:
        candidate.final_score = final_score(candidate, max_rrf)
    candidates.sort(
        key=lambda c: (
            1 if schema.candidate_out_of_window(c) else 0,
            -c.final_score,
            c.candidate_id,
        )
    )
    return candidates
