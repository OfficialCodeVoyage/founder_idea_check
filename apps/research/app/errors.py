"""Named failure conditions for every source adapter.

THE RULE THIS FILE ENFORCES: an adapter never returns an empty list to mean
"something went wrong". Empty means "we searched and the topic has no coverage",
which is a legitimate finding; everything else raises one of these, and the
route turns it into a typed failure the TypeScript side can act on.

The distinction is load-bearing. `apps/chat/lib/signals/types.ts` documents why:
the keyless adapters were verified from a residential IP, and DuckDuckGo serves
403s or challenge pages to datacenter egress ranges. If a 403 came back as `[]`,
a Vercel deployment would report "nobody is discussing your idea" for every
idea, forever, and the phase gate would BLOCK founders on the strength of it.
"""

from __future__ import annotations


class SourceError(Exception):
    """Base for every adapter failure. Carries the wire `kind` verbatim."""

    #: Mirrors `SignalFailureKind` in apps/chat/lib/signals/types.ts. The two
    #: enums must agree; `normalizeFailureKind` there maps anything unknown to
    #: `schema-drift` rather than guessing, so a drift is visible, not silent.
    kind: str = "unavailable"

    #: The upstream HTTP status, when the failure was one. Set by
    #: `http.py::_classify`; None for network errors, timeouts and failures an
    #: adapter found inside a 2xx body. Lets a caller tell "the host rejected
    #: this request" (a 4xx, which will not improve by asking again) from
    #: "the host is overloaded" without parsing `detail`.
    status: int | None = None

    #: Seconds the host asked us to wait before asking again (`Retry-After`, or
    #: Arctic Shift's `X-RateLimit-Reset`), when it said. None means unstated,
    #: never "retry immediately".
    retry_after: float | None = None

    def __init__(self, detail: str) -> None:
        super().__init__(detail)
        self.detail = detail


class SourceBlocked(SourceError):
    """HTTP 403, or a challenge page served in place of results.

    THE EXPECTED PRODUCTION FAILURE. Raise this — never return `[]` — when a
    host refuses us. `detail` must say which endpoint refused and what it
    returned, because the operator's next action ("run the sidecar somewhere
    with a residential egress" vs "this source is dead") depends on it.
    """

    kind = "blocked"


class SourceRateLimited(SourceError):
    """HTTP 429, or a documented quota exhausted.

    Distinct from `SourceBlocked` because retrying later is meaningful here and
    is not there. Collapsing them sends an operator to wait out a problem that
    waiting cannot fix.
    """

    kind = "rate-limited"


class SourceUnavailable(SourceError):
    """Network error, DNS failure, timeout, or a 5xx."""

    kind = "unavailable"


class SourceDisabled(SourceError):
    """The deployment's gate refused this source.

    Not an error in the operational sense — it is the `DemandSignalProvider`
    gate doing its job — but it travels the same channel so that a thin report
    can always explain itself.
    """

    kind = "disabled"


class SourceMissingCredential(SourceError):
    """Configured on, but its credential is absent.

    NEVER falls back to a keyless path. That fallback is exactly how a
    BYO-credential source silently becomes a keyless scraper.
    """

    kind = "missing-credential"


class SourceSchemaDrift(SourceError):
    """The response parsed as JSON/XML but not into the shape we expect.

    Its own kind because the fix is a code change, not a retry.
    """

    kind = "schema-drift"
