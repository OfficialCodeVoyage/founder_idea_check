"""The source registry.

Pattern taken from `miurla/morphic` `lib/tools/search/providers/` (Apache-2.0)
@ d4aba02a: one module per source, one index that resolves an id to an instance,
so adding a source is adding a file rather than editing a switch statement in
three places.

What is NOT taken from morphic is the gate. Its `providers/index.ts` resolves on
whether an API key is present, which answers "can we?" — this registry asks
`assert_permitted` first, which answers "may we?".
"""

from __future__ import annotations

from ..config import Settings
from .base import Source, SourceDescriptor, assert_permitted
from .github import DESCRIPTOR as GITHUB_DESCRIPTOR
from .github import GitHubSource
from .hackernews import DESCRIPTOR as HN_DESCRIPTOR
from .hackernews import HackerNewsSource
from .reddit_rss import DESCRIPTOR as REDDIT_RSS_DESCRIPTOR
from .reddit_rss import RedditRssSource
from .reddit_shreddit import DESCRIPTOR as REDDIT_SHREDDIT_DESCRIPTOR
from .reddit_shreddit import RedditShredditSource
from .web_search_keyless import DESCRIPTOR as WEB_DESCRIPTOR
from .web_search_keyless import KeylessWebSearchSource

ALL_DESCRIPTORS: tuple[SourceDescriptor, ...] = (
    HN_DESCRIPTOR,
    WEB_DESCRIPTOR,
    GITHUB_DESCRIPTOR,
    REDDIT_RSS_DESCRIPTOR,
    REDDIT_SHREDDIT_DESCRIPTOR,
)

_BY_ID = {descriptor.id: descriptor for descriptor in ALL_DESCRIPTORS}


def find_descriptor(source_id: str) -> SourceDescriptor | None:
    """PURE. Unknown ids return None, never a default.

    Returning a default here would let a typo in `RESEARCH_ENABLED_SOURCES`
    silently run a different source than the operator named.
    """
    return _BY_ID.get(source_id)


def build_source(descriptor: SourceDescriptor, settings: Settings) -> Source:
    """Instantiate one adapter. Call `assert_permitted` FIRST.

    The gate is not folded into this function on purpose: a caller that wants a
    descriptor's metadata without running it (the health endpoint) must not be
    forced through the gate, and a caller that wants to run it must not be able
    to skip it. Two calls, one obvious order.
    """
    if descriptor.id == "hackernews":
        return HackerNewsSource()
    if descriptor.id == "web-keyless":
        return KeylessWebSearchSource(searxng_url=settings.searxng_url)
    if descriptor.id == "github":
        return GitHubSource(token=settings.github_token)
    if descriptor.id == "reddit-rss":
        return RedditRssSource()
    if descriptor.id == "reddit-shreddit":
        return RedditShredditSource()
    raise KeyError(f"no adapter is registered for source id {descriptor.id!r}")


def resolve_permitted_source(source_id: str, settings: Settings) -> Source:
    """Gate, then build. Raises a named `SourceError` on refusal."""
    descriptor = find_descriptor(source_id)
    if descriptor is None:
        raise KeyError(source_id)
    assert_permitted(descriptor, settings.deployment)
    return build_source(descriptor, settings)
