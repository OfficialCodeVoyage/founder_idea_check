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

    # (max post_id, max comment_id) after each step. Index 0 is the seed round.
    watermarks: list[tuple[int, int]] = []

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

    return _read_reactions(
        db_path, [str(p["username"]) for p in personas], pitch, watermarks
    )


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
