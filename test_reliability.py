import json
import sqlite3
from pathlib import Path

import app
from storage import SQLiteStorage


PRIOR_SOURCES = {
    "neutral_50",
    "same_champion_role",
    "account_role",
    "account_profile",
    "peer_role",
    "global",
    "personal_baseline",
}


def test_reliability_bands_follow_effective_sample_size_thresholds():
    assert app.reliability_level(2.99, 1.0) == "exploratory"
    assert app.reliability_level(3.0, 1.0) == "weak"
    assert app.reliability_level(7.99, 1.0) == "weak"
    assert app.reliability_level(8.0, 1.0) == "indicative"
    assert app.reliability_level(19.99, 1.0) == "indicative"
    assert app.reliability_level(20.0, 0.99) == "reliable"
    assert app.reliability_level(20.0, 0.95) == "indicative"
    # Large support without a clear direction is still only indicative.
    assert app.reliability_level(20.0, 0.80) == "indicative"


def reliability_connection(tmp_path: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(tmp_path / "reliability.db")
    connection.row_factory = sqlite3.Row
    connection.executescript(app.SCHEMA_PATH.read_text(encoding="utf-8"))
    return connection


def add_match(
    connection: sqlite3.Connection,
    *,
    account: str,
    match_id: str,
    champion: str,
    role: str,
    win: int,
    loss_weight: float = 1.0,
    win_weight: float = 1.0,
) -> None:
    connection.execute(
        "INSERT OR IGNORE INTO champions(champion,asset_id,icon_url) VALUES(?,?,?)",
        (champion, champion, f"/{champion}.png"),
    )
    connection.execute(
        """INSERT INTO match_quality
           (account,match_id,date,patch,queue,champion,role,identity_resolution,
            duration_minutes,win,explicit_afk,suspected_quasi_afk,early_surrender,
            anomaly_flags,match_quality_score,loss_attribution_weight,
            win_evidence_weight,reason)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            account,
            match_id,
            "2026-08-01T12:00:00Z",
            "16.16",
            "420",
            champion,
            role,
            "test",
            30,
            win,
            0,
            0,
            0,
            "none",
            1,
            loss_weight if not win else 0,
            win_weight if win else 0,
            "test fixture",
        ),
    )


def add_roster(
    connection: sqlite3.Connection,
    *,
    match_id: str,
    owner_puuid: str,
    owner_riot_id: str,
    owner_champion: str,
    win: int,
    teammates: list[tuple[str, str, str]],
) -> None:
    rows = [
        (match_id, owner_puuid, owner_riot_id, 100, win, owner_champion),
        *[
            (match_id, puuid, riot_id, 100, win, champion)
            for puuid, riot_id, champion in teammates
        ],
    ]
    connection.executemany(
        """INSERT INTO match_participants
           (match_id,puuid,riot_id,team_id,win,champion)
           VALUES(?,?,?,?,?,?)""",
        rows,
    )


def all_synergy_items(payload: dict) -> list[dict]:
    items: dict[str, dict] = {}
    for key in ("better_with", "worse_with", "exploratory", "items"):
        for item in payload.get(key, []):
            items[item["champion"]] = item
    return list(items.values())


def test_owner_fallback_keeps_all_four_allies_even_when_they_are_tracked(tmp_path):
    connection = reliability_connection(tmp_path)
    tracked_allies = [
        ("ally-leona", "LeonaMain#EUW", "Leona"),
        ("ally-lux", "LuxMain#EUW", "Lux"),
        ("ally-jinx", "JinxMain#EUW", "Jinx"),
        ("ally-nautilus", "NautMain#EUW", "Nautilus"),
    ]
    connection.execute(
        "INSERT INTO tracked_account_puuids(puuid,account) VALUES(?,?)",
        ("current-player-puuid", "Player#EUW"),
    )
    connection.executemany(
        "INSERT INTO tracked_account_puuids(puuid,account) VALUES(?,?)",
        [(puuid, riot_id) for puuid, riot_id, _ in tracked_allies],
    )

    # The participant has an old, unmapped identity. Champion + result is the
    # reliable owner fallback; all four same-team participants must survive.
    add_match(
        connection,
        account="Player#EUW",
        match_id="win-with-tracked-allies",
        champion="Ahri",
        role="MIDDLE",
        win=1,
    )
    add_roster(
        connection,
        match_id="win-with-tracked-allies",
        owner_puuid="historical-player-puuid",
        owner_riot_id="OldPlayerName#EUW",
        owner_champion="Ahri",
        win=1,
        teammates=tracked_allies,
    )

    # Establish a lower personal baseline so that the four one-game allies
    # have a direction and remain observable as exploratory results.
    for number in range(3):
        match_id = f"baseline-loss-{number}"
        add_match(
            connection,
            account="Player#EUW",
            match_id=match_id,
            champion="Ahri",
            role="MIDDLE",
            win=0,
        )
        add_roster(
            connection,
            match_id=match_id,
            owner_puuid=f"historical-owner-{number}",
            owner_riot_id=f"OldPlayer{number}#EUW",
            owner_champion="Ahri",
            win=0,
            teammates=[(f"filler-{number}", f"Filler{number}#EUW", "Yuumi")],
        )
    connection.commit()

    try:
        payload = app.synergy_data(
            connection,
            {
                "account": ["Player#EUW"],
                "champion": ["Ahri"],
                "min_games": ["1"],
                "include_exploratory": ["true"],
            },
        )
    finally:
        connection.close()

    by_champion = {item["champion"]: item for item in all_synergy_items(payload)}
    assert {champion for _, _, champion in tracked_allies} <= by_champion.keys()
    for _, _, champion in tracked_allies:
        assert by_champion[champion]["games"] == 1
        assert by_champion[champion]["reliability"] == "exploratory"
        assert by_champion[champion]["actionable"] is False


def test_synergy_shrinks_small_samples_and_prefers_reliable_evidence(tmp_path):
    connection = reliability_connection(tmp_path)
    connection.execute(
        "INSERT INTO tracked_account_puuids(puuid,account) VALUES(?,?)",
        ("player-puuid", "Player#EUW"),
    )

    observations = [
        ("Sona", [1]),
        ("Leona", [1] * 16 + [0] * 4),
        ("Yuumi", [1] * 4 + [0] * 16),
    ]
    serial = 0
    for teammate, outcomes in observations:
        for outcome in outcomes:
            serial += 1
            match_id = f"synergy-{serial}"
            add_match(
                connection,
                account="Player#EUW",
                match_id=match_id,
                champion="Ahri",
                role="MIDDLE",
                win=outcome,
            )
            add_roster(
                connection,
                match_id=match_id,
                owner_puuid="player-puuid",
                owner_riot_id="Player#EUW",
                owner_champion="Ahri",
                win=outcome,
                teammates=[(f"ally-{serial}", f"Ally{serial}#EUW", teammate)],
            )
    connection.commit()

    try:
        payload = app.synergy_data(
            connection,
            {
                "account": ["Player#EUW"],
                "champion": ["Ahri"],
                "min_games": ["1"],
                "include_exploratory": ["true"],
            },
        )
    finally:
        connection.close()

    by_champion = {item["champion"]: item for item in all_synergy_items(payload)}
    fluke = by_champion["Sona"]
    stable = by_champion["Leona"]

    assert fluke["win_rate"] == 100
    assert fluke["posterior_win_rate"] < fluke["win_rate"]
    assert fluke["personal_effective_sample_size"] <= 1.0
    assert fluke["reliability"] == "exploratory"
    assert fluke["actionable"] is False

    assert stable["posterior_win_rate"] > fluke["posterior_win_rate"]
    assert stable["personal_effective_sample_size"] >= 20
    assert stable["reliability"] == "reliable"
    assert stable["actionable"] is True
    assert stable["credible_lower_90"] < stable["posterior_win_rate"] < stable["credible_upper_90"]
    assert stable["prior_source"] in PRIOR_SOURCES
    assert stable["prior_games"] >= 0


def test_synergy_keeps_neutral_prior_despite_a_larger_account_role_profile(tmp_path):
    connection = reliability_connection(tmp_path)
    connection.execute(
        "INSERT INTO tracked_account_puuids(puuid,account) VALUES(?,?)",
        ("player-puuid", "Player#EUW"),
    )

    add_match(
        connection,
        account="Player#EUW",
        match_id="pair-only",
        champion="Ahri",
        role="MIDDLE",
        win=1,
    )
    add_roster(
        connection,
        match_id="pair-only",
        owner_puuid="player-puuid",
        owner_riot_id="Player#EUW",
        owner_champion="Ahri",
        win=1,
        teammates=[("lulu-puuid", "Lulu#EUW", "Lulu")],
    )

    # The selected champion has no further evidence. A larger account-role
    # profile must not become pseudo-observations for this single personal win.
    for number, outcome in enumerate([1] * 7 + [0] * 3):
        add_match(
            connection,
            account="Player#EUW",
            match_id=f"account-role-{number}",
            champion="Orianna",
            role="MIDDLE",
            win=outcome,
        )
    connection.commit()

    try:
        payload = app.synergy_data(
            connection,
            {
                "account": ["Player#EUW"],
                "champion": ["Ahri"],
                "min_games": ["1"],
                "include_exploratory": ["true"],
            },
        )
    finally:
        connection.close()

    lulu = {item["champion"]: item for item in all_synergy_items(payload)}["Lulu"]
    assert lulu["prior_source"] == "neutral_50"
    assert lulu["prior_games"] == 0
    assert lulu["posterior_win_rate"] == 55.6
    assert lulu["credible_lower_90"] < 50 < lulu["credible_upper_90"]
    assert lulu["actionable"] is False


def test_one_game_matchup_is_exploratory_and_not_actionable():
    metrics = app.matchup_metrics(
        {
            "games": 1,
            "wins": 0,
            "positive_evidence": 0,
            "negative_evidence": 1,
            "evidence_square": 1,
            "recent_games": 1,
            "recent_evidence": 1,
        },
        baseline_win_rate=0.60,
        total_games_with_opponents=20,
    )

    assert metrics["personal_effective_sample_size"] <= 1
    assert metrics["reliability"] == "exploratory"
    assert metrics["actionable"] is False


def test_ban_score_rewards_stable_encounter_exposure_over_a_rare_result():
    rare = app.matchup_metrics(
        {
            "games": 2,
            "wins": 0,
            "positive_evidence": 0,
            "negative_evidence": 2,
            "evidence_square": 2,
            "recent_games": 2,
            "recent_evidence": 2,
        },
        baseline_win_rate=0.50,
        total_games_with_opponents=100,
    )
    common = app.matchup_metrics(
        {
            "games": 10,
            "wins": 0,
            "positive_evidence": 0,
            "negative_evidence": 10,
            "evidence_square": 10,
            "recent_games": 10,
            "recent_evidence": 10,
        },
        baseline_win_rate=0.50,
        total_games_with_opponents=100,
    )

    assert rare["exposure_rate"] == 2.0
    assert common["exposure_rate"] == 10.0
    assert common["matchup_score"] > rare["matchup_score"]
    assert common["actionable"] is False  # Ten observations cannot support an operational ban.
    assert rare["actionable"] is False


def test_ban_direction_is_relative_to_personal_baseline_not_fifty_percent(tmp_path):
    connection = reliability_connection(tmp_path)
    connection.execute(
        "INSERT INTO tracked_account_puuids(puuid,account) VALUES(?,?)",
        ("player-puuid", "Player#EUW"),
    )

    # Lux is a positive 3-2 in raw terms, but worse than the disjoint five wins
    # against Zed. This is only an exploratory negative direction.
    outcomes = [("Lux", win) for win in (1, 1, 1, 0, 0)] + [
        ("Zed", 1) for _ in range(5)
    ]
    for number, (opponent, outcome) in enumerate(outcomes):
        match_id = f"matchup-{number}"
        add_match(
            connection,
            account="Player#EUW",
            match_id=match_id,
            champion="Ahri",
            role="MIDDLE",
            win=outcome,
        )
        connection.executemany(
            """INSERT INTO match_participants
               (match_id,puuid,riot_id,team_id,win,champion)
               VALUES(?,?,?,?,?,?)""",
            [
                (match_id, "player-puuid", "Player#EUW", 100, outcome, "Ahri"),
                (
                    match_id,
                    f"opponent-{number}",
                    f"Opponent{number}#EUW",
                    200,
                    1 - outcome,
                    opponent,
                ),
            ],
        )
    connection.commit()

    try:
        payload = app.matchup_data(
            connection,
            {"account": ["Player#EUW"]},
            "Ahri",
            "MIDDLE",
        )
    finally:
        connection.close()

    assert payload["baseline_win_rate"] == 66.7  # Beta(4 + 8, 4 + 2) overall.
    loses_to = {item["champion"]: item for item in payload["loses_to"]}
    beats = {item["champion"]: item for item in payload["beats"]}
    assert "Lux" in loses_to
    assert "Lux" not in beats
    assert loses_to["Lux"]["win_rate_against"] == 60.0
    assert loses_to["Lux"]["baseline_win_rate"] == 69.2  # Beta(4 + 5, 4), excluding Lux.
    assert loses_to["Lux"]["posterior_lift_pp"] < 0
    assert loses_to["Lux"]["actionable"] is False


def test_accounts_report_raw_eligible_and_analyzed_coverage(tmp_path, monkeypatch):
    database = tmp_path / "coverage.db"
    storage = SQLiteStorage(database, app.SCHEMA_PATH)
    storage.initialize()
    connection = storage.connect()
    connection.row_factory = sqlite3.Row
    connection.execute(
        "INSERT INTO champions(champion,asset_id,icon_url) VALUES(?,?,?)",
        ("Ahri", "Ahri", "/Ahri.png"),
    )
    connection.execute(
        """INSERT INTO riot_match_list_raw
           (account,puuid,fetched_at,match_ids_json) VALUES(?,?,?,?)""",
        ("Player#EUW", "player-puuid", "now", json.dumps(["M1", "M2", "M3", "M4"])),
    )

    def raw_payload(match_id: str, queue_id: int, map_id: int) -> str:
        return json.dumps(
            {
                "metadata": {"matchId": match_id},
                "info": {
                    "queueId": queue_id,
                    "mapId": map_id,
                    "participants": [
                        {
                            "puuid": "player-puuid",
                            "championName": "Ahri",
                            "teamPosition": "MIDDLE",
                            "win": match_id == "M1",
                        }
                    ],
                },
            }
        )

    connection.executemany(
        """INSERT INTO riot_match_raw
           (match_id,routing_region,fetched_at,payload_json) VALUES(?,?,?,?)""",
        [
            ("M1", "europe", "now", raw_payload("M1", 420, 11)),
            ("M2", "europe", "now", raw_payload("M2", 440, 11)),
            ("M3", "europe", "now", raw_payload("M3", 450, 12)),
            # M4 is listed but its detail has not been downloaded yet.
        ],
    )
    connection.executemany(
        """INSERT INTO riot_match_materialization
           (account,match_id,status,reason,identity_resolution,
            participant_puuid,attempts,last_attempt_at)
           VALUES(?,?,?,?,?,?,?,?)""",
        [
            (
                "Player#EUW",
                "M1",
                "materialized",
                "normalized",
                "puuid_exact",
                "player-puuid",
                1,
                "now",
            ),
            (
                "Player#EUW",
                "M2",
                "identity_unresolved",
                "historical identity pending",
                "identity_unresolved",
                "",
                1,
                "now",
            ),
            (
                "Player#EUW",
                "M3",
                "unsupported_queue",
                "queue_not_supported",
                "",
                "",
                1,
                "now",
            ),
        ],
    )
    add_match(
        connection,
        account="Player#EUW",
        match_id="M1",
        champion="Ahri",
        role="MIDDLE",
        win=1,
    )
    connection.commit()
    connection.close()
    monkeypatch.setattr(app, "STORAGE", storage)

    status, payload = app.query_database("/api/accounts", {})

    assert status == 200
    account = payload["items"][0]
    assert account["raw_games"] == 4
    assert account["eligible_games"] == 2
    assert account["analyzed_games"] == 1
    assert account["raw_games"] >= account["eligible_games"] >= account["analyzed_games"]
