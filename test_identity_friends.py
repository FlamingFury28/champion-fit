import json
import pytest

import app
from storage import SQLiteStorage


@pytest.fixture
def identity_db(tmp_path, monkeypatch):
    path = tmp_path / "identity-friends.db"
    storage = SQLiteStorage(path, app.SCHEMA_PATH)
    storage.initialize()
    monkeypatch.setattr(app, "STORAGE", storage)
    connection = storage.connect()
    source = tmp_path / "source"
    source.mkdir()
    yield connection, source
    connection.close()


def add_match(connection, match_id, account="Player#EUW", champion="Ahri", win=1):
    connection.execute(
        "INSERT INTO champions(champion,asset_id,icon_url) VALUES(?,?,?) ON CONFLICT(champion) DO NOTHING",
        (champion, champion, f"/{champion}.png"),
    )
    connection.execute(
        """INSERT INTO match_quality
           (account,match_id,date,patch,queue,champion,role,identity_resolution,
            duration_minutes,win,explicit_afk,suspected_quasi_afk,early_surrender,
            anomaly_flags,match_quality_score,loss_attribution_weight,win_evidence_weight,reason)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (account, match_id, "2026-09-01T12:00:00Z", "16.17", "420", champion,
         "MIDDLE", "test", 30, win, 0, 0, 0, "none", 1, 0 if win else 1, win, "fixture"),
    )


def participant(connection, match_id, puuid, riot_id, champion, win=1, team=100):
    connection.execute(
        """INSERT INTO match_participants(match_id,puuid,riot_id,champion,win,team_id)
           VALUES(?,?,?,?,?,?)""",
        (match_id, puuid, riot_id, champion, win, team),
    )


def verify_identity(connection, puuid="owner", account="Player#EUW"):
    connection.execute(
        """INSERT INTO riot_account_aliases
           (account,normalized_riot_id,display_riot_id,puuid,verification_source,verified_at)
           VALUES(?,?,?,?,?,?)""",
        (account, app.normalize_riot_id_key(account), account, puuid,
         "riot_account_v1", "2026-09-01T12:00:00Z"),
    )


def ownership(connection):
    return dict(connection.execute("SELECT puuid,account FROM tracked_account_puuids"))


def test_frequent_duo_is_recovered_without_deleting_unproven_history(identity_db):
    connection, source = identity_db
    verify_identity(connection)
    connection.executemany(
        "INSERT INTO tracked_account_puuids(puuid,account) VALUES(?,?)",
        [("owner", "Player#EUW"), ("duo", "Player#EUW"),
         ("history-without-roster", "Player#EUW")],
    )
    for number in range(20):
        match_id = f"duo-{number}"
        add_match(connection, match_id)
        participant(connection, match_id, "owner", "Player#EUW", "Ahri")
        participant(connection, match_id, "duo", "Duo#EUW", "Leona")

    app.load_tracked_account_puuids(source, connection)
    first_mapping = ownership(connection)
    assert first_mapping == {"owner": "Player#EUW", "history-without-roster": "Player#EUW"}
    app.load_tracked_account_puuids(source, connection)
    assert ownership(connection) == first_mapping
    status, payload = app.query_database(
        "/api/friends", {"account": ["Player#EUW"], "min_shared_games": ["1"]},
    )
    assert status == 200
    assert [(row["friend"], row["shared_games"]) for row in payload["items"]] == [("Duo#EUW", 20)]


def test_cooccurrence_does_not_create_new_owned_identities(identity_db):
    connection, source = identity_db
    verify_identity(connection)
    for number in range(20):
        match_id = f"shared-{number}"
        add_match(connection, match_id)
        participant(connection, match_id, "owner", "Player#EUW", "Ahri")
        participant(connection, match_id, "duo", "Duo#EUW", "Leona")
    app.load_tracked_account_puuids(source, connection)
    assert ownership(connection) == {"owner": "Player#EUW"}


def test_imported_historical_identity_survives_restart_without_export(identity_db):
    connection, source = identity_db
    export = source / "accounts.json"
    export.write_text(json.dumps({"Player#EUW": {
        "puuid": "current-owner", "puuid_history": ["historical-owner"],
    }}), encoding="utf-8")
    add_match(connection, "historical")
    participant(connection, "historical", "historical-owner", "OldName#EUW", "Ahri")
    participant(connection, "historical", "duo", "Duo#EUW", "Leona")
    app.load_tracked_account_puuids(source, connection)
    expected = {"current-owner": "Player#EUW", "historical-owner": "Player#EUW"}
    assert ownership(connection) == expected
    export.unlink()
    app.load_tracked_account_puuids(source, connection)
    assert ownership(connection) == expected
    assert connection.execute(
        "SELECT COUNT(*) FROM riot_account_aliases WHERE verification_source='imported_accounts_json'"
    ).fetchone()[0] == 2
    status, payload = app.query_database(
        "/api/friends", {"account": ["Player#EUW"], "min_shared_games": ["1"]},
    )
    assert status == 200
    assert [row["friend"] for row in payload["items"]] == ["Duo#EUW"]


def test_verified_identity_is_not_removed_by_inconsistent_legacy_match(identity_db):
    connection, source = identity_db
    verify_identity(connection)
    add_match(connection, "bad-old-export", champion="Lux")
    participant(connection, "bad-old-export", "owner", "Player#EUW", "Ahri")
    app.load_tracked_account_puuids(source, connection)
    assert ownership(connection) == {"owner": "Player#EUW"}


@pytest.mark.parametrize("opposite_team", [False, True])
def test_friend_results_count_each_match_once_across_selected_accounts(identity_db, opposite_team):
    connection, _source = identity_db
    connection.executemany(
        "INSERT INTO tracked_account_puuids(puuid,account) VALUES(?,?)",
        [("a", "A#EUW"), ("b", "B#EUW")],
    )
    for match_id, win in [("shared-win", 1), ("solo-loss", 0)]:
        add_match(connection, match_id, "A#EUW", "Ahri", win)
        participant(connection, match_id, "a", "A#EUW", "Ahri", win)
        participant(connection, match_id, "friend", "Friend#EUW", "Leona", win)
        if match_id == "shared-win" or opposite_team:
            other_win = 1 - win if opposite_team else win
            add_match(connection, match_id, "B#EUW", "Jinx", other_win)
            participant(connection, match_id, "b", "B#EUW", "Jinx", other_win, 200 if opposite_team else 100)
    connection.commit()
    status, payload = app.query_database(
        "/api/friends", {"account": ["A#EUW", "B#EUW"], "min_shared_games": ["1"]},
    )
    assert status == 200
    assert len(payload["items"]) == 1
    friend = payload["items"][0]
    assert friend["shared_games"] == 2
    assert friend["friend_win_rate"] == 50.0
    assert friend["accounts_played_with"] == (1 if opposite_team else 2)


def test_friend_results_keep_distinct_puuids_with_a_reused_riot_id_separate(identity_db):
    connection, _source = identity_db
    connection.execute("INSERT INTO tracked_account_puuids(puuid,account) VALUES('owner','Player#EUW')")
    connection.execute("INSERT INTO friend_groups(name) VALUES('Duo')")
    group_id = connection.execute("SELECT id FROM friend_groups WHERE name='Duo'").fetchone()["id"]
    connection.execute(
        "INSERT INTO friend_group_aliases(group_id,alias) VALUES(?,?)",
        (group_id, "Friend#EUW"),
    )
    for match_id, win in [("win", 1), ("loss", 0)]:
        add_match(connection, match_id, win=win)
        participant(connection, match_id, "owner", "Player#EUW", "Ahri", win)
        participant(connection, match_id, "friend-old", "Friend#EUW", "Leona", win)
    participant(connection, "win", "friend-new", "Friend#EUW", "Leona", 1)
    connection.commit()
    status, payload = app.query_database(
        "/api/friends", {"account": ["Player#EUW"], "min_shared_games": ["1"]},
    )
    assert status == 200
    assert len(payload["items"]) == 2
    assert {row["friend_key"] for row in payload["items"]} == {"friend-old", "friend-new"}
    assert sorted((row["shared_games"], row["friend_win_rate"]) for row in payload["items"]) == [
        (1, 100.0), (2, 50.0),
    ]


def test_friend_with_reused_owned_riot_id_is_not_hidden(identity_db):
    connection, _source = identity_db
    connection.execute(
        "INSERT INTO tracked_account_puuids(puuid,account) VALUES('owner','Player#EUW')"
    )
    add_match(connection, "reused-owner-name")
    participant(connection, "reused-owner-name", "owner", "Player#EUW", "Ahri")
    participant(connection, "reused-owner-name", "former-owner", "Player#EUW", "Leona")
    connection.commit()

    status, payload = app.query_database(
        "/api/friends", {"account": ["Player#EUW"], "min_shared_games": ["1"]},
    )

    assert status == 200
    assert [(row["friend_key"], row["friend"], row["shared_games"]) for row in payload["items"]] == [
        ("former-owner", "Player#EUW", 1),
    ]


def test_saved_account_and_companion_filters_follow_verified_rename(identity_db):
    connection, _source = identity_db
    connection.executemany(
        "INSERT INTO riot_account_identities(identity_id,account) VALUES(?,?)",
        [("owner", "NewPlayer#EUW"), ("duo", "NewDuo#EUW")],
    )
    connection.executemany(
        "INSERT INTO riot_identity_puuids(puuid,identity_id) VALUES(?,?)",
        [("owner", "owner"), ("duo", "duo")],
    )
    verify_identity(connection, "owner", "OldPlayer#EUW")
    verify_identity(connection, "duo", "OldDuo#EUW")
    connection.executemany(
        "INSERT INTO tracked_account_puuids(puuid,account) VALUES(?,?)",
        [("owner", "NewPlayer#EUW"), ("duo", "NewDuo#EUW")],
    )
    for match_id in ("together", "alone"):
        add_match(connection, match_id, account="NewPlayer#EUW")
        participant(connection, match_id, "owner", "NewPlayer#EUW", "Ahri")
    participant(connection, "together", "duo", "NewDuo#EUW", "Leona")
    connection.commit()
    status, payload = app.query_database("/api/overview", {
        "account": ["OldPlayer#EUW"], "companion_account": ["OldDuo#EUW"],
        "companion_mode": ["exclude"],
    })
    assert status == 200
    assert payload["summary"]["observed_games"] == 1
