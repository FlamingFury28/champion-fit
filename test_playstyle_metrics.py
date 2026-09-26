from contextlib import closing
from copy import deepcopy
import json

import pytest

from backfill_playstyle_metrics import backfill, backup_sqlite, protected_snapshot
from playstyle_metrics import extract_metrics, fetch_metrics, materialize_details
from riot_sync import AccountIdentityEvidence, normalize_riot_id, persist_account_materialization
from storage import SQLiteStorage
from test_riot_ingestion import match_detail


@pytest.fixture
def storage(tmp_path):
    from pathlib import Path
    result = SQLiteStorage(tmp_path / "metrics.db", Path(__file__).with_name("schema.sql"))
    result.initialize()
    return result


def detail(match_id="M1"):
    result = match_detail(match_id)
    for participant in result["info"]["participants"]:
        participant.update(kills=2, assists=3, totalMinionsKilled=150,
                           neutralMinionsKilled=30, visionScore=30, damageDealtToTurrets=600)
    return result


def add_raw(connection, payload):
    connection.execute("INSERT INTO riot_match_raw VALUES(?,?,?,?)",
                       (payload["metadata"]["matchId"], "europe", "2026-09-01", json.dumps(payload)))


def admit(connection, match_id="M1", account="Player#EUW", puuid="historical-puuid"):
    connection.execute("INSERT OR IGNORE INTO riot_account_identities VALUES(?,?)", ("owner", account))
    connection.execute("INSERT OR IGNORE INTO riot_identity_puuids VALUES(?,?)", (puuid, "owner"))
    connection.execute(
        """INSERT INTO riot_match_materialization
        (account,match_id,status,identity_resolution,participant_puuid,last_attempt_at)
        VALUES(?,?,'materialized','puuid_exact',?,'2026-09-01')""", (account, match_id, puuid),
    )


def observation(**changes):
    return {"account": "Player#EUW", "match_id": "M1", "champion": "Vi", "role": "JUNGLE",
            "queue": "420", "win": 1, "date": "2026-09-01", "duration_minutes": 30} | changes


def test_extraction_uses_metadata_identity_and_has_no_outcome_dependency():
    payload = detail()
    status, rows = extract_metrics(payload, "M1")
    assert status == "ready"
    first = rows[0]
    assert first["participant_puuid"] == "historical-puuid"
    assert first["farm"] == 6
    assert first["vision"] == 1
    assert first["participation"] == .5
    assert first["turrets"] == 20
    changed = deepcopy(payload)
    for participant in changed["info"]["participants"]:
        participant["win"] = not participant["win"]
    assert extract_metrics(changed, "M1") == (status, rows)


def test_missing_zero_and_undefined_denominator_stay_distinct():
    payload = detail()
    first = payload["info"]["participants"][0]
    first.update(totalMinionsKilled=0, neutralMinionsKilled=0, visionScore=0, damageDealtToTurrets=0,
                 kills=0, assists=0)
    values = extract_metrics(payload, "M1")[1][0]
    assert all(values[field] == 0 for field in ("farm", "vision", "participation", "turrets"))
    del first["neutralMinionsKilled"]
    del first["visionScore"]
    for participant in payload["info"]["participants"]:
        participant["kills"] = 0
    values = extract_metrics(payload, "M1")[1][0]
    assert values["farm"] is None and values["vision"] is None and values["participation"] is None
    payload["info"]["gameDuration"] = 0
    assert extract_metrics(payload, "M1")[1][0]["turrets"] is None


def test_inconsistent_ratio_is_missing_not_clipped():
    payload = detail()
    payload["info"]["participants"][0]["assists"] = 100
    assert extract_metrics(payload, "M1")[1][0]["participation"] is None


@pytest.mark.parametrize("slot", [None, 0, 11, True, "1", 1.5])
def test_legacy_missing_or_invalid_slot_does_not_abort_optional_metrics(slot):
    payload = detail()
    payload["metadata"].pop("participants", None)
    payload["info"]["participants"] = [payload["info"]["participants"][0]]
    if slot is None:
        payload["info"]["participants"][0].pop("participantId", None)
    else:
        payload["info"]["participants"][0]["participantId"] = slot
    assert extract_metrics(payload, "M1") == ("invalid_payload", [])


def test_ambiguous_slot_is_not_materialized():
    payload = detail()
    payload["metadata"].pop("participants", None)
    payload["info"]["participants"][1]["participantId"] = 1
    assert extract_metrics(payload, "M1") == ("invalid_payload", [])


def test_source_idempotency_and_invalid_replacement_clear_stale_facts(storage):
    with closing(storage.connect()) as connection, connection:
        assert materialize_details(connection, {"M1": detail()})["changed"] == 1
        assert materialize_details(connection, {"M1": detail()})["changed"] == 0
        assert connection.execute("SELECT COUNT(*) FROM playstyle_match_metrics").fetchone()[0] == 10
        wrong = detail("OTHER")
        materialize_details(connection, {"M1": wrong})
        assert connection.execute("SELECT COUNT(*) FROM playstyle_match_metrics").fetchone()[0] == 0
        assert connection.execute("SELECT status FROM playstyle_metric_sources").fetchone()[0] == "invalid_payload"


def test_fetch_requires_proof_and_rechecks_group_policy_without_reading_raw(storage):
    with closing(storage.connect()) as connection, connection:
        materialize_details(connection, {"M1": detail()})
        assert fetch_metrics(connection, [observation()])[0]["farm"] is None
        admit(connection)
        queries = []
        connection.set_trace_callback(queries.append)
        enriched = fetch_metrics(connection, [observation()])[0]
        assert enriched["farm"] == 6 and enriched["metrics_status"] == "ready"
        assert all(enriched[k] == v for k, v in observation().items())
        assert not any("riot_match_raw" in query.lower() or "payload_json" in query.lower() for query in queries)
        connection.set_trace_callback(None)
        connection.execute("INSERT INTO riot_identity_puuids VALUES('another-puuid','owner')")
        connection.execute(
            """INSERT INTO riot_identity_policy
            (puuid,identity_id,state,resume_state,source,note,updated_at)
            VALUES('another-puuid','owner','exception','verified','user','suspended','2026-09-01')""",
        )
        blocked = fetch_metrics(connection, [observation()])[0]
        assert blocked["metrics_status"] == "identity_suspended"
        assert all(blocked[field] is None for field in ("farm", "vision", "participation", "turrets"))
        connection.execute("UPDATE riot_identity_policy SET state='verified' WHERE puuid='another-puuid'")
        assert fetch_metrics(connection, [observation()])[0]["farm"] == 6


def test_fetch_rejects_untrusted_materialization_and_old_extractor(storage):
    with closing(storage.connect()) as connection, connection:
        materialize_details(connection, {"M1": detail()})
        admit(connection)
        connection.execute("UPDATE riot_match_materialization SET identity_resolution='champion_guess'")
        assert fetch_metrics(connection, [observation()])[0]["metrics_status"] == "identity_unresolved"
        connection.execute("UPDATE riot_match_materialization SET identity_resolution='puuid_exact'")
        connection.execute("UPDATE playstyle_match_metrics SET extractor_version='old'")
        assert fetch_metrics(connection, [observation()])[0]["metrics_status"] == "stale_extractor"


def test_verified_renamed_account_alias_resolves_without_taxonomy(storage):
    with closing(storage.connect()) as connection, connection:
        materialize_details(connection, {"M1": detail()})
        admit(connection)
        connection.execute("INSERT INTO riot_account_aliases VALUES(?,?,?,?,?,?)",
                           ("Player#EUW", normalize_riot_id("Old#EUW"), "Old#EUW", "historical-puuid", "verified", "now"))
        assert fetch_metrics(connection, [observation(account="Old#EUW")])[0]["farm"] == 6


def test_backfill_interruption_reopen_resume_and_rescan_preserve_sources(storage):
    with closing(storage.connect()) as connection, connection:
        for mid in ("M1", "M2", "M3"):
            add_raw(connection, detail(mid))
    with closing(storage.connect()) as connection:
        before = protected_snapshot(connection)

        def interrupt(batch, cursor):
            if batch == 2:
                raise RuntimeError("simulated interruption")

        with pytest.raises(RuntimeError, match="simulated interruption"):
            backfill(connection, batch_size=1, before_commit=interrupt)
    with closing(storage.connect()) as connection:
        checkpoint = connection.execute("SELECT * FROM playstyle_backfill_checkpoints").fetchone()
        assert checkpoint["last_match_id"] == "M1" and checkpoint["processed_matches"] == 1
        assert connection.execute("SELECT COUNT(*) FROM playstyle_match_metrics").fetchone()[0] == 10
        result = backfill(connection, batch_size=2)
        assert result["complete"] and result["processed_matches"] == 3 and result["changed"] == 2
        assert protected_snapshot(connection) == before
        assert backfill(connection, batch_size=2)["changed"] == 0
        updated = detail("M1")
        updated["info"]["participants"][0]["visionScore"] = 60
        connection.execute("UPDATE riot_match_raw SET payload_json=? WHERE match_id='M1'", (json.dumps(updated),))
        connection.commit()
        assert backfill(connection, batch_size=2)["changed"] == 1
        assert connection.execute("SELECT vision FROM playstyle_match_metrics WHERE match_id='M1' AND participant_id=1").fetchone()[0] == 2


def test_import_hook_is_atomic_and_materializes_new_raw_facts(storage):
    evidence = AccountIdentityEvidence("Player#EUW", frozenset({"historical-puuid"}), frozenset())
    with closing(storage.connect()) as connection:
        result = persist_account_materialization(connection, "Player#EUW", evidence, {"M1": detail()}, "test")
        assert result["playstyle_metrics_changed"] == 1
        assert fetch_metrics(connection, [observation()])[0]["farm"] == 6
        connection.rollback()
        assert connection.execute("SELECT COUNT(*) FROM match_quality").fetchone()[0] == 0
        assert connection.execute("SELECT COUNT(*) FROM playstyle_match_metrics").fetchone()[0] == 0
        persist_account_materialization(connection, "Player#EUW", evidence, {"M1": detail()}, "test")
        connection.commit()
    with closing(storage.connect()) as connection:
        assert fetch_metrics(connection, [observation()])[0]["farm"] == 6


def test_backup_refuses_existing_destination_and_does_not_modify_source(storage, tmp_path):
    with closing(storage.connect()) as connection, connection:
        add_raw(connection, detail())
        before = protected_snapshot(connection)
    target = tmp_path / "copy.db"
    backup_sqlite(storage.path, target)
    with closing(SQLiteStorage(target, storage.schema_path).connect()) as connection:
        assert protected_snapshot(connection) == before
        assert backfill(connection)["changed"] == 1
    with closing(storage.connect()) as connection:
        assert protected_snapshot(connection) == before
        assert connection.execute("SELECT COUNT(*) FROM playstyle_match_metrics").fetchone()[0] == 0
    with pytest.raises(ValueError, match="new file"):
        backup_sqlite(storage.path, target)
