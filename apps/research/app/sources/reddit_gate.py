"""THE REDDIT POLICY. Read it before adding or changing any Reddit lane.

This module holds no code. It is the reasoning behind how this service treats
Reddit content, kept in one place so that a change to the Arctic Shift lane, or
a proposal for a new Reddit lane, starts by reading why the current shape is
what it is. The mechanism that enforces it is not here: it is
`sources/base.py::assert_permitted` on this side and `decideProviderGate` in
apps/chat/lib/signals/provider.ts on the other, applied to each descriptor's
`enabled_in_hosted`, `enabled_in_self_host`, `required_credentials` and
`gate_reason`.

═══════════════════════════════════════════════════════════════════════════════
WHAT SHIPS, AND WHAT DOES NOT
═══════════════════════════════════════════════════════════════════════════════

ONE Reddit lane ships: `arctic-shift` (`sources/arctic_shift.py`). It calls a
third party's documented public API, from that party's own hosting. It never
touches Reddit's own servers for content.

NO lane that reads Reddit's own site without a Reddit credential ships. Two did
once (an RSS/Atom discovery lane and an HTML comment-enrichment lane) and were
removed before the first public release, for the reason below. Do not add a
replacement that reads the same endpoints by another route.

═══════════════════════════════════════════════════════════════════════════════
WHY A KEYLESS LANE ON REDDIT'S OWN EDGE IS NOT SHIPPED
═══════════════════════════════════════════════════════════════════════════════

Two independent reasons. Either alone is sufficient.

1. ACCESS CONTROL.
   Such a lane works *because* Reddit's `.json` endpoints — and, as of the last
   probe, even `/robots.txt` — return HTTP 403 to unauthenticated clients while
   other endpoints on the same site still answered 200. Reaching the content
   anyway by picking the endpoints that have not been closed yet is routing
   around an access control. That is the precise theory
   pleaded in *Reddit v. Perplexity / SerpApi / Oxylabs* (Oct 2025) and
   *Reddit v. Anthropic* (Jun 2025), both unresolved at the time of writing.

   A credentialled path does not rescue a hosted deployment either: Reddit's
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
   about other strangers. This half applies to the Arctic Shift lane too, which
   is why the mitigations below exist.

═══════════════════════════════════════════════════════════════════════════════
MITIGATIONS THAT ARE ALREADY BUILT IN — do not remove them
═══════════════════════════════════════════════════════════════════════════════

  - `DemandSignal` in apps/chat/lib/signals/types.ts has NO `author` field, so
    the wire format cannot carry a username even by accident.
  - The Arctic Shift lane asks the archive for an explicit field list that
    excludes `author`, so the username is never received, and it also sets
    `SourceItem.author = None` AT PARSE TIME in case the archive sends one
    anyway. Only never holding the identifier answers an erasure request. Any
    future Reddit lane must do at least the second.
  - Snippets are capped to an excerpt. A permalink plus a short quote is a
    citation; a stored full copy is a republication.
  - A lane that needs a credential is refused when it is missing and never falls
    back to a keyless path (`assert_permitted`). A lane that must stay off in
    hosted mode says so with `enabled_in_hosted=False`, and that bar is checked
    before the operator toggle.

═══════════════════════════════════════════════════════════════════════════════
ARCTIC SHIFT
═══════════════════════════════════════════════════════════════════════════════

Its public API is fine to CALL. Its SOURCE is `license: null` — all rights
reserved — so not one line of it appears anywhere in this repository, and the
historical torrent dumps are not ingested at all: they redistribute
since-deleted user content, which is the erasure problem in its purest form.
"""
