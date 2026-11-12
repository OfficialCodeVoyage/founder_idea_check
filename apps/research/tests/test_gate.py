"""The source gate. These tests ARE the legal position.

If one of them starts failing, do not adjust the test — read
`app/sources/reddit_gate.py` and work out what changed.
"""

from __future__ import annotations

import pytest

from app.config import DEFAULT_ENABLED_SOURCES, load_settings
from app.errors import SourceDisabled, SourceMissingCredential
from app.sources.base import Deployment, SourceDescriptor, assert_permitted
from app.sources.registry import ALL_DESCRIPTORS, find_descriptor, resolve_permitted_source


def deployment(*, hosted: bool, enabled: set[str], credentials: set[str]) -> Deployment:
    return Deployment(
        hosted=hosted,
        available_credentials=frozenset(credentials),
        operator_enabled=frozenset(enabled),
    )


HN = find_descriptor("hackernews")
WEB = find_descriptor("web-keyless")
GITHUB = find_descriptor("github")

# No registered source is barred in hosted mode or needs a second lock any more,
# but the gate that enforces both is kept for the next source that does. These
# tests therefore build the descriptor by hand instead of reading one from the
# registry; a change to `assert_permitted` still has to answer to them.
BARRED_IN_HOSTED = SourceDescriptor(
    id="example-barred",
    label="Example barred source",
    enabled_in_hosted=False,
    enabled_in_self_host=True,
    gate_reason="Barred in hosted mode for the purposes of this test, with a reason long enough to read.",
    required_credentials=("EXAMPLE_ACK",),
)


class TestDefaultPosition:
    def test_defaults_are_hackernews_and_keyless_web_only(self):
        assert sorted(DEFAULT_ENABLED_SOURCES) == ["hackernews", "web-keyless"]

    def test_the_two_defaults_are_keyless(self):
        assert HN.required_credentials == ()
        assert WEB.required_credentials == ()

    @pytest.mark.parametrize("descriptor", ALL_DESCRIPTORS, ids=lambda d: d.id)
    def test_every_source_states_a_real_reason(self, descriptor):
        assert len(descriptor.gate_reason) > 40


class TestAssertPermitted:
    def test_allows_a_default_source_in_either_mode(self):
        for hosted in (True, False):
            assert_permitted(
                HN, deployment(hosted=hosted, enabled={"hackernews"}, credentials=set())
            )

    def test_refuses_a_hosted_barred_source_in_hosted_mode_even_when_fully_configured(self):
        with pytest.raises(SourceDisabled) as caught:
            assert_permitted(
                BARRED_IN_HOSTED,
                deployment(
                    hosted=True,
                    enabled={"example-barred"},
                    credentials={"EXAMPLE_ACK"},
                ),
            )
        assert "off in hosted mode" in caught.value.detail

    def test_checks_the_legal_bar_before_the_operator_toggle(self):
        # Both would refuse, but the REASON must be the legal one. "not enabled"
        # invites an operator to go and enable it.
        with pytest.raises(SourceDisabled) as caught:
            assert_permitted(
                BARRED_IN_HOSTED, deployment(hosted=True, enabled=set(), credentials=set())
            )
        assert "off in hosted mode" in caught.value.detail

    def test_refuses_a_source_the_operator_never_enabled(self):
        with pytest.raises(SourceDisabled) as caught:
            assert_permitted(
                BARRED_IN_HOSTED, deployment(hosted=False, enabled=set(), credentials=set())
            )
        assert "not enabled" in caught.value.detail

    def test_refuses_a_missing_credential_instead_of_going_keyless(self):
        with pytest.raises(SourceMissingCredential) as caught:
            assert_permitted(GITHUB, deployment(hosted=True, enabled={"github"}, credentials=set()))
        assert "GITHUB_TOKEN" in caught.value.detail
        assert "will not fall back" in caught.value.detail

    def test_allows_a_hosted_barred_source_in_self_host_with_both_locks_open(self):
        assert_permitted(
            BARRED_IN_HOSTED,
            deployment(
                hosted=False,
                enabled={"example-barred"},
                credentials={"EXAMPLE_ACK"},
            ),
        )


class TestSettings:
    def test_hosted_defaults_to_true_when_unset(self):
        # Fail-closed: an operator who never answered the question gets the
        # restrictive answer, which keeps a hosted-barred source barred.
        settings = load_settings({})
        assert settings.deployment.hosted is True

    def test_unset_sources_means_the_two_keyless_defaults(self):
        settings = load_settings({})
        assert settings.deployment.operator_enabled == frozenset(DEFAULT_ENABLED_SOURCES)

    def test_an_unknown_source_id_is_surfaced_not_ignored(self):
        settings = load_settings(
            {"RESEARCH_ENABLED_SOURCES": "hackernews,no-such-source"}
        )
        assert settings.unknown_source_ids == ("no-such-source",)
        assert "no-such-source" not in settings.deployment.operator_enabled

    def test_only_credential_presence_is_recorded_never_the_value(self):
        settings = load_settings({"GITHUB_TOKEN": "ghp_secret"})
        assert settings.deployment.available_credentials == frozenset({"GITHUB_TOKEN"})
        assert "ghp_secret" not in repr(settings.deployment)

    def test_a_blank_credential_counts_as_absent(self):
        settings = load_settings({"GITHUB_TOKEN": "   "})
        assert settings.deployment.available_credentials == frozenset()


class TestRegistry:
    def test_an_unknown_id_raises_rather_than_defaulting(self):
        assert find_descriptor("no-such-source") is None
        with pytest.raises(KeyError):
            resolve_permitted_source("no-such-source", load_settings({}))

    def test_a_source_the_operator_did_not_enable_cannot_be_built(self):
        settings = load_settings(
            {
                "RESEARCH_HOSTED": "true",
                "RESEARCH_ENABLED_SOURCES": "hackernews",
            }
        )
        with pytest.raises(SourceDisabled):
            resolve_permitted_source("arctic-shift", settings)

    def test_a_source_the_operator_enabled_can(self):
        settings = load_settings(
            {
                "RESEARCH_HOSTED": "true",
                "RESEARCH_ENABLED_SOURCES": "arctic-shift",
            }
        )
        source = resolve_permitted_source("arctic-shift", settings)
        assert source.descriptor.id == "arctic-shift"
