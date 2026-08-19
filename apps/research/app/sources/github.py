# ─────────────────────────────────────────────────────────────────────────────
# ADAPTED from mvanhorn/last30days-skill (MIT)
#   file:   skills/last30days/scripts/lib/github.py
#   commit: 9243a32d823c7c8659e44b92f2dedcf1b7397137 (2026-08-18)
#
# MODIFICATIONS: the search-qualifier construction and the "issues are where the
# pain is" framing are upstream's. Removed: device-flow auth, the repo-activity
# and release lanes, and the unauthenticated fallback (see the comment on
# `required_credentials` — the 60/hour limit makes it a trap, not a fallback).
#
#   gh api "repos/mvanhorn/last30days-skill/commits?path=skills/last30days/scripts/lib/github.py&since=2026-08-18" --jq '.[].commit.message'
# ─────────────────────────────────────────────────────────────────────────────
"""GitHub issues and discussions — where people describe a problem while having it."""

from __future__ import annotations

from urllib.parse import urlencode

from ..errors import SourceSchemaDrift
from ..http import get_json
from ..schema import SourceItem
from ..text.relevance import PreparedQuery, token_overlap_relevance
from .base import SourceDescriptor, SourceQuery

DESCRIPTOR = SourceDescriptor(
    id="github",
    label="GitHub",
    enabled_in_hosted=True,
    enabled_in_self_host=True,
    gate_reason=(
        "Official REST API used with a token, within its documented rate limits. "
        "Requires GITHUB_TOKEN because the 60/hour keyless limit is exhausted by a "
        "single research run."
    ),
    # NOT optional, and NOT a soft preference. Keyless GitHub search is 60
    # requests/hour per IP; one research run burns that, and the 61st request
    # returns 403 — which would surface as a blocked source halfway through
    # every run and look like an outage. Requiring the token converts a
    # confusing intermittent failure into one clear message up front.
    required_credentials=("GITHUB_TOKEN",),
    source_quality=0.7,
)

_SEARCH_URL = "https://api.github.com/search/issues"


def build_search_url(query: str, date_from: str, date_to: str, limit: int) -> str:
    """PURE. Builds a GitHub issue-search URL.

    `is:issue` rather than `is:pr`: a pull request is somebody solving a
    problem, an issue is somebody having one, and only the second is demand
    evidence. `created:` rather than `updated:` for the same reason — an old
    issue bumped by a bot is not new demand.
    """
    qualifiers = f"{query} is:issue created:{date_from}..{date_to}"
    params = {
        "q": qualifiers,
        "sort": "reactions",
        "order": "desc",
        "per_page": str(min(limit, 100)),
    }
    return f"{_SEARCH_URL}?{urlencode(params)}"


def parse_items(payload: object, query: str, limit: int) -> list[SourceItem]:
    """PURE. Turns a GitHub search response into SourceItems."""
    if not isinstance(payload, dict) or "items" not in payload:
        raise SourceSchemaDrift(
            "GitHub search returned no `items` key; the API shape changed or the "
            "request was rejected with a body we did not expect."
        )
    raw_items = payload.get("items")
    if not isinstance(raw_items, list):
        raise SourceSchemaDrift("GitHub search `items` was not a list.")

    prepared = PreparedQuery(query)
    items: list[SourceItem] = []

    for entry in raw_items:
        if not isinstance(entry, dict):
            continue
        url = str(entry.get("html_url") or "")
        if not url.startswith("https://"):
            continue
        title = str(entry.get("title") or "")
        body = str(entry.get("body") or "")[:2000]
        reactions = entry.get("reactions") or {}
        user = entry.get("user") or {}

        items.append(
            SourceItem(
                item_id=f"GH{entry.get('id')}",
                source="github",
                title=title,
                body=body,
                url=url,
                author=str(user.get("login") or "") or None,
                container=url.split("/issues/")[0].removeprefix("https://github.com/"),
                published_at=str(entry.get("created_at") or "")[:10] or None,
                date_confidence="high",
                engagement={
                    "reactions": reactions.get("total_count", 0)
                    if isinstance(reactions, dict)
                    else 0,
                    "comments": entry.get("comments") or 0,
                },
                relevance_hint=token_overlap_relevance(prepared, f"{title} {body}"),
                why_relevant="GitHub issue",
                snippet=(body or title)[:500],
                metadata={"state": entry.get("state")},
            )
        )
        if len(items) >= limit:
            break

    return items


class GitHubSource:
    descriptor = DESCRIPTOR

    def __init__(self, token: str) -> None:
        if not token:
            # Constructing a credentialled source with no credential is a
            # programming error, not a runtime condition — the gate in
            # `base.assert_permitted` already refuses this case with a clear
            # message, so reaching here means the registry skipped the gate.
            raise ValueError("GitHubSource requires a token; the gate should have refused first")
        self._token = token

    def fetch(self, query: SourceQuery) -> list[SourceItem]:
        url = build_search_url(query.query, query.date_from, query.date_to, query.limit)
        payload = get_json(
            url,
            timeout=30,
            headers={
                "Authorization": f"Bearer {self._token}",
                "X-GitHub-Api-Version": "2022-11-28",
            },
        )
        return parse_items(payload, query.query, query.limit)
