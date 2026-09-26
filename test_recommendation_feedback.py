import json
import sqlite3
from pathlib import Path

import pytest

import recommendation_feedback as feedback_module
from migrate_postgres import TABLES
from recommendation_feedback import (
    FeedbackConflictError,
    read_feedback,
    save_feedback,
)


SCHEMA = Path(__file__).with_name("schema.sql")


def database(tmp_path):
    path = tmp_path / "feedback.db"
    connection = sqlite3.connect(path)
    connection.row_factory = sqlite3.Row
    connection.executescript(SCHEMA.read_text(encoding="utf-8"))
    connection.commit()
    return path, connection


def add_account(connection, identity, account, puuid, *, match=True):
    connection.execute(
        "INSERT INTO riot_account_identities(identity_id,account) VALUES(?,?)",
        (identity, account),
    )
    connection.execute(
        "INSERT INTO riot_identity_puuids(puuid,identity_id) VALUES(?,?)",
        (puuid, identity),
    )
    connection.execute(
        "INSERT INTO tracked_account_puuids(puuid,account) VALUES(?,?)",
        (puuid, account),
    )
    if match:
        connection.execute(
            "INSERT OR IGNORE INTO champions(champion,asset_id,icon_url) VALUES('Ahri','Ahri','')"
        )
        connection.execute(
            """INSERT INTO match_quality
            (account,match_id,date,patch,queue,champion,role,identity_resolution,
             duration_minutes,win,explicit_afk,suspected_quasi_afk,early_surrender,
             anomaly_flags,match_quality_score,loss_attribution_weight,
             win_evidence_weight,reason)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                account, f"match-{identity}", "2026-09-01", "16.17", "420", "Ahri",
                "MIDDLE", "test", 30, 1, 0, 0, 0, "", 1, 0, 1, "fixture",
            ),
        )


def add_alias(connection, account, display, puuid):
    normalized = display.casefold()
    connection.execute(
        "INSERT INTO riot_account_aliases"
        "(account,normalized_riot_id,display_riot_id,puuid,verification_source,verified_at) "
        "VALUES(?,?,?,?,?,?)",
        (account, normalized, display, puuid, "verified_account_puuid", "2026-09-01"),
    )


def add_observed_champion(connection, account, match_id, champion, role="MIDDLE"):
    connection.execute(
        "INSERT OR IGNORE INTO champions(champion,asset_id,icon_url) VALUES(?,?,?)",
        (champion, champion, ""),
    )
    connection.execute(
        """INSERT INTO match_quality
        (account,match_id,date,patch,queue,champion,role,identity_resolution,
         duration_minutes,win,explicit_afk,suspected_quasi_afk,early_surrender,
         anomaly_flags,match_quality_score,loss_attribution_weight,
         win_evidence_weight,reason)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            account, match_id, "2026-09-01", "16.17", "420", champion, role,
            "test", 30, 1, 0, 0, 0, "", 1, 0, 1, "fixture",
        ),
    )


def test_schema_initializes_feedback_state_and_read_is_side_effect_free(tmp_path):
    _, connection = database(tmp_path)
    try:
        before = connection.total_changes
        assert read_feedback(connection, []) == {"revision": 0, "items": []}
        assert connection.total_changes == before
        assert connection.execute(
            "SELECT revision FROM recommendation_feedback_state WHERE singleton_id=1"
        ).fetchone()[0] == 0
    finally:
        connection.close()


def test_read_accepts_known_legacy_account_keys_and_ignores_unknown_keys(tmp_path):
    _, connection = database(tmp_path)
    try:
        connection.execute(
            "INSERT OR IGNORE INTO champions(champion,asset_id,icon_url) VALUES('Ahri','Ahri','')"
        )
        connection.execute(
            """INSERT INTO match_quality
            (account,match_id,date,patch,queue,champion,role,identity_resolution,
             duration_minutes,win,explicit_afk,suspected_quasi_afk,early_surrender,
             anomaly_flags,match_quality_score,loss_attribution_weight,
             win_evidence_weight,reason)
            VALUES('one','legacy-one','2026-09-01','16.17','420','Ahri','MIDDLE',
                   'legacy',30,1,0,0,0,'',1,0,1,'fixture')"""
        )
        connection.commit()

        saved = save_feedback(connection, ["one"], "Ahri", "MIDDLE", "like", 0)
        assert saved["revision"] == 1
        assert read_feedback(connection, ["one", "unknown"])["items"] == [{
            "account": "one", "champion": "Ahri", "role": "MIDDLE",
            "preference": "like", "updated_at": saved["items"][0]["updated_at"],
        }]
    finally:
        connection.close()


def test_feedback_survives_alias_rename_and_canonicalizes_champions_and_role(tmp_path):
    path, connection = database(tmp_path)
    try:
        add_account(connection, "identity-a", "New#EUW", "puuid-a")
        add_alias(connection, "New#EUW", "Old#EUW", "puuid-a")
        connection.commit()

        result = save_feedback(
            connection, ["Old#EUW"], "LeBlanc", "utility", "like", 0,
        )
        assert connection.in_transaction is True
        assert result["ok"] is True
        assert result["revision"] == 1
        assert result["items"][0] | {"updated_at": "ignored"} == {
            "account": "New#EUW", "champion": "Leblanc", "role": "SUPPORT",
            "preference": "like", "updated_at": "ignored",
        }

        # The function leaves durability to the caller.
        observer = sqlite3.connect(path)
        assert observer.execute(
            "SELECT revision FROM recommendation_feedback_state WHERE singleton_id=1"
        ).fetchone()[0] == 0
        observer.close()
        connection.commit()

        connection.execute(
            "UPDATE riot_account_identities SET account='Newest#EUW' WHERE identity_id='identity-a'"
        )
        connection.commit()
        connection.close()
        connection = sqlite3.connect(path)
        connection.row_factory = sqlite3.Row
        renamed = read_feedback(connection, ["Old#EUW"])
        assert renamed["items"][0]["account"] == "Newest#EUW"
        assert renamed["items"][0]["champion"] == "Leblanc"
        event = json.loads(connection.execute(
            "SELECT payload_json FROM recommendation_feedback_events WHERE revision=1"
        ).fetchone()[0])
        assert event["changes"][0]["requested_account"] == "Old#EUW"
        assert event["changes"][0]["identity_key"] == "identity-a"
    finally:
        connection.close()


def test_compare_and_swap_rejects_stale_write_without_overwrite(tmp_path):
    _, connection = database(tmp_path)
    try:
        add_account(connection, "identity-a", "Player#EUW", "puuid-a")
        connection.commit()
        assert save_feedback(
            connection, ["Player#EUW"], "Tahm Kench", "TOP", "like", 0,
        )["revision"] == 1
        connection.commit()

        with pytest.raises(FeedbackConflictError) as caught:
            save_feedback(
                connection, ["Player#EUW"], "TahmKench", "TOP", "dislike", 0,
            )
        assert caught.value.snapshot["revision"] == 1
        assert caught.value.snapshot["items"][0]["preference"] == "like"
        connection.rollback()
        assert connection.execute(
            "SELECT preference FROM recommendation_preferences"
        ).fetchall()[0][0] == "like"
        assert connection.execute(
            "SELECT COUNT(*) FROM recommendation_feedback_events"
        ).fetchone()[0] == 1
    finally:
        connection.close()


def test_neutral_reset_and_repeated_noop_do_not_advance_revision(tmp_path):
    _, connection = database(tmp_path)
    try:
        add_account(connection, "identity-a", "Player#EUW", "puuid-a")
        connection.commit()
        assert save_feedback(
            connection, ["Player#EUW"], "Ahri", "MIDDLE", "neutral", 0,
        )["revision"] == 0
        assert save_feedback(
            connection, ["Player#EUW"], "Ahri", "MIDDLE", "like", 0,
        )["revision"] == 1
        assert save_feedback(
            connection, ["Player#EUW"], "Ahri", "MIDDLE", "neutral", 1,
        ) == {"revision": 2, "items": [], "ok": True}
        assert save_feedback(
            connection, ["Player#EUW"], "Ahri", "MIDDLE", "neutral", 2,
        ) == {"revision": 2, "items": [], "ok": True}
        assert connection.execute(
            "SELECT COUNT(*) FROM recommendation_preferences"
        ).fetchone()[0] == 0
        assert [row[0] for row in connection.execute(
            "SELECT revision FROM recommendation_feedback_events ORDER BY revision"
        )] == [1, 2]
    finally:
        connection.close()


def test_savepoint_rolls_back_only_feedback_delta_on_error(tmp_path):
    _, connection = database(tmp_path)
    try:
        add_account(connection, "identity-a", "Player#EUW", "puuid-a")
        connection.commit()
        connection.execute(
            """CREATE TEMP TRIGGER reject_feedback BEFORE INSERT ON recommendation_preferences
            BEGIN SELECT RAISE(ABORT, 'forced feedback failure'); END"""
        )
        connection.execute("BEGIN IMMEDIATE")
        connection.execute("INSERT INTO source_metadata VALUES('outer-work','kept')")
        with pytest.raises(sqlite3.IntegrityError, match="forced feedback failure"):
            save_feedback(
                connection, ["Player#EUW"], "Ahri", "MIDDLE", "like", 0,
            )
        assert connection.execute(
            "SELECT value FROM source_metadata WHERE key='outer-work'"
        ).fetchone()[0] == "kept"
        assert connection.execute(
            "SELECT revision FROM recommendation_feedback_state WHERE singleton_id=1"
        ).fetchone()[0] == 0
        assert connection.execute(
            "SELECT COUNT(*) FROM recommendation_preferences"
        ).fetchone()[0] == 0
        connection.commit()
    finally:
        connection.close()


def test_write_rejects_unknown_or_suspended_account_atomically_but_read_omits_it(tmp_path):
    _, connection = database(tmp_path)
    try:
        add_account(connection, "identity-a", "Active#EUW", "puuid-a")
        add_account(connection, "identity-b", "Paused#EUW", "puuid-b")
        connection.execute(
            "INSERT INTO riot_identity_policy VALUES(?,?,?,?,?,?,?,?)",
            (
                "puuid-b", "identity-b", "exception", "verified", "manual", "paused",
                "2026-09-01", "[]",
            ),
        )
        connection.commit()

        with pytest.raises(ValueError, match="unknown account"):
            save_feedback(connection, ["Missing#EUW"], "Ahri", "MIDDLE", "like", 0)
        with pytest.raises(ValueError, match="suspended"):
            save_feedback(
                connection, ["Active#EUW", "Paused#EUW"], "Ahri", "MIDDLE", "like", 0,
            )
        assert read_feedback(connection, ["Missing#EUW", "Paused#EUW"]) == {
            "revision": 0, "items": [],
        }
        assert connection.execute(
            "SELECT COUNT(*) FROM recommendation_preferences"
        ).fetchone()[0] == 0
    finally:
        connection.close()


def test_empty_scope_expands_current_match_accounts_and_deduplicates_alias_identity(tmp_path):
    _, connection = database(tmp_path)
    try:
        add_account(connection, "identity-a", "Player#EUW", "puuid-a")
        add_alias(connection, "Player#EUW", "Historical#EUW", "puuid-a")
        connection.execute(
            "UPDATE match_quality SET account='Historical#EUW' WHERE account='Player#EUW'"
        )
        connection.commit()

        result = save_feedback(connection, [], "Ahri", "MIDDLE", "dislike", 0)
        assert result["revision"] == 1
        assert result["items"] == [{
            "account": "Player#EUW", "champion": "Ahri", "role": "MIDDLE",
            "preference": "dislike", "updated_at": result["items"][0]["updated_at"],
        }]
        assert read_feedback(connection, ["Player#EUW", "Historical#EUW"])["items"] == result["items"]
    finally:
        connection.close()


def test_unknown_champion_requires_raw_observation_for_every_target_account(tmp_path):
    _, connection = database(tmp_path)
    try:
        add_account(connection, "identity-a", "A#EUW", "puuid-a")
        add_account(connection, "identity-b", "B#EUW", "puuid-b")
        add_observed_champion(connection, "A#EUW", "future-a", "Future Hero")
        connection.commit()

        with pytest.raises(ValueError, match="observed.*every target account"):
            save_feedback(
                connection, ["A#EUW", "B#EUW"], "Future Hero", "MIDDLE", "dislike", 0,
            )
        assert connection.execute(
            "SELECT COUNT(*) FROM recommendation_preferences"
        ).fetchone()[0] == 0

        add_observed_champion(connection, "B#EUW", "future-b", "Future Hero")
        connection.commit()
        liked = save_feedback(
            connection, ["A#EUW", "B#EUW"], "Future Hero", "MIDDLE", "like", 0,
        )
        assert liked["revision"] == 1
        assert {item["preference"] for item in liked["items"]} == {"like"}
        saved = save_feedback(
            connection, ["A#EUW", "B#EUW"], "Future Hero", "MIDDLE", "dislike", 1,
        )
        assert saved["revision"] == 2
        assert {(item["account"], item["champion"], item["preference"])
                for item in saved["items"]} == {
            ("A#EUW", "Future Hero", "dislike"),
            ("B#EUW", "Future Hero", "dislike"),
        }
    finally:
        connection.close()


def test_neutral_removes_observed_unknown_after_catalog_canonicalization(tmp_path, monkeypatch):
    _, connection = database(tmp_path)
    try:
        add_account(connection, "identity-a", "A#EUW", "puuid-a")
        add_observed_champion(connection, "A#EUW", "future-a", "Future Hero")
        connection.commit()
        assert save_feedback(
            connection, ["A#EUW"], "Future Hero", "MIDDLE", "dislike", 0,
        )["revision"] == 1
        connection.commit()
        connection.execute("DELETE FROM match_quality WHERE match_id='future-a'")
        connection.commit()

        original_canonical = feedback_module.canonical_champion
        original_entry = feedback_module.champion_entry
        monkeypatch.setattr(
            feedback_module,
            "canonical_champion",
            lambda value: "FutureHero" if str(value).replace(" ", "").casefold() == "futurehero"
            else original_canonical(value),
        )
        monkeypatch.setattr(
            feedback_module,
            "champion_entry",
            lambda value: {"id": "FutureHero"} if value == "FutureHero" else original_entry(value),
        )

        reset = save_feedback(
            connection, ["A#EUW"], "Future Hero", "MIDDLE", "neutral", 1,
        )
        assert reset == {"revision": 2, "items": [], "ok": True}
        assert connection.execute(
            "SELECT COUNT(*) FROM recommendation_preferences"
        ).fetchone()[0] == 0
    finally:
        connection.close()


def test_current_name_is_authoritative_over_another_identity_historical_alias(tmp_path):
    _, connection = database(tmp_path)
    try:
        add_account(connection, "identity-a", "Current#EUW", "puuid-a")
        add_account(connection, "identity-b", "Other#EUW", "puuid-b")
        add_alias(connection, "Other#EUW", "Current#EUW", "puuid-b")
        connection.commit()

        saved = save_feedback(
            connection, ["Current#EUW"], "Ahri", "MIDDLE", "like", 0,
        )
        assert saved["items"][0]["account"] == "Current#EUW"
        assert connection.execute(
            "SELECT identity_key FROM recommendation_preferences"
        ).fetchone()[0] == "identity-a"
        assert read_feedback(connection, ["Other#EUW"])["items"] == []
    finally:
        connection.close()


def test_ambiguous_historical_alias_does_not_merge_feedback_from_distinct_people(tmp_path):
    _, connection = database(tmp_path)
    try:
        add_account(connection, "identity-a", "First#EUW", "puuid-a")
        add_account(connection, "identity-b", "Second#EUW", "puuid-b")
        add_alias(connection, "First#EUW", "Shared#EUW", "puuid-a")
        add_alias(connection, "Second#EUW", "Shared#EUW", "puuid-b")
        connection.commit()
        first = save_feedback(
            connection, ["First#EUW"], "Ahri", "MIDDLE", "like", 0,
        )
        connection.commit()
        save_feedback(
            connection, ["Second#EUW"], "Ahri", "MIDDLE", "dislike", first["revision"],
        )

        assert read_feedback(connection, ["Shared#EUW"])["items"] == []
        with pytest.raises(ValueError, match="ambiguous"):
            save_feedback(
                connection, ["Shared#EUW"], "Ahri", "MIDDLE", "neutral", 2,
            )
    finally:
        connection.close()


def test_reused_current_riot_id_does_not_claim_legacy_name_keyed_feedback(tmp_path):
    _, connection = database(tmp_path)
    try:
        add_account(connection, "identity-a", "First#EUW", "puuid-a")
        add_account(connection, "identity-b", "Shared#EUW", "puuid-b")
        add_alias(connection, "First#EUW", "Shared#EUW", "puuid-a")
        connection.execute(
            "INSERT INTO recommendation_preferences VALUES(?,?,?,?,?,?)",
            ("Shared#EUW", "Shared#EUW", "Ahri", "MIDDLE", "like", "2026-09-01"),
        )
        connection.commit()

        assert read_feedback(connection, ["First#EUW"])["items"] == []
        assert read_feedback(connection, ["Shared#EUW"])["items"] == []
        saved = save_feedback(
            connection, ["Shared#EUW"], "Ahri", "MIDDLE", "dislike", 0,
        )
        assert saved["items"][0]["preference"] == "dislike"
        rows = connection.execute(
            "SELECT identity_key,preference FROM recommendation_preferences ORDER BY identity_key"
        ).fetchall()
        assert [tuple(row) for row in rows] == [
            ("Shared#EUW", "like"), ("identity-b", "dislike"),
        ]
    finally:
        connection.close()


@pytest.mark.parametrize(("replacement", "remaining"), [("neutral", 0), ("dislike", 1)])
def test_save_reconciles_fallback_name_to_new_stable_identity(tmp_path, replacement, remaining):
    _, connection = database(tmp_path)
    try:
        connection.execute(
            "INSERT OR IGNORE INTO champions(champion,asset_id,icon_url) VALUES('Ahri','Ahri','')"
        )
        connection.execute(
            """INSERT INTO match_quality
            (account,match_id,date,patch,queue,champion,role,identity_resolution,
             duration_minutes,win,explicit_afk,suspected_quasi_afk,early_surrender,
             anomaly_flags,match_quality_score,loss_attribution_weight,
             win_evidence_weight,reason)
            VALUES('Old#EUW','fallback-match','2026-09-01','16.17','420','Ahri','MIDDLE',
                   'legacy',30,1,0,0,0,'',1,0,1,'fixture')"""
        )
        connection.commit()
        assert save_feedback(
            connection, ["Old#EUW"], "Ahri", "MIDDLE", "like", 0,
        )["revision"] == 1
        connection.commit()
        assert connection.execute(
            "SELECT identity_key FROM recommendation_preferences"
        ).fetchone()[0] == "Old#EUW"

        connection.execute(
            "INSERT INTO riot_account_identities VALUES('identity-a','New#EUW')"
        )
        connection.execute("INSERT INTO riot_identity_puuids VALUES('puuid-a','identity-a')")
        connection.execute("INSERT INTO tracked_account_puuids VALUES('puuid-a','New#EUW')")
        add_alias(connection, "New#EUW", "Old#EUW", "puuid-a")
        connection.commit()

        changed = save_feedback(
            connection, ["Old#EUW"], "Ahri", "MIDDLE", replacement, 1,
        )
        assert changed["revision"] == 2
        rows = connection.execute(
            "SELECT identity_key,preference FROM recommendation_preferences"
        ).fetchall()
        assert len(rows) == remaining
        if remaining:
            assert tuple(rows[0]) == ("identity-a", "dislike")
            assert changed["items"][0]["account"] == "New#EUW"
        else:
            assert changed["items"] == []
        payload = json.loads(connection.execute(
            "SELECT payload_json FROM recommendation_feedback_events WHERE revision=2"
        ).fetchone()[0])
        assert payload["changes"][0]["reconciled_identity_keys"] == ["Old#EUW"]
    finally:
        connection.close()


@pytest.mark.parametrize(
    ("kwargs", "message"),
    [
        ({"accounts": "Player#EUW"}, "accounts must be a list"),
        ({"champion": "Imaginary"}, "unknown champion"),
        ({"role": "ALL"}, "role must be one of"),
        ({"preference": "maybe"}, "preference"),
        ({"expected_revision": True}, "expected_revision"),
    ],
)
def test_write_validation_is_explicit_and_does_not_guess(tmp_path, kwargs, message):
    _, connection = database(tmp_path)
    try:
        add_account(connection, "identity-a", "Player#EUW", "puuid-a")
        connection.commit()
        arguments = {
            "accounts": ["Player#EUW"], "champion": "Ahri", "role": "MIDDLE",
            "preference": "like", "expected_revision": 0,
        } | kwargs
        with pytest.raises(ValueError, match=message):
            save_feedback(connection, **arguments)
        assert read_feedback(connection, ["Player#EUW"])["revision"] == 0
    finally:
        connection.close()


def test_postgres_migration_includes_feedback_tables_in_dependency_order():
    names = list(TABLES)
    assert names.index("recommendation_preferences") < names.index("recommendation_feedback_state")
    assert names.index("recommendation_feedback_state") < names.index("recommendation_feedback_events")
