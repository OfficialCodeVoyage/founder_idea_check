# ─────────────────────────────────────────────────────────────────────────────
# ADAPTED from mvanhorn/last30days-skill (MIT)
#   file:   skills/last30days/scripts/lib/hackernews.py
#   commit: 9243a32d823c7c8659e44b92f2dedcf1b7397137 (2026-08-18)
#
# MODIFICATIONS: the Algolia query construction — including BOTH traps quoted in
# the comments below, which are the reason this file was worth taking rather
# than writing — is upstream's. Removed: the depth presets, the thread-comment
# enrichment fan-out, and the `log.source_log` sink. Errors now raise named
# exceptions instead of returning `{"hits": [], "error": ...}`.
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
from ..text.relevance import PreparedQuery, token_overlap_relevance
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
                relevance_hint=token_overlap_relevance(prepared, f"{title} {body}"),
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
