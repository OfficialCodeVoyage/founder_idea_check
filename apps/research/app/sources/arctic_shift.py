# ─────────────────────────────────────────────────────────────────────────────
# WRITTEN HERE, not adapted. `ArthurHeitmann/arctic_shift` is `license: null`
# — all rights reserved — so not one line of its source appears in this file.
# Only its PUBLIC API is called, which its own README documents and invites.
# See THIRD_PARTY-research.md, "Arctic Shift source".
#
# API contract read from repos/ArthurHeitmann/arctic_shift @ api/README.md
# (2026-08-09) and verified live against the running service.
# ─────────────────────────────────────────────────────────────────────────────
"""Reddit history via the Arctic Shift archive.

WHY THIS IS THE ONLY REDDIT LANE. Reddit's own edge serves 403 to datacenter
egress ranges and to unauthenticated clients, and reading it anyway by picking
the endpoints that happen to answer is routing around an access control (see
`reddit_gate.py`). Arctic Shift is a THIRD-PARTY ARCHIVE with its own hosting and
a public API its operator invites people to call, so it answers the same
question from any IP without touching Reddit's servers for content. It is the
lane that survives being deployed.

WHAT IT CANNOT DO, stated up front because it shapes the whole adapter: there is
no global keyword search. `query` is documented as "Only in use with `author` or
`subreddit`". Searching all of Reddit for a phrase is not on offer at any price,
so this adapter REFUSES a query with no subreddits rather than quietly returning
the newest posts from nowhere in particular — an unscoped result would look like
a search that found little, when in fact no search happened.

THE USERNAME NEVER ENTERS THE PROCESS. Dropping `author` at parse time would
already keep it out of storage; this adapter does better: `fields` is a
documented request parameter, so the archive is asked for a field list that
excludes `author` entirely and the identifier is never received. That is the
strongest form of the rule — "delete my data" is answered by construction, not
by discipline.
"""

from __future__ import annotations

import time
from typing import Any
from urllib.parse import urlencode

from ..errors import (
    SourceError,
    SourceRateLimited,
    SourceSchemaDrift,
    SourceUnavailable,
)
from ..http import ARCTIC_SHIFT_LIMITER, get_json
from ..schema import SourceItem
from ..text.relevance import PreparedQuery, token_overlap_relevance
from .base import SourceDescriptor, SourceQuery

DESCRIPTOR = SourceDescriptor(
    id="arctic-shift",
    label="Reddit (Arctic Shift archive)",
    # The only Reddit lane that is honest to enable in hosted mode: it is not
    # Reddit's edge, so the datacenter-403 problem does not apply to it.
    enabled_in_hosted=True,
    enabled_in_self_host=True,
    gate_reason=(
        "Third-party public archive with a documented, keyless API its operator "
        "invites third parties to call. Queried with an explicit field list that "
        "excludes the author, so no Reddit username is ever received."
    ),
    required_credentials=(),
    # Below the live keyless lanes: the archive lags real time, so a brand-new
    # thread — the strongest demand signal there is — may simply not be in it yet.
    source_quality=0.6,
)

_BASE_URL = "https://arctic-shift.photon-reddit.com/api"
_POSTS_SEARCH = f"{_BASE_URL}/posts/search"
_TIMEOUT = 45

#: Documented ceiling is 1-100. Asking for more is a 400, not a truncation.
_MAX_LIMIT = 100

#: EXACTLY the fields this adapter reads, and `author` is deliberately not among
#: them. Sending this list is what keeps the username out of the process rather
#: than merely out of the output.
#:
#: `permalink` is NOT here because it is not selectable — the API answers a 400
#: naming the field, which is how this list was verified rather than assumed.
#: The thread URL is rebuilt from `subreddit` + `id`, which is also more correct
#: than the selectable `url`: for a LINK post `url` is the off-site target, so
#: citing it would send a founder to the article instead of the discussion.
_FIELDS = (
    "id",
    "title",
    "selftext",
    "score",
    "num_comments",
    "created_utc",
    "subreddit",
)

#: The archive reports overload BOTH ways: as a 200 whose body carries an error
#: string, and as a 422 with the same string. Either way it is a TRANSPORT
#: FAILURE, not an empty result set, and conflating the two is how a degraded
#: lane gets written into a report as "no demand for this idea".
# DO NOT DELETE THIS MACHINERY. It was slated for removal in the batch that
# added SearXNG, on the plan that self-hosting Arctic Shift would remove the
# need for retry, backoff and the overload sniffer. Self-hosting was then
# investigated and is NOT possible here: upstream's own README opens the usage
# section with "First download one or more dumps" and tells bulk users to "use
# the monthly dumps instead" of the API. Those dumps are 3.97 TB against 66 GB
# of free disk — the same wall the Reddit-dump corpus task hit, reached by a
# different road.
#
# So this adapter still calls the PUBLIC API, which still sheds load by
# answering 200 with {"error": "Timeout. Maybe slow down a bit"}. Removing the
# retry path would delete the handling for a condition that is still live.
_OVERLOAD_MARKERS = ("timeout", "slow down")

#: The archive is genuinely flaky under load — measured live, three identical
#: requests six seconds apart returned two successes and one overload, then all
#: three overloaded a few minutes later. Retrying is what makes this lane usable
#: rather than theoretically correct; NOT retrying would have meant an adapter
#: that is right about its failure and useless in practice.
_RETRY_BACKOFF_SECONDS = (2.0, 5.0, 11.0)


def _is_overload(text: str) -> bool:
    lowered = text.lower()
    return any(marker in lowered for marker in _OVERLOAD_MARKERS)


def _iso_from_epoch(created_utc: Any) -> tuple[str | None, str]:
    """Epoch seconds -> ISO date. Returns the date and its confidence."""
    try:
        seconds = float(created_utc)
    except (TypeError, ValueError):
        return None, "low"
    import datetime

    stamp = datetime.datetime.fromtimestamp(seconds, tz=datetime.UTC)
    return stamp.date().isoformat(), "high"


def build_search_url(
    *,
    subreddit: str,
    query: str,
    date_from: str,
    date_to: str,
    limit: int,
) -> str:
    """PURE. The documented parameter set, and nothing invented.

    `query` searches title and selftext together. `sort=desc` with `before`/
    `after` is what gives "the most recent N in this window" rather than the
    oldest posts in the archive.
    """
    params: dict[str, str] = {
        "subreddit": subreddit,
        "limit": str(max(1, min(limit, _MAX_LIMIT))),
        "sort": "desc",
        "fields": ",".join(_FIELDS),
    }
    if query.strip():
        params["query"] = query.strip()
    if date_from:
        params["after"] = date_from
    if date_to:
        params["before"] = date_to
    return f"{_POSTS_SEARCH}?{urlencode(params)}"


def _raise_for_payload_error(payload: Any, url: str) -> None:
    """The archive reports failure INSIDE a 200 body as often as by status."""
    if not isinstance(payload, dict):
        raise SourceSchemaDrift(
            f"Arctic Shift returned {type(payload).__name__}, not an object, from {url}."
        )
    error = payload.get("error")
    if not error:
        return
    text = str(error)
    if _is_overload(text):
        raise SourceRateLimited(
            f"Arctic Shift is shedding load: {text!r}. This is a transport "
            f"failure and must not be read as an empty result set."
        )
    raise SourceUnavailable(f"Arctic Shift refused {url}: {text!r}")


def parse_posts(payload: Any, prepared: PreparedQuery, url: str) -> list[SourceItem]:
    """PURE. Archive rows -> SourceItems, with no author to discard."""
    _raise_for_payload_error(payload, url)

    rows = payload.get("data")
    if rows is None:
        raise SourceSchemaDrift(
            f"Arctic Shift response from {url} has no 'data' key. Keys: {sorted(payload)[:8]}"
        )
    if not isinstance(rows, list):
        raise SourceSchemaDrift(
            f"Arctic Shift 'data' is {type(rows).__name__}, not a list, from {url}."
        )

    items: list[SourceItem] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        title = str(row.get("title") or "").strip()
        selftext = str(row.get("selftext") or "").strip()
        if not (title or selftext):
            continue

        post_id = str(row.get("id") or "").strip()
        subreddit = str(row.get("subreddit") or "").strip()
        if not (post_id and subreddit):
            # Without both there is no citable permalink, and an uncitable
            # finding is worse than a missing one — it renders with citation
            # machinery around a dead link.
            continue
        published_at, confidence = _iso_from_epoch(row.get("created_utc"))

        items.append(
            SourceItem(
                item_id="",  # assigned by the caller, after dedupe
                source=DESCRIPTOR.id,
                title=title,
                body=selftext,
                url=f"https://www.reddit.com/r/{subreddit}/comments/{post_id}/",
                # DELIBERATELY None, and this one is free: `author` was never
                # requested, so there is nothing here to drop. See the docstring.
                author=None,
                container=subreddit,
                published_at=published_at,
                date_confidence=confidence,
                # Unlike the RSS lane, the archive DOES carry engagement, so
                # these are real counts rather than zeros standing in for
                # unknowns.
                engagement={
                    "score": int(row.get("score") or 0),
                    "comments": int(row.get("num_comments") or 0),
                },
                relevance_hint=token_overlap_relevance(prepared, f"{title} {selftext}"),
                why_relevant="Reddit thread (archived)",
                snippet=(selftext or title)[:500],
                metadata={},
            )
        )
    return items


def _get_with_retry(url: str, *, sleep=time.sleep) -> Any:
    """One request, retried only while the archive says it is overloaded.

    ONLY overload is retried. A 400 (bad field), a 404 or a schema drift is a
    fact about the request that will not improve by asking again, and retrying
    it would turn a clear error into a slow one. `sleep` is injected so a test
    can drive the backoff without spending eleven seconds.
    """
    last: SourceError | None = None
    for attempt, backoff in enumerate((*_RETRY_BACKOFF_SECONDS, None)):
        try:
            payload = get_json(url, timeout=_TIMEOUT)
            # Inside the try on purpose: the archive reports overload in a 200
            # BODY as often as by status, so both forms must reach the same
            # retry decision. SourceRateLimited and SourceUnavailable are
            # SIBLINGS under SourceError, not parent and child — catching the
            # narrower one here would silently skip the body-reported case.
            _raise_for_payload_error(payload, url)
        except SourceError as error:
            if not _is_overload(error.detail):
                raise
            last = SourceRateLimited(
                f"Arctic Shift is shedding load (attempt {attempt + 1}): "
                f"{error.detail}"
            )
        else:
            return payload
        if backoff is None:
            break
        sleep(backoff)

    raise last or SourceRateLimited(f"Arctic Shift did not answer {url}.")


class ArcticShiftSource:
    descriptor = DESCRIPTOR

    def fetch(self, query: SourceQuery) -> list[SourceItem]:
        subreddits = query.options.get("subreddits") or []
        if not subreddits:
            # REFUSAL, not a silent unscoped search. `query` is documented as
            # working only alongside `author` or `subreddit`; without one this
            # would return the newest posts from nowhere in particular and read
            # as "we searched and found little".
            raise SourceUnavailable(
                "Arctic Shift cannot search all of Reddit for a phrase — its "
                "`query` parameter is documented as working only with a "
                "`subreddit` or `author`. Pass options['subreddits']; use the "
                "web-search lane to discover which subreddits to ask about."
            )

        prepared = PreparedQuery(query.query)
        collected: list[SourceItem] = []
        seen_urls: set[str] = set()
        failures: list[str] = []

        for subreddit in subreddits:
            url = build_search_url(
                subreddit=str(subreddit),
                query=query.query,
                date_from=query.date_from,
                date_to=query.date_to,
                limit=query.limit,
            )
            ARCTIC_SHIFT_LIMITER.acquire()
            try:
                payload = _get_with_retry(url)
                found = parse_posts(payload, prepared, url)
            except SourceError as error:
                # The BASE class, deliberately: SourceRateLimited is a sibling
                # of SourceUnavailable, not a subclass, so catching the narrower
                # one would let an exhausted-retry failure kill the whole lane
                # instead of being recorded against one subreddit. One subreddit
                # failing is not the lane failing; every subreddit failing is.
                failures.append(f"r/{subreddit}: {error.detail}")
                continue

            for item in found:
                if item.url in seen_urls:
                    continue
                seen_urls.add(item.url)
                collected.append(item)
            if len(collected) >= query.limit:
                break

        if not collected and failures and len(failures) == len(subreddits):
            raise SourceUnavailable(
                "Every Arctic Shift request failed, so this is a source outage "
                "rather than a topic with no discussion. Tried — " + "; ".join(failures)
            )

        for index, item in enumerate(collected, start=1):
            item.item_id = f"A{index}"
        return collected[: query.limit]
