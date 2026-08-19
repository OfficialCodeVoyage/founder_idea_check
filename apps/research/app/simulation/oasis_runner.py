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
import os
import sqlite3
import tempfile
from pathlib import Path

from .personas import Reaction, score_sentiment, validate_personas


class SimulationUnavailable(Exception):
    """OASIS is not installed, or could not be started."""

    def __init__(self, kind: str, detail: str) -> None:
        super().__init__(detail)
        self.kind = kind
        self.detail = detail


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

    model_type = os.environ.get("RESEARCH_SIM_MODEL", "gpt-4o-mini")
    base_url = os.environ.get("RESEARCH_SIM_BASE_URL", "").strip()

    kwargs = {"model_platform": ModelPlatformType.OPENAI, "model_type": model_type}
    if base_url:
        kwargs["url"] = base_url
    return ModelFactory.create(**kwargs)


def _read_reactions(db_path: Path, usernames: list[str]) -> list[Reaction]:
    """Read agent utterances out of the OASIS sqlite database.

    The `post` and `comment` tables are what an agent actually SAID; the `trace`
    table records that it acted. Both are queried because a persona reacting to
    a pitch may create a post or comment on one, and treating a comment as
    "no reaction" would understate divergence.
    """
    if not db_path.exists():
        raise SimulationUnavailable(
            "no-simulation-database",
            f"OASIS was asked to write {db_path} but no database exists, so no "
            "reactions can be read. The run did not complete.",
        )

    reactions: list[Reaction] = []
    connection = sqlite3.connect(db_path)
    try:
        connection.row_factory = sqlite3.Row
        for table, column in (("post", "content"), ("comment", "content")):
            try:
                rows = connection.execute(
                    f"SELECT user_id, {column} AS text FROM {table}"
                ).fetchall()
            except sqlite3.Error:
                # A table OASIS did not create in this run. Not a failure: the
                # other table may still carry every reaction.
                continue
            for row in rows:
                text = (row["text"] or "").strip()
                if not text:
                    continue
                index = int(row["user_id"] or 0)
                username = usernames[index] if 0 <= index < len(usernames) else f"agent-{index}"
                reactions.append(
                    Reaction(username=username, text=text, sentiment=score_sentiment(text))
                )
    finally:
        connection.close()

    return reactions


async def _run(personas: list[dict], pitch: str, rounds: int, workdir: Path) -> list[Reaction]:
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

        for _ in range(max(1, rounds)):
            await env.step({agent: oasis.LLMAction() for _, agent in env.agent_graph.get_agents()})
    finally:
        await env.close()

    return _read_reactions(db_path, [str(p["username"]) for p in personas])


def run_simulation(personas: list[dict], pitch: str, rounds: int = 2) -> list[Reaction]:
    """THE SEAM. Validates, runs OASIS, returns reactions.

    Validation happens BEFORE the OASIS import, so a malformed persona costs a
    millisecond rather than a torch load followed by a KeyError.
    """
    problems = validate_personas(personas)
    if problems:
        raise SimulationUnavailable("invalid-personas", "; ".join(problems))

    with tempfile.TemporaryDirectory(prefix="oasis-run-") as tmp:
        return asyncio.run(_run(personas, pitch, rounds, Path(tmp)))
