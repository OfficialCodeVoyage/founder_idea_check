# ─────────────────────────────────────────────────────────────────────────────
# ADAPTED from mvanhorn/last30days-skill (MIT)
#   file:   skills/last30days/scripts/lib/hackernews.py
#   commit: 9243a32d823c7c8659e44b92f2dedcf1b7397137 (2026-08-18)
#
# MODIFICATIONS: the Algolia query construction — including BOTH traps quoted in
# the comments below, which are the reason this file was worth taking rather
# than writing — is upstream's, except that `restrictSearchableAttributes=title`
# is added (`build_search_url`). Removed: the depth presets, the thread-comment
# enrichment fan-out, and the `log.source_log` sink. Errors now raise named
# exceptions instead of returning `{"hits": [], "error": ...}`. Added: a hit is
# dropped unless its TITLE shares a CONTENT word with the query (or two distinct
# weak words), where stopwords, numbers and years, countries, file types,
# research filler and broad tech words do not count; the story's text is never
# read for this (`matches_a_content_word`, `_NEVER_TOKENS`).
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

    DEPARTURE FROM UPSTREAM — `restrictSearchableAttributes=title` IS set.
    Upstream leaves it off so that Ask HN / Show HN threads whose topic appears
    only in the body are found. Our relevance test is TITLE-ONLY
    (`matches_a_content_word`), so such a story would be dropped client-side
    anyway, and without the restriction it first takes a slot of the overfetched
    page: a body-only hit fills the page that the title-only filter then empties.
    Asking Algolia for title matches spends the page on stories that can pass.
    Checked live on 2026-11-12 with the single-word query "reading": HTTP 200,
    7,903 hits restricted against 20,777 unrestricted, every returned title
    containing the word. `optionalWords` (TRAP 2) still applies, now to the title.
    """
    flat = _flatten_query(query)
    params = {
        "query": flat,
        "tags": "story",
        "restrictSearchableAttributes": "title",
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
# Live QA, 2026-11-12, a parents-of-young-readers question, five times:
#   1. Hacker News returned 51 of a run's 100 sources, among them a vet
#      directory and a story about a politician. Dropping hits whose lexical
#      relevance is exactly 0.0 (no query word in the title or text) removed those.
#   2. It still returned 56 of the next run's 115, and only 3 of 55 titles shared a
#      content word with the question. What they matched was the query's FILLER:
#      "U.S." / "United States" (the market the founder named), years ("2023"),
#      "pdf", "years", "prices", "report", "survey". A researcher's web-search
#      query is full of such words, any story shares some of them, and a bare
#      "matches one query word" test passes all of them.
#   3. With that filler out, 38 of a run's 96 sources were still Hacker News, and
#      18 of the 38 passed: the researcher's query for an AI-personalised
#      children's books product held "AI", "app", "early" and "screen", and
#      "Traceforce - security monitoring for AI apps", "Google, Microsoft and xAI
#      agree to share early AI models" and three AI coding-agent tools matched on
#      those. Only 3 of the 38 were about children's reading.
#   4. Re-check 5, with all of that out: 22 stories, 10 of them with NOTHING of the
#      question in the title, passing on words found somewhere in the story's text.
#      A vet directory and an org-mode notes app went through on "parent" or
#      "reading" said once in a paragraph. One word in a paragraph is how a story
#      mentions something, not what it is about, and a long query has a dozen
#      content words to be found by accident. The rule of the day let a story with
#      nothing of the question in its title pass on two DISTINCT content words in
#      its text.
#   5. Re-check 6, under that two-word body rule: 7 of 20 stories passed on their
#      text alone and 5 of those 7 were off topic (an org-mode notes app, an
#      offline-password-cracking write-up, a browser-extension recommender, an iOS
#      analytics dashboard, a birthday-party kit). Each said "read" and then any
#      other ordinary word of a long query ("book", "conflict", "level", "program",
#      "subscription", "teach"). "read" is in nearly every text, so "read and one
#      more word" is not a topic test. Re-check 5 had been the same with a Postgres
#      tool, a code-review tool and an adult vocabulary app, and the fix then (word
#      families, so "read" and "reading" are one word) closed that one pair and left
#      every other pair open. Each patch narrowed the door and none closed it, so
#      the decision is to close it: the title decides, alone.
#
# So the words of a query fall into three kinds, and only the last decides:
#
#   NEVER   a word that says where, when, in what file, how big, who in general or
#           how to search, or that is a broad tech or descriptor word any story can
#           contain (`_FILLER_TOKENS`, `_BROAD_TOKENS` and the planner's
#           `LOW_SIGNAL_QUERY_TOKENS`), and every number and year. It never
#           qualifies a hit, alone or as one half of a pair.
#   WEAK    a word that names something but is too common to decide a topic by
#           itself: "code", "review", "price", "comparison", "rate", "data"
#           (`_WEAK_TOKENS`). One of them is not evidence; two DIFFERENT ones in
#           the same title are ("code review", "price comparison").
#   CONTENT every other word. One in the title is enough.
#
# A hit is on topic when its TITLE shares one CONTENT word with the query or two
# distinct WEAK words. THE STORY TEXT IS NOT READ: a title is what the story is
# called, and a body is where a story can mention anything. "Different" means a
# different word FAMILY (`_family`): the inflections of one word ("read", "reads",
# "reader", "readers", "reading") are one word, on BOTH sides, so "tool" matches
# "tools", "APIs" matches "api", and "price" and "pricing" are not a pair. The
# title is read through `tokenize`, the same function the relevance score uses, so
# a word that counts there counts here.
#
# WHAT TITLE-ONLY COSTS, stated so nobody re-derives it. An Ask HN or Show HN whose
# terse title does not name the topic and whose text does is now missed. For demand
# validation that is the most valuable kind of thread on the site, but a hit found
# only by its text cannot be told apart from the five off-topic stories of check 5
# above. One missed thread costs a signal; an off-topic story kept costs the
# founder's trust in the whole lane, which is already searched last for a
# non-developer buyer.
#
# WHAT IT DOES NOT FIX, said once so nobody expects more: one generic word of a
# long query in a TITLE still passes. "Career at home..." (home), "Tailscale-rs:
# Official Rust library..." (library) and "H.R.8250 Parents Decide Act" (parent)
# passed in re-check 6. A lexical test cannot tell the word that names a story's
# subject from the founder's own word matched by luck; only a semantic one
# (similarity of the title to the founder's question) can, and that is not built.
# What bounds it today is the per-search lane limit (3 for a non-developer buyer,
# the rest reported as left out) and the 0.25 audience weight. The entry is in
# `.planning/codebase/CONCERNS.md`.
#
# The TITLE rule: one content word qualifies ("Starlink Reluctant to Operate in
# Taiwan" for a question about reluctant readers). A title is one line and the word
# either names the story's subject or is the founder's own word matched by luck;
# telling the two apart takes more than a count of words.
#
# THE TRADE-OFF, stated so nobody re-derives it: a story that shares only two
# weak words with a query can still be off topic. The pair rule counts only the
# weak words the QUERY has, so it needs a query with two of them AND a content
# word: for "tutoring price cost", "Airline fares price and cost" passes on
# price + cost although it says nothing of tutoring (for "tutoring price" it
# cannot, there is no second weak word to pair). What the pair buys back is "How do
# you do code review in a small team?" for the query "code review automation",
# which a content-word-only rule dropped, and it costs a few such coincidences.
# The research filler, the age words and "time" and "local" stay NEVER on purpose:
# they are what let "Netflix Raising Prices for Second Time in Less Than Two
# Years" (price + years, and price + time) and "...survey report says" through in
# QA run 2. As weak words, "time" and "local" would complete a pair with "price"
# for any query that carries both ("kids screen time apps price").
#
# A SEPARATE RULE covers a query with NO CONTENT WORD at all ("price comparison
# tool", "market size report 2024", "AI tools"): nothing could ever pass, so the
# test falls back to its WEAK words, ANY ONE of them ("price comparison tool"
# keeps "Show HN: price comparison for flights", by the single word and not by a
# pair), and to any query word when it has no weak word either, rather than
# turning the whole lane into an empty result. That fallback reads the TITLE only,
# like the rule above, and on purpose: one weak word in a body is the weakest
# evidence this lane could accept and the exact case that let five off-topic
# stories in, while a lane with nothing titled for the query is a finding
# ("nothing on Hacker News is named for this"), not a failure.
_FILLER_TOKENS = frozenset(
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
        "url", "site", "website", "websites", "web", "internet",
        "blog", "blogs", "article", "articles", "post", "posts", "forum",
        "forums", "thread", "threads", "reddit", "discussion", "discussions",
        # Research filler.
        "report", "reports", "survey", "surveys",
        "study", "studies", "statistic", "statistics", "stats", "research",
        "analysis", "analyses", "result", "results", "finding", "findings",
        "evidence", "trend", "trends", "overview", "summary", "size", "share",
        "growth", "average", "percent", "percentage", "number", "numbers",
        "level", "levels", "million", "billion", "thousand", "annual",
        "quarterly", "yearly", "monthly", "complaint", "complaints",
        # The KIND of source a researcher asks for ("official qualitative
        # evidence ..."), not what it is about. Live QA (re-check 4) let 12
        # government "officials" stories in on "official". "recent", "current"
        # and "latest" are already NEVER through `LOW_SIGNAL_QUERY_TOKENS`. Words
        # that are often the topic itself ("interventions", "trust", "barriers",
        # "needs") are NOT here; "source" alone is not either ("open source").
        "official", "officials", "qualitative", "quantitative", "sources",
        # Time and age words: "5-7 year old" matches any story that says "years".
        # Month names are here because a date in a query ("March 2026") is a
        # date and not a topic ("PFAS contamination in the U.S. (March 5, 2026)").
        "year", "years", "month", "months", "week", "weeks", "day", "days",
        "time", "today", "old", "age", "ages", "aged", "january", "february", "march",
        "april", "may", "june", "july", "august", "september", "october",
        "november", "december",
        # Who, in general.
        "user", "users", "customer", "customers", "consumer", "consumers",
        "person", "persons",
    )
)  # fmt: skip

#: Broad tech and descriptor words. A story about almost anything mentions "AI"
#: or "an app" these days, so they say nothing about a topic. Singular on purpose:
#: `_kind` also looks a word up by its stem, so "apps" and "agents" are covered.
#: "artificial" and "intelligence" are here because `relevance.tokenize` expands
#: "ai" into them, on the query and on the hit alike.
_BROAD_TOKENS = frozenset(
    (
        "ai", "artificial", "intelligence", "app", "application", "tool",
        "software", "platform", "model", "agent", "online", "digital", "early",
        "screen", "tech", "technology", "startup", "product", "service",
        "solution", "system", "device",
    )
)  # fmt: skip

#: Words that name something but are too common to decide a topic alone; two
#: different ones in one hit do (see the comment above). Most of them are also in
#: the planner's `LOW_SIGNAL_QUERY_TOKENS`, which `_NEVER_TOKENS` takes them out of.
_WEAK_TOKENS = frozenset(
    (
        "code", "compare", "comparison", "review", "reviews", "rate", "rates",
        "prompt", "prompts", "prompting", "tutorial", "tutorials", "animation",
        "animations", "prediction", "predictions", "probability",
        "probabilities", "chance", "chances", "odds", "price", "prices",
        "pricing", "cost", "costs", "data", "dataset", "datasets", "market",
        "markets", "industry", "industries",
    )
)  # fmt: skip

_NEVER_TOKENS = (_FILLER_TOKENS | _BROAD_TOKENS | LOW_SIGNAL_QUERY_TOKENS) - _WEAK_TOKENS

#: Years ("2023"), decades ("1990s") and any other bare number.
_NUMBER = re.compile(r"^\d+s?$")

_NEVER = "never"
_WEAK = "weak"
_CONTENT = "content"


def _stem(token: str) -> str:
    """PURE. A crude, predictable stem: a trailing plural "s" comes off.

    Not from a word of three letters or fewer ("ios", "aws", "css") or one ending
    in "ss" or "us" ("business", "status"). The same rule runs on the query and on
    the hit, so a word that is not a plural ("analysis" becomes "analysi") still
    matches itself; what the rule must do is turn "APIs" into "api". "ies" and
    "es" plurals are left alone, so "batteries" does not match "battery": a miss
    is the cautious direction here, and a cleverer stemmer is one more thing to
    get wrong.

    This stem is for LOOKING A WORD UP in the NEVER and WEAK lists (`_kind`),
    where "sources" is a research-filler word and "source" is not, so it must
    stay exactly this small. COUNTING words is `_family`'s job.
    """
    if len(token) > 3 and token.endswith("s") and not token.endswith(("ss", "us")):
        return token[:-1]
    return token


#: The fewest letters `_family` leaves when it takes "ing", "ed" or "er" off:
#: "ring", "bring", "string", "thing", "need", "speed", "water" and "paper" stay
#: whole, "reading" and "learned" lose their ending.
_MIN_FAMILY_STEM = 4

#: A doubled consonant an ending leaves behind, which `_family` takes back to one
#: ("running" to "run", "stopped" to "stop"). Not "l", "s", "z" or "f": "fall",
#: "pass" and "stuff" keep theirs.
_UNDOUBLED = "bdgmnprt"


def _without_plural(token: str) -> str:
    """PURE. `token` without its plural: the "s" (`_stem`), or the "es" of "boxes",
    "watches", "dishes" and "classes"."""
    return token[:-2] if token.endswith(("xes", "ches", "shes", "sses")) else _stem(token)


def _without_endings(word: str) -> str:
    """PURE. `word` with "ing", "ed" and "er" each taken off IN TURN, in that order.

    In turn and not "the first that fits": "engineering" is "engineer" plus "ing" and
    "engineer" is "engine" plus "er", so one pass that stopped at "ing" left
    "engineering" one step behind "engineers" and "engineer". Each ending comes off
    only when `_MIN_FAMILY_STEM` letters or more are left ("ring", "string", "need",
    "water" stay), and a doubled consonant it leaves behind is undoubled ("running",
    "stopped").
    """
    for suffix in ("ing", "ed", "er"):
        if word.endswith(suffix) and len(word) - len(suffix) >= _MIN_FAMILY_STEM:
            word = word[: -len(suffix)]
            if word[-1] == word[-2] and word[-1] in _UNDOUBLED:
                word = word[:-1]
    return word


def _family(token: str) -> str:
    """PURE. A key for the word FAMILY `token` belongs to: its inflections share it.

    A comparison key and not a word: "read", "reads", "reader", "readers" and
    "reading" all become "read"; "pricing" and "prices" become "pric"; "batteries"
    and "battery" become "batteri"; "engineer", "engineers" and "engineering" all
    become "engin". It is what `matches_a_content_word` COUNTS, so that one word
    said twice in two forms is one word. The rule, in order:

    1. a plural comes off: the "s" (`_stem`), or the "es" of "boxes", "watches",
       "dishes" and "classes" (`_without_plural`);
    2. "ing", "ed" and "er" come off in turn, each only when four letters or more are
       left ("ring", "string", "need", "water" stay), and a doubled consonant an
       ending leaves behind is undoubled ("running", "stopped")
       (`_without_endings`);
    3. a trailing "e" comes off a word of five letters or more ("create" meets
       "creating"), and a trailing "y" after a consonant becomes "i" ("battery"
       and "batteries" meet; "movie" and "movies" meet at "movi").

    Everything else stays a different word: "migration" is not "migrating", and a
    word of three letters or fewer is never touched ("bus", "ios", "api"). The key
    is crude both ways. Two unrelated words can meet ("number" and "numb"), which
    costs one wrong match; two forms of one word can still part ("child" and
    "children"), which costs one missed one. `_kind` does NOT use this: the NEVER and
    WEAK lists are written in whole words, and "source" must stay a content word
    while "sources" does not.
    """
    if len(token) <= 3:
        return token
    word = _without_endings(_without_plural(token))
    if len(word) > 4 and word.endswith("e"):
        word = word[:-1]
    elif len(word) > 3 and word.endswith("y") and word[-2] not in "aeiou":
        word = word[:-1] + "i"
    return word


def _kind(token: str) -> str:
    """PURE. Which of NEVER, WEAK and CONTENT a query word is (see above)."""
    stem = _stem(token)
    if _NUMBER.match(token) or token in _NEVER_TOKENS or stem in _NEVER_TOKENS:
        return _NEVER
    if token in _WEAK_TOKENS or stem in _WEAK_TOKENS:
        return _WEAK
    return _CONTENT


def matches_a_content_word(prepared: PreparedQuery, title: str) -> bool:
    """PURE. Is the story on topic for the query? THE one place that decides
    whether a Hacker News hit is, and it reads the TITLE only.

    On topic means: the title shares one CONTENT word with the query or two
    distinct WEAK words. The story's text is deliberately not an input (the
    history and the reasons are in the comment above `_FILLER_TOKENS`). The title
    is tokenised with the same
    `tokenize` the relevance score uses, so a word that counts there counts here,
    and compared on `_family`, like the query's words, so "read" and "reading" are
    one word. With no CONTENT word in the query the test is "any WEAK word" in the
    title, and with no WEAK word either "any query word"; with no query word at
    all (stopwords only) every hit stays, as `token_overlap_relevance` already
    treats such a query as neutral.
    """
    query_tokens = prepared.q_tokens
    if not query_tokens:
        return True
    in_title = {_family(token) for token in tokenize(title)}
    content: set[str] = set()
    weak: set[str] = set()
    for token in query_tokens:
        kind = _kind(token)
        if kind == _CONTENT:
            content.add(_family(token))
        elif kind == _WEAK:
            weak.add(_family(token))
    if content:
        return bool(content & in_title) or len(weak & in_title) >= 2
    return bool((weak or {_family(token) for token in query_tokens}) & in_title)


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

        # A HIT WHOSE TITLE HAS NO REAL WORD OF THE QUERY IS NOT ON TOPIC, whatever
        # its text says. See `matches_a_content_word`, the one place this is
        # decided, and the history in the comment above `_FILLER_TOKENS`. Dropped
        # HERE, where the looseness is introduced, and not for every lane: a
        # web-search snippet can match a query without repeating its words. An
        # empty result is still a finding (nothing on HN is titled for it), not an
        # error.
        if not matches_a_content_word(prepared, title):
            continue
        relevance = token_overlap_relevance(prepared, f"{title} {body}")

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
