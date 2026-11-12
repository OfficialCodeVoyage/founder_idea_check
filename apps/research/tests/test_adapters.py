"""Adapter parsing and the 403 contract. No network — every input is a fixture."""

from __future__ import annotations

import pytest

from app.errors import (
    SourceBlocked,
    SourceError,
    SourceRateLimited,
    SourceSchemaDrift,
    SourceUnavailable,
)
from app.http import _classify, _is_private_http
from app.sources import (
    arctic_shift,
    github,
    hackernews,
    web_search_keyless,
)
from app.sources.base import SourceQuery


class TestHttpClassification:
    def test_a_403_becomes_source_blocked_with_the_datacenter_explanation(self):
        error = _classify(403, "https://html.duckduckgo.com/html/", "Blocked")
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


class TestPrivateHttpException:
    """The https rule has exactly one hole and it must stay exactly this size.

    A local SearXNG has no certificate and needs none. Everything else does.
    """

    def test_loopback_literals_are_allowed(self):
        assert _is_private_http("http://127.0.0.1:8888/search")
        assert _is_private_http("http://[::1]:8888/search")

    def test_localhost_is_allowed_because_it_resolves_to_loopback(self):
        # Allowed by RESOLUTION, not by name. The distinction matters: the name
        # earns no exemption, its addresses do.
        assert _is_private_http("http://localhost:8888/search")

    def test_rfc1918_is_allowed_so_a_compose_service_name_works(self):
        assert _is_private_http("http://10.0.0.5:8080/search")
        assert _is_private_http("http://192.168.1.10:8080/search")
        assert _is_private_http("http://172.16.0.1:8080/search")

    def test_a_public_address_is_refused(self):
        assert not _is_private_http("http://1.1.1.1/search")
        assert not _is_private_http("http://example.com/search")

    def test_https_is_not_this_functions_business(self):
        # https is allowed by the caller's own check. This predicate answers
        # only "may this PLAIN HTTP request proceed", so it says no.
        assert not _is_private_http("https://127.0.0.1/search")

    def test_userinfo_is_refused_because_it_is_a_parser_differential(self):
        # `http://127.0.0.1@evil.example/` has hostname `evil.example`, but a
        # careless reader — human or regex — sees the loopback first.
        assert not _is_private_http("http://127.0.0.1@example.com/search")
        assert not _is_private_http("http://user:pass@127.0.0.1/search")

    def test_backslash_and_control_characters_are_refused(self):
        # The other half of the same trick: urlsplit and a naive splitter
        # disagree about where the authority ends.
        assert not _is_private_http("http://127.0.0.1\\@example.com/")
        assert not _is_private_http("http://127.0.0.1\t/")
        assert not _is_private_http("http://127.0.0.1\n/")

    def test_an_unresolvable_host_fails_closed(self):
        assert not _is_private_http("http://nx.invalid./search")

    def test_a_missing_host_fails_closed(self):
        assert not _is_private_http("http://")
        assert not _is_private_http("http:///search")


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

    def test_drops_a_hit_that_shares_no_word_with_the_query(self):
        # REGRESSION (live QA): Hacker News returned 51 of a run's 100 sources
        # for a parents-of-readers question, among them stories with no query
        # word anywhere. `optionalWords` makes Algolia fill a page regardless of
        # topic; a lexical score of exactly 0.0 means nothing in the title or
        # text matched, so the hit is not on topic.
        payload = {
            "hits": [
                {
                    "objectID": "1",
                    "title": "Independent Vet - find locally owned vets near you",
                    "points": 90,
                    "created_at": "2026-07-20T10:00:00Z",
                },
                {
                    "objectID": "2",
                    "title": "Teaching my son to read: what worked for a reluctant reader",
                    "points": 30,
                    "created_at": "2026-07-21T10:00:00Z",
                },
            ]
        }
        items = hackernews.parse_hits(payload, "reluctant readers early literacy", 10)
        assert [item.item_id for item in items] == ["HN2"]
        assert items[0].relevance_hint > 0.0

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
        # Inline CSS/JS otherwise leaks into a title or snippet.
        assert web_search_keyless.strip_html("<style>.a{color:red}</style>Title") == "Title"
        assert web_search_keyless.strip_html("<script>var x=1</script>Body") == "Body"

    def test_a_fully_blocked_ladder_raises_blocked_and_names_every_rung(self):
        source = web_search_keyless.KeylessWebSearchSource()

        def refuse(_query):
            raise SourceBlocked("HTTP 403")

        source._ddg = refuse
        # searxng has no URL configured, so it refuses on its own.

        with pytest.raises(SourceBlocked) as caught:
            source.fetch(SourceQuery(query="q", date_from="2026-07-01", date_to="2026-08-01"))
        detail = caught.value.detail
        assert "duckduckgo" in detail
        assert "searxng" in detail
        assert "202" in detail  # names the actual DDG challenge behaviour

    def test_searxng_is_tried_first_so_the_local_rung_wins(self):
        # Order is load-bearing: the local rung has no rate limit to trip, so
        # spending a remote request before trying it is pure waste.
        source = web_search_keyless.KeylessWebSearchSource(searxng_url="http://127.0.0.1:9")
        source._searxng = lambda _q: [("T", "https://example.com/sx", "S")]
        source._ddg = lambda _q: (_ for _ in ()).throw(
            AssertionError("duckduckgo must not be reached when searxng answers")
        )
        items = source.fetch(SourceQuery(query="q", date_from="2026-07-01", date_to="2026-08-01"))
        assert items[0].metadata["keyless_backend"] == "searxng"

    def test_falls_through_to_duckduckgo_when_searxng_is_unavailable(self):
        # The container is not running. That must not take keyless search down.
        source = web_search_keyless.KeylessWebSearchSource()
        source._ddg = lambda _q: [("T", "https://example.com/a", "S")]

        items = source.fetch(SourceQuery(query="q", date_from="2026-07-01", date_to="2026-08-01"))
        assert len(items) == 1
        assert items[0].metadata["keyless_backend"] == "duckduckgo"


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


def _arctic_row(**overrides):
    row = {
        "id": "abc123",
        "title": "Pricing feedback wanted",
        "selftext": "We charge $39/mo and churn is brutal.",
        "score": 42,
        "num_comments": 7,
        "created_utc": 1787245003,
        "subreddit": "startups",
    }
    row.update(overrides)
    return row


class TestArcticShiftUrl:
    def test_never_asks_for_the_author_field(self):
        """The strongest form of the username rule: it is never received.

        Dropping `author` at parse time would keep it out of storage; excluding
        it from the request means it is never received, so there is nothing to
        drop.
        """
        url = arctic_shift.build_search_url(
            subreddit="startups",
            query="pricing",
            date_from="2026-01-01",
            date_to="2026-08-01",
            limit=25,
        )
        assert "fields=" in url
        assert "author" not in url

    def test_carries_the_documented_parameters(self):
        url = arctic_shift.build_search_url(
            subreddit="startups",
            query="pricing",
            date_from="2026-01-01",
            date_to="2026-08-01",
            limit=25,
        )
        assert "subreddit=startups" in url
        # `title`, not `query`: live (2026-11-12) the archive answered `query=` with
        # HTTP 422 in under a second on every try, and the same request with the
        # keyword sent as `title=` with 200 and matching posts.
        assert "title=pricing" in url
        assert "query=" not in url
        assert "after=2026-01-01" in url
        assert "before=2026-08-01" in url
        assert "sort=desc" in url

    def test_clamps_limit_to_the_documented_ceiling(self):
        # The API answers 400 above 100 rather than truncating, so a caller
        # asking for 500 would get nothing at all instead of 100 results.
        assert "limit=100" in arctic_shift.build_search_url(
            subreddit="startups", query="x", date_from="", date_to="", limit=500
        )
        assert "limit=1" in arctic_shift.build_search_url(
            subreddit="startups", query="x", date_from="", date_to="", limit=0
        )

    def test_omits_an_empty_query_rather_than_sending_a_blank(self):
        url = arctic_shift.build_search_url(
            subreddit="startups", query="   ", date_from="", date_to="", limit=5
        )
        assert "title=" not in url
        assert "query=" not in url


class TestArcticShiftParsing:
    def _prepared(self):
        from app.text.relevance import PreparedQuery

        return PreparedQuery("pricing churn")

    def test_parses_a_row_into_a_source_item(self):
        items = arctic_shift.parse_posts({"data": [_arctic_row()]}, self._prepared(), "u")
        assert len(items) == 1
        item = items[0]
        assert item.title == "Pricing feedback wanted"
        assert item.url.startswith("https://www.reddit.com/r/startups/")
        assert item.container == "startups"
        assert item.published_at is not None
        assert item.date_confidence == "high"
        assert item.engagement == {"score": 42, "comments": 7}

    def test_the_author_is_always_none_even_if_the_archive_sends_one(self):
        # `fields` should prevent this, but a server-side change must not be
        # able to reintroduce a username through the back door.
        items = arctic_shift.parse_posts(
            {"data": [_arctic_row(author="someone_real")]}, self._prepared(), "u"
        )
        assert items[0].author is None

    def test_an_overload_body_raises_rather_than_reading_as_no_results(self):
        """THE IMPORTANT ONE.

        The archive sheds load with a 200 whose body carries an error string.
        Returning [] here would write "nobody is discussing this" into a report
        when the truth is "we never got to ask".
        """
        with pytest.raises(SourceRateLimited):
            arctic_shift.parse_posts(
                {"data": None, "error": "Timeout. Maybe slow down a bit"},
                self._prepared(),
                "u",
            )

    def test_a_non_overload_error_body_is_unavailable_not_rate_limited(self):
        with pytest.raises(SourceUnavailable):
            arctic_shift.parse_posts(
                {"data": None, "error": "Internal server error"}, self._prepared(), "u"
            )

    def test_a_missing_data_key_is_schema_drift(self):
        with pytest.raises(SourceSchemaDrift):
            arctic_shift.parse_posts({"results": []}, self._prepared(), "u")

    def test_an_empty_result_set_is_still_an_empty_list(self):
        # Genuinely no matches must remain distinguishable from a failure.
        assert arctic_shift.parse_posts({"data": []}, self._prepared(), "u") == []

    def test_drops_rows_that_cannot_produce_a_citable_permalink(self):
        # An uncitable finding is worse than a missing one: it renders with
        # citation machinery wrapped around a dead link.
        rows = [
            _arctic_row(title="", selftext=""),
            _arctic_row(id=""),
            _arctic_row(subreddit=""),
            _arctic_row(),
        ]
        assert len(arctic_shift.parse_posts({"data": rows}, self._prepared(), "u")) == 1

    def test_builds_the_thread_permalink_from_subreddit_and_id(self):
        # `permalink` is not a selectable field, and the selectable `url` is the
        # OFF-SITE target for a link post — citing it would send a founder to
        # the article instead of the discussion.
        items = arctic_shift.parse_posts({"data": [_arctic_row()]}, self._prepared(), "u")
        assert items[0].url == "https://www.reddit.com/r/startups/comments/abc123/"

    def test_never_requests_the_unselectable_permalink_field(self):
        # Verified against a live 400: "'permalink' is not a valid field".
        url = arctic_shift.build_search_url(
            subreddit="startups", query="x", date_from="", date_to="", limit=5
        )
        assert "permalink" not in url

    def test_an_unparseable_timestamp_lowers_confidence_instead_of_failing(self):
        items = arctic_shift.parse_posts(
            {"data": [_arctic_row(created_utc="not-a-number")]}, self._prepared(), "u"
        )
        assert items[0].published_at is None
        assert items[0].date_confidence == "low"


class TestArcticShiftScoping:
    def test_refuses_an_unscoped_search_instead_of_returning_arbitrary_posts(self):
        """No global keyword search exists, so pretending otherwise is a lie.

        Without a subreddit the API ignores `query` and returns the newest posts
        in the archive, which would read as "we searched and found little".
        """
        query = SourceQuery(query="pricing", date_from="2026-01-01", date_to="2026-08-01", limit=5)
        with pytest.raises(SourceUnavailable) as caught:
            arctic_shift.ArcticShiftSource().fetch(query)
        assert "subreddit" in caught.value.detail.lower()


class _Clock:
    """A fake monotonic clock that `sleep` advances. No test ever waits."""

    def __init__(self) -> None:
        self.now = 1000.0
        self.slept: list[float] = []

    def __call__(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.slept.append(seconds)
        self.now += seconds


class _FreeLimiter:
    """Always grants: the politeness limiter is tested on its own, not here."""

    def acquire(self, max_wait=None):
        return True


def _http_error(cls, status, detail, retry_after=None):
    error = cls(detail)
    error.status = status
    error.retry_after = retry_after
    return error


def _retry(url, clock, deadline_in=25.0):
    return arctic_shift._get_with_retry(
        url,
        deadline=clock() + deadline_in,
        clock=clock,
        sleep=clock.sleep,
        limiter=_FreeLimiter(),
    )


class TestArcticShiftRetry:
    """Retry only what retrying can fix, at most once. Nothing here waits."""

    def test_retries_a_body_reported_overload_once_and_succeeds(self, monkeypatch):
        calls = {"n": 0}

        def fake_get_json(url, timeout=None):
            calls["n"] += 1
            if calls["n"] == 1:
                return {"data": None, "error": "Timeout. Maybe slow down a bit"}
            return {"data": [_arctic_row()]}

        monkeypatch.setattr(arctic_shift, "get_json", fake_get_json)
        payload = _retry("u", _Clock())
        assert calls["n"] == 2
        assert len(payload["data"]) == 1

    def test_gives_up_as_rate_limited_after_one_retry_never_as_empty(self, monkeypatch):
        # Exhausting the retry must still be a FAILURE, never a quiet empty
        # result that reads as "nobody is talking about this".
        calls = {"n": 0}

        def fake_get_json(url, timeout=None):
            calls["n"] += 1
            return {"data": None, "error": "Timeout. Maybe slow down a bit"}

        monkeypatch.setattr(arctic_shift, "get_json", fake_get_json)
        with pytest.raises(SourceRateLimited) as caught:
            _retry("u", _Clock())
        assert calls["n"] == 2
        assert caught.value.detail.startswith("rate-limited")

    def test_a_429_waits_for_retry_after_then_retries_once(self, monkeypatch):
        calls = {"n": 0}

        def fake_get_json(url, timeout=None):
            calls["n"] += 1
            if calls["n"] == 1:
                raise _http_error(SourceRateLimited, 429, "HTTP 429", retry_after=3.0)
            return {"data": [_arctic_row()]}

        monkeypatch.setattr(arctic_shift, "get_json", fake_get_json)
        clock = _Clock()
        assert _retry("u", clock)["data"]
        assert calls["n"] == 2
        assert clock.slept == [3.0]

    def test_a_429_asking_for_a_long_wait_is_not_retried(self, monkeypatch):
        # Asking again sooner than told is impolite and pointless; waiting
        # longer does not fit the lane. Either way: report, do not retry.
        calls = {"n": 0}

        def fake_get_json(url, timeout=None):
            calls["n"] += 1
            raise _http_error(SourceRateLimited, 429, "HTTP 429", retry_after=60.0)

        monkeypatch.setattr(arctic_shift, "get_json", fake_get_json)
        clock = _Clock()
        with pytest.raises(SourceRateLimited):
            _retry("u", clock)
        assert calls["n"] == 1
        assert clock.slept == []

    def test_does_not_retry_a_bad_request_and_says_it_was_rejected(self, monkeypatch):
        """A 400 will not improve by asking again — retrying only slows it."""
        calls = {"n": 0}

        def fake_get_json(url, timeout=None):
            calls["n"] += 1
            raise _http_error(
                SourceUnavailable, 400, "HTTP 400 ... 'permalink' is not a valid field"
            )

        monkeypatch.setattr(arctic_shift, "get_json", fake_get_json)
        with pytest.raises(SourceUnavailable) as caught:
            _retry("u", _Clock())
        assert calls["n"] == 1
        assert caught.value.detail.startswith("rejected the query")

    def test_a_403_stays_blocked_and_is_not_retried(self, monkeypatch):
        # A 403 is the host refusing this server (a datacenter egress range), not
        # the archive rejecting the query. It must keep the wire kind `blocked`
        # so the lane report names a blocked host.
        calls = {"n": 0}

        def fake_get_json(url, timeout=None):
            calls["n"] += 1
            raise _http_error(SourceBlocked, 403, "HTTP 403 from the archive")

        monkeypatch.setattr(arctic_shift, "get_json", fake_get_json)
        with pytest.raises(SourceBlocked) as caught:
            _retry("u", _Clock())
        assert calls["n"] == 1
        assert caught.value.kind == "blocked"
        assert not caught.value.detail.startswith("rejected the query")

    def test_a_422_is_a_rejected_request_not_a_rate_limit_and_is_not_retried(self, monkeypatch):
        # REGRESSION (live QA). The archive answers a request it cannot process
        # with HTTP 422 and the body "Timeout. Maybe slow down a bit"; the lane
        # read that wording as a rate limit and told the founder so. A rate limit
        # is a 429. The failure kind is `unavailable`, the message names the
        # cause, and a 4xx other than 429 is never retried.
        calls = {"n": 0}

        def fake_get_json(url, timeout=None):
            calls["n"] += 1
            raise _http_error(
                SourceUnavailable, 422, "HTTP 422 ... 'Timeout. Maybe slow down a bit'"
            )

        monkeypatch.setattr(arctic_shift, "get_json", fake_get_json)
        with pytest.raises(SourceUnavailable) as caught:
            _retry("u", _Clock())
        assert calls["n"] == 1
        assert caught.value.kind == "unavailable"
        assert caught.value.status == 422
        assert caught.value.detail.startswith("rejected the query (HTTP 422")
        assert "not a rate limit" in caught.value.detail
        assert "429" in caught.value.detail


class TestArcticShiftKeywordQuery:
    """The archive matches every word it is sent; a web query matches nothing."""

    def test_a_long_web_query_becomes_two_content_words(self):
        query = (
            "parents struggling reluctant readers age 5 7 decodable books phonics "
            "apps tutoring dyslexia reviews price cancellation complaints UK US "
            "Australia Canada New Zealand"
        )
        assert arctic_shift.keyword_query(query) == "reluctant readers"

    def test_search_operators_and_quotes_are_dropped(self):
        query = 'site:reddit.com -ads "flea treatment" OR reminder'
        assert arctic_shift.keyword_query(query) == "flea treatment"

    def test_a_query_with_no_content_word_is_refused_not_sent_empty(self):
        # An empty `query` returns the newest posts in the subreddit, which
        # would read as a search that found little.
        lane = SourceQuery(
            query="site:reddit.com the of",
            date_from="2026-01-01",
            date_to="2026-08-20",
            limit=5,
            options={"subreddits": ["startups"]},
        )
        with pytest.raises(SourceUnavailable) as caught:
            arctic_shift.ArcticShiftSource().fetch(lane)
        assert "not asked" in caught.value.detail


class TestArcticShiftLaneResilience:
    """One subreddit failing is not the lane failing; every one failing is."""

    def _query(self, subs):
        return SourceQuery(
            query="pricing anxiety",
            date_from="2026-01-01",
            date_to="2026-08-20",
            limit=5,
            options={"subreddits": subs},
        )

    def _fetch(self, subs, clock=None):
        clock = clock or _Clock()
        return arctic_shift.ArcticShiftSource().fetch(
            self._query(subs), clock=clock, sleep=clock.sleep, limiter=_FreeLimiter()
        )

    def test_a_failing_subreddit_does_not_kill_a_healthy_one(self, monkeypatch):
        """REGRESSION. SourceRateLimited is a SIBLING of SourceUnavailable.

        Catching the narrower type in the per-subreddit loop let an exhausted
        retry escape and take down the whole lane, discarding results already
        collected from subreddits that answered perfectly well.
        """

        def fake_retry(url, **_kw):
            if "subreddit=dead" in url:
                raise SourceUnavailable("HTTP 503 from the archive")
            return {"data": [_arctic_row()]}

        monkeypatch.setattr(arctic_shift, "_get_with_retry", fake_retry)
        items = self._fetch(["dead", "alive"])
        assert len(items) == 1
        assert items[0].container == "startups"

    def test_a_rate_limited_lane_says_so_and_stops_asking(self, monkeypatch):
        asked: list[str] = []

        def fake_retry(url, **_kw):
            asked.append(url)
            raise SourceRateLimited("rate-limited (HTTP 429)")

        monkeypatch.setattr(arctic_shift, "_get_with_retry", fake_retry)
        with pytest.raises(SourceRateLimited) as caught:
            self._fetch(["a", "b", "c"])
        # Asking the next subreddit of a host that is rate-limiting us would be
        # refused too.
        assert len(asked) == 1
        detail = caught.value.detail
        assert detail.startswith("Arctic Shift rate-limited this lane")
        assert "not a finding" in detail
        assert "r/b: not asked" in detail

    def test_nothing_found_while_part_of_the_lane_failed_is_never_empty(self, monkeypatch):
        # One subreddit answered with no posts, one rejected the query. "Found
        # nothing" would be a claim about a subreddit nobody searched.
        def fake_retry(url, **_kw):
            if "subreddit=bad" in url:
                raise _http_error(SourceUnavailable, 400, "rejected the query (HTTP 400)")
            return {"data": []}

        monkeypatch.setattr(arctic_shift, "_get_with_retry", fake_retry)
        with pytest.raises(SourceUnavailable) as caught:
            self._fetch(["empty", "bad"])
        assert "rejected the query" in caught.value.detail

    def test_a_lane_rejected_with_422_names_the_request_not_a_rate_limit(self, monkeypatch):
        # REGRESSION (live QA): four of five archive calls answered 422 and the
        # lane told the founder it was rate-limited, and stopped after the first
        # subreddit. Every subreddit is asked, the lane fails as `unavailable`,
        # and the headline says the archive rejected the query.
        asked: list[str] = []

        def get_json_422(url, timeout=None):
            asked.append(url)
            raise _http_error(
                SourceUnavailable,
                422,
                "HTTP 422 from the archive. Body began: 'Timeout. Maybe slow down a bit'",
            )

        monkeypatch.setattr(arctic_shift, "get_json", get_json_422)
        with pytest.raises(SourceError) as caught:
            self._fetch(["a", "b", "c", "d"])
        assert len(asked) == 4
        failure = caught.value
        assert type(failure) is SourceUnavailable
        assert failure.kind == "unavailable"
        assert failure.detail.startswith("Arctic Shift rejected the query")
        assert "rate-limited" not in failure.detail
        assert "not a rate limit" in failure.detail

    def test_a_lane_refused_with_403_is_reported_blocked_not_rejected(self, monkeypatch):
        # Every subreddit answered 403: the archive refused this server. The
        # lane failure must reach the TypeScript side as kind `blocked`, and its
        # headline must not blame the query.
        def fake_retry(url, **_kw):
            raise _http_error(SourceBlocked, 403, "HTTP 403 from the archive")

        monkeypatch.setattr(arctic_shift, "_get_with_retry", fake_retry)
        with pytest.raises(SourceBlocked) as caught:
            self._fetch(["a", "b"])
        assert caught.value.kind == "blocked"
        assert "blocked host" in caught.value.detail
        assert "rejected the query" not in caught.value.detail

    def test_a_403_next_to_a_rate_limit_still_reads_blocked(self, monkeypatch):
        # Waiting cannot fix a blocked host, so the blocked kind outranks a rate
        # limit seen in the same lane.
        def fake_retry(url, **_kw):
            if "subreddit=a" in url:
                raise _http_error(SourceBlocked, 403, "HTTP 403 from the archive")
            raise _http_error(SourceRateLimited, 429, "rate-limited (HTTP 429)")

        monkeypatch.setattr(arctic_shift, "_get_with_retry", fake_retry)
        with pytest.raises(SourceBlocked):
            self._fetch(["a", "b"])

    def test_the_lane_stops_at_its_time_limit(self, monkeypatch):
        """The guard for the QA run: a slow archive cannot eat the research run."""
        clock = _Clock()
        asked: list[str] = []

        def slow_get_json(url, timeout=None):
            asked.append(url)
            clock.now += timeout  # every request uses its whole timeout
            raise SourceUnavailable(f"Timed out after {timeout}s reaching {url}.")

        monkeypatch.setattr(arctic_shift, "get_json", slow_get_json)
        start = clock()
        with pytest.raises(SourceError) as caught:
            self._fetch(["a", "b", "c", "d"], clock=clock)
        assert clock() - start <= arctic_shift._LANE_WALL_TIME_SECONDS
        assert len(asked) < 4
        assert "not asked" in caught.value.detail
