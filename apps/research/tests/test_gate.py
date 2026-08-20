"""The source gate. These tests ARE the legal position.

If one of them starts failing, do not adjust the test — read
`app/sources/reddit_gate.py` and work out what changed.
"""

from __future__ import annotations

import pytest

from app.config import DEFAULT_ENABLED_SOURCES, load_settings
from app.errors import SourceDisabled, SourceMissingCredential
from app.sources.base import Deployment, assert_permitted
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
REDDIT_RSS = find_descriptor("reddit-rss")
REDDIT_SHREDDIT = find_descriptor("reddit-shreddit")


class TestDefaultPosition:
    def test_defaults_are_hackernews_and_keyless_web_only(self):
        assert sorted(DEFAULT_ENABLED_SOURCES) == ["hackernews", "web-keyless"]

    def test_both_reddit_lanes_are_barred_in_hosted_mode(self):
        assert REDDIT_RSS.enabled_in_hosted is False
        assert REDDIT_SHREDDIT.enabled_in_hosted is False

    def test_reddit_is_permitted_in_self_host(self):
        assert REDDIT_RSS.enabled_in_self_host is True
        assert REDDIT_SHREDDIT.enabled_in_self_host is True

    def test_the_two_defaults_are_keyless(self):
        assert HN.required_credentials == ()
        assert WEB.required_credentials == ()

    def test_reddit_needs_a_second_lock_beyond_the_toggle(self):
        assert REDDIT_RSS.required_credentials == ("REDDIT_ENABLED_ACK",)
        assert REDDIT_SHREDDIT.required_credentials == ("REDDIT_ENABLED_ACK",)

    @pytest.mark.parametrize("descriptor", ALL_DESCRIPTORS, ids=lambda d: d.id)
    def test_every_source_states_a_real_reason(self, descriptor):
        assert len(descriptor.gate_reason) > 40

    @pytest.mark.parametrize("descriptor", [REDDIT_RSS, REDDIT_SHREDDIT], ids=lambda d: d.id)
    def test_the_reddit_reason_names_the_actual_legal_theory(self, descriptor):
        reason = descriptor.gate_reason
        assert "403" in reason
        assert "access control" in reason
        assert "GDPR" in reason
        assert "erasure" in reason


class TestAssertPermitted:
    def test_allows_a_default_source_in_either_mode(self):
        for hosted in (True, False):
            assert_permitted(
                HN, deployment(hosted=hosted, enabled={"hackernews"}, credentials=set())
            )

    def test_refuses_reddit_in_hosted_mode_even_when_fully_configured(self):
        with pytest.raises(SourceDisabled) as caught:
            assert_permitted(
                REDDIT_RSS,
                deployment(
                    hosted=True,
                    enabled={"reddit-rss"},
                    credentials={"REDDIT_ENABLED_ACK"},
                ),
            )
        assert "off in hosted mode" in caught.value.detail

    def test_checks_the_legal_bar_before_the_operator_toggle(self):
        # Both would refuse, but the REASON must be the legal one. "not enabled"
        # invites an operator to go and enable it.
        with pytest.raises(SourceDisabled) as caught:
            assert_permitted(REDDIT_RSS, deployment(hosted=True, enabled=set(), credentials=set()))
        assert "off in hosted mode" in caught.value.detail

    def test_refuses_a_source_the_operator_never_enabled(self):
        with pytest.raises(SourceDisabled) as caught:
            assert_permitted(REDDIT_RSS, deployment(hosted=False, enabled=set(), credentials=set()))
        assert "not enabled" in caught.value.detail

    def test_refuses_a_missing_credential_instead_of_going_keyless(self):
        with pytest.raises(SourceMissingCredential) as caught:
            assert_permitted(GITHUB, deployment(hosted=True, enabled={"github"}, credentials=set()))
        assert "GITHUB_TOKEN" in caught.value.detail
        assert "will not fall back" in caught.value.detail

    def test_allows_reddit_in_self_host_with_both_locks_open(self):
        assert_permitted(
            REDDIT_RSS,
            deployment(
                hosted=False,
                enabled={"reddit-rss"},
                credentials={"REDDIT_ENABLED_ACK"},
            ),
        )


class TestSettings:
    def test_hosted_defaults_to_true_when_unset(self):
        # Fail-closed: an operator who never answered the question gets the
        # restrictive answer, which keeps Reddit off.
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

    def test_a_hosted_deployment_cannot_build_a_reddit_source(self):
        settings = load_settings(
            {
                "RESEARCH_HOSTED": "true",
                "RESEARCH_ENABLED_SOURCES": "reddit-rss",
                "REDDIT_ENABLED_ACK": "yes",
            }
        )
        with pytest.raises(SourceDisabled):
            resolve_permitted_source("reddit-rss", settings)

    def test_a_self_host_deployment_can(self):
        settings = load_settings(
            {
                "RESEARCH_HOSTED": "false",
                "RESEARCH_ENABLED_SOURCES": "reddit-rss",
                "REDDIT_ENABLED_ACK": "yes",
            }
        )
        source = resolve_permitted_source("reddit-rss", settings)
        assert source.descriptor.id == "reddit-rss"
