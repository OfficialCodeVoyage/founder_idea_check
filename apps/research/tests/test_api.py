"""The wire contract, exercised through the real FastAPI app with no network.

These tests are the other half of `apps/chat/lib/signals/sidecar.test.ts`. The
two suites assert the same shapes from opposite sides, which is what stops the
sidecar and the app drifting apart silently.
"""

from __future__ import annotations

import importlib

import pytest
from fastapi.testclient import TestClient

from app.errors import SourceBlocked


@pytest.fixture
def client(monkeypatch):
    """A hosted deployment with the default sources, built fresh per test."""
    monkeypatch.setenv("RESEARCH_HOSTED", "true")
    monkeypatch.delenv("RESEARCH_ENABLED_SOURCES", raising=False)
    monkeypatch.delenv("GITHUB_TOKEN", raising=False)
    monkeypatch.delenv("REDDIT_ENABLED_ACK", raising=False)
    main = importlib.reload(importlib.import_module("app.main"))
    return TestClient(main.app), main


def body(source_id: str = "hackernews") -> dict:
    return {
        "query": "dog walking scheduling",
        "limit": 5,
        "date_from": "2026-07-01",
        "date_to": "2026-08-01",
    }


class TestHealth:
    def test_reports_the_gate_position_for_every_source(self, client):
        http, _ = client
        payload = http.get("/v1/health").json()
        assert payload["hosted"] is True
        ids = {source["id"] for source in payload["sources"]}
        assert ids == {
            "hackernews",
            "web-keyless",
            "github",
            "reddit-rss",
            "reddit-shreddit",
            "arctic-shift",
        }

    def test_shows_reddit_as_barred_in_hosted_mode(self, client):
        http, _ = client
        payload = http.get("/v1/health").json()
        reddit = [s for s in payload["sources"] if s["id"].startswith("reddit")]
        assert all(s["enabled_in_hosted"] is False for s in reddit)
        assert all("GDPR" in s["gate_reason"] for s in reddit)

    def test_never_leaks_a_credential_value(self, monkeypatch):
        monkeypatch.setenv("GITHUB_TOKEN", "ghp_supersecret")
        main = importlib.reload(importlib.import_module("app.main"))
        payload = TestClient(main.app).get("/v1/health").json()
        assert payload["credentials_present"] == ["GITHUB_TOKEN"]
        assert "ghp_supersecret" not in str(payload)

    def test_surfaces_an_unknown_source_id_rather_than_dropping_it(self, monkeypatch):
        # NOT "arctic-shift" any more — that is a real source id now, and a
        # test for unknown-id handling that names a known id proves nothing.
        monkeypatch.setenv("RESEARCH_ENABLED_SOURCES", "hackernews,no-such-source")
        main = importlib.reload(importlib.import_module("app.main"))
        payload = TestClient(main.app).get("/v1/health").json()
        assert payload["unknown_source_ids"] == ["no-such-source"]


class TestSignalsContract:
    def test_an_unknown_source_id_is_a_200_with_ok_false(self, client):
        http, _ = client
        response = http.post("/v1/signals/no-such-source", json=body())
        assert response.status_code == 200
        payload = response.json()
        assert payload["ok"] is False
        assert payload["kind"] == "schema-drift"

    def test_a_gate_refusal_is_a_200_with_kind_disabled(self, client):
        # Not a 403. A 403 from the sidecar means "the sidecar refused you",
        # which classifySidecarStatus maps to missing-credential — sending an
        # operator to look for a key that was never needed.
        http, _ = client
        response = http.post("/v1/signals/reddit-rss", json=body())
        assert response.status_code == 200
        payload = response.json()
        assert payload["ok"] is False
        assert payload["kind"] == "disabled"
        assert "hosted mode" in payload["detail"]

    def test_a_missing_credential_is_named_as_such(self, monkeypatch):
        monkeypatch.setenv("RESEARCH_ENABLED_SOURCES", "github")
        monkeypatch.delenv("GITHUB_TOKEN", raising=False)
        main = importlib.reload(importlib.import_module("app.main"))
        payload = TestClient(main.app).post("/v1/signals/github", json=body()).json()
        assert payload["kind"] == "missing-credential"
        assert "GITHUB_TOKEN" in payload["detail"]

    def test_AN_UPSTREAM_403_IS_HTTP_200_WITH_KIND_BLOCKED(self, client, monkeypatch):
        # THE MOST IMPORTANT TEST IN THIS FILE. The sidecar succeeded at its job
        # — it tried the source and reported honestly. A 5xx here would be
        # indistinguishable from the sidecar itself being broken.
        http, main = client

        class Blocked:
            descriptor = main.find_descriptor("hackernews")

            def fetch(self, _query):
                raise SourceBlocked("HTTP 403 from a datacenter egress range")

        monkeypatch.setattr(main, "resolve_permitted_source", lambda *_: Blocked())

        response = http.post("/v1/signals/hackernews", json=body())
        assert response.status_code == 200
        payload = response.json()
        assert payload["ok"] is False
        assert payload["kind"] == "blocked"
        assert "403" in payload["detail"]

    def test_an_empty_result_is_ok_true_with_no_signals(self, client, monkeypatch):
        # Distinct from blocked, and that distinction is the whole point.
        http, main = client

        class Empty:
            descriptor = main.find_descriptor("hackernews")

            def fetch(self, _query):
                return []

        monkeypatch.setattr(main, "resolve_permitted_source", lambda *_: Empty())

        payload = http.post("/v1/signals/hackernews", json=body()).json()
        assert payload["ok"] is True
        assert payload["signals"] == []

    def test_an_adapter_that_breaks_its_contract_is_schema_drift_not_unavailable(
        self, client, monkeypatch
    ):
        # The fix is a code change, not a retry.
        http, main = client

        class Rogue:
            descriptor = main.find_descriptor("hackernews")

            def fetch(self, _query):
                raise RuntimeError("forgot to wrap this")

        monkeypatch.setattr(main, "resolve_permitted_source", lambda *_: Rogue())

        payload = http.post("/v1/signals/hackernews", json=body()).json()
        assert payload["kind"] == "schema-drift"
        assert "RuntimeError" in payload["detail"]

    def test_signals_carry_exactly_the_keys_the_typescript_side_parses(self, client, monkeypatch):
        http, main = client
        from app.schema import SourceItem

        class Fake:
            descriptor = main.find_descriptor("hackernews")

            def fetch(self, _query):
                return [
                    SourceItem(
                        item_id="HN1",
                        source="hackernews",
                        title="Coordinating dog walkers",
                        body="We use a spreadsheet.",
                        url="https://news.ycombinator.com/item?id=1",
                        author="realperson",
                        published_at="2026-07-20",
                        date_confidence="high",
                        engagement={"score": 40},
                        relevance_hint=0.8,
                        snippet="We use a spreadsheet.",
                    )
                ]

        monkeypatch.setattr(main, "resolve_permitted_source", lambda *_: Fake())

        payload = http.post("/v1/signals/hackernews", json=body()).json()
        assert payload["ok"] is True
        assert payload["source_id"] == "hackernews"
        signal = payload["signals"][0]
        assert sorted(signal) == [
            "engagement",
            "id",
            "published_at",
            "relevance",
            "snippet",
            "title",
            "url",
        ]
        # And the author never reaches the wire.
        assert "realperson" not in str(payload)

    def test_options_reach_the_adapter_verbatim(self, client, monkeypatch):
        """THE HALF OF THE ARCTIC SHIFT LANE THAT WAS NEVER CONNECTED.

        `arctic_shift.py` refuses any query with no subreddits — deliberately,
        because Arctic Shift's `query` parameter is documented as working only
        alongside `subreddit` or `author`, so it cannot search all of Reddit for
        a phrase and an unscoped answer would read as "we searched and found
        little" when no search happened.

        The lane was enabled, correct and reachable, and refused EVERY request,
        because `sidecarWebSearch` on the TypeScript side built its body as
        `{query, limit, from, to}` and never sent `options`. That end now sends
        them (see `sourceOptionsFor` in apps/chat/lib/signals/audience.ts); this
        pins the receiving end, so the contract cannot rot from either side.
        """
        http, main = client
        seen = {}

        class Recording:
            descriptor = main.find_descriptor("hackernews")

            def fetch(self, query):
                seen["options"] = query.options
                return []

        monkeypatch.setattr(main, "resolve_permitted_source", lambda *_: Recording())

        payload = http.post(
            "/v1/signals/hackernews",
            json={
                **body(),
                "options": {"subreddits": ["Parenting", "daddit"]},
            },
        ).json()
        assert payload["ok"] is True
        assert seen["options"] == {"subreddits": ["Parenting", "daddit"]}

    def test_an_omitted_options_key_is_an_empty_dict_not_a_missing_attribute(
        self, client, monkeypatch
    ):
        """An adapter reads `query.options.get(...)`; it must never see None.

        The TypeScript side omits the key entirely for a source with no options
        rather than sending `{}`, which is the honest encoding of "nothing was
        chosen" — so this default is what makes that safe.
        """
        http, main = client
        seen = {}

        class Recording:
            descriptor = main.find_descriptor("hackernews")

            def fetch(self, query):
                seen["options"] = query.options
                return []

        monkeypatch.setattr(main, "resolve_permitted_source", lambda *_: Recording())

        http.post("/v1/signals/hackernews", json=body())
        assert seen["options"] == {}


class TestSimulateContract:
    def test_a_missing_oasis_is_a_200_with_a_named_kind(self, client):
        try:
            import oasis  # noqa: F401
        except ImportError:
            pass
        else:
            pytest.skip("OASIS is installed in this environment")

        http, _ = client
        response = http.post(
            "/v1/simulate",
            json={
                "personas": [
                    {
                        "username": "a",
                        "bio": "b",
                        "persona": "p",
                        "age": 30,
                        "gender": "f",
                        "mbti": "XXXX",
                        "country": "UK",
                    },
                    {
                        "username": "b",
                        "bio": "b",
                        "persona": "p",
                        "age": 40,
                        "gender": "m",
                        "mbti": "XXXX",
                        "country": "US",
                    },
                ],
                "pitch": "an app for coordinating dog walkers",
                "rounds": 1,
            },
        )
        assert response.status_code == 200
        payload = response.json()
        assert payload["ok"] is False
        assert payload["kind"] == "oasis-not-installed"

    def test_a_single_persona_is_refused_before_anything_heavy_loads(self, client):
        http, _ = client
        payload = http.post(
            "/v1/simulate",
            json={
                "personas": [
                    {
                        "username": "a",
                        "bio": "b",
                        "persona": "p",
                        "age": 30,
                        "gender": "f",
                        "mbti": "XXXX",
                        "country": "UK",
                    }
                ],
                "pitch": "a pitch",
                "rounds": 1,
            },
        ).json()
        assert payload["ok"] is False
        assert payload["kind"] == "invalid-personas"
        assert "only one persona" in payload["detail"]
