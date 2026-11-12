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

from typing import Any

from fastapi import FastAPI
from pydantic import BaseModel, Field

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


class SignalRequest(BaseModel):
    query: str = Field(min_length=1)
    limit: int = Field(default=25, ge=1, le=100)
    date_from: str
    date_to: str
    options: dict[str, Any] = Field(default_factory=dict)


class SimulationRequest(BaseModel):
    personas: list[dict[str, Any]]
    pitch: str = Field(min_length=1)
    rounds: int = Field(default=2, ge=1, le=10)


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


@app.post("/v1/signals/{source_id}")
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


@app.post("/v1/simulate")
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
            else "no agent action failed, so the personas were reached and simply "
            "posted nothing"
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
