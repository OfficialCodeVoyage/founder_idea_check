"""The pure pipeline: dedupe, fusion, scoring, grounding. No network, no model."""

from __future__ import annotations

import pytest

from app.pipeline import dedupe, fusion, grounding, rerank
from app.schema import Candidate, QueryPlan, SourceItem, SubQuery, to_demand_signal


def item(
    item_id: str,
    title: str,
    url: str,
    *,
    source: str = "hackernews",
    author: str | None = None,
    published_at: str | None = "2026-07-15",
    relevance: float = 0.7,
    engagement: dict | None = None,
) -> SourceItem:
    return SourceItem(
        item_id=item_id,
        source=source,
        title=title,
        body=title,
        url=url,
        author=author,
        published_at=published_at,
        date_confidence="high" if published_at else "low",
        engagement=engagement or {},
        relevance_hint=relevance,
        snippet=title,
        local_relevance=relevance,
        freshness=50,
        engagement_score=0.0,
        source_quality=0.7,
    )


def plan(sources: list[str]) -> QueryPlan:
    return QueryPlan(
        raw_topic="dog walking",
        intent="single-source",
        cluster_mode="none",
        subqueries=[
            SubQuery(
                label="primary",
                search_query="dog walking",
                ranking_query="dog walking",
                sources=sources,
            )
        ],
        source_weights=dict.fromkeys(sources, 1.0),
    )


class TestDedupe:
    def test_collapses_near_identical_titles(self):
        items = [
            item("1", "Coordinating dog walkers is a nightmare", "https://a.test/1"),
            item("2", "Coordinating dog walkers is a nightmare!", "https://a.test/2"),
        ]
        assert len(dedupe.dedupe_items(items)) == 1

    def test_keeps_genuinely_different_items(self):
        items = [
            item("1", "Coordinating dog walkers is a nightmare", "https://a.test/1"),
            item("2", "Best harness for a husky in winter", "https://a.test/2"),
        ]
        assert len(dedupe.dedupe_items(items)) == 2

    def test_keeps_the_first_occurrence(self):
        items = [
            item("keep", "Coordinating dog walkers is a nightmare", "https://a.test/1"),
            item("drop", "Coordinating dog walkers is a nightmare.", "https://a.test/2"),
        ]
        assert dedupe.dedupe_items(items)[0].item_id == "keep"


class TestNormalizeUrl:
    @pytest.mark.parametrize(
        ("left", "right"),
        [
            ("https://www.reddit.com/r/x/1/", "https://old.reddit.com/r/x/1"),
            ("https://a.test/p?utm_source=x", "https://a.test/p"),
            ("https://A.TEST/p", "https://a.test/p"),
        ],
    )
    def test_treats_variants_as_one_url(self, left, right):
        # Counting one thread twice would make it look like corroboration.
        assert fusion.normalize_url(left) == fusion.normalize_url(right)

    def test_keeps_meaningful_query_params(self):
        assert "id=1" in fusion.normalize_url("https://news.ycombinator.com/item?id=1")


class TestWeightedRrf:
    def test_merges_the_same_url_seen_from_two_sources(self):
        streams = {
            ("primary", "hackernews"): [item("h1", "Same thread", "https://a.test/1")],
            ("primary", "web-keyless"): [
                item("w1", "Same thread", "https://a.test/1?utm_source=x", source="web-keyless")
            ],
        }
        fused = fusion.weighted_rrf(streams, plan(["hackernews", "web-keyless"]), pool_limit=10)
        assert len(fused) == 1
        assert sorted(fused[0].sources) == ["hackernews", "web-keyless"]

    def test_a_corroborated_candidate_outranks_a_single_source_one(self):
        streams = {
            ("primary", "hackernews"): [
                item("h1", "Corroborated", "https://a.test/1"),
                item("h2", "Solo", "https://a.test/2"),
            ],
            ("primary", "web-keyless"): [
                item("w1", "Corroborated", "https://a.test/1", source="web-keyless")
            ],
        }
        fused = fusion.weighted_rrf(streams, plan(["hackernews", "web-keyless"]), pool_limit=10)
        assert fused[0].title == "Corroborated"

    def test_caps_one_author_so_they_cannot_look_like_a_market(self):
        streams = {
            ("primary", "hackernews"): [
                item(f"h{i}", f"Distinct complaint number {i}", f"https://a.test/{i}", author="one")
                for i in range(6)
            ]
        }
        fused = fusion.weighted_rrf(streams, plan(["hackernews"]), pool_limit=10)
        assert len(fused) == 3

    def test_an_unplanned_stream_raises_rather_than_being_silently_fused(self):
        streams = {("unplanned", "hackernews"): [item("1", "t", "https://a.test/1")]}
        with pytest.raises(KeyError):
            fusion.weighted_rrf(streams, plan(["hackernews"]), pool_limit=10)

    def test_reserves_slots_so_one_source_cannot_win_every_place(self):
        streams = {
            ("primary", "hackernews"): [
                item(f"h{i}", f"HN item number {i}", f"https://hn.test/{i}") for i in range(8)
            ],
            ("primary", "web-keyless"): [
                item(f"w{i}", f"Web item number {i}", f"https://w.test/{i}", source="web-keyless")
                for i in range(8)
            ],
        }
        fused = fusion.weighted_rrf(streams, plan(["hackernews", "web-keyless"]), pool_limit=4)
        assert {c.source for c in fused} == {"hackernews", "web-keyless"}


class TestScoring:
    def test_engagement_is_log_scaled_so_one_viral_thread_cannot_dominate(self):
        small = rerank.engagement_score({"score": 45})
        large = rerank.engagement_score({"score": 45_000})
        assert large > small
        # Linear scaling would make this 1000x. log1p keeps it under 3x.
        assert large < small * 3

    def test_no_engagement_is_zero_not_a_default(self):
        assert rerank.engagement_score({}) == 0.0

    def test_freshness_places_an_item_in_the_window(self):
        assert rerank.freshness_score("2026-07-01", "2026-07-01", "2026-07-31") == 0
        assert rerank.freshness_score("2026-07-31", "2026-07-01", "2026-07-31") == 100
        assert 40 <= rerank.freshness_score("2026-07-16", "2026-07-01", "2026-07-31") <= 60

    def test_an_undated_item_scores_zero_not_a_midpoint(self):
        # A midpoint would let the ABSENCE of a date outrank its presence.
        assert rerank.freshness_score(None, "2026-07-01", "2026-07-31") == 0

    def test_an_out_of_window_item_scores_zero(self):
        assert rerank.freshness_score("2025-01-01", "2026-07-01", "2026-07-31") == 0

    def test_out_of_window_candidates_are_scaled_down_not_removed(self):
        streams = {
            ("primary", "hackernews"): [
                item("fresh", "A fresh thread", "https://a.test/1", published_at="2026-07-15"),
                item("stale", "A stale thread", "https://a.test/2", published_at="2025-01-15"),
            ]
        }
        fused = fusion.weighted_rrf(
            streams,
            plan(["hackernews"]),
            pool_limit=10,
            range_from="2026-07-01",
            range_to="2026-07-31",
        )
        scored = rerank.score_candidates(fused)
        assert scored[0].item_id == "fresh"
        # Still present: "old but worth reading" is information, not noise.
        assert any(c.item_id == "stale" for c in scored)


class TestGrounding:
    def _candidate(self, url: str) -> Candidate:
        return Candidate(
            candidate_id=url,
            item_id="1",
            source="hackernews",
            title="t",
            url=url,
            snippet="s",
            subquery_labels=["primary"],
            native_ranks={},
            local_relevance=0.5,
            freshness=0,
            engagement=0,
            source_quality=0.7,
            rrf_score=0.1,
        )

    def test_rejects_a_url_no_adapter_ever_fetched(self):
        # A citation to something we never retrieved is worse than no citation.
        report = grounding.ground_candidates(
            [self._candidate("https://hallucinated.test/1")],
            {"https://real.test/1"},
        )
        assert report.grounded == []
        assert "never fetched" in report.rejected[0][1]

    def test_accepts_a_tracking_param_variant_of_a_url_we_did_fetch(self):
        report = grounding.ground_candidates(
            [self._candidate("https://real.test/1?utm_source=x")],
            {"https://real.test/1"},
        )
        assert len(report.grounded) == 1

    def test_rejects_a_candidate_with_no_url_rather_than_caveating_it(self):
        report = grounding.ground_candidates([self._candidate("")], set())
        assert report.grounded == []
        assert "no url" in report.rejected[0][1]

    def test_rejects_a_non_https_url(self):
        report = grounding.ground_candidates(
            [self._candidate("http://real.test/1")], {"http://real.test/1"}
        )
        assert report.grounded == []

    def test_flags_a_single_domain_pool(self):
        report = grounding.ground_candidates(
            [self._candidate("https://a.test/1"), self._candidate("https://a.test/2")],
            {"https://a.test/1", "https://a.test/2"},
        )
        assert report.single_domain is True

    def test_corroboration_is_named_not_numeric(self):
        assert grounding.corroboration_level([]) == "none"
        assert (
            grounding.corroboration_level([self._candidate("https://a.test/1")]) == "single-source"
        )

    def test_two_sources_is_only_weakly_corroborated(self):
        a = self._candidate("https://a.test/1")
        b = self._candidate("https://b.test/1")
        b.source = "web-keyless"
        b.sources = ["web-keyless"]
        assert grounding.corroboration_level([a, b]) == "corroborated-weak"


class TestWireFormat:
    def test_the_author_never_reaches_the_wire(self):
        # apps/chat/lib/signals/types.ts has no `author` field. This asserts the
        # serialiser cannot reintroduce one.
        streams = {
            ("primary", "hackernews"): [
                item("1", "A thread", "https://a.test/1", author="realperson")
            ]
        }
        fused = fusion.weighted_rrf(streams, plan(["hackernews"]), pool_limit=10)
        payload = to_demand_signal(fused[0])
        assert "author" not in payload
        assert "realperson" not in str(payload)

    def test_the_snippet_is_capped_to_an_excerpt(self):
        streams = {("primary", "hackernews"): [item("1", "x" * 2000, "https://a.test/1")]}
        fused = fusion.weighted_rrf(streams, plan(["hackernews"]), pool_limit=10)
        assert len(to_demand_signal(fused[0])["snippet"]) <= 500

    def test_emits_exactly_the_keys_the_typescript_side_parses(self):
        streams = {("primary", "hackernews"): [item("1", "t", "https://a.test/1")]}
        fused = fusion.weighted_rrf(streams, plan(["hackernews"]), pool_limit=10)
        assert sorted(to_demand_signal(fused[0])) == [
            "engagement",
            "id",
            "published_at",
            "relevance",
            "snippet",
            "title",
            "url",
        ]
