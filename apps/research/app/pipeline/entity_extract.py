# ─────────────────────────────────────────────────────────────────────────────
# VENDORED from mvanhorn/last30days-skill (MIT)
#   file:   skills/last30days/scripts/lib/entity_extract.py
#   commit: 9243a32d823c7c8659e44b92f2dedcf1b7397137 (2026-08-18)
#
# Borrowed code is FROZEN — upstream fixes never arrive on their own. To see
# what upstream changed since:
#   gh api "repos/mvanhorn/last30days-skill/commits?path=skills/last30days/scripts/lib/entity_extract.py&since=2026-08-18" --jq '.[].commit.message'
#
# MODIFICATIONS: only `extract_text_entities` and `entity_overlap` are kept — the X/Reddit handle and hashtag miners belong to adapters this service does not have.
# ─────────────────────────────────────────────────────────────────────────────
"""Entity extraction, used by the cluster pass to merge cross-source stories."""

import re

ENTITY_STOPWORDS = frozenset({
    "the", "a", "an", "to", "for", "how", "is", "in", "of", "on", "and",
    "with", "from", "by", "at", "this", "that", "it", "what", "are", "do",
    "can", "his", "her", "he", "she", "its", "was", "has", "new", "just",
    "says", "said", "will", "about", "after", "now", "all", "been", "here",
    "not", "out", "up", "more", "also", "but", "who", "year", "first",
    "make", "being", "making", "over", "into", "than", "they", "their",
    "would", "could", "get", "got", "some", "like", "back", "going",
    "breaking", "https", "http", "www", "com",
})


def has_anchor_signal(word: str) -> bool:
    """True when a word carries an anchor signal: leading capital, all-caps,
    or any digit (product/person/version anchors)."""
    return word[0].isupper() or word.isupper() or any(char.isdigit() for char in word)


def extract_text_entities(text: str) -> set[str]:
    """Extract significant words used by clustering and eval scoring."""
    words = re.sub(r"[^\w\s]", " ", text).split()
    entities = set()
    for word in words:
        lower = word.lower()
        if lower in ENTITY_STOPWORDS or len(word) <= 2:
            continue
        if has_anchor_signal(word) or len(word) >= 4:
            entities.add(lower)
    return entities


def entity_overlap(entities_a: set[str], entities_b: set[str]) -> float:
    """Return overlap coefficient for two extracted entity sets."""
    if not entities_a or not entities_b:
        return 0.0
    return len(entities_a & entities_b) / min(len(entities_a), len(entities_b))
