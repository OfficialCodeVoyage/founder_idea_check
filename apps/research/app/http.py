# ─────────────────────────────────────────────────────────────────────────────
# REIMPLEMENTED from the design of mvanhorn/last30days-skill (MIT, Copyright (c)
# 2026 Matt Van Horn)
#   file:   skills/last30days/scripts/lib/http.py
#   commit: 9243a32d823c7c8659e44b92f2dedcf1b7397137 (2026-08-18)
#   licence text: LICENSES/MIT-mvanhorn-last30days-skill.txt
#
# WHAT IS UPSTREAM'S: stdlib urllib only, a browser User-Agent for HTML
# endpoints, and the idea of a small token-bucket rate limiter. The code is
# written here, and failures are classified into named errors instead of
# strings. The docstring below says more.
#
#   gh api "repos/mvanhorn/last30days-skill/commits?path=skills/last30days/scripts/lib/http.py&since=2026-08-18" --jq '.[].commit.message'
# ─────────────────────────────────────────────────────────────────────────────
"""Minimal stdlib HTTP with a NAMED 403.

REIMPLEMENTED, not vendored. `mvanhorn/last30days-skill`'s `lib/http.py`
@ 9243a32d is 992 lines and carries a fixture record/replay harness, a
thread-local failure-capture sink, secret scrubbing, and per-source rate
limiters wired to that project's CLI. This service needs about a tenth of that,
and the tail would be permanent maintenance for code we would never call.

What IS taken from upstream, because it is the part that was expensive to learn:

  - stdlib urllib only, no requests/httpx — an adapter set with no third-party
    HTTP dependency is portable and does not inherit that library's CVEs.
  - a browser User-Agent for HTML endpoints, because several of them serve a
    challenge page to anything that looks automated.
  - a small token-bucket rate limiter (`RateLimiter`). Upstream used it to hold
    Reddit's keyless endpoints to 5 requests/second; this service has no such
    lane, and its one limiter, `ARCTIC_SHIFT_LIMITER`, is set from that
    archive's own guidance instead.

THE ONE BEHAVIOURAL DIVERGENCE, and the reason this file exists at all:
upstream classifies failures into strings for a health report and keeps going.
Here a 403 raises `SourceBlocked`, a 429 raises `SourceRateLimited`, and
everything else raises `SourceUnavailable`. Nothing degrades to an empty result.
"""

from __future__ import annotations

import ipaddress
import json
import socket
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

from .errors import (
    SourceBlocked,
    SourceRateLimited,
    SourceSchemaDrift,
    SourceUnavailable,
)

DEFAULT_TIMEOUT = 20

#: Identifies this service honestly. A UA that impersonates a browser on a JSON
#: API is the kind of thing that turns "we called your public API" into "we
#: evaded your bot detection", which is precisely the characterisation the
#: Reddit policy in apps/chat/lib/signals/providers.ts exists to avoid.
USER_AGENT = "idea-check-research/0.1 (+https://github.com/OfficialCodeVoyage/founder_idea_check)"

#: HTML endpoints (DuckDuckGo) serve a challenge page to an obviously-automated
#: UA. Used ONLY for endpoints that render HTML for humans, never for a
#: documented JSON API.
BROWSER_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)


class RateLimiter:
    """Token bucket. Blocks the caller rather than dropping the request.

    Dropping would surface as a missing result with no failure attached, which
    is the exact silent-empty this service is built to avoid.
    """

    def __init__(self, rate_per_sec: float, burst: int) -> None:
        self._rate = rate_per_sec
        self._burst = burst
        self._tokens = float(burst)
        self._updated = time.monotonic()
        self._lock = threading.Lock()

    def acquire(self) -> None:
        with self._lock:
            now = time.monotonic()
            self._tokens = min(
                float(self._burst), self._tokens + (now - self._updated) * self._rate
            )
            self._updated = now
            if self._tokens >= 1.0:
                self._tokens -= 1.0
                return
            wait = (1.0 - self._tokens) / self._rate
            self._tokens = 0.0
            self._updated = now + wait
        time.sleep(wait)


#: Arctic Shift sheds load by answering 200 with {"error": "Timeout. Maybe slow
#: down a bit"} rather than by returning 429, so the usual status-based backoff
#: never sees it. Measured live: a burst of three requests ~6s apart already
#: drew that response once. 1/s is well inside what the archive tolerates, and
#: the whole point of this lane is that it keeps working unattended.
ARCTIC_SHIFT_LIMITER = RateLimiter(rate_per_sec=1.0, burst=2)


def _is_private_http(url: str) -> bool:
    """Is this a plain-http URL to an address on this machine or this network?

    RESOLVES the hostname and requires EVERY returned address to be private,
    rather than trusting the name. `localhost` is not special-cased and gets no
    exemption: on a misconfigured box it can point anywhere, and a hostname that
    merely looks local is exactly the shape an SSRF payload takes
    (`http://127.0.0.1\\@evil.example` parses one way and connects another).

    Requiring ALL addresses to be private, not any, closes the split-horizon
    case where a name answers with both a private and a public address and the
    connection picks whichever it likes.

    Returns False on anything it cannot prove — an unresolvable host, a parse
    failure, an embedded credential, a non-default port smuggling a second URL.
    Fail closed, as everywhere else in this service.
    """
    try:
        parsed = urllib.parse.urlsplit(url)
    except ValueError:
        return False

    if parsed.scheme != "http":
        return False
    # Credentials in the authority are the classic parser-differential vector:
    # `http://127.0.0.1@evil.example/` has hostname `evil.example`, but plenty of
    # readers see the first host. Nothing here needs userinfo, so refuse it.
    if parsed.username or parsed.password:
        return False
    # A backslash, tab, CR or LF in the authority is likewise only ever an
    # attempt to make two parsers disagree.
    if any(ch in url for ch in ("\\", "\t", "\r", "\n")):
        return False

    host = parsed.hostname
    if not host:
        return False

    try:
        resolved = socket.getaddrinfo(host, parsed.port or 80, proto=socket.IPPROTO_TCP)
    except (socket.gaierror, UnicodeError, ValueError):
        return False
    if not resolved:
        return False

    for info in resolved:
        address = info[4][0]
        try:
            ip = ipaddress.ip_address(address)
        except ValueError:
            return False
        # `is_private` already covers loopback, link-local and the RFC1918 and
        # unique-local ranges, which is exactly the set that cannot leave this
        # host or its container network.
        if not ip.is_private:
            return False
    return True


def _classify(status: int, url: str, body: str) -> SourceUnavailable:
    """Turn an HTTP status into the RIGHT named error.

    403 is singled out on purpose. It is not a generic failure here — it is the
    documented, expected condition for every keyless adapter running from a
    datacenter IP, and the operator's remedy is completely different from the
    remedy for a 500.
    """
    excerpt = body[:200].replace("\n", " ")
    if status == 403:
        return SourceBlocked(
            f"HTTP 403 from {url}. This is the expected response when the host "
            f"refuses a datacenter egress range; the keyless adapters were only "
            f"verified from a residential IP. Body began: {excerpt!r}"
        )
    if status == 429:
        return SourceRateLimited(f"HTTP 429 from {url}. Body began: {excerpt!r}")
    return SourceUnavailable(f"HTTP {status} from {url}. Body began: {excerpt!r}")


def _request(
    url: str,
    *,
    accept: str,
    user_agent: str,
    timeout: int,
    headers: dict[str, str] | None = None,
) -> str:
    request = urllib.request.Request(url, method="GET")
    if not url.startswith("https://") and not _is_private_http(url):
        # Refusing plaintext is not paranoia: every REMOTE endpoint this service
        # talks to offers https, and a public http URL in an adapter is a typo or
        # an injected value, both of which should fail loudly.
        #
        # The one exception is a service on this machine or this container
        # network — a local SearXNG has no certificate and needs none, since the
        # traffic never leaves the host. `_is_private_http` decides that by
        # RESOLVING the host and checking the addresses, not by pattern-matching
        # the string, because a name is not evidence of where it points.
        raise SourceUnavailable(
            f"Refusing a non-https request to {url}. Plain http is permitted only "
            "to an address that resolves entirely inside loopback or private "
            "space; this one does not."
        )
    request.add_header("User-Agent", user_agent)
    request.add_header("Accept", accept)
    request.add_header("Accept-Language", "en-US,en;q=0.9")
    for key, value in (headers or {}).items():
        request.add_header(key, value)

    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read()
            status = response.status
            body = raw.decode("utf-8", errors="replace")
    except urllib.error.HTTPError as error:
        body = ""
        try:
            body = error.read().decode("utf-8", errors="replace")
        except Exception:
            body = ""
        raise _classify(error.code, url, body) from error
    except urllib.error.URLError as error:
        raise SourceUnavailable(f"Could not reach {url}: {error.reason}") from error
    except TimeoutError as error:
        raise SourceUnavailable(f"Timed out after {timeout}s reaching {url}.") from error

    # A 2xx is not automatically a result. DuckDuckGo serves its anomaly
    # challenge as HTTP 202 with a body that contains no results at all, which
    # upstream documents in web_search_keyless.py. Callers detect that by
    # finding zero parsed results and moving to the next rung of the ladder;
    # this function only guarantees the status was a success.
    if status >= 400:
        raise _classify(status, url, body)
    return body


def get_text(
    url: str,
    *,
    accept: str = "text/html",
    timeout: int = DEFAULT_TIMEOUT,
    browser_ua: bool = True,
) -> str:
    """Fetch an HTML/XML endpoint. Raises a named error; never returns None."""
    return _request(
        url,
        accept=accept,
        user_agent=BROWSER_USER_AGENT if browser_ua else USER_AGENT,
        timeout=timeout,
    )


def get_json(
    url: str,
    *,
    timeout: int = DEFAULT_TIMEOUT,
    headers: dict[str, str] | None = None,
) -> Any:
    """Fetch a documented JSON API. Raises a named error; never returns None."""
    body = _request(
        url,
        accept="application/json",
        user_agent=USER_AGENT,
        timeout=timeout,
        headers=headers,
    )
    try:
        return json.loads(body)
    except json.JSONDecodeError as error:
        raise SourceSchemaDrift(
            f"{url} returned a 2xx with a body that is not JSON: {body[:200]!r}"
        ) from error
