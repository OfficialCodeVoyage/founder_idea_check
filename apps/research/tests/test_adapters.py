"""Adapter parsing and the 403 contract. No network — every input is a fixture."""

from __future__ import annotations

import json

import pytest

from app.errors import SourceBlocked, SourceRateLimited, SourceSchemaDrift, SourceUnavailable
from app.http import _classify
from app.sources import github, hackernews, reddit_rss, reddit_shreddit, web_search_keyless
from app.sources.base import SourceQuery


class TestHttpClassification:
    def test_a_403_becomes_source_blocked_with_the_datacenter_explanation(self):
        error = _classify(403, "https://www.reddit.com/search.rss", "Blocked")
        assert isinstance(error, SourceBlocked)
        assert error.kind == "blocked"
        assert "datacenter" in error.detail
        assert "residential" in error.detail

    def test_a_429_is_rate_limited_not_blocked(self):
        # Retrying later is meaningful for one and not the other. Collapsing
        # them sends an operator to wait out a problem waiting cannot fix.
        error = _classify(429, "https://hn.algolia.com/api/v1/search", "")
        assert isinstance(error, SourceRateLimited)
        assert not isinstance(error, SourceBlocked)

    def test_everything_else_is_unavailable(self):
        assert isinstance(_classify(500, "https://x.test", ""), SourceUnavailable)
        assert isinstance(_classify(502, "https://x.test", ""), SourceUnavailable)

    def test_the_response_body_excerpt_reaches_the_message(self):
        error = _classify(403, "https://x.test", "whoa there, pardner")
        assert "whoa there" in error.detail


class TestHackerNews:
    def test_the_points_filter_is_never_put_in_the_query(self):
        # THE TRAP: `points` is not in the HN Algolia index's
        # numericAttributesForFiltering, so a points>N clause returns HTTP 400
        # and ZERO stories. Filtering happens client-side after overfetching.
        url = hackernews.build_search_url("dog walking", "2026-07-01", "2026-08-01", 10)
        assert "points" not in url

    def test_only_created_at_i_is_used_as_a_numeric_filter(self):
        url = hackernews.build_search_url("dog walking", "2026-07-01", "2026-08-01", 10)
        assert "created_at_i" in url

    def test_multiword_queries_get_optionalwords_or_they_match_nothing(self):
        # Algolia ANDs query tokens by default, so a 4-word theme query matches
        # no stories at all without this.
        url = hackernews.build_search_url(
            "dog walking scheduling app", "2026-07-01", "2026-08-01", 5
        )
        assert "optionalWords" in url

    def test_a_single_word_query_needs_no_optionalwords(self):
        url = hackernews.build_search_url("dogs", "2026-07-01", "2026-08-01", 5)
        assert "optionalWords" not in url

    def test_hyphens_are_flattened_because_algolia_tokenizes_them_badly(self):
        url = hackernews.build_search_url("ts-bun-node", "2026-07-01", "2026-08-01", 5)
        assert "ts-bun-node" not in url
        assert "ts+bun+node" in url or "ts%20bun%20node" in url

    def test_it_overfetches_so_client_side_filtering_has_something_to_cut(self):
        url = hackernews.build_search_url("dogs", "2026-07-01", "2026-08-01", 10)
        assert "hitsPerPage=20" in url

    def test_parses_a_real_shaped_response(self):
        payload = {
            "hits": [
                {
                    "objectID": "111",
                    "title": "Ask HN: how do you coordinate dog walkers?",
                    "story_text": "<p>We use a spreadsheet and it is awful.</p>",
                    "points": 42,
                    "num_comments": 17,
                    "author": "someone",
                    "created_at": "2026-07-20T10:00:00Z",
                    "url": "https://example.com",
                }
            ]
        }
        items = hackernews.parse_hits(payload, "dog walkers", 10)
        assert len(items) == 1
        item = items[0]
        # The HN permalink, not the linked article: the discussion is the
        # evidence, the article is what it is about.
        assert item.url == "https://news.ycombinator.com/item?id=111"
        assert item.date_confidence == "high"
        assert "spreadsheet" in item.body
        assert "<p>" not in item.body

    def test_drops_low_engagement_stories_client_side(self):
        payload = {"hits": [{"objectID": "1", "title": "t", "points": 1}]}
        assert hackernews.parse_hits(payload, "t", 10) == []

    def test_a_changed_api_shape_raises_rather_than_returning_empty(self):
        # An API that changed shape and an API that found nothing are different
        # problems with different fixes.
        with pytest.raises(SourceSchemaDrift):
            hackernews.parse_hits({"results": []}, "q", 10)
        with pytest.raises(SourceSchemaDrift):
            hackernews.parse_hits({"hits": "nope"}, "q", 10)

    def test_an_empty_hit_list_is_a_finding_not_an_error(self):
        assert hackernews.parse_hits({"hits": []}, "q", 10) == []


class TestKeylessWebSearch:
    DDG = """
    <div><a class="result__a" href="https://example.com/a">First <b>result</b></a>
    <a class="result__snippet">Snippet for the first one</a></div>
    <div><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fb">Second</a></div>
    <div><a class="result__a" href="https://example.net/c">Third</a>
    <a class="result__snippet">Third snippet</a></div>
    """

    def test_unwraps_the_duckduckgo_redirect(self):
        rows = web_search_keyless.parse_ddg(self.DDG, 10)
        assert rows[1][1] == "https://example.org/b"

    def test_snippets_are_matched_by_position_not_by_index(self):
        # Result 2 has no snippet. A parallel zip would shift result 3's snippet
        # onto it and every later snippet onto the wrong result.
        rows = web_search_keyless.parse_ddg(self.DDG, 10)
        assert rows[0][2] == "Snippet for the first one"
        assert rows[1][2] == ""
        assert rows[2][2] == "Third snippet"

    def test_strips_style_and_script_contents_not_just_tags(self):
        # Otherwise Startpage's inline emotion CSS leaks into the title.
        assert web_search_keyless.strip_html("<style>.a{color:red}</style>Title") == "Title"
        assert web_search_keyless.strip_html("<script>var x=1</script>Body") == "Body"

    def test_parses_startpage_markup(self):
        html = (
            '<a class="result-title result-link css-hash" href="https://example.com/x">'
            "<h2>A Title</h2></a>"
            '<p class="w-gl__description css-hash">A description</p>'
        )
        rows = web_search_keyless.parse_startpage(html, 10)
        assert rows == [("A Title", "https://example.com/x", "A description")]

    def test_a_fully_blocked_ladder_raises_blocked_and_names_every_rung(self):
        source = web_search_keyless.KeylessWebSearchSource()

        def refuse(_query):
            raise SourceBlocked("HTTP 403")

        source._ddg = refuse
        source._startpage = refuse
        # searxng has no URL configured, so it refuses on its own.

        with pytest.raises(SourceBlocked) as caught:
            source.fetch(SourceQuery(query="q", date_from="2026-07-01", date_to="2026-08-01"))
        detail = caught.value.detail
        assert "duckduckgo" in detail
        assert "startpage" in detail
        assert "searxng" in detail
        assert "202" in detail  # names the actual DDG challenge behaviour

    def test_falls_through_to_startpage_when_duckduckgo_is_blocked(self):
        source = web_search_keyless.KeylessWebSearchSource()
        source._ddg = lambda _q: (_ for _ in ()).throw(SourceBlocked("202 challenge"))
        source._startpage = lambda _q: [("T", "https://example.com/a", "S")]

        items = source.fetch(SourceQuery(query="q", date_from="2026-07-01", date_to="2026-08-01"))
        assert len(items) == 1
        assert items[0].metadata["keyless_backend"] == "startpage"


class TestGitHub:
    def test_searches_issues_not_pull_requests(self):
        # A PR is somebody solving a problem; an issue is somebody having one.
        url = github.build_search_url("dog walking", "2026-07-01", "2026-08-01", 10)
        assert "is%3Aissue" in url
        assert "is%3Apr" not in url

    def test_filters_on_created_not_updated(self):
        url = github.build_search_url("dog walking", "2026-07-01", "2026-08-01", 10)
        assert "created%3A2026-07-01..2026-08-01" in url

    def test_parses_a_real_shaped_response(self):
        payload = {
            "items": [
                {
                    "id": 9,
                    "title": "Scheduling is broken",
                    "body": "It drops bookings.",
                    "html_url": "https://github.com/acme/app/issues/9",
                    "user": {"login": "someone"},
                    "created_at": "2026-07-15T00:00:00Z",
                    "reactions": {"total_count": 12},
                    "comments": 4,
                    "state": "open",
                }
            ]
        }
        items = github.parse_items(payload, "scheduling", 10)
        assert items[0].container == "acme/app"
        assert items[0].engagement["reactions"] == 12

    def test_a_changed_shape_raises(self):
        with pytest.raises(SourceSchemaDrift):
            github.parse_items({"nope": []}, "q", 10)

    def test_constructing_without_a_token_is_a_programming_error(self):
        with pytest.raises(ValueError):
            github.GitHubSource(token="")


ATOM = """<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>Coordinating dog walkers is a nightmare</title>
    <link href="https://www.reddit.com/r/dogs/comments/abc/coordinating/"/>
    <author><name>/u/realperson</name></author>
    <category term="dogs"/>
    <updated>2026-07-20T18:48:31+00:00</updated>
    <content type="html">&lt;p&gt;We use three group chats.&lt;/p&gt;</content>
  </entry>
  <entry>
    <title>Not a thread</title>
    <link href="https://www.reddit.com/r/dogs/"/>
    <updated>2026-07-21T00:00:00+00:00</updated>
  </entry>
</feed>
"""


class TestRedditRss:
    def test_THE_AUTHOR_IS_NEVER_HELD(self):
        # The single most important assertion in this file. Upstream keeps the
        # author; we drop it at parse time so the username never enters this
        # process. That is the difference between "we do not publish it" and
        # "we do not hold it", and only the second answers an erasure request.
        items = reddit_rss.parse_feed(ATOM, "dog walkers")
        assert len(items) == 1
        assert items[0].author is None
        assert "realperson" not in json.dumps(items[0].__dict__, default=str)

    def test_skips_entries_that_are_not_threads(self):
        items = reddit_rss.parse_feed(ATOM, "dog walkers")
        assert all("/comments/" in item.url for item in items)

    def test_does_not_invent_engagement_it_cannot_see(self):
        # RSS carries no vote counts. A guessed number would feed the score.
        items = reddit_rss.parse_feed(ATOM, "dog walkers")
        assert items[0].engagement == {}

    def test_refuses_a_body_declaring_a_doctype(self):
        # Billion-laughs and quadratic blowup both need an internal DTD subset,
        # and a real Atom feed has no DOCTYPE at all.
        bomb = '<!DOCTYPE feed [<!ENTITY a "aaaa">]><feed xmlns="http://www.w3.org/2005/Atom"/>'
        with pytest.raises(SourceSchemaDrift) as caught:
            reddit_rss.parse_feed(bomb, "q")
        assert "DOCTYPE" in caught.value.detail

    def test_refuses_an_oversized_body_before_parsing_it(self):
        with pytest.raises(SourceSchemaDrift) as caught:
            reddit_rss.parse_feed("<feed>" + "x" * (9 * 1024 * 1024), "q")
        assert "cap" in caught.value.detail

    def test_a_non_atom_body_raises_rather_than_returning_empty(self):
        with pytest.raises(SourceSchemaDrift):
            reddit_rss.parse_feed("<html>403 Forbidden</html>", "q")

    def test_an_empty_body_is_simply_empty(self):
        assert reddit_rss.parse_feed("", "q") == []

    def test_builds_both_search_and_listing_feeds(self):
        urls = reddit_rss.build_feed_urls("dog walkers", ["r/dogs"])
        assert any("search.rss" in u and "restrict_sr=on" in u for u in urls)
        assert any("/top.rss" in u for u in urls)
        assert all("t=month" in u for u in urls)


SHREDDIT = """
<shreddit-comment-tree>
  <shreddit-comment thingId="t1_aaa" author="realperson" score="42" permalink="/r/dogs/comments/abc/x/aaa/">
    <div id="t1_aaa-post-rtjson-content"><p>The scheduling is the hard part.</p></div>
  </shreddit-comment>
  <shreddit-comment thingId="t1_bbb" author="[deleted]" score="9" permalink="/r/dogs/comments/abc/x/bbb/">
    <div id="t1_bbb-post-rtjson-content"><p>Should not appear.</p></div>
  </shreddit-comment>
  <shreddit-comment thingId="t1_ccc" author="other" score="99" permalink="/r/dogs/comments/abc/x/ccc/">
    <div id="t1_ccc-post-rtjson-content"><p>Price is what stops me.</p></div>
  </shreddit-comment>
</shreddit-comment-tree>
"""


class TestRedditShreddit:
    def test_THE_AUTHOR_IS_NEVER_RETURNED(self):
        comments = reddit_shreddit.parse_comments(SHREDDIT)
        assert all("author" not in comment for comment in comments)
        assert "realperson" not in json.dumps(comments)

    def test_does_not_match_the_comment_tree_wrapper_elements(self):
        # Without the whitespace-or-'>' lookahead, <shreddit-comment-tree>
        # parses as a comment and the output fills with empty bodies.
        comments = reddit_shreddit.parse_comments(SHREDDIT)
        assert all(comment["body"] for comment in comments)

    def test_skips_deleted_comments(self):
        # A removed comment is the clearest possible signal that its author did
        # not want it retained.
        comments = reddit_shreddit.parse_comments(SHREDDIT)
        assert all("Should not appear" not in comment["body"] for comment in comments)

    def test_bodies_are_anchored_on_their_own_thing_id(self):
        comments = reddit_shreddit.parse_comments(SHREDDIT)
        by_id = {comment["thing_id"]: comment["body"] for comment in comments}
        assert by_id["t1_aaa"] == "The scheduling is the hard part."
        assert by_id["t1_ccc"] == "Price is what stops me."

    def test_returns_best_scored_first(self):
        comments = reddit_shreddit.parse_comments(SHREDDIT)
        assert [c["score"] for c in comments] == [99, 42]

    def test_extracts_a_post_reference_from_a_thread_url(self):
        assert reddit_shreddit.extract_post_ref(
            "https://www.reddit.com/r/dogs/comments/abc123/title/"
        ) == ("dogs", "abc123")
        assert reddit_shreddit.extract_post_ref("https://example.com") is None

    def test_no_urls_to_enrich_is_not_a_failure(self):
        source = reddit_shreddit.RedditShredditSource()
        assert (
            source.fetch(SourceQuery(query="q", date_from="2026-07-01", date_to="2026-08-01")) == []
        )
