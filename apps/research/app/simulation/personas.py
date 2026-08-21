"""STEP 8, the PURE half: persona validation and reaction scoring.

Nothing in this module imports OASIS, torch, or anything else heavy. That is
what makes it testable: `tests/test_simulation.py` runs it with no ML stack
installed and no network.

The impure half — actually spawning agents — is `oasis_runner.py`, behind one
seam that lazily imports OASIS and reports `oasis-not-installed` as a named
condition rather than crashing the whole service at import time.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass

#: The SEVEN keys `generate_reddit_agent_graph` indexes with no `.get()` and no
#: default (`oasis/social_agent/agents_generator.py:573-596` @ 40bf1705):
#:
#:     profile["other_info"]["user_profile"] = agent_info[i]["persona"]
#:     profile["other_info"]["mbti"]         = agent_info[i]["mbti"]
#:     profile["other_info"]["gender"]       = agent_info[i]["gender"]
#:     profile["other_info"]["age"]          = agent_info[i]["age"]
#:     profile["other_info"]["country"]      = agent_info[i]["country"]
#:     user_info = UserInfo(name=agent_info[i]["username"],
#:                          description=agent_info[i]["bio"], ...)
#:
#: A missing key is a KeyError inside an async generator, which surfaces as an
#: opaque 500 after the caller has already paid to load torch. Validating here
#: turns that into one clear message before anything is imported.
REQUIRED_PERSONA_KEYS = ("username", "bio", "persona", "age", "gender", "mbti", "country")

_WORD_RE = re.compile(r"[^\w\s]", re.UNICODE)

#: Two reactions above this Jaccard similarity are treated as the same opinion.
NEAR_DUPLICATE_THRESHOLD = 0.8

#: Below this a run is reported as collapsed, not as a finding. Mirrors
#: MIN_DIVERGENCE_SCORE in apps/chat/lib/research/simulation.ts — the two are
#: intentionally the same number so the sidecar and the app agree on what
#: "usable" means.
MIN_DIVERGENCE_SCORE = 0.35


def validate_personas(personas: list[dict]) -> list[str]:
    """PURE. Every problem with a persona list, or an empty list if it is fine.

    Returns ALL problems rather than raising on the first: fixing personas one
    KeyError per round trip through a torch-loading process is the slowest
    possible way to learn that four of them are incomplete.
    """
    problems: list[str] = []

    if not personas:
        problems.append("no personas supplied — a simulation over zero agents is meaningless")
        return problems
    if len(personas) == 1:
        # OASIS would happily run this. It would also produce a "consensus" of
        # one, which is the collapse this whole module exists to detect.
        problems.append(
            "only one persona — divergence is undefined over a single agent, so the "
            "run cannot answer the question it exists to answer"
        )

    seen: set[str] = set()
    for index, persona in enumerate(personas):
        if not isinstance(persona, dict):
            problems.append(f"persona {index} is a {type(persona).__name__}, not an object")
            continue
        missing = [key for key in REQUIRED_PERSONA_KEYS if key not in persona]
        if missing:
            problems.append(
                f"persona {index} is missing OASIS-required key(s): {', '.join(missing)}"
            )
            continue
        username = str(persona["username"]).strip()
        if not username:
            problems.append(f"persona {index} has an empty username")
            continue
        if username in seen:
            # OASIS keys agents by list index but signs them up by name; a
            # duplicate makes two agents indistinguishable in the `trace` table,
            # which is the only place reactions are read back from.
            problems.append(f"persona {index} reuses the username {username!r}")
            continue
        seen.add(username)

        age = persona["age"]
        if not isinstance(age, int) or isinstance(age, bool) or not (13 <= age <= 120):
            problems.append(f"persona {index} has an out-of-range age: {age!r}")

    return problems


@dataclass(frozen=True)
class Reaction:
    username: str
    text: str
    #: -1 (rejects it) .. +1 (would use it).
    sentiment: float

    #: Which OASIS table this came from: a top-level "post" or a "comment" on
    #: one. Flattening both into one list — as this used to — throws away the
    #: only thread structure a run produces, so any feed built on the flattened
    #: payload can only be a styled list in an order it invented.
    kind: str = "post"

    #: `post.post_id` or `comment.comment_id`. The edge target for replies.
    reaction_id: int | None = None

    #: For a comment, the `post_id` it answers. For a repost, the
    #: `original_post_id`. None for an original post — OASIS stores NULL there
    #: and that NULL is meaningful, so it is not defaulted to 0.
    parent_id: int | None = None

    #: Which `env.step()` produced this. 0 is the seeded pitch; 1..n are the
    #: agent rounds.
    #:
    #: DERIVED FROM ROW-ID WATERMARKS taken after each step, not from
    #: `created_at`. OASIS's schema (`post.sql`, `comment.sql`) has no round
    #: column, and ordering by its simulated clock would be an inference
    #: presented as a fact. None means the watermark could not be read, which
    #: is deliberately distinguishable from round 0.
    round: int | None = None


def _tokens(text: str) -> set[str]:
    cleaned = _WORD_RE.sub(" ", (text or "").lower())
    return {word for word in cleaned.split() if len(word) > 2}


def reaction_similarity(left: str, right: str) -> float:
    """PURE. Word-set Jaccard. Enough to catch N copies of one opinion."""
    a = _tokens(left)
    b = _tokens(right)
    if not a or not b:
        return 0.0
    shared = len(a & b)
    union = len(a) + len(b) - shared
    return shared / union if union else 0.0


@dataclass(frozen=True)
class DivergenceReport:
    score: float
    sentiment_spread: float
    duplicate_rate: float
    distinct_reactions: int
    total_reactions: int


def measure_divergence(reactions: list[Reaction]) -> DivergenceReport:
    """PURE. How much the personas actually disagreed.

    THE STEP 8 GATE. The verification criterion is "an OASIS run produces
    divergent persona reactions, not N copies of one opinion". N identical
    reactions is the signature of a simulation that collapsed onto the base
    model's prior — and it is dangerous rather than merely useless, because it
    reads as unanimous enthusiasm. A founder shown ten agreeing personas
    concludes the market agrees.

    Both terms are needed and are combined rather than used alone: sentiment can
    spread while every agent recites identical reasoning, and wording can vary
    while every agent lands on the same verdict.
    """
    total = len(reactions)
    if total < 2:
        return DivergenceReport(
            score=0.0,
            sentiment_spread=0.0,
            duplicate_rate=1.0 if total == 1 else 0.0,
            distinct_reactions=total,
            total_reactions=total,
        )

    sentiments = [r.sentiment for r in reactions]
    mean = sum(sentiments) / total
    spread = math.sqrt(sum((s - mean) ** 2 for s in sentiments) / total)

    pairs = 0
    duplicate_pairs = 0
    duplicated: set[int] = set()
    for i in range(total):
        for j in range(i + 1, total):
            pairs += 1
            if (
                reaction_similarity(reactions[i].text, reactions[j].text)
                >= NEAR_DUPLICATE_THRESHOLD
            ):
                duplicate_pairs += 1
                duplicated.add(j)
    duplicate_rate = duplicate_pairs / pairs if pairs else 0.0

    # Sentiment is on [-1, 1] so its standard deviation is at most 1. Clamping
    # rather than rescaling by the observed maximum keeps the score comparable
    # between runs — a per-run rescale could not be compared to a threshold.
    spread_term = min(spread, 1.0)
    text_term = 1.0 - duplicate_rate

    return DivergenceReport(
        score=round(0.5 * spread_term + 0.5 * text_term, 4),
        sentiment_spread=round(spread, 4),
        duplicate_rate=round(duplicate_rate, 4),
        distinct_reactions=total - len(duplicated),
        total_reactions=total,
    )


#: Words that mark a reaction as rejecting rather than accepting. Deliberately
#: crude: this is a coarse ordering signal for the divergence metric, not a
#: sentiment classifier, and pretending otherwise by shipping a model here
#: would put an unvalidated judgement in the middle of a legibility measure.
_NEGATIVE = frozenset(
    {
        "no",
        "not",
        "never",
        "wouldn",
        "wouldnt",
        "dont",
        "don",
        "nope",
        "already",
        "fine",
        "instead",
        "expensive",
        "pointless",
        "useless",
        "unnecessary",
        "overkill",
        "skip",
        "pass",
        "meh",
        "doubt",
        "sceptical",
        "skeptical",
        "hassle",
        "annoying",
        "confusing",
    }
)
_POSITIVE = frozenset(
    {
        "yes",
        "would",
        "pay",
        "buy",
        "love",
        "great",
        "useful",
        "helpful",
        "solve",
        "solves",
        "need",
        "want",
        "finally",
        "definitely",
        "absolutely",
        "worth",
        "better",
        "easier",
    }
)


def score_sentiment(text: str) -> float:
    """PURE. A crude -1..+1 lexical score.

    Used ONLY to give `measure_divergence` an ordering, so it can notice that
    every agent landed in the same place. It is never surfaced as a finding, and
    it must never be read as "the market feels +0.7 about this".
    """
    words = _tokens(text) | {w for w in (text or "").lower().split() if len(w) <= 2}
    positive = len(words & _POSITIVE)
    negative = len(words & _NEGATIVE)
    if positive == 0 and negative == 0:
        return 0.0
    return round((positive - negative) / (positive + negative), 4)


def judge(reactions: list[Reaction]) -> dict:
    """PURE. The verdict, in the shape the wire contract expects.

    `usable_as_evidence` is hard-wired False. A simulated reaction is a
    hypothesis to go and test on a real human, never demand evidence — and the
    field exists explicitly rather than being omitted so that any future code
    reaching for "can the gate use this?" finds a hard False and a reason.

    A RUN BELOW TWO REACTIONS HAS NO `usable` KEY AT ALL. It used to report
    `usable: False`, which is the same value, the same field and the same badge
    as "the personas all said the same thing" — so a run in which every model
    call 400'd was indistinguishable from unanimous agreement. Divergence is
    undefined below two; "undefined" is not a polarity of "defined", so it is
    not a value of `usable`. Callers narrow on `assessed` first, and reading
    `usable` off an unassessed run is a KeyError rather than a false negative.
    This mirrors `judgeSimulation` in `apps/chat/lib/research/simulation.ts`,
    and the two must stay mirrored.
    """
    divergence = measure_divergence(reactions)
    divergence_payload = {
        "score": divergence.score,
        "sentiment_spread": divergence.sentiment_spread,
        "duplicate_rate": divergence.duplicate_rate,
        "distinct_reactions": divergence.distinct_reactions,
        "total_reactions": divergence.total_reactions,
    }

    if len(reactions) < 2:
        return {
            "assessed": False,
            "kind": "no-reactions" if not reactions else "too-few-reactions",
            "usable_as_evidence": False,
            "reason": (
                f"The simulation produced {len(reactions)} reaction(s). Divergence "
                "is undefined below two, so this run was NOT assessed — that is a "
                "different fact from the personas having converged."
            ),
            "divergence": divergence_payload,
        }

    if divergence.score < MIN_DIVERGENCE_SCORE:
        usable = False
        reason = (
            f"The personas converged: divergence {divergence.score} is below the "
            f"{MIN_DIVERGENCE_SCORE} floor ({divergence.distinct_reactions} distinct of "
            f"{divergence.total_reactions} reactions, sentiment spread "
            f"{divergence.sentiment_spread}). This is one model's opinion restated "
            f"{divergence.total_reactions} times, not an audience."
        )
    else:
        usable = True
        reason = (
            f"The personas diverged (score {divergence.score}, "
            f"{divergence.distinct_reactions} distinct of {divergence.total_reactions}). "
            "Treat the objections as questions to ask real users, not as demand evidence."
        )

    return {
        "assessed": True,
        "usable": usable,
        "usable_as_evidence": False,
        "reason": reason,
        "divergence": divergence_payload,
    }
