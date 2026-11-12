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

import datetime
import logging
import re
import threading
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

# ── LOAD. Ask the archive as little, and as politely, as a search can. ───────
#
# Live QA, second run (2026-11-12): with the keyword sent as `title`, 14 of 16
# subreddit requests in two of a run's three searches were answered HTTP 422
# {"data":null,"error":"Timeout. Maybe slow down a bit"}, and later requests
# HTTP 429 "Too many requests". Each search step runs TWO queries at once, and
# each asked FOUR subreddits, so a run sent the archive up to 8 keyword searches
# at a time.
#
#: At most this many subreddits are asked per call ONCE A SUBREDDIT HAS FOUND
#: POSTS OR ANY PROBLEM HAS BEEN SEEN. The app lists them best-fit first, so the
#: ones left out are the least relevant. A timeout and a 429 are never repeated
#: and each ends the call, so while the archive is failing two queries per step
#: make at most four requests a step (one per subreddit), down from eight. No
#: request is repeated (`_get_payload`).
#:
#: The cap does NOT apply while every subreddit asked so far answered cleanly
#: and had nothing: the archive is then not overloaded, and stopping would turn
#: "the archive answered, and there is nothing" into a failure (a lane that
#: "was not searched in full") for the researcher and the founder. The rest are
#: asked, with the same spacing and the same pause check, so an empty result
#: really means the whole lane found nothing and is returned as `[]`.
_MAX_SUBREDDITS_PER_CALL = 2
#: A pause between one subreddit's request and the next, on top of the
#: 1 request/second limiter in `app/http.py`.
_SUBREDDIT_SPACING_SECONDS = 2.0
#: After a 429 the whole lane stays quiet for the wait the archive asked for
#: (`Retry-After` / `X-RateLimit-Reset`, which it reports per minute), or this
#: long when it names none, and never longer than the cap: other searches of the
#: same run, and the other query of the same step, must not keep asking an
#: archive that has just said it is receiving too many requests.
_COOLDOWN_DEFAULT_SECONDS = 30.0
_COOLDOWN_MAX_SECONDS = 60.0
#: After a timeout (HTTP 422, or the same words in the body of a 200) the lane
#: stays quiet for this long, below the cap. The archive named no wait and a
#: timeout is a slow search, not a refusal, so this is shorter than the 429
#: default; it still outlasts the other query of the same step, which would
#: otherwise ask the next subreddit about two seconds later. A search that times
#: out is not retried (see `_normalise`): live, the one retry over the last 30
#: days timed out again 5 times out of 5.
_TIMEOUT_COOLDOWN_SECONDS = 20.0

#: The two reasons the lane can be paused, which are also the keys the lane
#: report uses for them in `_PROBLEM_WORDS`.
_RATE_LIMITED = "rate-limited"
_TIMED_OUT = "timed out"

#: Raw URLs and response bodies go HERE, to the sidecar's log, and never into an
#: error's `detail`: that sentence is shown to the founder in the lane report.
log = logging.getLogger("research.arctic_shift")


class _Cooldown:
    """When the lane may ask the archive again, on the injected clock, and why.

    SHARED BY THREADS, NOT BY COROUTINES: `app/main.py::fetch_signals` is a plain
    `def` route, so FastAPI runs each call in its own worker thread and the two
    queries of one search step really do run at once. `start` reads and then
    writes `until`, so it holds a lock; a lost update would shorten a pause.
    """

    def __init__(self) -> None:
        self.until = 0.0
        #: `_RATE_LIMITED` or `_TIMED_OUT`: why the pause that ends last began.
        self.reason = _RATE_LIMITED
        self._lock = threading.Lock()

    def remaining(self, now: float) -> float:
        return max(0.0, self.until - now)

    def start(self, now: float, seconds: float | None, reason: str) -> None:
        wait = _COOLDOWN_DEFAULT_SECONDS if seconds is None else seconds
        ends = now + min(max(wait, 1.0), _COOLDOWN_MAX_SECONDS)
        with self._lock:
            if ends > self.until:
                self.until = ends
                self.reason = reason


ARCTIC_SHIFT_COOLDOWN = _Cooldown()

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
        # Research framing: how a researcher words what they want to learn, which
        # a Reddit title rarely contains. Live QA sent `title=perspectives home`
        # for "parent perspectives home reading ...": `parent` was dropped, and the
        # first two words left were one topic word and one piece of framing.
        "perspective", "perspectives", "insight", "insights", "opinion",
        "opinions", "view", "views", "attitude", "attitudes", "trend", "trends",
        "challenge", "challenges", "need", "needs", "solution", "solutions",
        "option", "options", "tip", "tips", "strategy", "strategies",
        "approach", "approaches", "way", "ways", "factor", "factors",
        "behavior", "behaviors", "behaviour", "behaviours", "pattern",
        "patterns",
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
# `title`, `selftext` and `link_flair_text`. First live probes against the public
# API (2026-11-12, six requests in all, generic queries, nothing stored), every one
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
# WHAT THAT DID NOT SETTLE (second live run, and four more probes the same day,
# `title=reluctant readers`, r/Parenting, `limit=5`):
#
#   30-day window, after 40 minutes with no request   HTTP 200 in 5.9 s  (no posts)
#   one-year window, 44 s later                       HTTP 422 in 0.4 s  (the body above)
#   one-year window, 85 s after that                  HTTP 422 in 0.5 s
#   30-day window, 2 s after that                     HTTP 422 in 0.4 s
#
# and the run's own requests: 14 of 16 answered 422 with that body (about 6 s
# each), later ones 429 "Too many requests". Then a third live run (2026-11-12,
# 15 failed requests in about 90 s, 13 of them that 422 body): the lane retried
# every timed-out search once over the most recent 30 days, and all 5 of those
# retries timed out again. With the one back-to-back probe above that is 6
# shorter-window retries, 0 answered, so the retry was REMOVED: it only added
# load to an archive that was already timing out. So `title` is NOT immune, a
# shorter window does not rescue it, and the first sample's
# verdict (query refused, title answered) cannot be separated from WHEN each
# request was made: the archive sheds keyword searches with this body whatever
# the parameter. `title` stays because it is the parameter the README's own
# example uses and it was answered 2 times in 6, `query` 0 times in 4; that is
# all the evidence there is. What the lane can and does control is how often it
# asks (`_MAX_SUBREDDITS_PER_CALL`, `_SUBREDDIT_SPACING_SECONDS`, the pause after
# a 429 or a timeout) and what it says when the archive refuses (`_normalise`). The
# archive documents a rate limit as HTTP 429 and says of its own "Query timed
# out" that the cause is a parameter combination it has not optimised.
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

#: The archive reports a timeout of its own keyword search either as HTTP 422 or as
#: a 200 whose body carries an error string (a 429 is its documented rate limit,
#: handled by status). Both are a TRANSPORT FAILURE, not an empty result set, and
#: conflating either with one is how a degraded lane gets written into a report as
#: "no demand for this idea". The body wording is the same in both forms, so both
#: are one condition, `_UpstreamTimeout`. A 422 counts only when its BODY says so:
#: see `_normalise`.
# DO NOT DELETE THIS DETECTION. The sniffer, the classification and the lane pause
# it feeds were slated for removal in the batch that added SearXNG, on the plan
# that self-hosting Arctic Shift would remove the need for retry, backoff and the
# overload sniffer. Self-hosting was then investigated and is NOT possible here:
# upstream's own README opens the usage section with "First download one or more
# dumps" and tells bulk users to "use the monthly dumps instead" of the API. Those
# dumps are 3.97 TB against 66 GB of free disk — the same wall the Reddit-dump
# corpus task hit, reached by a different road.
#
# So this adapter still calls the PUBLIC API, which still sheds load by answering
# {"error": "Timeout. Maybe slow down a bit"}. Removing the detection would delete
# the handling for a condition that is still live.
#
# What is gone is the REPEAT. Three retries at 2+5+11 s per subreddit let a
# rate-limited archive eat a minute of every research step; the one retry that
# replaced them for a body-reported timeout sent 2 requests per call and started
# no pause (code-review probe: two calls, 4 requests, pause still 0), and the same
# retry of a 422 timeout failed 5 times out of 5 live. No request is repeated
# now: a timeout in either form ends the call and starts the lane-wide pause
# (`fetch`).
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
    """The archive reports failure INSIDE a 200 body as often as by status.

    The `detail` of what it raises is a sentence for the founder; the URL and
    the archive's own words go to the log (`log`).
    """
    if not isinstance(payload, dict):
        log.warning("Arctic Shift returned %s, not an object: %s", type(payload).__name__, url)
        raise SourceSchemaDrift("the archive answered in a shape this adapter does not know")
    error = payload.get("error")
    if not error:
        return
    text = str(error)
    log.warning("Arctic Shift reported an error in a 200 body: %r for %s", text, url)
    if _is_overload(text):
        raise _UpstreamTimeout(
            "the archive could not run the search in time (a timeout on its side, "
            "reported in the body of its answer and not as an empty result): it is "
            "busy or slowing this server down, which a different query will not fix"
        )
    raise _ArchiveReportedError("the archive reported an error instead of posts")


def parse_posts(payload: Any, prepared: PreparedQuery, url: str) -> list[SourceItem]:
    """PURE. Archive rows -> SourceItems, with no author to discard."""
    _raise_for_payload_error(payload, url)

    rows = payload.get("data")
    if rows is None:
        log.warning(
            "Arctic Shift response has no 'data' key (keys %s): %s", sorted(payload)[:8], url
        )
        raise SourceSchemaDrift("the archive's answer had no list of posts in it")
    if not isinstance(rows, list):
        log.warning("Arctic Shift 'data' is %s, not a list: %s", type(rows).__name__, url)
        raise SourceSchemaDrift("the archive's answer had no list of posts in it")

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


class _UpstreamTimeout(SourceUnavailable):
    """The archive's own search timed out: HTTP 422 with a "Timeout" body, or a 200
    whose body says "Timeout. Maybe slow down a bit".

    Still `unavailable` on the wire (`errors.py::SourceUnavailable` is documented
    as "network error, DNS failure, timeout, or a 5xx"); its own class so the
    lane can name it, and so `fetch` can end the call and pause the lane. Both
    forms are this one class on purpose: they are one condition and the lane
    treats them alike.
    """


class _ArchiveReportedError(SourceUnavailable):
    """The archive answered 200 with an `error` string that is not an overload.

    Its own class so `_normalise` can keep what it means (the archive answered,
    and what it sent was an error, not posts) instead of folding it into "could
    not be reached", and so the lane report can say so. Its `detail` is already a
    sentence for the founder: no URL and no body.
    """


def _normalise(error: SourceError, url: str) -> SourceError:
    """The failure in plain words.

    EVERY `detail` THIS RETURNS IS A SENTENCE FOR THE FOUNDER. The raw error
    from `http.py` carries the request URL and the start of the response body,
    and its `detail` is shown verbatim in the lane report; both are logged here
    instead and never leave the process. Nothing here is retried: see the comment
    above `_OVERLOAD_MARKERS`.

    - 403 (`SourceBlocked`): kept AS BLOCKED. The host refused this server
      (typically a datacenter egress range), which is a fact about where the
      sidecar runs and not about the query; rewording it as "rejected the query"
      would send an operator to fix a query that is fine. See
      `errors.py::SourceBlocked`.
    - 429: RATE-LIMITED. The archive has said it is receiving too many requests;
      the lane starts its cool-down (`fetch`) and stops.
    - A timeout, in either of the two forms the archive uses (`_UpstreamTimeout`):
      * HTTP 422 whose BODY says "Timeout" (the body, `SourceError.body`, and not
        the whole `detail`: that holds the request URL, and the URL holds the
        query's words). Live QA (2026-11-12) saw this on 13 to 14 of every 16
        requests in a run (about 6 s each), and probes saw it after 0.4 to 0.5 s
        (`_KEYWORD_PARAMETER`): the archive's keyword search is slow or being shed
        on ITS side. That is neither a bad request (a 422 reads "unprocessable")
        nor a rate limit (the archive documents that as a 429).
      * A 200 whose body says the same (`_raise_for_payload_error` already
        raised `_UpstreamTimeout`; its `detail` is kept).
      Neither is retried: the one retry this used to make, over the last 30 days,
      timed out again 5 times out of 5 live, so it only added load to an archive
      that was already struggling. `fetch` ends the call and pauses the whole lane.
    - Any other 4xx, including a 422 that does not say Timeout: REJECTED THE
      QUERY: the archive has decided about this request.
    - A 200 body with an error that is not a timeout (`_ArchiveReportedError`):
      kept as what it is.
    - Anything else (5xx, network, timeout, schema drift): the class it was, in
      plain words.
    """
    status = error.status
    log.warning("Arctic Shift request failed (status %s): %s | %s", status, error.detail, url)

    if isinstance(error, SourceBlocked):
        blocked = SourceBlocked(
            "the archive refused this server (HTTP 403): the host is blocked from where "
            "the sidecar runs, which a different query will not fix"
        )
        blocked.status = status
        return blocked
    if status == 429:
        asked = error.retry_after
        pause = f", and asked for a pause of {asked:.0f} s" if asked is not None else ""
        limited = SourceRateLimited(
            f"rate-limited (the archive said it is receiving too many requests{pause})"
        )
        limited.status, limited.retry_after = status, asked
        return limited
    if status == 422 and _is_overload(error.body or ""):
        timed_out = _UpstreamTimeout(
            "the archive could not run the search in time (HTTP 422, a timeout on its side): "
            "it is busy or slowing this server down, which a different query will not fix"
        )
        timed_out.status = status
        return timed_out
    if status is not None and 400 <= status < 500:
        why = (
            "the archive could not process this request"
            if status == 422
            else "the archive will not process this request"
        )
        rejected = SourceUnavailable(f"rejected the query (HTTP {status}): {why}")
        rejected.status = status
        return rejected
    if isinstance(error, _UpstreamTimeout | _ArchiveReportedError):
        return error
    if isinstance(error, SourceSchemaDrift):
        return SourceSchemaDrift("the archive answered in a shape this adapter does not know")
    unavailable = SourceUnavailable(
        f"the archive answered HTTP {status}"
        if status is not None
        else "the archive could not be reached, or did not answer in time"
    )
    unavailable.status = status
    return unavailable


def _get_payload(
    url: str,
    *,
    deadline: float,
    clock: Callable[[], float] = time.monotonic,
    limiter: RateLimiter = ARCTIC_SHIFT_LIMITER,
) -> Any:
    """ONE request, never repeated, and never past `deadline`.

    A 400, a 404, a 429, a timeout (HTTP 422 or a 200 body, see `_normalise`) or a
    schema drift is a fact about the request or the archive that will not improve
    by asking again, and asking again adds load to an archive that is already
    shedding it. A request with too little time left is not sent
    (`_LaneOutOfTime`).

    The request goes through `limiter`, so the 1 request/second politeness limit
    holds. `clock` and `limiter` are injected so a test never waits.
    """
    remaining = deadline - clock()
    if remaining < _MIN_REQUEST_SECONDS or not limiter.acquire(
        max_wait=remaining - _MIN_REQUEST_SECONDS
    ):
        raise _LaneOutOfTime
    timeout = min(_REQUEST_TIMEOUT_SECONDS, deadline - clock())
    try:
        payload = get_json(url, timeout=timeout)
        # Inside the try on purpose: the archive reports a timeout in a 200 BODY
        # as often as by status, so both forms must be classified the same way.
        _raise_for_payload_error(payload, url)
    except SourceError as error:
        raise _normalise(error, url) from error
    return payload


class ArcticShiftSource:
    descriptor = DESCRIPTOR

    def fetch(
        self,
        query: SourceQuery,
        *,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
        limiter: RateLimiter = ARCTIC_SHIFT_LIMITER,
        cooldown: _Cooldown = ARCTIC_SHIFT_COOLDOWN,
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

        # STOP EARLY ON A 429 OR A TIMEOUT, for the whole lane and not just this
        # call: after the archive said it is receiving too many requests, or its
        # search timed out, the other query of the same step and the run's later
        # searches do not ask it until the pause is over.
        left = cooldown.remaining(clock())
        if left > 0:
            raise _paused(cooldown.reason, left)

        # Relevance is still scored against the researcher's FULL query: the
        # keywords decide what the archive returns, not how well it fits.
        prepared = PreparedQuery(query.query)
        collected: list[SourceItem] = []
        seen_urls: set[str] = set()
        # One plain line per subreddit, for the founder-facing lane report.
        outcomes: list[str] = []
        # Which of "blocked", "rate-limited", "timed out", "rejected", "errored",
        # "out of time", "capped", "failed" happened. Every one of them means part
        # of the lane was not searched in full.
        problems: set[str] = set()
        deadline = clock() + _LANE_WALL_TIME_SECONDS
        stop_reason: str | None = None

        # The first `_MAX_SUBREDDITS_PER_CALL` are always asked. Past that the rest
        # are asked only while every subreddit so far answered cleanly with no posts
        # (no `collected`, no `problems`): then nothing says the archive is
        # struggling, and an empty answer from two of four subreddits is not yet an
        # answer for the lane. A hit or any problem is the moment to stop and say so.
        asked = 0
        for subreddit in subreddits:
            if (
                stop_reason is None
                and asked >= _MAX_SUBREDDITS_PER_CALL
                and (collected or problems)
            ):
                stop_reason = (
                    f"at most {_MAX_SUBREDDITS_PER_CALL} subreddits are asked per search "
                    "once one has found posts or failed"
                )
                # Left out, not searched and found empty: see the end of this method.
                problems.add("capped")
            if stop_reason is not None:
                outcomes.append(f"r/{subreddit}: not asked ({stop_reason})")
                continue
            if asked > 0 and deadline - clock() > _SUBREDDIT_SPACING_SECONDS + _MIN_REQUEST_SECONDS:
                sleep(_SUBREDDIT_SPACING_SECONDS)
            # RE-CHECK THE PAUSE BEFORE EVERY REQUEST, not only when the call starts.
            # The two queries of a step run at the same time, in two threads, and
            # the pause above can have been started by the other one while this call
            # waited its two seconds: asking the next subreddit then would send the
            # archive a request that the lane has just decided not to send.
            left = cooldown.remaining(clock())
            if left > 0:
                problems.add(cooldown.reason)
                stop_reason = f"another search just paused this lane for {left:.0f} s"
                outcomes.append(f"r/{subreddit}: not asked ({stop_reason})")
                continue
            asked += 1
            url = build_search_url(
                subreddit=str(subreddit),
                query=keywords,
                date_from=query.date_from,
                date_to=query.date_to,
                limit=query.limit,
            )
            try:
                payload = _get_payload(url, deadline=deadline, clock=clock, limiter=limiter)
                found = parse_posts(payload, prepared, url)
            except _LaneOutOfTime:
                problems.add("out of time")
                stop_reason = f"this lane's {_LANE_WALL_TIME_SECONDS:.0f} s limit ran out"
                outcomes.append(f"r/{subreddit}: not asked ({stop_reason})")
                continue
            except SourceRateLimited as error:
                # Asking the next subreddit of a host that is rate-limiting us
                # would be refused too, and would be the opposite of polite.
                problems.add(_RATE_LIMITED)
                stop_reason = "the archive was already rate-limiting this lane"
                outcomes.append(f"r/{subreddit}: {error.detail}")
                # Only a 429 is a `SourceRateLimited` by now (`_normalise`; a timeout
                # in a 200 body is an `_UpstreamTimeout`).
                cooldown.start(clock(), error.retry_after, _RATE_LIMITED)
                continue
            except SourceError as error:
                # The BASE class, deliberately: one subreddit failing is not the
                # lane failing, and a narrower catch would let another sibling
                # of SourceError kill the lane and discard what was collected.
                status = error.status
                if isinstance(error, SourceBlocked):
                    problems.add("blocked")
                elif isinstance(error, _UpstreamTimeout):
                    # A TIMEOUT ENDS THE CALL AND PAUSES THE LANE, whether the archive
                    # said it as HTTP 422 or in the body of a 200 (one class, see
                    # `_UpstreamTimeout`). The search was not retried (`_normalise`),
                    # and the next subreddit would meet the same archive: it timed out
                    # on 13 of 15 requests in one live run whichever subreddit was
                    # asked. So the remaining subreddits are not asked, and for
                    # `_TIMEOUT_COOLDOWN_SECONDS` neither is any other search of this
                    # lane.
                    problems.add(_TIMED_OUT)
                    stop_reason = "the archive's search just timed out on its side"
                    cooldown.start(clock(), _TIMEOUT_COOLDOWN_SECONDS, _TIMED_OUT)
                elif isinstance(error, _ArchiveReportedError):
                    problems.add("errored")
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
            # was not searched (a subreddit failed, was paused or ran out of time,
            # and any subreddit after it was left out by `_MAX_SUBREDDITS_PER_CALL`),
            # so "found nothing" would be a claim about subreddits nobody looked
            # at. The report carries it the one way the wire has for a lane that
            # did not finish: a failure whose `detail` lists every subreddit's
            # outcome (`LaneOutcome` `refused` in
            # apps/chat/tools/platform/deep-research/lane-report.ts).
            #
            # With no problem the empty list below IS the finding: every subreddit
            # the app named was asked, answered, and had nothing (the cap does not
            # stop a lane that has seen neither a hit nor a problem).
            raise _lane_failure(keywords, problems, outcomes)

        for index, item in enumerate(collected, start=1):
            item.item_id = f"A{index}"
        return collected[: query.limit]


_PROBLEM_WORDS = {
    "blocked": "refused this server (HTTP 403: a blocked host, not a bad query)",
    _RATE_LIMITED: "rate-limited this lane",
    _TIMED_OUT: "timed out on its own side",
    "rejected": "rejected the query",
    "errored": "answered with an error instead of posts",
    "failed": "failed to answer",
    "out of time": "ran past this lane's time limit",
    "capped": "searched only the best-fitting subreddits",
}


def _paused(reason: str, left: float) -> SourceError:
    """PURE. What a call made while the lane is paused raises: nothing was sent.

    A paused lane is a lane that was not searched, so it says so in the same words
    a failed one does, and never reads as "nobody discusses the topic".

    The `detail` is shown to the founder VERBATIM as the whole lane line, so it
    must stand on its own: whole sentences, each with a subject. It used to begin
    "timed out on its own side a moment ago (...)", a predicate with nothing it
    was said of.
    """
    not_searched = "Reddit was not searched, which is not a finding that nobody discusses the topic."
    if reason == _TIMED_OUT:
        return SourceUnavailable(
            f"The Reddit archive (Arctic Shift) timed out on its own side a moment ago, so "
            f"this search did not ask it again; the lane stays paused for another "
            f"{left:.0f} s. {not_searched}"
        )
    return SourceRateLimited(
        f"The Reddit archive (Arctic Shift) said a moment ago that it is receiving too many "
        f"requests, so this search did not ask it again; the lane stays paused for another "
        f"{left:.0f} s. {not_searched}"
    )


def _lane_failure(keywords: str, problems: set[str], outcomes: list[str]) -> SourceError:
    """PURE. The lane's failure, headline first, in words a founder can read.

    `blocked` when any subreddit was answered with a 403: that is the remedy that
    matters (run the sidecar from another network), and waiting cannot fix it, so
    it outranks a rate limit seen alongside it. `rate-limited` when every problem
    was a rate limit or the lane's own time limit (asking later can help);
    `unavailable` otherwise (a rejected query, an error body, a failed request,
    or a timeout). `capped` never stands alone here: the cap only applies once a
    subreddit found posts (then nothing is raised) or a problem was seen, so it
    sits beside the problem that made the cap apply.
    """
    words = [_PROBLEM_WORDS[key] for key in _PROBLEM_WORDS if key in problems]
    # Whole sentences, each with a subject: the founder reads this line verbatim.
    detail = (
        f"Arctic Shift {' and '.join(words)}, so Reddit was not searched in full, which "
        f"is not a finding that nobody discusses the topic. The words sent to the archive "
        f"were {keywords!r}. What happened to each subreddit: " + "; ".join(outcomes) + "."
    )
    if "blocked" in problems:
        return SourceBlocked(detail)
    if problems <= {_RATE_LIMITED, "out of time"}:
        return SourceRateLimited(detail)
    return SourceUnavailable(detail)
