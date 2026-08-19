"""Step 8, the pure half. Runs with no OASIS, no torch and no network installed."""

from __future__ import annotations

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

    def test_rejects_fewer_than_two_reactions(self):
        assert judge([])["usable"] is False
        assert judge([Reaction("a", "great", 1.0)])["usable"] is False


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
