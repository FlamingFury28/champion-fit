import sqlite3
from pathlib import Path

import app
from algorithm_settings import recommended_settings, settings_context
from storage import SQLiteStorage


def matchup_connection(tmp_path: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(tmp_path / "matchups.db")
    connection.row_factory = sqlite3.Row
    connection.executescript(Path("schema.sql").read_text(encoding="utf-8"))
    connection.executemany(
        "INSERT INTO champions(champion,asset_id,icon_url) VALUES(?,?,?)",
        [(name, name, f"/{name}.png") for name in ("Ahri", "Lux", "Jinx", "Zed")],
    )
    connection.execute(
        "INSERT INTO tracked_account_puuids(puuid,account) VALUES(?,?)",
        ("player-puuid", "Player#EUW"),
    )
    matches = [
        ("m1", 0),  # Lux beats Ahri.
        ("m2", 0),  # Lux beats Ahri again.
        ("m3", 1),  # Ahri beats Lux.
        ("m4", 1),  # Ahri beats Zed.
    ]
    connection.executemany(
        """INSERT INTO match_quality
           (account,match_id,date,patch,queue,champion,role,identity_resolution,
            duration_minutes,win,explicit_afk,suspected_quasi_afk,early_surrender,
            anomaly_flags,match_quality_score,loss_attribution_weight,
            win_evidence_weight,reason)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        [
            (
                "Player#EUW", match_id, "2026-01-01", "16.1", "420", "Ahri", "MIDDLE",
                "test", 30, win, 0, 0, 0, "none", 1, 1 if not win else 0, 1 if win else 0, "test",
            )
            for match_id, win in matches
        ],
    )
    opponents = [("m1", "Lux", 0), ("m2", "Lux", 0), ("m3", "Lux", 1), ("m4", "Zed", 1)]
    teammates = [("m1", "Leona"), ("m2", "Leona"), ("m3", "Leona"), ("m4", "Nautilus")]
    participant_rows = []
    for (match_id, opponent, win), (_, teammate) in zip(opponents, teammates):
        participant_rows.extend([
            (match_id, "player-puuid", "Player#EUW", 100, win, "Ahri"),
            (match_id, f"{match_id}-teammate", f"{teammate}#EUW", 100, win, teammate),
            (match_id, f"{match_id}-opponent", f"{opponent}#EUW", 200, 1 - win, opponent),
        ])
    connection.executemany(
        "INSERT INTO match_participants(match_id,puuid,riot_id,team_id,win,champion) VALUES(?,?,?,?,?,?)",
        participant_rows,
    )
    connection.commit()
    return connection


def test_matchup_directions_are_opposite_and_disjoint(tmp_path):
    connection = matchup_connection(tmp_path)
    try:
        result = app.matchup_data(connection, {"account": ["Player#EUW"]}, "Ahri", "MIDDLE")
    finally:
        connection.close()

    assert result["games"] == 4
    assert result["games_with_opponents"] == 4
    assert result["loses_to"][0]["champion"] == "Lux"
    assert result["loses_to"][0]["losses_to"] == 2
    assert result["beats"][0]["champion"] == "Zed"
    assert result["beats"][0]["wins_against"] == 1
    for item in result["loses_to"] + result["beats"]:
        assert item["actionable"] is False
        assert item["credible_lower_90"] < 50 < item["credible_upper_90"]
    assert {item["champion"] for item in result["loses_to"]}.isdisjoint(
        {item["champion"] for item in result["beats"]}
    )


def test_matchup_all_champions_removes_champion_filter(tmp_path):
    connection = matchup_connection(tmp_path)
    try:
        result = app.matchup_data(connection, {"account": ["Player#EUW"]}, "ALL", "MIDDLE")
    finally:
        connection.close()

    assert result["champion"] == "ALL"
    assert result["games"] == 4
    assert result["wins"] == 2
    assert result["win_rate"] == 50
    assert result["loses_to"][0]["champion"] == "Lux"


def test_matchup_does_not_treat_uninformative_losses_as_counter_evidence(tmp_path):
    connection = matchup_connection(tmp_path)
    connection.execute(
        "UPDATE match_quality SET loss_attribution_weight=0 WHERE match_id IN ('m1', 'm2')"
    )
    connection.commit()
    try:
        result = app.matchup_data(connection, {"account": ["Player#EUW"]}, "Ahri", "MIDDLE")
        legacy = recommended_settings()
        legacy["attribution"]["negative_veto"] = True
        with settings_context(legacy):
            vetoed = app.matchup_data(connection, {"account": ["Player#EUW"]}, "Ahri", "MIDDLE")
    finally:
        connection.close()

    # With the recommended policy, attribution is explanatory: a raw observed
    # disadvantage remains visible even when no negative evidence is assigned.
    loses_to = {item["champion"] for item in result["loses_to"]}
    assert "Lux" in loses_to
    metrics = app.matchup_metrics({
        "games": 3,
        "wins_against": 1,
        "losses_to": 2,
        "positive_evidence": 1,
        "negative_evidence": 0,
        "evidence_square": 1,
        "recent_games": 3,
        "recent_evidence": 1,
    }, 0.5, 4)
    # Raw direction remains available diagnostically; the API above excludes
    # the row from counter advice because its attributable negative evidence is zero.
    assert metrics["recommendation"] == "loses_to"
    assert metrics["posterior_win_rate"] == 45.5  # Beta(4 + 1, 4 + 2), including raw losses.
    assert metrics["actionable"] is False
    assert metrics["negative_evidence"] == 0
    assert metrics["effective_evidence"] == 1
    assert metrics["credible_lower_90"] < metrics["credible_upper_90"]

    # The fixture cannot satisfy the configured minimum sample size; the veto
    # additionally prevents its zero-attribution loss from becoming advice.
    descriptive = next(item for item in vetoed["loses_to"] if item["champion"] == "Lux")
    assert descriptive["actionable"] is False


def test_synergy_directions_are_ranked_by_win_rate(tmp_path):
    connection = matchup_connection(tmp_path)
    connection.executemany(
        "INSERT INTO match_participants(match_id,puuid,riot_id,team_id,win,champion) VALUES(?,?,?,?,?,?)",
        [
            (match_id, f"common-{match_id}", "Common#EUW", 100, win, "Jinx")
            for match_id, win in (("m1", 0), ("m2", 0), ("m3", 1), ("m4", 1))
        ],
    )
    connection.commit()
    try:
        result = app.synergy_data(
            connection,
            {"account": ["Player#EUW"], "champion": ["Ahri"], "min_games": ["1"]},
        )
    finally:
        connection.close()

    assert result["games"] == 4
    assert result["games_with_teammates"] == 4
    assert result["better_with"][0]["champion"] == "Nautilus"
    assert result["better_with"][0]["win_rate"] == 100
    assert result["worse_with"][0]["champion"] == "Leona"
    assert result["worse_with"][0]["win_rate"] == 33.3
    assert all(item["actionable"] is False for item in result["better_with"] + result["worse_with"])
    assert {item["champion"] for item in result["better_with"]}.isdisjoint(
        {item["champion"] for item in result["worse_with"]}
    )
    assert "Jinx" not in {
        item["champion"] for item in result["better_with"] + result["worse_with"]
    }


def test_friends_only_returns_same_team_participants(tmp_path, monkeypatch):
    connection = matchup_connection(tmp_path)
    connection.close()
    monkeypatch.setattr(
        app,
        "STORAGE",
        SQLiteStorage(tmp_path / "matchups.db", Path("schema.sql")),
    )

    status, result = app.query_database(
        "/api/friends",
        {"account": ["Player#EUW"], "min_shared_games": ["1"], "days": ["all"]},
    )

    assert status == 200
    names = {item["friend"] for item in result["items"]}
    assert names == {"Leona#EUW", "Nautilus#EUW"}
    assert not any("Lux#EUW" in name or "Zed#EUW" in name for name in names)


def test_champion_role_filters_stats_and_recent_matches(tmp_path, monkeypatch):
    connection = matchup_connection(tmp_path)
    connection.execute(
        """INSERT INTO match_quality
           (account,match_id,date,patch,queue,champion,role,identity_resolution,
            duration_minutes,win,explicit_afk,suspected_quasi_afk,early_surrender,
            anomaly_flags,match_quality_score,loss_attribution_weight,
            win_evidence_weight,reason)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            "Player#EUW", "m5", "2026-01-02", "16.1", "420", "Ahri", "SUPPORT",
            "test", 25, 1, 0, 0, 0, "none", 1, 0, 1, "support fixture",
        ),
    )
    connection.commit()
    connection.close()
    monkeypatch.setattr(
        app,
        "STORAGE",
        SQLiteStorage(tmp_path / "matchups.db", Path("schema.sql")),
    )

    status, middle = app.query_database(
        "/api/champion",
        {"account": ["Player#EUW"], "champion": ["Ahri"], "role": ["MIDDLE"], "days": ["all"]},
    )
    _, all_roles = app.query_database(
        "/api/champion",
        {"account": ["Player#EUW"], "champion": ["Ahri"], "role": ["ALL"], "days": ["all"]},
    )

    assert status == 200
    assert middle["stats"]["games"] == 4
    assert {item["role"] for item in middle["recent"]} == {"MIDDLE"}
    assert all_roles["stats"]["games"] == 5


def test_default_context_does_not_fall_back_when_it_has_no_matches(tmp_path, monkeypatch):
    connection = matchup_connection(tmp_path)
    connection.close()
    monkeypatch.setattr(
        app,
        "STORAGE",
        SQLiteStorage(tmp_path / "matchups.db", Path("schema.sql")),
    )

    status, default_scope = app.query_database(
        "/api/champion",
        {"account": ["Player#EUW"], "champion": ["Ahri"], "role": ["ALL"]},
    )
    _, explicit_history = app.query_database(
        "/api/champion",
        {"account": ["Player#EUW"], "champion": ["Ahri"], "role": ["ALL"], "days": ["all"]},
    )

    assert status == 200
    assert default_scope["context"]["days"] == "180"
    assert default_scope["stats"]["games"] == 0
    assert explicit_history["stats"]["games"] == 4


def test_companion_filter_does_not_exclude_the_profile_being_analysed():
    clause, values = app.companion_filter({
        "account": ["Player#EUW"],
        "companion_account": ["Player#EUW"],
        "companion_mode": ["exclude"],
    })

    assert clause == ""
    assert values == []
