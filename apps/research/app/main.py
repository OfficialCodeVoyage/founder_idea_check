"""FastAPI surface for the research sidecar.

THE WIRE CONTRACT is defined by `apps/chat/lib/signals/sidecar.ts`. Both halves
are written and tested against it:

    POST /v1/signals/{source_id}
    <- {"ok": true,  "source_id": "...", "signals": [...]}
     | {"ok": false, "source_id": "...", "kind": "...", "detail": "..."}

NOTE THE STATUS CODE. An upstream failure — a 403 from an archive, a blocked
DuckDuckGo ladder — comes back as HTTP 200 with `ok: false`, NOT as a 5xx. The
sidecar succeeded at its job, which was to try the source and report honestly
what happened. A 5xx would be indistinguishable from the sidecar itself being
broken, and `classifySidecarStatus` on the TypeScript side would then label an
upstream 403 as `missing-credential`, sending an operator to look for a key that
was never needed.
"""

from __future__ import annotations

import hmac
import ipaddress
import json
import logging
from typing import Any

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from pydantic import BaseModel, Field, field_validator

from .config import Settings, load_settings
from .errors import SourceError
from .pipeline import cluster as cluster_mod
from .pipeline import dedupe, fusion, grounding, rerank
from .schema import Candidate, QueryPlan, SourceItem, SubQuery, to_demand_signal
from .simulation import personas as persona_lib
from .simulation.oasis_runner import SimulationUnavailable, run_simulation
from .sources.base import SourceQuery
from .sources.registry import ALL_DESCRIPTORS, find_descriptor, resolve_permitted_source

app = FastAPI(title="idea_check research sidecar", version="0.1.0")

# Read once at import. Configuration that could change per-request would make
# the legal gate racy, and a racy legal gate is not a gate.
SETTINGS: Settings = load_settings()

log = logging.getLogger("research.sidecar")


# ─────────────────────────────────────────────────────────────────────────────
# WHO MAY SPEND THIS PROCESS'S KEYS.
#
# `/v1/simulate` spends `OPENAI_API_KEY` and `/v1/signals` spends `GITHUB_TOKEN`
# (and is an open search proxy besides), so both require a caller this process
# trusts. `/v1/health` stays open: it reports names and gate positions, never a
# value, and it is what an operator reads to find out why a call was refused.
#
# THE RULE, in order:
#   1. `RESEARCH_SIDECAR_TOKEN` set -> every caller must send
#      `Authorization: Bearer <token>`, from loopback or not. Compared in
#      constant time, so the response time does not leak a prefix.
#   2. unset, `RESEARCH_SIDECAR_ALLOW_UNAUTHENTICATED` true -> any caller.
#      Only for the containerised dev sidecar, whose published port is bound to
#      127.0.0.1 on the host but which sees the host's requests arrive from the
#      Docker bridge address. Never in a deployed environment.
#   3. unset -> loopback callers only, and one warning at startup.
#
# THE TRADE-OFF in (3), stated once. It keeps a stranger's first run at zero
# configuration: `uvicorn app.main:app` binds 127.0.0.1 and the app on the same
# machine calls it from loopback, so nothing has to be generated or copied
# between two env files before research works. What it gives up is protection
# from other processes and users on the same host, and from a reverse proxy on
# the same host that forwards remote traffic WITHOUT an X-Forwarded-For header
# (uvicorn trusts that header from 127.0.0.1 by default, so a proxy that sets
# it is seen as the remote address and refused). Any deployment where the app
# reaches the sidecar over a network — Vercel to anywhere — cannot use (3) and
# must set the token on both sides.
# ─────────────────────────────────────────────────────────────────────────────


def _is_loopback(host: str | None) -> bool:
    if not host:
        return False
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        # A hostname rather than an address (Starlette's TestClient reports
        # "testclient"). Never trusted by name: a name is not a network fact.
        return False
    # Python 3.11 does not count `::ffff:127.0.0.1` as loopback; a dual-stack
    # listener reports IPv4 loopback callers in exactly that form.
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped is not None:
        return address.ipv4_mapped.is_loopback
    return address.is_loopback


def _bearer(authorization: str | None) -> str | None:
    if not authorization:
        return None
    scheme, _, value = authorization.partition(" ")
    if scheme.lower() != "bearer":
        return None
    return value.strip() or None


def require_caller(
    request: Request,
    authorization: str | None = Header(default=None),
) -> None:
    """FastAPI dependency on every endpoint that spends. See THE RULE above.

    401 for a missing or wrong token, 403 for a refused unauthenticated caller.
    Both map to `missing-credential` in `classifySidecarStatus`, which is the
    accurate name for either: the remedy is RESEARCH_SIDECAR_TOKEN.
    """
    expected = SETTINGS.sidecar_token
    if expected:
        presented = _bearer(authorization)
        if presented is None or not hmac.compare_digest(
            presented.encode("utf-8"), expected.encode("utf-8")
        ):
            raise HTTPException(
                status_code=401,
                detail="This sidecar requires RESEARCH_SIDECAR_TOKEN; the request "
                "carried no matching bearer token.",
                headers={"WWW-Authenticate": "Bearer"},
            )
        return

    if SETTINGS.allow_unauthenticated:
        return

    host = request.client.host if request.client else None
    if not _is_loopback(host):
        raise HTTPException(
            status_code=403,
            detail="RESEARCH_SIDECAR_TOKEN is not set, so this sidecar serves "
            "loopback callers only. Set the same token in the app's and the "
            "sidecar's environment to call it over a network.",
        )


def _caller_auth_mode() -> str:
    if SETTINGS.sidecar_token:
        return "token"
    if SETTINGS.allow_unauthenticated:
        return "unauthenticated"
    return "loopback-only"


if not SETTINGS.sidecar_token:
    log.warning(
        "RESEARCH_SIDECAR_TOKEN is not set: %s",
        "serving ANY caller because RESEARCH_SIDECAR_ALLOW_UNAUTHENTICATED is on"
        if SETTINGS.allow_unauthenticated
        else "serving loopback callers only",
    )


#: The most seats one simulation may seat. MIRRORS `MAX_SIMULATION_SEATS` in
#: `apps/chat/lib/research/simulation.ts`, which the app enforces first; this
#: is the backstop for any other caller. Every OASIS agent is one model call per
#: round, so this bounds what one request can spend on this process's key.
MAX_SIMULATION_PERSONAS = 10

#: MIRRORS `MAX_SIMULATION_PITCH_CHARS` in the same file. The default pitch is
#: a stored fact, and the app caps a fact value at 2,000 characters, so a real
#: pitch fits. Python counts code points where JavaScript counts UTF-16 units,
#: so the app's check is never the looser of the two.
MAX_SIMULATION_PITCH_CHARS = 2000

#: MIRRORS `MAX_PERSONA_ENTRY_CHARS` in `apps/chat/lib/research/simulation.ts`,
#: where the sizing is explained: every agent's prompt carries its entry on
#: every round, and the app appends the project's facts to each one. Measured
#: as compact JSON with non-ASCII kept literal, which is what `JSON.stringify`
#: produces; JavaScript counts UTF-16 units, so the app's check is never the
#: looser of the two.
MAX_PERSONA_ENTRY_CHARS = 16_000


def _entry_chars(entry: dict[str, Any]) -> int:
    return len(json.dumps(entry, ensure_ascii=False, separators=(",", ":")))


class SignalRequest(BaseModel):
    query: str = Field(min_length=1)
    limit: int = Field(default=25, ge=1, le=100)
    date_from: str
    date_to: str
    options: dict[str, Any] = Field(default_factory=dict)


class SimulationRequest(BaseModel):
    personas: list[dict[str, Any]] = Field(max_length=MAX_SIMULATION_PERSONAS)
    pitch: str = Field(min_length=1, max_length=MAX_SIMULATION_PITCH_CHARS)
    rounds: int = Field(default=2, ge=1, le=10)

    @field_validator("personas")
    @classmethod
    def _each_persona_fits(cls, personas: list[dict[str, Any]]) -> list[dict[str, Any]]:
        # A 422, not the named 200 refusals `run_simulation` gives: the app
        # never sends an entry this large, so reaching here means a caller that
        # is not the app, and it gets the framework's validation error.
        for index, entry in enumerate(personas):
            size = _entry_chars(entry)
            if size > MAX_PERSONA_ENTRY_CHARS:
                raise ValueError(
                    f"persona {index} is {size} characters as JSON; "
                    f"the limit is {MAX_PERSONA_ENTRY_CHARS}"
                )
        return personas


def _failure(source_id: str, kind: str, detail: str) -> dict:
    return {"ok": False, "source_id": source_id, "kind": kind, "detail": detail}


@app.get("/v1/health")
def health() -> dict:
    """What this deployment will and will not run, and why.

    Exposed rather than logged because a thin research report is nearly always
    explained by a gate decision, and the fastest way to that answer should not
    be reading someone's container logs.
    """
    return {
        "ok": True,
        "hosted": SETTINGS.deployment.hosted,
        # How a spending call is authorised: "token", "loopback-only" or
        # "unauthenticated". The mode, never the token, and not even whether a
        # token is long or short.
        "caller_auth": _caller_auth_mode(),
        # Names only. Values never leave `config.py`.
        "credentials_present": sorted(SETTINGS.deployment.available_credentials),
        "unknown_source_ids": list(SETTINGS.unknown_source_ids),
        "sources": [
            {
                "id": descriptor.id,
                "label": descriptor.label,
                "enabled_in_hosted": descriptor.enabled_in_hosted,
                "enabled_in_self_host": descriptor.enabled_in_self_host,
                "operator_enabled": descriptor.id in SETTINGS.deployment.operator_enabled,
                "gate_reason": descriptor.gate_reason,
            }
            for descriptor in ALL_DESCRIPTORS
        ],
    }


@app.post("/v1/signals/{source_id}", dependencies=[Depends(require_caller)])
def fetch_signals(source_id: str, request: SignalRequest) -> dict:
    """Run ONE source and report honestly what happened."""
    if find_descriptor(source_id) is None:
        return _failure(
            source_id,
            "schema-drift",
            f"No source is registered under the id {source_id!r}.",
        )

    try:
        source = resolve_permitted_source(source_id, SETTINGS)
    except SourceError as error:
        # Includes the gate refusals — `disabled` and `missing-credential`.
        return _failure(source_id, error.kind, error.detail)

    query = SourceQuery(
        query=request.query,
        date_from=request.date_from,
        date_to=request.date_to,
        limit=request.limit,
        options=request.options,
    )

    try:
        items = source.fetch(query)
    except SourceError as error:
        return _failure(source_id, error.kind, error.detail)
    except Exception as error:
        # An adapter that raises something other than a SourceError has violated
        # its contract. Reported as `schema-drift` rather than `unavailable`
        # because the fix is a code change, not a retry.
        return _failure(
            source_id,
            "schema-drift",
            f"{source_id} raised {type(error).__name__} instead of a SourceError: {error}",
        )

    candidates = _pipeline(items, source, request)
    return {
        "ok": True,
        "source_id": source_id,
        "signals": [to_demand_signal(candidate) for candidate in candidates],
    }


def _pipeline(items: list[SourceItem], source: Any, request: SignalRequest) -> list[Candidate]:
    """Score, dedupe, fuse, ground. Pure functions, called in one place."""
    descriptor = source.descriptor
    for item in items:
        item.local_relevance = item.relevance_hint
        item.source_quality = descriptor.source_quality
        item.freshness = rerank.freshness_score(
            item.published_at, request.date_from, request.date_to
        )
        item.engagement_score = rerank.engagement_score(item.engagement)

    items = dedupe.dedupe_items(items)

    plan = QueryPlan(
        raw_topic=request.query,
        # Single-source requests are not clustered: clustering exists to merge
        # the same story across sources, and there is only one here.
        intent="single-source",
        cluster_mode="none",
        subqueries=[
            SubQuery(
                label="primary",
                search_query=request.query,
                ranking_query=request.query,
                sources=[descriptor.id],
            )
        ],
        source_weights={descriptor.id: 1.0},
    )

    candidates = fusion.weighted_rrf(
        {("primary", descriptor.id): items},
        plan,
        pool_limit=request.limit,
        range_from=request.date_from,
        range_to=request.date_to,
    )
    candidates = rerank.score_candidates(candidates)

    # Grounding over the urls the adapter actually returned. A candidate whose
    # url did not come from this fetch cannot have been fetched, and a citation
    # to something we never retrieved is worse than no citation.
    report = grounding.ground_candidates(candidates, {item.url for item in items})
    return report.grounded


@app.post("/v1/simulate", dependencies=[Depends(require_caller)])
def simulate(request: SimulationRequest) -> dict:
    """STEP 8. Runs a persona simulation and judges whether it collapsed.

    Never 5xx for an expected condition. `oasis-not-installed` is the normal
    state of the default image, not an error.
    """
    try:
        result = run_simulation(request.personas, request.pitch, request.rounds)
    except SimulationUnavailable as error:
        return {"ok": False, "kind": error.kind, "detail": error.detail}
    except Exception as error:
        return {
            "ok": False,
            "kind": "simulation-failed",
            "detail": f"{type(error).__name__}: {error}",
        }

    reactions = result.reactions

    # ZERO REACTIONS IS A REFUSAL, NOT A VERDICT.
    #
    # This is the shape that produced the worst bug this service has had. Every
    # agent call 400'd, OASIS swallowed each one, the run "succeeded" with an
    # empty list, and the app judged that list: divergence undefined, therefore
    # `usable: false`, stored and rendered as COLLAPSED. A run in which nothing
    # happened became indistinguishable from a run in which the personas
    # unanimously agreed — and those two facts point the founder in opposite
    # directions.
    #
    # So an empty result never reaches `judge`. It returns a NAMED failure with
    # the agent-error count attached, which is the difference between "your
    # personas all said the same thing" and "none of them could be reached".
    # BELOW TWO, not just zero. One reaction has the identical pathology: it
    # cannot be judged, and reporting it as `usable: false` puts the COLLAPSED
    # badge on a run that was never assessed. Verified live on 2026-08-21 — a
    # two-agent luna run returned exactly one comment and, before this, a
    # `usable: false` verdict alongside it.
    if len(reactions) < 2:
        blamed = (
            f"{result.agent_errors} agent action(s) failed"
            if result.agent_errors
            else "no agent action failed, so the personas were reached and simply posted nothing"
        )
        samples = "; ".join(result.agent_error_samples)
        produced = (
            "no reactions at all"
            if not reactions
            else "a single reaction, and divergence is undefined below two"
        )
        return {
            "ok": False,
            "kind": "no-reactions" if not reactions else "too-few-reactions",
            "detail": (
                f"The simulation ran and produced {produced}: {blamed}."
                + (f" First failures: {samples}" if samples else "")
                + " Nothing can be concluded about divergence from this run, which "
                "is a different fact from the personas having converged."
            ),
            "agentErrors": result.agent_errors,
            "agentErrorSamples": result.agent_error_samples,
            "modelValidated": result.model_validated,
            # The partial result is still returned so the founder can read what
            # the one persona that answered actually said.
            "reactions": [
                {"username": r.username, "text": r.text, "sentiment": r.sentiment}
                for r in reactions
            ],
        }

    return {
        "ok": True,
        # Hand-built rather than `asdict` so that adding a field to Reaction is
        # a deliberate act here too — a field that reaches the sidecar boundary
        # but not the client is worse than one that was never added, because the
        # producer's tests pass and the consumer sees nothing.
        "reactions": [
            {
                "username": r.username,
                "text": r.text,
                "sentiment": r.sentiment,
                "kind": r.kind,
                "reactionId": r.reaction_id,
                "parentId": r.parent_id,
                # None stays None across the wire. `round or 0` would file an
                # unmeasured reaction into the seed round.
                "round": r.round,
            }
            for r in reactions
        ],
        # The verdict travels with the reactions so a caller that ignores it
        # still has it in the payload it logs.
        "verdict": persona_lib.judge(reactions),
        # A run can be PARTIAL: four agents, two of them 400'd, two answered.
        # Divergence over the survivors is measurable but it is not divergence
        # over the population the founder chose, so the count travels with it
        # rather than being dropped because the run "worked".
        "agentErrors": result.agent_errors,
        "agentErrorSamples": result.agent_error_samples,
        "modelValidated": result.model_validated,
    }


# Referenced so the module-level import is not flagged as unused. `cluster` is
# used by the multi-source path in `apps/chat/lib/research/loop.ts`, which posts
# several sources' items back for fusion; it is exported here so both paths use
# one implementation.
CLUSTER_CANDIDATES = cluster_mod.cluster_candidates
