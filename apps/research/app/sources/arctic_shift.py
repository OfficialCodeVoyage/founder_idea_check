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
no global keyword search. The keyword parameters are documented as "Only in use
with `author` or `subreddit`". Searching all of Reddit for a phrase is not on offer at any price,
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

import re
import time
from collections.abc import Callable
from typing import Any
from urllib.parse import urlencode

from ..errors import (
    SourceBlocked,
    SourceError,
    SourceRateLimited,
    SourceSchemaDrift,
    SourceUnavailable,
)
from ..http import ARCTIC_SHIFT_LIMITER, RateLimiter, get_json
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

# ── TIME. One dead lane must not eat a research run. ─────────────────────────
#
# Live QA (2026-11-12): the archive answered 429 or 422 for every subreddit of a
# parent-buyer run, and the old policy (three retries at 2+5+11 s, 45 s request
# timeout, four subreddits in turn) added about a minute to every search step
# of a deep-research run whose whole budget is 290 s. Measured the same day
# through this sidecar: one two-word query on r/Parenting took 16 s end to end.
#
#: The whole lane, every subreddit and every wait included. Below the 30 s the
#: app gives one search step (`SEARCH_STEP_TIMEOUT_MS` in
#: apps/chat/tools/platform/deep-research/research-clock.ts), so this lane
#: always reports its own outcome rather than being cut off by the caller.
_LANE_WALL_TIME_SECONDS = 25.0
#: One archive request. Above the 16 s measured for a real query, so a slow
#: but working archive still answers.
_REQUEST_TIMEOUT_SECONDS = 20.0
#: A request with less time than this left is not sent: it could not finish.
_MIN_REQUEST_SECONDS = 3.0
#: A 429 is retried once, after the wait the archive asked for, but only when
#: that wait is at most this long; asking again sooner than told is impolite and
#: pointless, and a longer wait does not fit the lane.
_MAX_RETRY_WAIT_SECONDS = 5.0
#: The wait before that one retry when the archive names none.
_DEFAULT_RETRY_WAIT_SECONDS = 2.0

# ── THE QUERY. Arctic Shift matches keywords, not web-search strings. ────────
#
# The researcher writes queries for a web search engine: seventeen words, a
# `site:reddit.com`, quoted phrases, a "£", country names. The archive matches
# every word it is given (live probe: that seventeen-word query on r/Parenting
# returned 0 posts; "reluctant readers" returned 2), so a long query asks for a
# post that contains all of it, which none does. `keyword_query` keeps the few
# words a post would actually contain.
#
#: Two, not three: each extra word is another AND term inside one subreddit and
#: one year, and the sidecar still scores relevance against the FULL query.
_MAX_KEYWORDS = 2

#: `site:reddit.com`, `intitle:x`, `-exclude`, `OR` — search-engine syntax the
#: archive would read as words.
_OPERATOR_TOKEN = re.compile(r"^(-.+|[A-Za-z]+:.*|OR|AND|NOT)$")
_WORD = re.compile(r"[a-z]+(?:'[a-z]+)?")
#: U+2019 RIGHT SINGLE QUOTATION MARK, which phones type for an apostrophe.
_CURLY_APOSTROPHE = chr(0x2019)

_STOPWORDS = frozenset(
    (
        "a", "about", "after", "also", "an", "and", "any", "are", "as", "at",
        "be", "been", "but", "by", "can", "could", "do", "does", "for", "from",
        "get", "had", "has", "have", "how", "i", "if", "in", "into", "is", "it",
        "its", "just", "like", "many", "may", "me", "more", "most", "much",
        "my", "no", "not", "of", "on", "or", "other", "our", "over", "should",
        "so", "some", "such", "than", "that", "the", "their", "them", "then",
        "there", "these", "they", "this", "those", "to", "too", "under", "up",
        "us", "vs", "versus", "was", "we", "what", "when", "where", "which",
        "while", "who", "why", "will", "with", "without", "would", "you",
        "your",
    )
)  # fmt: skip

#: Words that steer a web search engine but that a Reddit post does not
#: contain, or that every post in a topical subreddit contains. Dropping them
#: is what turns a web query into a keyword query.
_BOILERPLATE = frozenset(
    (
        # Search-engine framing.
        "reddit", "site", "forum", "forums", "thread", "threads", "discussion",
        "discussions", "post", "posts", "review", "reviews", "complaint",
        "complaints", "price", "prices", "pricing", "cost", "costs", "survey",
        "surveys", "report", "reports", "pdf", "study", "studies",
        "statistics", "stats", "data", "research", "market", "best", "top",
        "alternative", "alternatives", "guide", "example", "examples",
        # Words every post in a subreddit chosen for this buyer already shares.
        "people", "person", "parent", "parents", "user", "users", "customer",
        "customers", "struggling", "struggle", "struggles", "problem",
        "problems", "issue", "issues", "help", "advice", "experience",
        "experiences", "year", "years", "old", "age", "aged", "child",
        "children", "kid", "kids",
        # Geography, which a web engine uses to localise and a post rarely names.
        "uk", "usa", "america", "american", "australia", "canada", "new",
        "zealand", "ireland", "india", "europe",
    )
)  # fmt: skip


def keyword_query(query: str) -> str:
    """PURE. The researcher's web-search string, cut to what the archive can match.

    Search operators and quotes go first, then stopwords and web-search
    boilerplate, then everything after the first `_MAX_KEYWORDS` content words.
    If that leaves nothing, the first non-stopwords are used rather than none:
    an empty `query` would make the archive return the newest posts in the
    subreddit, which reads as a search that found little.
    """
    kept_tokens = [
        token for token in query.split() if not _OPERATOR_TOKEN.match(token.strip("\"'"))
    ]
    words = _WORD.findall(" ".join(kept_tokens).lower().replace(_CURLY_APOSTROPHE, "'"))
    plain = [word for word in words if len(word) > 1 and word not in _STOPWORDS]

    chosen: list[str] = []
    for word in plain:
        if word not in _BOILERPLATE and word not in chosen:
            chosen.append(word)
    if not chosen:
        chosen = list(dict.fromkeys(plain))
    return " ".join(chosen[:_MAX_KEYWORDS])


#: Documented ceiling is 1-100. Asking for more is a 400, not a truncation.
_MAX_LIMIT = 100

# ── WHICH KEYWORD PARAMETER. `title`, not `query`. ───────────────────────────
#
# The README lists `query` ("Search in both `title` and `selftext`") beside
# `title`, `selftext` and `link_flair_text`. Live probes against the public API
# (2026-11-12, six requests in all, generic queries, nothing stored), every one
# of them `subreddit=Parenting` unless noted, `limit=5&sort=desc` and this
# adapter's own `fields` list:
#
#   query=early reading, one-year window   HTTP 422 in 0.4 s  {"data":null,"error":"Timeout. Maybe slow down a bit"}
#   the same request again                 HTTP 422 in 0.5 s  (same body)
#   query=early reading, 30-day window     HTTP 422 in 0.6 s  (same body)
#   query=early reading, r/kindergarten    HTTP 422 in 0.5 s  (same body)
#   NO keyword, 7-day window               HTTP 200 in 1.7 s  (five posts)
#   title=early reading, one-year window   HTTP 200 in 4.9 s  (five matching posts)
#
# So the rejection is about the `query` parameter and nothing else in the
# request: the same subreddit, window, limit, sort and field list are answered
# when the keyword is sent as `title`, which is also the parameter the README's
# own search example uses. The body's "Timeout... slow down" wording is not what
# happened: a real timeout or a rate limit does not answer in half a second
# while a keyword-free request to the same host is served within the same
# minute. The archive documents a rate limit as HTTP 429.
#
# THE COST: `title` matches the title only, where `query` was meant to match the
# title and the selftext. A thread whose title lacks the words but whose body
# has them is no longer found by this lane. Relevance is still scored against the
# title AND the body of whatever comes back (`parse_posts`). `selftext` is a
# documented keyword parameter too, but it was not among the probes, so it is not
# used: sending both would AND them, and a second request per subreddit would
# double a lane that has a 25 s wall time.
_KEYWORD_PARAMETER = "title"

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

#: The archive reports overload as a 200 whose body carries an error string
#: (a 429 is the other documented form, handled by status). That is a TRANSPORT
#: FAILURE, not an empty result set, and conflating the two is how a degraded
#: lane gets written into a report as "no demand for this idea". The same string
#: also arrives with a 422, but a 422 is NOT overload: see `_normalise`.
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
#
# The retry is now ONE retry, for a 429 or a body-reported overload only (see
# `_get_with_retry`): three retries at 2+5+11 s per subreddit is what let a
# rate-limited archive eat a minute of every research step.
_OVERLOAD_MARKERS = ("timeout", "slow down")


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

    The keywords go in `title` (see `_KEYWORD_PARAMETER`: the archive answers
    `query` with a 422). `sort=desc` with `before`/`after` is what gives "the
    most recent N in this window" rather than the oldest posts in the archive.
    """
    params: dict[str, str] = {
        "subreddit": subreddit,
        "limit": str(max(1, min(limit, _MAX_LIMIT))),
        "sort": "desc",
        "fields": ",".join(_FIELDS),
    }
    if query.strip():
        params[_KEYWORD_PARAMETER] = query.strip()
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


class _LaneOutOfTime(Exception):
    """Not a source failure: this lane's own time limit, reached before asking.

    Deliberately NOT a SourceError, so it can never be mistaken for something the
    archive said. `fetch` turns it into a plain "not asked" line.
    """


def _normalise(error: SourceError) -> tuple[SourceError, bool]:
    """PURE. The failure in plain words, and whether asking once more can help.

    - 403 (`SourceBlocked`): kept AS BLOCKED, not retryable. The host refused this
      server (typically a datacenter egress range), which is a fact about where
      the sidecar runs and not about the query; rewording it as "rejected the
      query" would send an operator to fix a query that is fine. See
      `errors.py::SourceBlocked`.
    - 429, or overload reported in a 200 body: RATE-LIMITED, retryable once.
    - Any other 4xx: not retryable, because the archive has decided about this
      request: it REJECTED THE QUERY. The status decides, not the body's
      wording. The archive documents a rate limit as 429. A 422 carrying
      "Timeout. Maybe slow down a bit" was answered in under a second while a
      keyword-free request to the same host was served within the same minute
      (`_KEYWORD_PARAMETER`), so it is the archive refusing a request it cannot
      process, not asking us to wait. Reading it as a rate limit sent the
      founder to wait out a problem that waiting cannot fix, and made the lane
      stop asking its other subreddits.
    - Anything else (5xx, network, timeout, schema drift): as raised, no retry.
    """
    if isinstance(error, SourceBlocked):
        return error, False
    status = error.status
    if status == 429 or (status is None and isinstance(error, SourceRateLimited)):
        limited = SourceRateLimited(f"rate-limited ({error.detail})")
        limited.status, limited.retry_after = status, error.retry_after
        return limited, True
    if status is not None and 400 <= status < 500:
        cause = (
            "an unprocessable request, not a rate limit: the archive answers a "
            "rate limit with HTTP 429"
            if status == 422
            else "a request the archive will not process"
        )
        rejected = SourceUnavailable(f"rejected the query (HTTP {status}, {cause}): {error.detail}")
        rejected.status = status
        return rejected, False
    return error, False


def _get_with_retry(
    url: str,
    *,
    deadline: float,
    clock: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], None] = time.sleep,
    limiter: RateLimiter = ARCTIC_SHIFT_LIMITER,
) -> Any:
    """One request, plus at most ONE retry, and never past `deadline`.

    Only a rate limit is retried (see `_normalise`): a 400, a 404, a 422 or a
    schema drift is a fact about the request that will not improve by asking
    again. The retry waits for what the archive asked (`Retry-After` or
    `X-RateLimit-Reset`), and is skipped when that is longer than
    `_MAX_RETRY_WAIT_SECONDS` or would not leave time for the request itself.

    Every attempt goes through `limiter`, so a retry is paced like a first
    request: the 1 request/second politeness limit holds either way.
    `clock`, `sleep` and `limiter` are injected so a test never waits.
    """
    for attempt in (1, 2):
        remaining = deadline - clock()
        if remaining < _MIN_REQUEST_SECONDS or not limiter.acquire(
            max_wait=remaining - _MIN_REQUEST_SECONDS
        ):
            raise _LaneOutOfTime
        timeout = min(_REQUEST_TIMEOUT_SECONDS, deadline - clock())
        try:
            payload = get_json(url, timeout=timeout)
            # Inside the try on purpose: the archive reports overload in a 200
            # BODY as often as by status, so both forms must reach the same
            # retry decision. SourceRateLimited and SourceUnavailable are
            # SIBLINGS under SourceError, not parent and child — catching the
            # narrower one here would silently skip the body-reported case.
            _raise_for_payload_error(payload, url)
        except SourceError as error:
            failure, retryable = _normalise(error)
        else:
            return payload

        if attempt == 2 or not retryable:
            raise failure
        wait = _DEFAULT_RETRY_WAIT_SECONDS if failure.retry_after is None else failure.retry_after
        if wait > _MAX_RETRY_WAIT_SECONDS or clock() + wait + _MIN_REQUEST_SECONDS > deadline:
            raise failure
        sleep(wait)

    raise AssertionError("unreachable: the second attempt returns or raises")


class ArcticShiftSource:
    descriptor = DESCRIPTOR

    def fetch(
        self,
        query: SourceQuery,
        *,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
        limiter: RateLimiter = ARCTIC_SHIFT_LIMITER,
    ) -> list[SourceItem]:
        subreddits = query.options.get("subreddits") or []
        if not subreddits:
            # REFUSAL, not a silent unscoped search. The keyword parameters are
            # documented as working only alongside `author` or `subreddit`;
            # without one this would return the newest posts from nowhere in
            # particular and read as "we searched and found little".
            raise SourceUnavailable(
                "Arctic Shift cannot search all of Reddit for a phrase — its "
                "keyword parameters are documented as working only with a "
                "`subreddit` or `author`. Pass options['subreddits']; use the "
                "web-search lane to discover which subreddits to ask about."
            )

        keywords = keyword_query(query.query)
        if not keywords:
            raise SourceUnavailable(
                f"Arctic Shift was not asked: the query {query.query!r} has no word "
                "the archive could match, and an empty query would return the "
                "newest posts rather than a search."
            )

        # Relevance is still scored against the researcher's FULL query: the
        # keywords decide what the archive returns, not how well it fits.
        prepared = PreparedQuery(query.query)
        collected: list[SourceItem] = []
        seen_urls: set[str] = set()
        # One plain line per subreddit, for the founder-facing lane report.
        outcomes: list[str] = []
        # Which of "blocked", "rate-limited", "rejected", "out of time", "failed"
        # happened.
        problems: set[str] = set()
        deadline = clock() + _LANE_WALL_TIME_SECONDS
        stop_reason: str | None = None

        for subreddit in subreddits:
            if stop_reason is not None:
                outcomes.append(f"r/{subreddit}: not asked ({stop_reason})")
                continue
            url = build_search_url(
                subreddit=str(subreddit),
                query=keywords,
                date_from=query.date_from,
                date_to=query.date_to,
                limit=query.limit,
            )
            try:
                payload = _get_with_retry(
                    url, deadline=deadline, clock=clock, sleep=sleep, limiter=limiter
                )
                found = parse_posts(payload, prepared, url)
            except _LaneOutOfTime:
                problems.add("out of time")
                stop_reason = f"this lane's {_LANE_WALL_TIME_SECONDS:.0f} s limit ran out"
                outcomes.append(f"r/{subreddit}: not asked ({stop_reason})")
                continue
            except SourceRateLimited as error:
                # Asking the next subreddit of a host that is rate-limiting us
                # would be refused too, and would be the opposite of polite.
                problems.add("rate-limited")
                stop_reason = "the archive was already rate-limiting this lane"
                outcomes.append(f"r/{subreddit}: {error.detail}")
                continue
            except SourceError as error:
                # The BASE class, deliberately: one subreddit failing is not the
                # lane failing, and a narrower catch would let another sibling
                # of SourceError kill the lane and discard what was collected.
                status = error.status
                if isinstance(error, SourceBlocked):
                    problems.add("blocked")
                elif status is not None and 400 <= status < 500:
                    problems.add("rejected")
                else:
                    problems.add("failed")
                outcomes.append(f"r/{subreddit}: {error.detail}")
                continue

            outcomes.append(f"r/{subreddit}: answered, {len(found)} matching posts")
            for item in found:
                if item.url in seen_urls:
                    continue
                seen_urls.add(item.url)
                collected.append(item)
            if len(collected) >= query.limit:
                break

        if not collected and problems:
            # NEVER an empty list here. Nothing came back AND part of the lane
            # was not searched, so "found nothing" would be a claim about
            # subreddits nobody looked at.
            raise _lane_failure(keywords, problems, outcomes)

        for index, item in enumerate(collected, start=1):
            item.item_id = f"A{index}"
        return collected[: query.limit]


_PROBLEM_WORDS = {
    "blocked": "refused this server (HTTP 403: a blocked host, not a bad query)",
    "rate-limited": "rate-limited this lane",
    "rejected": "rejected the query",
    "failed": "failed to answer",
    "out of time": "ran past this lane's time limit",
}


def _lane_failure(keywords: str, problems: set[str], outcomes: list[str]) -> SourceError:
    """PURE. The lane's failure, headline first, in words a founder can read.

    `blocked` when any subreddit was answered with a 403: that is the remedy that
    matters (run the sidecar from another network), and waiting cannot fix it, so
    it outranks a rate limit seen alongside it. `rate-limited` when every problem
    was a rate limit or the lane's own time limit (asking later can help);
    `unavailable` otherwise.
    """
    words = [_PROBLEM_WORDS[key] for key in _PROBLEM_WORDS if key in problems]
    detail = (
        f"Arctic Shift {' and '.join(words)}, so Reddit was not searched in full: "
        f"this is not a finding that nobody discusses the topic. Searched for "
        f"{keywords!r}. " + "; ".join(outcomes)
    )
    if "blocked" in problems:
        return SourceBlocked(detail)
    if problems <= {"rate-limited", "out of time"}:
        return SourceRateLimited(detail)
    return SourceUnavailable(detail)
