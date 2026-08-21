"""STEP 8, the IMPURE half: the one seam that actually calls OASIS.

`camel-ai/oasis` @ 40bf1705, Apache-2.0. No OASIS code is copied here — this
module only calls its documented public API, which is the twelve names exported
from `oasis/__init__.py`.

WHY THE IMPORT IS LAZY, INSIDE THE FUNCTION. `import oasis` is not free:

  - `oasis/social_platform/recsys.py:26-29` imports torch, sentence-transformers
    and scikit-learn at module scope, and line 46 runs
    `torch.device("cuda" if torch.cuda.is_available() else "cpu")` at import
    time. `oasis/__init__.py` imports that module transitively, so merely
    importing the package pulls a multi-gigabyte ML stack and probes CUDA.
  - `oasis/environment/env.py:30-32`, `platform.py:37-39` and `agent.py:44-45`
    create `./log/` and open log files RELATIVE TO THE CURRENT DIRECTORY at
    import time, so an unwritable CWD makes the import itself fail.

A top-level import would therefore make every signal endpoint in this service
depend on a working ML stack and a writable CWD. The signal endpoints are what
the phase gate actually needs; the simulation is an extra. So the import happens
inside `run_simulation`, and its absence is a NAMED condition
(`oasis-not-installed`) rather than a stack trace at startup.

WHAT WE READ BACK. `env.step()` returns `None` (`oasis/environment/env.py:136`).
Every agent action lands in the sqlite `trace` table instead, which `close()`
names explicitly. So results are read with a plain SQL query, not from a return
value.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import sqlite3
import tempfile
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

from .personas import Reaction, score_sentiment, validate_personas

#: OpenAI's own endpoint, used when no gateway is configured.
DEFAULT_BASE_URL = "https://api.openai.com/v1"


class SimulationUnavailable(Exception):
    """OASIS is not installed, or could not be started."""

    def __init__(self, kind: str, detail: str) -> None:
        super().__init__(detail)
        self.kind = kind
        self.detail = detail


@dataclass(frozen=True)
class SimulationResult:
    """What a run produced, INCLUDING what it failed to produce.

    This used to be a bare `list[Reaction]`, and that is precisely how a run in
    which every single model call returned 400 became indistinguishable from a
    run in which every persona genuinely agreed. Both are an empty list. The
    caller then judged the empty list, found divergence undefined, and stored
    `usable: false` — a verdict, on a run that never happened.

    So the failures travel WITH the reactions. `agent_errors` is the number of
    per-agent failures OASIS logged and swallowed; `agent_error_samples` carries
    the first few messages so the app can say WHY rather than merely that.
    """

    reactions: list[Reaction]
    #: How many agent actions failed. 0 means none failed, not "unknown" —
    #: `run_simulation` always counts, so this is never a stand-in for absence.
    agent_errors: int = 0
    agent_error_samples: list[str] = field(default_factory=list)
    #: True  — the provider confirmed this model id exists.
    #: None  — the check could not be made (no key, gateway without /models).
    #: Never False: a model id known to be wrong raises instead of returning.
    model_validated: bool | None = None


class _AgentErrorCounter(logging.Handler):
    """Counts the per-agent failures OASIS logs and then swallows.

    `oasis/social_agent/agent.py:153-155` @ 40bf1705 catches every exception a
    model call raises, logs one ERROR record to the `social.agent` logger, and
    RETURNS the exception object instead of raising it. Nothing upstream ever
    sees it, so a run where all N agents 400'd completes "successfully" with no
    reactions. One ERROR record per failed agent action is therefore the only
    signal OASIS emits, and this handler is the only place it can be read.
    """

    def __init__(self) -> None:
        super().__init__(level=logging.ERROR)
        self.count = 0
        self.samples: list[str] = []

    def emit(self, record: logging.LogRecord) -> None:
        if record.levelno < logging.ERROR:
            return
        self.count += 1
        if len(self.samples) < 5:
            try:
                self.samples.append(record.getMessage())
            # A record that cannot be formatted must not kill a live run; the
            # count is still correct, only this sample is unavailable.
            except Exception:
                self.samples.append("<log record could not be formatted>")


#: The model every OASIS agent uses unless RESEARCH_SIM_MODEL says otherwise.
#:
#: Moved off gpt-4o-mini on 2026-08-21. TAU-Bench measures agentic tool use in
#: multi-turn conversation, which is precisely what an OASIS agent does, and
#: gpt-4o-mini scores 26.7% against luna's 70.7%. The cost of the change is a
#: rounding error: a 2-agent, 2-round run goes from about $0.0022 to $0.0031,
#: and even 10 agents over 5 rounds stays under four cents.
#:
#: READ THIS BEFORE CHANGING IT. luna cannot be selected on its own. Every OASIS
#: action is a function tool call, CAMEL posts to chat/completions, and this
#: family rejects function tools there unless reasoning effort is off — so a
#: bare model swap would have made "every agent 400s" the DEFAULT behaviour.
#: `_default_reasoning_effort` below is the other half of this change and the
#: two must move together.
DEFAULT_MODEL = "gpt-5.6-luna"

#: Model prefixes that reject function tools on chat/completions at any
#: reasoning effort above "none". MEASURED, not documented: the docs say this
#: family supports chat/completions, and it does — until you attach a tool.
REASONING_TOOL_MODEL_PREFIXES = ("gpt-5.6-",)


def _model_id() -> str:
    """The model every OASIS agent will use."""
    return os.environ.get("RESEARCH_SIM_MODEL", DEFAULT_MODEL)


def _default_reasoning_effort(model_type: str) -> str:
    """The effort to send when nobody has said, derived from the model.

    A FIXED DEFAULT WOULD BE WRONG IN BOTH DIRECTIONS. Always sending
    `reasoning_effort` breaks gpt-4o-mini, which rejects the key outright.
    Never sending it breaks every 5.6 model, which rejects the tool call. So
    the default follows the model, and an explicit environment value still
    wins over it.
    """
    return (
        "none" if model_type.startswith(REASONING_TOOL_MODEL_PREFIXES) else ""
    )


def _validate_model_id(model_type: str) -> bool | None:
    """Ask the provider whether this model id exists, BEFORE the run.

    WHY THIS EXISTS. CAMEL accepts any string as a model type. A typo does not
    raise: `not-a-real-model-xyz` constructs fine, is wrapped in
    `UnifiedModelType`, and reports `token_limit=999_999_999`. It then fails at
    call time, once per agent, inside the swallow described on
    `_AgentErrorCounter` — so a misspelled model is a silent zero-reaction run.

    WHY NOT CHECK `token_limit`. Because it does not distinguish a typo from a
    new model. Verified 2026-08-21: `gpt-5.6-luna` and `not-a-real-model-xyz`
    BOTH construct as `UnifiedModelType` with `token_limit=999_999_999`, while
    `gpt-4o-mini` reports 128000. Rejecting on the sentinel would reject every
    model newer than CAMEL's enum, which is the opposite of the intent here.

    So the provider is asked directly. `GET {base}/models/{id}` returns 200 for
    a real model and 404 for a typo — verified against all three ids above.

    A 404 is loud. Anything else is NOT treated as a failure: no API key, a
    gateway that does not implement `/models`, or a network blip cannot tell us
    the id is wrong, and failing the run on those would break every
    self-hosted deployment. Those return None — "not checked" — which is a
    different fact from "checked and fine", and is reported as such.
    """
    key = os.environ.get("OPENAI_API_KEY", "").strip()
    if not key:
        return None

    base = os.environ.get("RESEARCH_SIM_BASE_URL", "").strip() or DEFAULT_BASE_URL
    request = urllib.request.Request(
        f"{base.rstrip('/')}/models/{model_type}",
        headers={"Authorization": f"Bearer {key}"},
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return 200 <= response.status < 300
    except urllib.error.HTTPError as error:
        if error.code == 404:
            raise SimulationUnavailable(
                "unknown-simulation-model",
                f"The provider does not have a model called {model_type!r} "
                f"(RESEARCH_SIM_MODEL). Every agent in this run would have failed "
                f"at call time, one at a time, and the run would have returned "
                f"zero reactions with no stated reason.",
            ) from error
        # 401, 403, 429, 5xx: all say something about the request or the
        # provider, and nothing about whether the model id is real.
        return None
    # An unreachable provider says nothing about whether the model id is real.
    except Exception:
        return None


def _require_oasis():
    """Import OASIS lazily. Raises a NAMED condition when it is absent."""
    try:
        import oasis
    except ImportError as error:
        raise SimulationUnavailable(
            "oasis-not-installed",
            "The simulation extra is not installed in this image. Install it with "
            "`pip install -e '.[simulation]'` (this pulls torch and "
            "sentence-transformers, which is why it is optional). Underlying import "
            f"error: {error}",
        ) from error
    return oasis


def _build_model(oasis_module):
    """Construct the CAMEL model backend OASIS agents will use.

    OASIS constructs no model of its own: `model` is passed straight through to
    CAMEL's `ChatAgent` (`oasis/social_agent/agent.py:106-111`). CAMEL's
    `ModelFactory.create` takes `url=` — NOT `base_url=` — which is what lets a
    self-hoster point this at any OpenAI-compatible gateway
    (`docs/key_modules/models.mdx:28-38`).

    NOTE for anyone extending this: the repo demonstrates only the OPENAI, QWEN
    and VLLM platform enums. There is no `OPENAI_COMPATIBLE_MODEL` usage
    anywhere in OASIS, so pointing at an arbitrary gateway relies on CAMEL's
    enum, not on an OASIS-documented path.
    """
    try:
        from camel.models import ModelFactory
        from camel.types import ModelPlatformType
    except ImportError as error:
        raise SimulationUnavailable(
            "oasis-not-installed",
            f"OASIS is present but CAMEL is not importable: {error}",
        ) from error

    model_type = _model_id()
    base_url = os.environ.get("RESEARCH_SIM_BASE_URL", "").strip()

    kwargs = {"model_platform": ModelPlatformType.OPENAI, "model_type": model_type}
    if base_url:
        kwargs["url"] = base_url

    # CONDITIONAL, AND IT MUST STAY CONDITIONAL.
    #
    # Reasoning models reject function tools on `chat/completions` unless
    # reasoning effort is switched off, and CAMEL posts to `chat/completions`:
    #
    #   400 - "Function tools with reasoning_effort are not supported for
    #          gpt-5.6-luna in /v1/chat/completions. To use function tools, use
    #          /v1/responses or set reasoning_effort to 'none'."
    #
    # Every OASIS agent action IS a function tool call, so without this the
    # whole run 400s per agent and returns nothing. With
    # `reasoning_effort: "none"` the same model returns tool calls in 0.8s at
    # `reasoning_tokens=0` (measured through CAMEL's own ModelFactory,
    # 2026-08-21).
    #
    # It is conditional because the default model does NOT accept the key at
    # all: sending `reasoning_effort` to `gpt-4o-mini` is itself a 400. An
    # unconditional dict would fix the model nobody is using and break the one
    # everybody is.
    # UNSET and SET-TO-EMPTY are different instructions, so `.get(name, "")`
    # would be wrong here. Unset means "you decide", and the answer depends on
    # the model. Set to "" means an operator deliberately turned it off, and
    # that must be honoured even for a model this code thinks needs it.
    configured = os.environ.get("RESEARCH_SIM_REASONING_EFFORT")
    effort = (
        configured.strip()
        if configured is not None
        else _default_reasoning_effort(model_type)
    )
    if effort:
        kwargs["model_config_dict"] = {"reasoning_effort": effort}

    return ModelFactory.create(**kwargs)


def _table_exists(connection: sqlite3.Connection, table: str) -> bool:
    """Does this table exist at all?

    Split from the query attempt so that "OASIS never created this table" and
    "the table is there but its columns changed" stay distinguishable. The first
    is normal; the second must be loud.
    """
    row = connection.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=? LIMIT 1", (table,)
    ).fetchone()
    return row is not None


def _watermarks(db_path: Path) -> tuple[int, int]:
    """Highest post and comment row id currently in the database.

    Called after each `env.step()` so a row can later be attributed to the round
    that wrote it. Defensive on purpose: this runs INSIDE a live simulation, and
    failing to read a watermark must degrade `round` to None rather than kill a
    run that is otherwise producing good reactions. sqlite may also be mid-write
    and briefly locked. Opened read-only so this can never disturb OASIS.
    """
    try:
        connection = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    except sqlite3.Error:
        return (0, 0)
    try:
        highest: list[int] = []
        for table, column in (("post", "post_id"), ("comment", "comment_id")):
            try:
                row = connection.execute(f"SELECT MAX({column}) FROM {table}").fetchone()
                highest.append(int(row[0]) if row and row[0] is not None else 0)
            except sqlite3.Error:
                highest.append(0)
        return (highest[0], highest[1])
    finally:
        connection.close()


def _round_for(
    kind: str, row_id: int | None, watermarks: list[tuple[int, int]] | None
) -> int | None:
    """Which round wrote this row, from the watermarks taken after each step.

    A row belongs to the FIRST round whose high-water mark it falls within. A
    row above every watermark is attributed to the last round rather than to
    None: it exists, so something wrote it, and the final step is the only
    candidate.
    """
    if not watermarks or row_id is None:
        return None
    position = 0 if kind == "post" else 1
    for index, mark in enumerate(watermarks):
        if row_id <= mark[position]:
            return index
    return len(watermarks) - 1


def _read_reactions(
    db_path: Path,
    usernames: list[str],
    seed_text: str = "",
    watermarks: list[tuple[int, int]] | None = None,
) -> list[Reaction]:
    """Read agent utterances out of the OASIS sqlite database.

    The `post` and `comment` tables are what an agent actually SAID; the `trace`
    table records that it acted. Both are queried because a persona reacting to
    a pitch may create a post or comment on one, and treating a comment as
    "no reaction" would understate divergence.

    THE SEED POST IS NOT A REACTION. `_run` seeds the pitch as a post from agent
    0 so the others have something concrete to react to, and that post lands in
    the same `post` table as every genuine reply. Counting it inflates
    `total_reactions` and, because the pitch resembles no reply, it always
    scores as one more DISTINCT opinion — so the artefact pushes the divergence
    score UP. That is the dangerous direction: this module exists to detect a
    run collapsing onto one opinion, and an echo of the prompt was making
    collapse harder to detect. Observed live at 4 personas / 2 rounds: 1 of 8
    reactions was a verbatim echo. At the 2-persona minimum it would be 1 of 3.

    WHAT `watermarks` IS FOR. OASIS has no round column — `post.sql` and
    `comment.sql` carry only `created_at`, a simulated clock. `_run` therefore
    records `(max post_id, max comment_id)` after every `env.step()`, and a row
    belongs to the first round whose watermark it falls within. That is a fact
    about when the row was written rather than an order inferred from
    timestamps. Passing None leaves `round` None everywhere, which is
    distinguishable from round 0 on purpose.
    """
    if not db_path.exists():
        raise SimulationUnavailable(
            "no-simulation-database",
            f"OASIS was asked to write {db_path} but no database exists, so no "
            "reactions can be read. The run did not complete.",
        )

    seed = seed_text.strip()
    reactions: list[Reaction] = []
    connection = sqlite3.connect(db_path)
    try:
        connection.row_factory = sqlite3.Row
        # `original_post_id` is a post's parent (NULL unless it is a repost);
        # `post_id` is a comment's. Aliasing both to `parent` keeps one loop
        # without pretending they are the same column.
        queries = (
            (
                "post",
                "SELECT post_id AS rid, user_id, content AS text, "
                "original_post_id AS parent FROM post",
            ),
            (
                "comment",
                "SELECT comment_id AS rid, user_id, content AS text, "
                "post_id AS parent FROM comment",
            ),
        )
        for kind, query in queries:
            if not _table_exists(connection, kind):
                # A table OASIS did not create in this run. Not a failure: the
                # other table may still carry every reaction.
                continue
            try:
                rows = connection.execute(query).fetchall()
            except sqlite3.Error as error:
                # THE TABLE EXISTS AND THE QUERY STILL FAILED, so its columns
                # are not what this reader expects — an OASIS upgrade renamed
                # or dropped one. Swallowing that would return zero reactions
                # from a run that produced plenty, which is indistinguishable
                # from every persona ignoring the pitch. It is named instead.
                raise SimulationUnavailable(
                    "simulation-schema-drift",
                    f"the OASIS `{kind}` table exists but does not have the "
                    f"columns this reader needs ({error}). Reactions cannot be "
                    "read, and reporting zero would look like agent "
                    "indifference rather than a schema change.",
                ) from error
            for row in rows:
                text = (row["text"] or "").strip()
                if not text:
                    continue
                if seed and text == seed:
                    # The seeded pitch, or an agent reposting it verbatim.
                    # Neither is an opinion about the pitch.
                    continue
                index = int(row["user_id"] or 0)
                username = usernames[index] if 0 <= index < len(usernames) else f"agent-{index}"
                row_id = row["rid"]
                parent = row["parent"]
                reactions.append(
                    Reaction(
                        username=username,
                        text=text,
                        sentiment=score_sentiment(text),
                        kind=kind,
                        reaction_id=int(row_id) if row_id is not None else None,
                        # NULL preserved rather than coerced to 0: "no parent"
                        # and "parent number zero" are different facts.
                        parent_id=int(parent) if parent is not None else None,
                        round=_round_for(kind, row_id, watermarks),
                    )
                )
    finally:
        connection.close()

    return reactions


async def _run(
    personas: list[dict],
    pitch: str,
    rounds: int,
    workdir: Path,
    model_validated: bool | None = None,
) -> SimulationResult:
    oasis = _require_oasis()
    model = _build_model(oasis)

    profile_path = workdir / "personas.json"
    profile_path.write_text(json.dumps(personas), encoding="utf-8")

    db_path = workdir / "simulation.db"
    # BOTH are required. `database_path` is the documented argument, but every
    # OASIS example also sets OASIS_DB_PATH because `create_db(db_path=None)`
    # falls back to `<package_dir>/data/social_media.db`
    # (`oasis/social_platform/database.py:62-66`) — writing into site-packages.
    os.environ["OASIS_DB_PATH"] = str(db_path.resolve())

    agent_graph = await oasis.generate_reddit_agent_graph(
        profile_path=str(profile_path),
        model=model,
        available_actions=[
            oasis.ActionType.CREATE_POST,
            oasis.ActionType.CREATE_COMMENT,
            oasis.ActionType.LIKE_POST,
            oasis.ActionType.DISLIKE_POST,
            oasis.ActionType.DO_NOTHING,
        ],
    )

    env = oasis.make(
        agent_graph=agent_graph,
        platform=oasis.DefaultPlatformType.REDDIT,
        database_path=str(db_path),
        # Default is 128. A shared gateway will 429 long before that, and a 429
        # storm inside OASIS surfaces as agents that "chose to do nothing",
        # which is indistinguishable from genuine disinterest — the exact
        # confusion this service is built to avoid.
        semaphore=int(os.environ.get("RESEARCH_SIM_CONCURRENCY", "8")),
    )

    # (max post_id, max comment_id) after each step. Index 0 is the seed round.
    watermarks: list[tuple[int, int]] = []

    # Attached before the first agent acts and removed in `finally`, so the
    # count covers every round and nothing leaks into a later run. Handlers are
    # additive: OASIS's own file handler keeps working alongside this one.
    errors = _AgentErrorCounter()
    agent_log = logging.getLogger("social.agent")
    agent_log.addHandler(errors)

    try:
        await env.reset()

        # Round 0: seed the pitch as a post from agent 0, so every other agent
        # has something concrete to react to. Without a seed the agents invent
        # their own topics and the run measures nothing.
        await env.step(
            {
                env.agent_graph.get_agent(0): oasis.ManualAction(
                    action_type=oasis.ActionType.CREATE_POST,
                    action_args={"content": pitch},
                )
            }
        )

        watermarks.append(_watermarks(db_path))

        for _ in range(max(1, rounds)):
            await env.step({agent: oasis.LLMAction() for _, agent in env.agent_graph.get_agents()})
            # After the step, not before: the point is to bound what this round
            # wrote.
            watermarks.append(_watermarks(db_path))
    finally:
        await env.close()
        agent_log.removeHandler(errors)

    return SimulationResult(
        reactions=_read_reactions(
            db_path, [str(p["username"]) for p in personas], pitch, watermarks
        ),
        agent_errors=errors.count,
        agent_error_samples=list(errors.samples),
        model_validated=model_validated,
    )


def run_simulation(personas: list[dict], pitch: str, rounds: int = 2) -> SimulationResult:
    """THE SEAM. Validates, runs OASIS, returns reactions AND what failed.

    Validation happens BEFORE the OASIS import, so a malformed persona costs a
    millisecond rather than a torch load followed by a KeyError. The model id is
    checked in the same place and for the same reason: a typo that is only
    discovered at call time costs a full torch load, every agent in the run, and
    produces an empty result with no stated cause.
    """
    problems = validate_personas(personas)
    if problems:
        raise SimulationUnavailable("invalid-personas", "; ".join(problems))

    model_validated = _validate_model_id(_model_id())

    with tempfile.TemporaryDirectory(prefix="oasis-run-") as tmp:
        return asyncio.run(_run(personas, pitch, rounds, Path(tmp), model_validated))
