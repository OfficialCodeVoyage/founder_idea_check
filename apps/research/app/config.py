"""Deployment configuration, read once from the environment.

Kept tiny on purpose. `mvanhorn/last30days-skill`'s `lib/env.py` is 1,366 lines
of keychain, `pass`, project-trust and CLI-wizard resolution; none of that
belongs in a service whose entire configuration surface is "am I hosted, and
which sources did the operator turn on".

FAIL-CLOSED DEFAULTS. Absent or unparseable configuration resolves to the MORE
restrictive value, every time:
  - `RESEARCH_HOSTED` unset -> hosted (assume the risky deployment)
  - `RESEARCH_ENABLED_SOURCES` unset -> the two keyless defaults only
  - an unknown source id in that list -> refused, not silently ignored
"""

from __future__ import annotations

import os
from dataclasses import dataclass

from .sources.base import Deployment

#: The sources a fresh deployment runs with: Hacker News plus keyless web
#: search. Both keyless, both legally boring, neither requiring the operator to
#: accept somebody else's risk.
#:
#: GitHub is NOT here despite being permitted in both modes: it needs a token,
#: and a default that is always refused for a missing credential trains
#: operators to ignore the refusal list.
DEFAULT_ENABLED_SOURCES = ("hackernews", "web-keyless")

KNOWN_SOURCE_IDS = frozenset(
    {
        "hackernews",
        "web-keyless",
        "github",
        "arctic-shift",
    }
)

#: Credential names a descriptor may require. Read from the environment and
#: reported only as present/absent — the values never leave this module.
CREDENTIAL_NAMES = ("GITHUB_TOKEN",)


def _flag(env: dict[str, str], name: str, *, default: bool) -> bool:
    raw = (env.get(name) or "").strip()
    if not raw:
        return default
    return raw.lower() in ("1", "true", "yes", "on")


@dataclass(frozen=True)
class Settings:
    deployment: Deployment
    github_token: str
    searxng_url: str
    #: Rejected ids from RESEARCH_ENABLED_SOURCES, surfaced at /v1/health so a
    #: typo does not present as a silently missing source.
    unknown_source_ids: tuple[str, ...]


def load_settings(environ: dict[str, str] | None = None) -> Settings:
    """PURE with respect to its argument — pass a dict to test it.

    `RESEARCH_HOSTED` DEFAULTS TO TRUE. An operator who has not answered the
    question gets the restrictive answer, which means a source barred in hosted
    mode stays barred. The opposite default would enable a legally exposed
    source on every deployment that forgot to configure one variable.
    """
    env = dict(os.environ if environ is None else environ)

    hosted = _flag(env, "RESEARCH_HOSTED", default=True)

    raw_sources = (env.get("RESEARCH_ENABLED_SOURCES") or "").strip()
    requested = (
        tuple(part.strip() for part in raw_sources.split(",") if part.strip())
        if raw_sources
        else DEFAULT_ENABLED_SOURCES
    )
    enabled = tuple(sid for sid in requested if sid in KNOWN_SOURCE_IDS)
    unknown = tuple(sid for sid in requested if sid not in KNOWN_SOURCE_IDS)

    available = frozenset(name for name in CREDENTIAL_NAMES if (env.get(name) or "").strip())

    return Settings(
        deployment=Deployment(
            hosted=hosted,
            available_credentials=available,
            operator_enabled=frozenset(enabled),
        ),
        github_token=(env.get("GITHUB_TOKEN") or "").strip(),
        searxng_url=(env.get("RESEARCH_SEARXNG_URL") or "").strip(),
        unknown_source_ids=unknown,
    )
