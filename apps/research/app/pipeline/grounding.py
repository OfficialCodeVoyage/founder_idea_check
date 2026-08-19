"""Grounding: does every claim in the output trace to something we actually fetched?

REIMPLEMENTED, not vendored. `mvanhorn/last30days-skill` `lib/grounding.py`
@ 9243a32d is 369 lines but imports `env` (1,366 lines of keychain, `pass` and
CLI config resolution), `dates`, `http` and `web_search_keyless`, so vendoring
it would drag in that project's whole configuration system for the sake of two
checks. The two checks are here; the configuration system is not.

WHY GROUNDING IS A SEPARATE PASS AND NOT A NICE-TO-HAVE. This service feeds the
"Verifying Demand" gate, and the gate's entire value is refusing to advance a
founder on evidence that does not exist. A citation pointing at a url we never
fetched — a model-hallucinated permalink, or one dropped by a later dedupe pass
— makes an ungrounded claim look verified. That failure is silent by
construction: the founder sees a link, assumes someone checked it, and does not.

Everything here is PURE.
"""

from __future__ import annotations

from dataclasses import dataclass
from urllib.parse import urlparse

from .. import schema
from .fusion import normalize_url


@dataclass(frozen=True)
class GroundingReport:
    """What survived the check, and what did not."""

    grounded: list[schema.Candidate]
    #: (candidate_id, why) for everything dropped. Never silently discarded —
    #: a thin report must be able to say why it is thin.
    rejected: list[tuple[str, str]]
    #: Distinct hosts among the grounded candidates. One host is a warning sign
    #: whatever the item count says.
    distinct_domains: int

    @property
    def single_domain(self) -> bool:
        return self.distinct_domains <= 1


def domain_of(url: str) -> str:
    """Normalised host, matching `fusion.normalize_url`'s treatment."""
    try:
        netloc = urlparse(url).netloc.strip().lower()
    except (ValueError, AttributeError):
        return ""
    for prefix in ("www.", "old.", "m."):
        if netloc.startswith(prefix):
            netloc = netloc[len(prefix) :]
    return netloc


def ground_candidates(
    candidates: list[schema.Candidate],
    fetched_urls: set[str],
) -> GroundingReport:
    """PURE. Keep only candidates whose url is one we actually retrieved.

    `fetched_urls` is the set of urls the adapters really requested, normalised
    through `normalize_url` so that a tracking-param or `old.` variant of a url
    we did fetch still counts as fetched.

    A candidate with NO url is rejected rather than kept-with-a-caveat. There is
    no way for a reader to check it, so it cannot function as evidence, and a
    caveat next to a confident sentence is read as a formality.
    """
    normalized_fetched = {normalize_url(url) for url in fetched_urls if url}

    grounded: list[schema.Candidate] = []
    rejected: list[tuple[str, str]] = []

    for candidate in candidates:
        url = (candidate.url or "").strip()
        if not url:
            rejected.append((candidate.candidate_id, "no url — nothing a reader could check"))
            continue
        if not url.startswith("https://"):
            rejected.append((candidate.candidate_id, f"url is not https: {url[:80]!r}"))
            continue
        if normalize_url(url) not in normalized_fetched:
            rejected.append(
                (
                    candidate.candidate_id,
                    f"url {url[:80]!r} was never fetched by any adapter in this run",
                )
            )
            continue
        grounded.append(candidate)

    domains = {domain_of(c.url) for c in grounded}
    domains.discard("")

    return GroundingReport(
        grounded=grounded,
        rejected=rejected,
        distinct_domains=len(domains),
    )


def corroboration_level(candidates: list[schema.Candidate]) -> str:
    """PURE. How much independent support the pool actually carries.

    Named rather than numeric because the caller writes it into a report a
    founder reads, and "corroborated across 3 sources" is actionable where
    "0.62" is not.

    The thresholds are deliberately unforgiving. `none` and `single-source` both
    mean the gate must not treat this as evidence of demand: one forum thread is
    one person's opinion about one afternoon.
    """
    if not candidates:
        return "none"
    sources = {source for c in candidates for source in schema.candidate_sources(c)}
    domains = {domain_of(c.url) for c in candidates}
    domains.discard("")

    if len(sources) <= 1 and len(domains) <= 1:
        return "single-source"
    if len(sources) == 1:
        return "single-source-multiple-domains"
    if len(sources) == 2:
        return "corroborated-weak"
    return "corroborated"
