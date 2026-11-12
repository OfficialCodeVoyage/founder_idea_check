# ─────────────────────────────────────────────────────────────────────────────
# ADAPTED from mvanhorn/last30days-skill (MIT)
#   file:   skills/last30days/scripts/lib/hackernews.py
#   commit: 9243a32d823c7c8659e44b92f2dedcf1b7397137 (2026-08-18)
#
# MODIFICATIONS: the Algolia query construction — including BOTH traps quoted in
# the comments below, which are the reason this file was worth taking rather
# than writing — is upstream's. Removed: the depth presets, the thread-comment
# enrichment fan-out, and the `log.source_log` sink. Errors now raise named
# exceptions instead of returning `{"hits": [], "error": ...}`. Added: a hit is
# dropped unless its title or text shares a CONTENT word with the query, where
# stopwords, numbers and years, countries, file types, research filler and price
# words do not count (`matches_a_content_word`, `_GENERIC_TOKENS`).
#
#   gh api "repos/mvanhorn/last30days-skill/commits?path=skills/last30days/scripts/lib/hackernews.py&since=2026-08-18" --jq '.[].commit.message'
# ─────────────────────────────────────────────────────────────────────────────
"""Hacker News via the Algolia API. Keyless, documented, intended for third parties."""

from __future__ import annotations

import datetime
import html
import re
from urllib.parse import urlencode

from ..errors import SourceSchemaDrift
from ..http import get_json
from ..schema import SourceItem
from ..text.relevance import (
    LOW_SIGNAL_QUERY_TOKENS,
    PreparedQuery,
    token_overlap_relevance,
    tokenize,
)
from .base import SourceDescriptor, SourceQuery

DESCRIPTOR = SourceDescriptor(
    id="hackernews",
    label="Hacker News",
    enabled_in_hosted=True,
    enabled_in_self_host=True,
    gate_reason=(
        "Public, documented, keyless API that its operator intends third parties to "
        "call. No anti-bot posture and no personal data stored beyond a public permalink."
    ),
    required_credentials=(),
    source_quality=0.75,
)

ALGOLIA_SEARCH_URL = "https://hn.algolia.com/api/v1/search"

#: Overfetch, then filter client-side. See the `points` trap below — this is the
#: only way to apply a minimum-engagement filter at all.
_OVERFETCH_MULTIPLIER = 2
_MIN_STORY_POINTS = 2

#: HN title conventions that would otherwise produce false keyword matches.
_HN_PREFIXES = re.compile(r"^(Tell HN|Show HN|Ask HN|Launch HN)\s*:\s*", re.IGNORECASE)
_TAG_RE = re.compile(r"<[^>]+>")
_PARA_RE = re.compile(r"<p>")


def _date_to_unix(date_str: str) -> int:
    year, month, day = (int(part) for part in date_str.split("-"))
    return int(datetime.datetime(year, month, day, tzinfo=datetime.UTC).timestamp())


def _strip_html(text: str) -> str:
    text = html.unescape(text or "")
    return _TAG_RE.sub("", _PARA_RE.sub("\n", text)).strip()


def _flatten_query(text: str) -> str:
    """Hyphens and commas tokenize awkwardly in Algolia.

    Upstream's fix: flatten them, so a themed query like "ts-bun-node" or
    "claude, personal agents" becomes plain words rather than one opaque token
    that matches nothing.
    """
    return re.sub(r"[\-,/]+", " ", text).strip()


def build_search_url(query: str, date_from: str, date_to: str, count: int) -> str:
    """PURE. Builds the Algolia URL, carrying both of upstream's hard-won traps.

    TRAP 1 — `points` IS NOT FILTERABLE. The HN Algolia index does not list
    `points` in its `numericAttributesForFiltering`, so a `points>N` clause makes
    the API return HTTP 400 ("invalid numeric attribute(points)") and ZERO
    stories. Not a warning, not a partial result — nothing. Low-engagement
    filtering therefore happens client-side after overfetching. Do not
    "optimise" the filter back into the query.

    TRAP 2 — ALGOLIA ANDs QUERY TOKENS BY DEFAULT, so a four- or five-word theme
    query matches no stories at all. Marking all but the first token as
    `optionalWords` makes Algolia rank by how many tokens match instead of
    requiring every one.

    Also deliberate: `restrictSearchableAttributes=title` is NOT set. It would
    miss the Ask HN / Show HN threads where the topic appears only in the body —
    which for demand validation are the most valuable results on the site.
    """
    flat = _flatten_query(query)
    params = {
        "query": flat,
        "tags": "story",
        "numericFilters": (
            f"created_at_i>{_date_to_unix(date_from)},created_at_i<{_date_to_unix(date_to) + 86400}"
        ),
        "hitsPerPage": str(count * _OVERFETCH_MULTIPLIER),
    }
    tokens = flat.split()
    if len(tokens) > 1:
        params["optionalWords"] = " ".join(tokens[1:])
    return f"{ALGOLIA_SEARCH_URL}?{urlencode(params)}"


# ── WHICH HITS ARE ON TOPIC. ─────────────────────────────────────────────────
#
# `optionalWords` (TRAP 2 above) lets Algolia return a story that matches a
# SINGLE query token, and Algolia's matching is looser than our token test (typo
# tolerance, prefixes), so a full page of hits comes back whatever the topic.
#
# Live QA, 2026-11-12, a parents-of-young-readers question, twice:
#   1. Hacker News returned 51 of a run's 100 sources, among them a vet
#      directory and a story about a politician. Dropping hits whose lexical
#      relevance is exactly 0.0 (no query word in the title or text) removed those.
#   2. It still returned 56 of the next run's 115, and only 3 of 55 titles shared a
#      content word with the question. What they matched was the query's FILLER:
#      "U.S." / "United States" (the market the founder named), years ("2023"),
#      "pdf", "years", "prices", "report", "survey". A researcher's web-search
#      query is full of such words, any story shares some of them, and a bare
#      "matches one query word" test passes all of them.
#
# So the test is "matches a CONTENT word of the query", and the words that cannot
# decide a topic are excluded from the overlap: stopwords (`tokenize` already
# drops them), numbers and years, countries and regions, file types and web
# scaffolding, research filler (report, survey, data, study, statistics), price
# words that every commerce story shares, and time and age words. The planner's
# own low-signal list (`LOW_SIGNAL_QUERY_TOKENS`: best, guide, review, new, people)
# is excluded too. A word that is on the list is never evidence on its own; it
# still counts in the relevance score of a hit that passes.
#
# IF THE QUERY HAS NO CONTENT WORD at all ("market size report 2024"), nothing
# could ever pass, so the test falls back to "matches any query word" rather than
# turning the whole lane into an empty result.
_GENERIC_TOKENS = frozenset(
    (
        # Countries, regions, nationalities: the market the founder named.
        "us", "usa", "america", "american", "americans", "states", "united",
        "state", "uk", "britain", "british", "england", "scotland", "wales",
        "ireland", "irish", "canada", "canadian", "australia", "australian",
        "zealand", "india", "indian", "china", "chinese", "europe", "european",
        "asia", "asian", "africa", "global", "worldwide", "international",
        "national", "nationwide", "country", "countries", "world", "region",
        "regional", "local",
        # File types and web scaffolding from a search-engine query.
        "pdf", "doc", "docx", "ppt", "pptx", "xls", "xlsx", "csv", "html",
        "htm", "txt", "www", "http", "https", "com", "org", "net", "edu", "gov",
        "url", "site", "website", "websites", "web", "online", "internet",
        "blog", "blogs", "article", "articles", "post", "posts", "forum",
        "forums", "thread", "threads", "reddit", "discussion", "discussions",
        # Research filler.
        "report", "reports", "survey", "surveys", "data", "dataset", "datasets",
        "study", "studies", "statistic", "statistics", "stats", "research",
        "analysis", "analyses", "result", "results", "finding", "findings",
        "evidence", "trend", "trends", "market", "markets", "industry",
        "industries", "overview", "summary", "size", "share", "growth",
        "average", "percent", "percentage", "number", "numbers", "rate",
        "rates", "level", "levels", "million", "billion", "thousand", "annual",
        "quarterly", "yearly", "monthly",
        # Words every commerce story shares.
        "price", "prices", "pricing", "cost", "costs", "complaint",
        "complaints",
        # Time and age words: "5-7 year old" matches any story that says "years".
        "year", "years", "month", "months", "week", "weeks", "day", "days",
        "time", "today", "old", "age", "ages", "aged",
        # Who, in general.
        "user", "users", "customer", "customers", "consumer", "consumers",
        "person", "persons",
    )
) | LOW_SIGNAL_QUERY_TOKENS  # fmt: skip

#: Years ("2023"), decades ("1990s") and any other bare number.
_NUMBER = re.compile(r"^\d+s?$")


def _is_generic(token: str) -> bool:
    return token in _GENERIC_TOKENS or _NUMBER.match(token) is not None


def matches_a_content_word(prepared: PreparedQuery, text: str) -> bool:
    """PURE. Does `text` share a CONTENT word with the query? THE one place that
    decides whether a Hacker News hit is on topic.

    Tokenised with the same `tokenize` the relevance score uses, so a word that
    counts here counts there. With no content word in the query the test is
    "any query word"; with no query word at all (stopwords only) every hit stays,
    as `token_overlap_relevance` already treats such a query as neutral.
    """
    query_tokens = prepared.q_tokens
    if not query_tokens:
        return True
    content_tokens = {token for token in query_tokens if not _is_generic(token)}
    return bool((content_tokens or query_tokens) & tokenize(text))


def parse_hits(payload: object, query: str, limit: int) -> list[SourceItem]:
    """PURE. Turns an Algolia response into SourceItems.

    Raises `SourceSchemaDrift` rather than returning `[]` when the payload is
    not the documented shape: an API that changed shape and an API that found
    nothing are different problems with different fixes.
    """
    if not isinstance(payload, dict) or "hits" not in payload:
        raise SourceSchemaDrift(
            f"HN Algolia returned no `hits` key; got {type(payload).__name__} "
            f"with keys {sorted(payload)[:8] if isinstance(payload, dict) else '-'}"
        )
    hits = payload.get("hits")
    if not isinstance(hits, list):
        raise SourceSchemaDrift("HN Algolia `hits` was not a list.")

    prepared = PreparedQuery(query)
    items: list[SourceItem] = []

    for hit in hits:
        if not isinstance(hit, dict):
            continue
        points = hit.get("points") or 0
        if points <= _MIN_STORY_POINTS:
            continue
        object_id = str(hit.get("objectID") or "").strip()
        if not object_id:
            continue

        title = _HN_PREFIXES.sub("", str(hit.get("title") or "")).strip()
        body = _strip_html(str(hit.get("story_text") or ""))
        created = str(hit.get("created_at") or "")[:10] or None

        # A HIT THAT MATCHES NO REAL WORD OF THE QUERY IS NOT ON TOPIC. See
        # `matches_a_content_word`, the one place this is decided, and the
        # history in the comment above `_GENERIC_TOKENS`. Dropped HERE, where the
        # looseness is introduced, and not for every lane: a web-search snippet
        # can match a query without repeating its words. An empty result is still
        # a finding (nothing on HN matches), not an error.
        text = f"{title} {body}"
        if not matches_a_content_word(prepared, text):
            continue
        relevance = token_overlap_relevance(prepared, text)

        items.append(
            SourceItem(
                item_id=f"HN{object_id}",
                source="hackernews",
                title=title,
                body=body,
                # The HN permalink, not the linked article: the discussion is
                # the evidence, the article is what it is about.
                url=f"https://news.ycombinator.com/item?id={object_id}",
                author=str(hit.get("author") or "") or None,
                container="Hacker News",
                published_at=created,
                # Algolia returns a real ISO timestamp, so the date is reliable.
                date_confidence="high" if created else "low",
                engagement={
                    "score": points,
                    "num_comments": hit.get("num_comments") or 0,
                },
                relevance_hint=relevance,
                why_relevant="Hacker News discussion",
                snippet=(body or title)[:500],
                metadata={"external_url": hit.get("url")},
            )
        )
        if len(items) >= limit:
            break

    return items


class HackerNewsSource:
    descriptor = DESCRIPTOR

    def fetch(self, query: SourceQuery) -> list[SourceItem]:
        url = build_search_url(query.query, query.date_from, query.date_to, query.limit)
        payload = get_json(url, timeout=30)
        return parse_hits(payload, query.query, query.limit)
