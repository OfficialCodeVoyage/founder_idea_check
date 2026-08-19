"""The source contract, and the gate in front of it.

Mirrors `apps/chat/lib/signals/providers.ts` field for field. The two must agree:
the TypeScript side gates before it calls, and this side gates again before it
fetches. That is deliberate belt-and-braces — a source that must not run in
hosted mode must not run even if someone curls the sidecar directly, because
the sidecar is reachable inside the deployment's own network.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol

from ..errors import SourceDisabled, SourceMissingCredential
from ..schema import SourceItem


@dataclass(frozen=True)
class SourceDescriptor:
    """How a source is allowed to run.

    `enabled_in_hosted` has no default. A new adapter cannot be added without
    its author answering the question, which is the whole point.
    """

    id: str
    label: str
    enabled_in_hosted: bool
    enabled_in_self_host: bool
    gate_reason: str
    required_credentials: tuple[str, ...] = ()
    #: Prior on how trustworthy this source's items are, 0-1. Feeds the final
    #: score's `source_quality` term. Not a popularity measure: a small,
    #: high-signal forum outranks a large, noisy one.
    source_quality: float = 0.6


@dataclass
class SourceQuery:
    query: str
    date_from: str
    date_to: str
    limit: int = 25
    #: Adapter-specific hints (subreddits, repo filters). Never required.
    options: dict = field(default_factory=dict)


class Source(Protocol):
    """One adapter.

    CONTRACT: `fetch` returns items or RAISES a `SourceError`. It NEVER returns
    `[]` to mean "something went wrong" — see `app/errors.py` for why that
    distinction is the load-bearing one in this whole service.
    """

    descriptor: SourceDescriptor

    def fetch(self, query: SourceQuery) -> list[SourceItem]: ...


@dataclass(frozen=True)
class Deployment:
    """Where this sidecar is running, which decides what it may query."""

    hosted: bool
    #: Credential names that currently hold a non-empty value.
    available_credentials: frozenset[str]
    #: Source ids the operator explicitly switched on. An id here is a REQUEST,
    #: never a grant — `assert_permitted` still refuses anything barred.
    operator_enabled: frozenset[str]


def assert_permitted(descriptor: SourceDescriptor, deployment: Deployment) -> None:
    """Raise unless this source may run in this deployment.

    Rule order is most-restrictive-first, and the legal bar is checked BEFORE
    the operator toggle on purpose: the toggle is permission to run something
    already permitted, never permission to run something barred. Checking the
    toggle first would produce the message "not enabled", which invites an
    operator to go and enable it.
    """
    if deployment.hosted and not descriptor.enabled_in_hosted:
        raise SourceDisabled(f"{descriptor.label} is off in hosted mode. {descriptor.gate_reason}")
    if not deployment.hosted and not descriptor.enabled_in_self_host:
        raise SourceDisabled(
            f"{descriptor.label} is off in self-host mode. {descriptor.gate_reason}"
        )
    if descriptor.id not in deployment.operator_enabled:
        raise SourceDisabled(f"{descriptor.label} is not enabled for this deployment.")

    missing = [
        name
        for name in descriptor.required_credentials
        if name not in deployment.available_credentials
    ]
    if missing:
        raise SourceMissingCredential(
            f"{descriptor.label} is enabled but {', '.join(missing)} "
            f"{'is' if len(missing) == 1 else 'are'} not set. "
            "It will not fall back to a keyless path."
        )
