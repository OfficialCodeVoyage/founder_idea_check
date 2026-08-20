# ─────────────────────────────────────────────────────────────────────────────
# ADAPTED from mvanhorn/last30days-skill (MIT)
#   file:   skills/last30days/scripts/lib/web_search_keyless.py
#   commit: 9243a32d823c7c8659e44b92f2dedcf1b7397137 (2026-08-18)
#
# MODIFICATIONS: every regex, the DuckDuckGo redirect unwrapper, the positional
# snippet-window trick and the three-rung ladder are upstream's, along with the
# comments explaining why each is shaped the way it is. Removed: the artifact
# dict and the `_KEYLESS_RELEVANCE` floor constant (relevance is computed here
# from the query instead of assigned a flat prior). Changed: a fully blocked
# ladder RAISES `SourceBlocked` instead of returning `([], {"reason": ...})`.
#
#   gh api "repos/mvanhorn/last30days-skill/commits?path=skills/last30days/scripts/lib/web_search_keyless.py&since=2026-08-18" --jq '.[].commit.message'
# ─────────────────────────────────────────────────────────────────────────────
"""Keyless web search: a local SearXNG first, DuckDuckGo HTML as the fallback.

WHY A LADDER AND NOT ONE ENDPOINT. DuckDuckGo's HTML endpoint anomaly-blocks
datacenter IPs with an HTTP 202 challenge page — a success status carrying no
results. A single-endpoint implementation would report "nothing found" for every
query from such a host, forever, which is the exact failure mode
`app/errors.py` exists to prevent. A ladder that runs out of rungs therefore
raises `SourceBlocked` naming every rung it tried.

WHY SEARXNG IS FIRST. It runs on this machine (`docker-compose.yml`), so it has
no rate limit we can trip and no anomaly detection to fall foul of, and it fans
out across roughly a dozen upstream engines internally — including the ones a
single scraper cannot reach. Its own JSON reports which of those engines failed,
so a partial upstream outage degrades instead of disappearing.

WHY DUCKDUCKGO IS STILL HERE. SearXNG is a container, and the sidecar can run
without one. If the ladder were a single local rung, `docker compose up` would
become a hard requirement for keyless search rather than a convenience.

STARTPAGE WAS THE THIRD RUNG AND WAS REMOVED 2026-08-20, on measurement rather
than on taste: it answered HTTP 200 and parsed to ZERO results, which is the
silent-empty this module is built to avoid. The local SearXNG independently
reports `startpage: CAPTCHA` in its own `unresponsive_engines` for the same
queries, so both observations agree. Its parser and regexes are gone with it;
`unwrap_ddg_redirect` is NOT Startpage's and stays.
"""

from __future__ import annotations

import html
import re
from urllib.parse import parse_qs, urlencode, urlparse

from ..errors import SourceBlocked, SourceError
from ..http import get_json, get_text
from ..schema import SourceItem
from ..text.relevance import PreparedQuery, token_overlap_relevance
from .base import SourceDescriptor, SourceQuery

DESCRIPTOR = SourceDescriptor(
    id="web-keyless",
    label="Keyless web search",
    enabled_in_hosted=True,
    enabled_in_self_host=True,
    gate_reason=(
        "Reads ordinary public search result pages with no credential and no access "
        "control to route around. Tries a local SearXNG first, then DuckDuckGo; a "
        "fully blocked ladder is reported as blocked, not as zero results."
    ),
    required_credentials=(),
    # Lower than HN: a search-result snippet is a summary of evidence, not the
    # evidence, so it should never outrank a primary discussion thread.
    source_quality=0.5,
)

_DDG_HTML_URL = "https://html.duckduckgo.com/html/"

_TAG_RE = re.compile(r"<[^>]+>")
# Strip <style>/<script> blocks INCLUDING their contents before dropping tags,
# so inline CSS/JS text never leaks into a title or snippet. Result pages carry
# plenty of it.
_STYLE_SCRIPT_RE = re.compile(r"<(style|script)\b[^>]*>.*?</\1>", re.IGNORECASE | re.DOTALL)

_RESULT_A_RE = re.compile(
    r'class="result__a"[^>]*href="(?P<href>[^"]+)"[^>]*>(?P<title>.*?)</a>',
    re.IGNORECASE | re.DOTALL,
)
_SNIPPET_RE = re.compile(
    r'class="result__snippet"[^>]*>(?P<snippet>.*?)</a>',
    re.IGNORECASE | re.DOTALL,
)

def strip_html(fragment: str) -> str:
    without_blocks = _STYLE_SCRIPT_RE.sub("", fragment or "")
    return html.unescape(_TAG_RE.sub("", without_blocks)).strip()


def unwrap_ddg_redirect(href: str) -> str:
    """DuckDuckGo wraps result links as //duckduckgo.com/l/?uddg=<encoded>."""
    if "uddg=" not in href:
        if href.startswith("http"):
            return href
        return f"https:{href}" if href.startswith("//") else href
    try:
        absolute = href if href.startswith("http") else f"https:{href}"
        target = parse_qs(urlparse(absolute).query).get("uddg", [""])[0]
        return target or href
    except (ValueError, AttributeError):
        return href


def parse_ddg(text: str, limit: int) -> list[tuple[str, str, str]]:
    """PURE. -> [(title, url, snippet)].

    Snippets are associated BY POSITION, not by a parallel index: some result
    anchors (video and news modules) carry no snippet, so zipping two lists
    shifts every later snippet onto the wrong result. Take the first snippet
    that falls between this anchor and the next one.
    """
    out: list[tuple[str, str, str]] = []
    matches = list(_RESULT_A_RE.finditer(text))
    for index, match in enumerate(matches):
        if len(out) >= limit:
            break
        target = unwrap_ddg_redirect(match.group("href"))
        if not target.startswith("http"):
            continue
        next_start = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        window = text[match.end() : next_start]
        snippet_match = _SNIPPET_RE.search(window)
        snippet = strip_html(snippet_match.group("snippet")) if snippet_match else ""
        out.append((strip_html(match.group("title")), target, snippet))
    return out


def _to_items(rows: list[tuple[str, str, str]], query: str, backend: str) -> list[SourceItem]:
    prepared = PreparedQuery(query)
    items: list[SourceItem] = []
    for index, (title, url, snippet) in enumerate(rows, start=1):
        items.append(
            SourceItem(
                item_id=f"WK{index}",
                source="web-keyless",
                title=title,
                body=snippet,
                url=url,
                container=urlparse(url).netloc.lower(),
                # Search engines do not date their results reliably, and
                # inventing a date here would let an undated page outrank a
                # dated one in the freshness term.
                published_at=None,
                date_confidence="low",
                engagement={},
                relevance_hint=token_overlap_relevance(prepared, f"{title} {snippet}"),
                why_relevant=f"Keyless web search ({backend})",
                snippet=snippet[:500],
                metadata={"keyless_backend": backend},
            )
        )
    return items


class KeylessWebSearchSource:
    descriptor = DESCRIPTOR

    def __init__(self, searxng_url: str | None = None) -> None:
        # Operator-supplied, and it stays a URL rather than becoming a hardcoded
        # service name: the sidecar runs on the HOST in dev, where a compose
        # service name would not resolve.
        #
        # This used to carry a note that SearXNG is AGPL-3.0 and therefore had
        # to stay out of docker-compose.yml. That bar was lifted on 2026-08-20
        # for local-only use — see THIRD_PARTY.md. What survives the reversal:
        # never vendor and never patch it, because a patched build forfeits
        # upstream security fixes, which was never a licence argument.
        self._searxng_url = (searxng_url or "").strip().rstrip("/")

    def fetch(self, query: SourceQuery) -> list[SourceItem]:
        attempts: list[str] = []

        # SearXNG first: local, unmetered, and internally fans out across many
        # engines. DuckDuckGo second, so a stack without containers still works.
        for backend, runner in (
            ("searxng", self._searxng),
            ("duckduckgo", self._ddg),
        ):
            try:
                rows = runner(query)
            except SourceError as error:
                # A rung that refuses us is recorded and the ladder continues.
                # The ladder existing is the whole mitigation for a datacenter IP.
                attempts.append(f"{backend}: {error.detail}")
                continue
            if rows:
                return _to_items(rows, query.query, backend)
            attempts.append(f"{backend}: returned no parseable results")

        raise SourceBlocked(
            "Every rung of the keyless search ladder failed or returned nothing. "
            "This is the expected symptom of a datacenter egress range: DuckDuckGo "
            "answers HTTP 202 with a challenge page rather than results. Tried — "
            + "; ".join(attempts)
        )

    def _ddg(self, query: SourceQuery) -> list[tuple[str, str, str]]:
        url = f"{_DDG_HTML_URL}?{urlencode({'q': query.query})}"
        return parse_ddg(get_text(url, accept="text/html"), query.limit)

    def _searxng(self, query: SourceQuery) -> list[tuple[str, str, str]]:
        if not self._searxng_url:
            raise SourceBlocked("no RESEARCH_SEARXNG_URL configured, so this rung is unavailable")
        url = f"{self._searxng_url}/search?{urlencode({'q': query.query, 'format': 'json'})}"
        payload = get_json(url, timeout=15)
        if not isinstance(payload, dict):
            return []
        rows: list[tuple[str, str, str]] = []
        for result in payload.get("results", []):
            if len(rows) >= query.limit:
                break
            if not isinstance(result, dict):
                continue
            target = str(result.get("url") or "")
            if not target.startswith("http"):
                continue
            rows.append((str(result.get("title") or ""), target, str(result.get("content") or "")))
        return rows
