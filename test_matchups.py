import sqlite3
from pathlib import Path

import app


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
    assert all(
        item["direction_confidence"] >= app.MATCHUP_MIN_DIRECTION_CONFIDENCE
        for item in result["loses_to"] + result["beats"]
    )
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
    finally:
        connection.close()

    loses_to = {item["champion"] for item in result["loses_to"]}
    assert "Lux" not in loses_to
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
    assert metrics["recommendation"] == "beats"
    assert metrics["negative_evidence"] == 0
    assert metrics["effective_evidence"] == 1
    assert metrics["credible_lower_90"] < metrics["credible_upper_90"]


def test_synergy_directions_are_ranked_by_win_rate(tmp_path):
    connection = matchup_connection(tmp_path)
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


def test_companion_filter_does_not_exclude_the_profile_being_analysed():
    clause, values = app.companion_filter({
        "account": ["Player#EUW"],
        "companion_account": ["Player#EUW"],
        "companion_mode": ["exclude"],
    })

    assert clause == ""
    assert values == []
