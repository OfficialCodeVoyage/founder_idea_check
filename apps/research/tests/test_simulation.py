"""Step 8, the pure half. Runs with no OASIS, no torch and no network installed."""

from __future__ import annotations

import sys
import types

import pytest

from app.simulation.oasis_runner import SimulationUnavailable, run_simulation
from app.simulation.personas import (
    MIN_DIVERGENCE_SCORE,
    REQUIRED_PERSONA_KEYS,
    Reaction,
    judge,
    measure_divergence,
    reaction_similarity,
    score_sentiment,
    validate_personas,
)


def persona(username: str = "busy_owner", **overrides) -> dict:
    base = {
        "username": username,
        "bio": "Pays for dog walking, hates coordinating it",
        "persona": "Works long hours, owns two dogs, pays a walker weekly.",
        "age": 34,
        "gender": "female",
        "mbti": "XXXX",
        "country": "UK",
    }
    base.update(overrides)
    return base


class TestValidatePersonas:
    def test_names_exactly_the_seven_keys_oasis_indexes_unguarded(self):
        assert set(REQUIRED_PERSONA_KEYS) == {
            "username",
            "bio",
            "persona",
            "age",
            "gender",
            "mbti",
            "country",
        }

    def test_a_complete_pair_is_fine(self):
        assert validate_personas([persona("a"), persona("b")]) == []

    def test_refuses_an_empty_list(self):
        assert validate_personas([]) != []

    def test_refuses_a_single_persona(self):
        # Divergence is undefined over one agent, and OASIS would happily
        # produce a "consensus" of one.
        problems = validate_personas([persona()])
        assert any("only one persona" in p for p in problems)

    @pytest.mark.parametrize("missing", REQUIRED_PERSONA_KEYS)
    def test_names_the_missing_oasis_key(self, missing):
        incomplete = persona("a")
        del incomplete[missing]
        problems = validate_personas([incomplete, persona("b")])
        assert any(missing in p for p in problems)

    def test_refuses_duplicate_usernames(self):
        # OASIS signs agents up by name; a duplicate makes two agents
        # indistinguishable in the trace table.
        problems = validate_personas([persona("same"), persona("same")])
        assert any("reuses the username" in p for p in problems)

    def test_refuses_an_out_of_range_age(self):
        assert any("age" in p for p in validate_personas([persona("a", age=5), persona("b")]))
        assert any("age" in p for p in validate_personas([persona("a", age="34"), persona("b")]))

    def test_reports_every_problem_at_once(self):
        # One KeyError per round trip through a torch-loading process is the
        # slowest possible way to learn four personas are broken.
        problems = validate_personas([persona("a", age=5), persona(""), {"nope": 1}])
        assert len(problems) >= 3


class TestReactionSimilarity:
    def test_identical_text_scores_one(self):
        assert reaction_similarity("this is great", "this is great") == 1.0

    def test_unrelated_text_scores_zero(self):
        assert (
            reaction_similarity("walking dogs is expensive", "quantum chromodynamics funding")
            == 0.0
        )

    def test_ignores_punctuation_and_case(self):
        assert reaction_similarity("Dogs, walking!", "dogs walking") > 0.9

    def test_empty_text_is_zero_not_an_error(self):
        assert reaction_similarity("", "anything meaningful") == 0.0


class TestMeasureDivergence:
    def test_n_copies_of_one_opinion_score_zero(self):
        same = "I would absolutely use this every single day it looks great"
        report = measure_divergence(
            [Reaction("a", same, 0.9), Reaction("b", same, 0.9), Reaction("c", same, 0.9)]
        )
        assert report.duplicate_rate == 1.0
        assert report.sentiment_spread == 0.0
        assert report.score == 0.0

    def test_genuinely_different_reactions_score_above_the_floor(self):
        report = measure_divergence(
            [
                Reaction("a", "the scheduling problem is real, I would pay for this", 0.9),
                Reaction("b", "my group chat already handles this fine, no thanks", -0.8),
                Reaction("c", "price matters more than features here honestly", 0.1),
            ]
        )
        assert report.score > MIN_DIVERGENCE_SCORE
        assert report.distinct_reactions == 3

    def test_catches_identical_wording_despite_spread_sentiment(self):
        same = "this product would definitely solve my particular problem"
        report = measure_divergence([Reaction("a", same, 1.0), Reaction("b", same, -1.0)])
        assert report.duplicate_rate == 1.0
        assert report.score < 0.55

    def test_catches_identical_sentiment_despite_varied_wording(self):
        report = measure_divergence(
            [
                Reaction("a", "scheduling walks around my shifts is the hard bit", 0.5),
                Reaction("b", "coordinating with the walker eats my evenings", 0.5),
            ]
        )
        assert report.sentiment_spread == 0.0

    def test_one_reaction_is_maximally_convergent_not_a_clean_pass(self):
        report = measure_divergence([Reaction("a", "great", 1.0)])
        assert report.score == 0.0
        assert report.duplicate_rate == 1.0

    def test_zero_reactions_is_finite(self):
        report = measure_divergence([])
        assert report.score == 0.0


class TestScoreSentiment:
    def test_orders_acceptance_above_rejection(self):
        assert score_sentiment("I would pay for this, it solves my problem") > 0
        assert score_sentiment("no, my spreadsheet is fine instead") < 0

    def test_neutral_text_is_zero_rather_than_guessed(self):
        assert score_sentiment("the weather in Lisbon") == 0.0
        assert score_sentiment("") == 0.0


class TestJudge:
    def test_rejects_a_collapsed_run_and_says_what_collapse_means(self):
        same = "I would absolutely use this every single day it looks great"
        verdict = judge([Reaction("a", same, 0.9), Reaction("b", same, 0.9)])
        assert verdict["usable"] is False
        assert "converged" in verdict["reason"]
        assert "not an audience" in verdict["reason"]

    def test_accepts_a_divergent_run_but_never_calls_it_evidence(self):
        verdict = judge(
            [
                Reaction("a", "the scheduling problem is real, I would pay for this", 0.9),
                Reaction("b", "my group chat already handles this fine, no thanks", -0.8),
                Reaction("c", "price matters more than features here honestly", 0.1),
            ]
        )
        assert verdict["usable"] is True
        assert verdict["usable_as_evidence"] is False
        assert "not as demand evidence" in verdict["reason"]

    @pytest.mark.parametrize(
        "reactions",
        [
            [],
            [Reaction("a", "x", 0.0)],
            [Reaction("a", "totally different here", 1.0), Reaction("b", "unrelated words", -1.0)],
        ],
    )
    def test_is_never_usable_as_evidence(self, reactions):
        assert judge(reactions)["usable_as_evidence"] is False

    def test_does_NOT_judge_fewer_than_two_reactions(self):
        # Replaced, not weakened. The old assertion here was
        # `judge([])["usable"] is False`, and that False IS the defect: it is
        # the same value the COLLAPSED badge reads, on a run that produced
        # nothing. "Not assessed" now has no `usable` key to misread.
        for reactions, kind in (([], "no-reactions"), ([Reaction("a", "great", 1.0)], "too-few-reactions")):
            verdict = judge(reactions)
            assert verdict["assessed"] is False
            assert verdict["kind"] == kind
            assert "usable" not in verdict
            assert verdict["usable_as_evidence"] is False

    def test_a_real_verdict_is_marked_assessed(self):
        verdict = judge([
            Reaction("a", "the scheduling problem is real and I would pay", 0.9),
            Reaction("b", "my group chat handles this fine already", -0.8),
        ])
        assert verdict["assessed"] is True
        assert "usable" in verdict


class TestRunSimulationWithoutOasis:
    def test_validates_before_importing_anything_heavy(self):
        # A malformed persona must cost a millisecond, not a torch load.
        with pytest.raises(SimulationUnavailable) as caught:
            run_simulation([persona()], "a pitch")
        assert caught.value.kind == "invalid-personas"

    def test_reports_a_missing_oasis_as_a_NAMED_condition(self):
        try:
            import oasis  # noqa: F401
        except ImportError:
            pass
        else:
            pytest.skip("OASIS is installed in this environment")

        with pytest.raises(SimulationUnavailable) as caught:
            run_simulation([persona("a"), persona("b")], "a pitch")
        assert caught.value.kind == "oasis-not-installed"
        # The message must name the install command AND why it is optional.
        assert "simulation" in caught.value.detail
        assert "torch" in caught.value.detail


class TestReadReactionsExcludesSeed:
    """The seeded pitch is not an opinion about the pitch.

    `_run` posts the pitch as agent 0 so the others have something concrete to
    react to, and it lands in the same `post` table as every genuine reply.
    Counting it inflates the reaction total and always reads as one more
    DISTINCT opinion, which pushes the divergence score UP — the direction that
    makes a collapsed run harder to detect. Runs with no OASIS installed: it
    builds the sqlite database by hand.
    """

    @staticmethod
    def _db(tmp_path, rows, comments=()):
        """Build a database with OASIS's REAL column names.

        Mirrors `oasis/social_platform/schema/post.sql` and `comment.sql`. The
        earlier fixture declared `post(user_id, content)` only, which stopped
        being a faithful stand-in once the reader started selecting `post_id`
        and `original_post_id` — and a fixture that is not faithful tests the
        fixture.
        """
        import sqlite3

        path = tmp_path / "oasis.db"
        connection = sqlite3.connect(path)
        try:
            connection.execute(
                "CREATE TABLE post (post_id INTEGER PRIMARY KEY AUTOINCREMENT, "
                "user_id INTEGER, original_post_id INTEGER, content TEXT)"
            )
            connection.executemany(
                "INSERT INTO post (user_id, original_post_id, content) VALUES (?, NULL, ?)",
                rows,
            )
            if comments:
                connection.execute(
                    "CREATE TABLE comment (comment_id INTEGER PRIMARY KEY AUTOINCREMENT, "
                    "post_id INTEGER, user_id INTEGER, content TEXT)"
                )
                connection.executemany(
                    "INSERT INTO comment (post_id, user_id, content) VALUES (?, ?, ?)",
                    comments,
                )
            connection.commit()
        finally:
            connection.close()
        return path

    def test_drops_the_seeded_pitch_but_keeps_real_reactions(self, tmp_path):
        from app.simulation.oasis_runner import _read_reactions

        pitch = "A social network just for dog owners."
        path = self._db(
            tmp_path,
            [(0, pitch), (1, "I would never pay for this."), (2, "Genuinely useful.")],
        )

        reactions = _read_reactions(path, ["marta", "deshawn", "yuki"], pitch)

        assert [r.username for r in reactions] == ["deshawn", "yuki"]
        assert all(r.text != pitch for r in reactions)

    def test_drops_a_verbatim_repost_of_the_pitch(self, tmp_path):
        from app.simulation.oasis_runner import _read_reactions

        pitch = "A social network just for dog owners."
        # Whitespace differences are still the same non-opinion.
        path = self._db(tmp_path, [(0, pitch), (1, f"  {pitch}  "), (2, "No thanks.")])

        reactions = _read_reactions(path, ["marta", "deshawn", "yuki"], pitch)

        assert len(reactions) == 1
        assert reactions[0].username == "yuki"

    def test_keeps_everything_when_no_seed_is_supplied(self, tmp_path):
        """Back-compat: the old two-argument call must not start dropping rows."""
        from app.simulation.oasis_runner import _read_reactions

        path = self._db(tmp_path, [(0, "one"), (1, "two")])

        assert len(_read_reactions(path, ["a", "b"])) == 2


class TestReactionPayloadCarriesStructure:
    """A flat list of (username, text, sentiment) cannot be threaded.

    Without `kind`, `parent_id` and `round` the only feed you can build is a
    styled list in an order it invented. These pin the structure that makes a
    real thread possible.
    """

    # staticmethod() explicitly: a bare reference would rebind as an instance
    # method in this class and swallow `tmp_path` as `self`.
    _db = staticmethod(TestReadReactionsExcludesSeed._db)

    def test_distinguishes_a_comment_from_a_post(self, tmp_path):
        from app.simulation.oasis_runner import _read_reactions

        path = self._db(
            tmp_path,
            [(0, "seed pitch"), (1, "top level take")],
            comments=[(1, 2, "replying to the pitch")],
        )
        reactions = _read_reactions(path, ["a", "b", "c"])
        kinds = {r.text: r.kind for r in reactions}
        assert kinds["top level take"] == "post"
        assert kinds["replying to the pitch"] == "comment"

    def test_a_comment_points_at_the_post_it_answers(self, tmp_path):
        from app.simulation.oasis_runner import _read_reactions

        path = self._db(
            tmp_path, [(0, "seed pitch")], comments=[(1, 1, "I disagree with this")]
        )
        comment = next(r for r in _read_reactions(path, ["a", "b"]) if r.kind == "comment")
        assert comment.parent_id == 1
        assert comment.reaction_id == 1

    def test_an_original_post_has_no_parent_and_says_so_with_none(self, tmp_path):
        from app.simulation.oasis_runner import _read_reactions

        # None, not 0: "no parent" and "parent number zero" are different facts,
        # and an edge drawn to post 0 would be a fabricated reply.
        path = self._db(tmp_path, [(0, "standalone opinion")])
        post = _read_reactions(path, ["a"])[0]
        assert post.parent_id is None

    def test_round_is_none_without_watermarks_not_zero(self, tmp_path):
        from app.simulation.oasis_runner import _read_reactions

        # "Not measured" must not read as "round 0", which is the seed round.
        path = self._db(tmp_path, [(0, "a take")])
        assert _read_reactions(path, ["a"])[0].round is None

    def test_watermarks_attribute_each_row_to_the_step_that_wrote_it(self, tmp_path):
        from app.simulation.oasis_runner import _read_reactions

        path = self._db(tmp_path, [(0, "seed"), (1, "round one take"), (2, "round two take")])
        # Seed step ended at post_id 1; round 1 ended at 2; round 2 at 3.
        watermarks = [(1, 0), (2, 0), (3, 0)]
        by_text = {
            r.text: r.round for r in _read_reactions(path, ["a", "b", "c"], "", watermarks)
        }
        assert by_text["seed"] == 0
        assert by_text["round one take"] == 1
        assert by_text["round two take"] == 2

    def test_a_row_above_every_watermark_lands_in_the_last_round(self, tmp_path):
        from app.simulation.oasis_runner import _read_reactions

        # It exists, so something wrote it, and the final step is the only
        # candidate. None would claim it was never measured.
        path = self._db(tmp_path, [(0, "one"), (1, "two")])
        rounds = [r.round for r in _read_reactions(path, ["a", "b"], "", [(1, 0)])]
        assert rounds == [0, 0]

    def test_a_table_whose_columns_changed_raises_instead_of_reporting_zero(self, tmp_path):
        import sqlite3

        import pytest

        from app.simulation.oasis_runner import SimulationUnavailable, _read_reactions

        # An OASIS upgrade that renames a column must not present as "every
        # persona ignored the pitch".
        path = tmp_path / "drift.db"
        connection = sqlite3.connect(path)
        try:
            connection.execute("CREATE TABLE post (user_id INTEGER, body TEXT)")
            connection.execute("INSERT INTO post VALUES (1, 'a take')")
            connection.commit()
        finally:
            connection.close()

        with pytest.raises(SimulationUnavailable) as caught:
            _read_reactions(path, ["a"])
        assert caught.value.kind == "simulation-schema-drift"

    def test_a_missing_table_is_still_tolerated(self, tmp_path):
        from app.simulation.oasis_runner import _read_reactions

        # No `comment` table at all is normal — nobody commented.
        path = self._db(tmp_path, [(0, "just a post")])
        assert len(_read_reactions(path, ["a"])) == 1


class TestReasoningEffortIsConditional:
    """T7. The config dict is present IFF the env var is set.

    Unconditional would be worse than absent: `gpt-4o-mini`, the default, 400s
    on `reasoning_effort` outright, so an always-on dict breaks every existing
    deployment in order to fix one nobody has switched to yet.
    """

    @staticmethod
    def _built(monkeypatch, effort: str | None):
        import app.simulation.oasis_runner as runner

        captured: dict = {}

        class _FakeFactory:
            @staticmethod
            def create(**kwargs):
                captured.update(kwargs)
                return object()

        class _FakePlatform:
            OPENAI = "openai"

        fake_models = types.ModuleType("camel.models")
        fake_models.ModelFactory = _FakeFactory
        fake_types = types.ModuleType("camel.types")
        fake_types.ModelPlatformType = _FakePlatform
        monkeypatch.setitem(sys.modules, "camel", types.ModuleType("camel"))
        monkeypatch.setitem(sys.modules, "camel.models", fake_models)
        monkeypatch.setitem(sys.modules, "camel.types", fake_types)

        if effort is None:
            monkeypatch.delenv("RESEARCH_SIM_REASONING_EFFORT", raising=False)
        else:
            monkeypatch.setenv("RESEARCH_SIM_REASONING_EFFORT", effort)

        runner._build_model(None)
        return captured

    def test_absent_when_the_env_var_is_unset(self, monkeypatch):
        captured = self._built(monkeypatch, None)
        assert "model_config_dict" not in captured

    def test_absent_when_the_env_var_is_blank_or_whitespace(self, monkeypatch):
        # A blank var is how a deployment "turns it off"; it must not send `""`,
        # which is not a valid reasoning effort and would 400 every call.
        assert "model_config_dict" not in self._built(monkeypatch, "")
        assert "model_config_dict" not in self._built(monkeypatch, "   ")

    def test_present_when_the_env_var_is_set(self, monkeypatch):
        captured = self._built(monkeypatch, "none")
        assert captured["model_config_dict"] == {"reasoning_effort": "none"}


class TestModelIdIsValidatedBeforeTheRun:
    """T7. CAMEL accepts any string, so the provider is asked instead."""

    def test_a_404_from_the_provider_is_a_NAMED_condition(self, monkeypatch):
        import urllib.error

        import app.simulation.oasis_runner as runner

        monkeypatch.setenv("OPENAI_API_KEY", "sk-test")

        def _raise_404(*_args, **_kwargs):
            raise urllib.error.HTTPError(
                url="http://x/models/nope", code=404, msg="Not Found", hdrs=None, fp=None
            )

        monkeypatch.setattr(runner.urllib.request, "urlopen", _raise_404)

        with pytest.raises(SimulationUnavailable) as caught:
            runner._validate_model_id("not-a-real-model-xyz")
        assert caught.value.kind == "unknown-simulation-model"
        # The message must name the model AND the variable that set it.
        assert "not-a-real-model-xyz" in caught.value.detail
        assert "RESEARCH_SIM_MODEL" in caught.value.detail

    def test_no_api_key_means_NOT_CHECKED_rather_than_valid(self, monkeypatch):
        import app.simulation.oasis_runner as runner

        monkeypatch.delenv("OPENAI_API_KEY", raising=False)
        # None, not True: nothing was verified, and saying "valid" would be a
        # claim this code has no basis for.
        assert runner._validate_model_id("anything") is None

    def test_an_unreachable_provider_does_not_fail_the_run(self, monkeypatch):
        import app.simulation.oasis_runner as runner

        monkeypatch.setenv("OPENAI_API_KEY", "sk-test")

        def _boom(*_args, **_kwargs):
            raise OSError("network is unreachable")

        monkeypatch.setattr(runner.urllib.request, "urlopen", _boom)
        # A self-hosted gateway without /models must not be told its model is
        # wrong. Not checked is not the same as invalid.
        assert runner._validate_model_id("gpt-4o-mini") is None

    def test_a_401_is_not_reported_as_a_bad_model_id(self, monkeypatch):
        import urllib.error

        import app.simulation.oasis_runner as runner

        monkeypatch.setenv("OPENAI_API_KEY", "sk-test")

        def _raise_401(*_args, **_kwargs):
            raise urllib.error.HTTPError(
                url="http://x", code=401, msg="Unauthorized", hdrs=None, fp=None
            )

        monkeypatch.setattr(runner.urllib.request, "urlopen", _raise_401)
        assert runner._validate_model_id("gpt-4o-mini") is None


class TestAgentErrorsAreCounted:
    """T8. OASIS swallows every per-agent failure; this is where it is read."""

    def test_counts_one_error_per_swallowed_agent_failure(self):
        import logging

        from app.simulation.oasis_runner import _AgentErrorCounter

        counter = _AgentErrorCounter()
        agent_log = logging.getLogger("social.agent")
        agent_log.addHandler(counter)
        try:
            # Exactly what oasis/social_agent/agent.py:154 emits.
            agent_log.error("Agent 0 error: Error code: 400 - bad request")
            agent_log.error("Agent 1 error: Error code: 400 - bad request")
            agent_log.info("Agent 2 performed action: create_post")
        finally:
            agent_log.removeHandler(counter)

        assert counter.count == 2
        assert len(counter.samples) == 2
        assert "Agent 0 error" in counter.samples[0]

    def test_keeps_at_most_five_samples_but_keeps_counting(self):
        import logging

        from app.simulation.oasis_runner import _AgentErrorCounter

        counter = _AgentErrorCounter()
        agent_log = logging.getLogger("social.agent")
        agent_log.addHandler(counter)
        try:
            for i in range(12):
                agent_log.error(f"Agent {i} error: boom")
        finally:
            agent_log.removeHandler(counter)

        # The count is the fact that matters; the samples are only there to
        # explain it, so they are capped and the count is not.
        assert counter.count == 12
        assert len(counter.samples) == 5


class TestSimulationResultKeepsFailuresWithReactions:
    def test_zero_errors_is_a_measurement_not_an_absence(self):
        from app.simulation.oasis_runner import SimulationResult

        result = SimulationResult(reactions=[])
        assert result.agent_errors == 0
        assert result.agent_error_samples == []
        # `model_validated` defaults to None — "not checked" — because a default
        # of True would assert something no one verified.
        assert result.model_validated is None
