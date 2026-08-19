"""THE REDDIT GATE. One string, imported by both Reddit adapters.

It lives in its own module so that turning Reddit on means reading this file,
and so that the two adapters cannot drift into giving different reasons for the
same decision.

═══════════════════════════════════════════════════════════════════════════════
WHY REDDIT IS OFF BY DEFAULT IN HOSTED MODE
═══════════════════════════════════════════════════════════════════════════════

Two independent reasons. Either alone is sufficient; together they make hosting
this on somebody else's behalf indefensible.

1. ACCESS CONTROL.
   The keyless Reddit lanes work *because* Reddit's `.json` endpoints — and, as
   of the last probe, even `/robots.txt` — return HTTP 403, while `/search.rss`
   and `/svc/shreddit/` still return 200. Reaching the content anyway by picking
   the endpoints that have not been closed yet is routing around an access
   control. That is the precise theory pleaded in *Reddit v. Perplexity /
   SerpApi / Oxylabs* (Oct 2025) and *Reddit v. Anthropic* (Jun 2025), both
   unresolved at the time of writing.

   The credentialled path does not rescue a hosted deployment either: Reddit's
   free API tier is non-commercial-only.

2. GDPR.
   A demand signal is a person's post: a username plus a verbatim quote, which
   is personal data. Storing it makes the operator a data controller with
     (a) no lawful basis — legitimate interest does not survive a balancing test
         against a data subject who was never told, and consent is impossible to
         obtain at this scale; and
     (b) no mechanism to honour an erasure request, because a deleted Reddit
         post emits no signal that would ever reach our store.

   In self-host the operator is the only user and can make that call for
   themselves. In hosted mode the operator would be making it for strangers,
   about other strangers.

═══════════════════════════════════════════════════════════════════════════════
MITIGATIONS THAT ARE ALREADY BUILT IN — do not remove them
═══════════════════════════════════════════════════════════════════════════════

  - `DemandSignal` in apps/chat/lib/signals/types.ts has NO `author` field, so
    the wire format cannot carry a username even by accident.
  - Both Reddit adapters set `SourceItem.author = None` AT PARSE TIME, so the
    username is never held in this process, not merely never published. Only
    that answers an erasure request.
  - Snippets are capped to an excerpt. A permalink plus a short quote is a
    citation; a stored full copy is a republication.
  - Two locks, not one: the operator must both enable the source id AND set
    `REDDIT_ENABLED_ACK`.

═══════════════════════════════════════════════════════════════════════════════
ARCTIC SHIFT
═══════════════════════════════════════════════════════════════════════════════

Its public API is fine to CALL. Its SOURCE is `license: null` — all rights
reserved — so not one line of it appears anywhere in this repository, and the
historical torrent dumps are not ingested at all: they redistribute
since-deleted user content, which is the erasure problem in its purest form.
"""

from __future__ import annotations

#: The operator-facing one-paragraph version. Kept in sync by hand with
#: `REDDIT_GATE_REASON` in apps/chat/lib/signals/providers.ts — both are shown
#: next to the toggle, and a gate whose reason is buried gets flipped unread.
REDDIT_GATE_REASON = (
    "Off by default in hosted mode. The keyless Reddit lanes work because Reddit's "
    ".json endpoints return 403 while its RSS does not, which is routing around an "
    "access control — the theory in Reddit v. Perplexity (Oct 2025) and Reddit v. "
    "Anthropic (Jun 2025), both unresolved. Separately, storing posts makes the "
    "operator a GDPR data controller with no lawful basis and no way to honour "
    "erasure. Self-host operators may enable it for their own data; a hosted "
    "operator would be making that decision for strangers."
)
