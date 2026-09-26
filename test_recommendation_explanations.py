"""Recommendation provenance and uncertainty checks using isolated SQLite fixtures."""

from contextlib import closing

import pytest

import app
from storage import SQLiteStorage


class RecommendationFixture:
    def __init__(self, storage):
        self.storage = storage

    def add_match(
        self, match_id, win, weight, *, account="Player#EUW", champion="Ahri",
        role="MIDDLE", date="2026-09-01T12:00:00Z", companion=False,
    ):
        with closing(self.storage.connect()) as connection, connection:
            connection.execute(
                "INSERT OR IGNORE INTO champions VALUES(?,?,?)",
                (champion, champion, f"/{champion}.png"),
            )
            connection.execute(
                """INSERT INTO match_quality
                    (account,match_id,date,patch,queue,champion,role,identity_resolution,
                     duration_minutes,win,explicit_afk,suspected_quasi_afk,early_surrender,
                     anomaly_flags,match_quality_score,loss_attribution_weight,
                     win_evidence_weight,reason) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (account, match_id, date, "16.17", "420", champion, role, "test", 30,
                 win, 0, 0, 0, "none", 1, 0 if win else weight, weight if win else 0,
                 "Historical fixture: do not infer current-model causes"),
            )
            if companion:
                # Two matching participants must not multiply the observation.
                connection.executemany(
                    "INSERT OR IGNORE INTO match_participants(match_id,puuid,riot_id) VALUES(?,?,?)",
                    [(match_id, "buddy-puuid", "Buddy#EUW"),
                     (match_id, "buddy-old-puuid", "Buddy#EUW")],
                )

    def annotate(self, match_id, *, afk=0, griefer=0, invincible=0):
        with closing(self.storage.connect()) as connection, connection:
            connection.execute(
                """INSERT INTO match_annotations(match_id,afk_player,griefer,invincible,updated_at)
                   VALUES(?,?,?,?,?) ON CONFLICT(match_id) DO UPDATE SET
                   afk_player=excluded.afk_player,griefer=excluded.griefer,
                   invincible=excluded.invincible""",
                (match_id, afk, griefer, invincible, "2026-09-08T10:00:00Z"),
            )

    def evidence(self, **params):
        query = {"champion": ["Ahri"], "role": ["MIDDLE"], "account": ["Player#EUW"]}
        query.update(params)
        status, result = app.query_database("/api/recommendation-evidence", query)
        assert status == 200, result
        return result

    def recommendation(self, **params):
        query = {"account": ["Player#EUW"]}
        query.update(params)
        status, result = app.query_database("/api/profile", query)
        assert status == 200, result
        return next(item for item in result["recommendations"]
                    if item["champion"] == "Ahri" and item["role"] == "MIDDLE")


@pytest.fixture
def recommendations(tmp_path, monkeypatch):
    storage = SQLiteStorage(tmp_path / "recommendations.db", app.SCHEMA_PATH)
    storage.initialize()
    monkeypatch.setattr(app, "STORAGE", storage)
    fixture = RecommendationFixture(storage)
    fixture.add_match("m1", 1, 1, companion=True)
    fixture.add_match("m2", 0, 0.125, companion=True)
    fixture.add_match("m3", 0, 0)
    fixture.add_match("m4", 0, 1, companion=True)
    fixture.add_match("m5", 1, 0.8, companion=True)
    fixture.add_match("m6", 0, 1)
    fixture.add_match("m7", 0, 1)
    fixture.add_match("m8", 1, 0, date="2026-09-02T12:00:00Z")
    fixture.annotate("m4", afk=1)
    fixture.annotate("m5", afk=1, griefer=1, invincible=1)
    fixture.annotate("m6", griefer=1)
    fixture.annotate("m7", invincible=1)
    fixture.add_match("other-role", 1, 1, role="SUPPORT")
    fixture.add_match("other-champion", 1, 1, champion="Lux")
    for number in range(3):
        fixture.add_match(f"outside-{number}", 0, 1, account="Other#EUW", companion=True)
    return fixture


def test_evidence_retains_excluded_rows_and_uses_loss_only_annotation_overrides(recommendations):
    payload = recommendations.evidence()
    assert payload["summary"] == {
        "games": 8, "wins": 3, "losses": 5, "positive_evidence": 1.8,
        "negative_evidence": 0.12, "discounted_games": 2, "excluded_games": 5,
    }
    items = {item["match_id"]: item for item in payload["items"]}
    assert items["m5"]["evidence_weight"] == 0.8
    assert items["m5"]["contribution"] == "positive"
    assert "ridotto" in items["m5"]["weight_reason"]
    assert "AFK" not in items["m5"]["weight_reason"]
    for match_id, annotation in (("m4", "AFK"), ("m6", "griefer"), ("m7", "invincibile")):
        assert items[match_id]["evidence_weight"] == 0
        assert items[match_id]["contribution"] == "excluded"
        assert annotation in items[match_id]["weight_reason"]
    assert items["m2"]["evidence_weight"] == 0.125  # Preserve the stored precision.
    assert "salvato" in items["m2"]["weight_reason"]
    assert "AFK" not in items["m3"]["weight_reason"]  # A zero is not proof of an AFK.
    assert items["m8"]["contribution"] == "excluded"  # Zero-weight wins are visible too.


@pytest.mark.parametrize("mode,expected_games,expected_ids", [
    (None, 8, {f"m{number}" for number in range(1, 9)}),
    ("only", 4, {"m1", "m2", "m4", "m5"}),
    ("exclude", 4, {"m3", "m6", "m7", "m8"}),
])
def test_all_pages_reconcile_to_scoped_recommendation(recommendations, mode, expected_games, expected_ids):
    scope = {} if mode is None else {"companion_mode": [mode], "companion_account": ["Buddy#EUW"]}
    first = recommendations.evidence(limit=["3"], **scope)
    items = list(first["items"])
    for offset in range(3, first["total"], 3):
        page = recommendations.evidence(limit=["3"], offset=[str(offset)], **scope)
        assert page["summary"] == first["summary"]
        items.extend(page["items"])
    recommendation = recommendations.recommendation(**scope)
    explanation = recommendation["explanation"]
    assert first["total"] == first["summary"]["games"] == recommendation["games"] == expected_games
    assert {item["match_id"] for item in items} == expected_ids
    assert len(items) == expected_games
    for contribution, field in (("positive", "positive_evidence"), ("negative", "negative_evidence")):
        total = round(sum(item["evidence_weight"] for item in items if item["contribution"] == contribution), 2)
        assert total == first["summary"][field] == explanation[field]
    assert round(sum(item["evidence_weight"] for item in items), 2) == recommendation["effective_evidence"]


def test_account_order_duplicates_and_shared_match_rows_have_stable_pagination(recommendations):
    recommendations.add_match("m1", 1, 0.5, account="Alt#EUW")
    first = recommendations.evidence(account=["Player#EUW, Alt#EUW", "Alt#EUW"], limit=["2"])
    second = recommendations.evidence(account=["Alt#EUW", "Player#EUW"], limit=["2"], offset=["2"])
    assert first["total"] == second["total"] == 9
    assert [(item["match_id"], item["account"]) for item in first["items"] + second["items"]] == [
        ("m8", "Player#EUW"), ("m1", "Alt#EUW"), ("m1", "Player#EUW"), ("m2", "Player#EUW"),
    ]
    assert recommendations.evidence(account=["unknown"])["total"] == 0
    assert recommendations.evidence(offset=["999"])["items"] == []


def test_annotation_removal_restores_saved_loss_in_both_endpoints_after_reopening(recommendations):
    before = recommendations.recommendation()
    recommendations.annotate("m4")
    after = recommendations.recommendation()
    evidence = recommendations.evidence()
    item = next(row for row in evidence["items"] if row["match_id"] == "m4")
    assert before["explanation"]["negative_evidence"] == 0.12
    assert after["explanation"]["negative_evidence"] == evidence["summary"]["negative_evidence"] == 1.12
    for field in ("score", "posterior_fit", "credible_lower_90", "credible_upper_90", "actionable"):
        assert after[field] == before[field]
    assert item["evidence_weight"] == 1
    assert item["contribution"] == "negative"
    assert "manuale" not in item["weight_reason"]


@pytest.mark.parametrize("params", [
    {}, {"champion": ["Ahri"]}, {"champion": ["Ahri"], "role": ["INVALID"]},
    {"champion": ["Ahri"], "role": ["MIDDLE"], "limit": ["abc"]},
    {"champion": ["Ahri"], "role": ["MIDDLE"], "limit": ["0"]},
    {"champion": ["Ahri"], "role": ["MIDDLE"], "offset": ["-1"]},
    {"champion": ["Ahri"], "role": ["MIDDLE"], "offset": ["1.5"]},
])
def test_evidence_rejects_invalid_queries(recommendations, params):
    status, payload = app.query_database("/api/recommendation-evidence", params)
    assert status == 400
    assert payload["error"]


def test_evidence_defaults_caps_and_role_normalization(recommendations):
    assert recommendations.evidence()["limit"] == 20
    assert recommendations.evidence()["offset"] == 0
    assert recommendations.evidence(limit=["1000"])["limit"] == 100
    assert recommendations.evidence(role=[" utility "])["role"] == "SUPPORT"
    assert recommendations.evidence(champion=["unknown"])["items"] == []


def test_tiny_raw_sample_stays_uncertain_despite_large_role_context():
    candidates = [
        {"champion": "Tiny", "role": "MIDDLE", "games": 3, "wins": 2,
         "positive_evidence": 0.15, "negative_evidence": 0.15},
        {"champion": "Stable", "role": "MIDDLE", "games": 100, "wins": 50,
         "positive_evidence": 50, "negative_evidence": 50},
    ]
    result = {item["champion"]: item for item in app.rank_recommendations(candidates)}
    tiny = result["Tiny"]
    explanation = tiny["explanation"]
    assert tiny["credible_lower_90"] < 50 < tiny["credible_upper_90"]
    assert tiny["credible_upper_90"] - tiny["credible_lower_90"] > 30
    assert explanation["prior_fit"] == 50
    assert explanation["prior_evidence"] == 8
    assert explanation["prior_share"] == pytest.approx(100 * 8 / 11, abs=0.1)
    assert explanation["uncertainty_level"] == "high"
    assert tiny["confidence"] == "da confermare"
    assert tiny["actionable"] is False
    assert explanation["uncertainty_reasons"]
    # A precise 50% estimate is not evidence of a useful advantage.
    assert result["Stable"]["actionable"] is False
    assert result["Stable"]["confidence"] != "sufficiente"
    assert explanation["summary"] and explanation["next_step"]


def test_three_zero_weight_games_preserve_raw_uncertainty_and_quality_explanation():
    result = app.rank_recommendations([
        {"champion": "Excluded", "role": "MIDDLE", "games": 3, "wins": 2,
         "positive_evidence": 0, "negative_evidence": 0, "excluded_games": 3},
    ])[0]
    assert result["explanation"]["prior_share"] == pytest.approx(100 * 8 / 11, abs=0.1)
    assert result["posterior_fit"] == pytest.approx(100 * 6 / 11, abs=0.1)
    assert result["credible_lower_90"] < 50 < result["credible_upper_90"]
    assert result["actionable"] is False
    assert result["explanation"]["uncertainty_level"] == "high"
    assert result["confidence"] == "da confermare"
    assert any("3" in reason and "esclus" in reason for reason in result["explanation"]["uncertainty_reasons"])
