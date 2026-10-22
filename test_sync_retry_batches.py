"""Historical recovery semantics and bounded SQL reads for incremental sync."""
import json

import pytest

import app
from check_new_matches import _retry_detail_ids
from ingest import ingest_rows
from storage import SQLiteStorage


@pytest.fixture
def connection(tmp_path):
    storage = SQLiteStorage(tmp_path / "retry.db", app.SCHEMA_PATH)
    storage.initialize()
    connection = storage.connect()
    yield connection
    connection.close()


def facts(connection, match_ids, account="Player#EUW"):
    ingest_rows(connection, [{
        "account": account, "match_id": match_id, "champion": "Lux", "role": "MIDDLE", "win": True,
        "date": "2026-09-01", "patch": "16.13", "queue": "420", "duration_minutes": 25,
    } for match_id in match_ids], "test")


def raw(connection, match_id, payload='{"info":{"ok":true}}'):
    connection.execute("INSERT INTO riot_match_raw VALUES(?,?,?,?)", (match_id, "europe", "now", payload))


def state(connection, match_id, status, account="Player#EUW"):
    connection.execute(
        "INSERT INTO riot_match_materialization(account,match_id,status,last_attempt_at) VALUES(?,?,?,'now')",
        (account, match_id, status),
    )


def test_batch_preserves_raw_status_ownership_and_missing_fact_recovery(connection):
    ids = {
        "missing", "corrupt", "invalid", "unresolved", "eligible", "materialized_missing", "no_state",
        "other_invalid", "unsupported", "complete", "legacy_complete",
    }
    for match_id in ids - {"missing", "corrupt"}:
        raw(connection, match_id)
    raw(connection, "corrupt", '{"info":')
    state(connection, "invalid", "invalid_payload")
    state(connection, "unresolved", "identity_unresolved")
    state(connection, "eligible", "eligible")
    state(connection, "materialized_missing", "materialized")
    state(connection, "unsupported", "unsupported_queue")
    state(connection, "complete", "materialized")
    state(connection, "other_invalid", "invalid_payload", "SomeoneElse#EUW")
    facts(connection, {"unresolved", "complete", "legacy_complete", "other_invalid"})
    connection.commit()
    retry, refetch = _retry_detail_ids(connection, ids, "Player#EUW", "p1")
    assert retry == sorted({"missing", "corrupt", "invalid", "unresolved", "eligible", "materialized_missing", "no_state"})
    assert refetch == sorted({"missing", "corrupt", "invalid"})
    assert connection.execute("SELECT COUNT(*) FROM match_quality").fetchone()[0] == 4


@pytest.mark.parametrize("status", ["assumed", "verified", "exception"])
def test_retry_uses_canonical_owner_without_expanding_to_other_players(connection, status):
    connection.execute("INSERT INTO riot_account_identities VALUES('owner','Current#EUW')")
    connection.execute("INSERT INTO riot_identity_puuids VALUES('p1','owner')")
    connection.execute(
        "INSERT INTO riot_account_aliases VALUES('Current#EUW','old#euw','Old#EUW','p1','account_v1','now')",
    )
    connection.execute(
        "INSERT INTO riot_identity_policy(puuid,identity_id,state,source,updated_at) VALUES('p1','owner',?,'test','now')",
        (status,),
    )
    raw(connection, "M1")
    raw(connection, "M2")
    state(connection, "M1", "invalid_payload", "Current#EUW")
    state(connection, "M2", "invalid_payload", "SomeoneElse#EUW")
    facts(connection, ["M2"], "Current#EUW")
    connection.commit()
    retry, refetch = _retry_detail_ids(connection, {"M1", "M2"}, "Old#EUW", "p1")
    assert retry == refetch == ["M1"]
    assert connection.execute("SELECT state FROM riot_identity_policy").fetchone()[0] == status


@pytest.mark.parametrize("size,expected_queries", [(0, 0), (1, 3), (400, 3), (401, 6), (1201, 12)])
def test_retry_data_reads_are_bounded_by_batches_not_history_length(connection, size, expected_queries):
    ids = {f"M{index:05d}" for index in range(size)}
    connection.executemany("INSERT INTO riot_match_raw VALUES(?,'europe','now',?)", [
        (match_id, json.dumps({"info": {"ok": True}})) for match_id in ids
    ])
    connection.executemany(
        "INSERT INTO riot_match_materialization(account,match_id,status,last_attempt_at) "
        "VALUES('Player#EUW',?,'unsupported_queue','now')", [(match_id,) for match_id in ids],
    )
    connection.commit()
    statements = []
    connection.set_trace_callback(statements.append)
    try:
        assert _retry_detail_ids(connection, ids, "Player#EUW", "p1") == ([], [])
    finally:
        connection.set_trace_callback(None)
    data_reads = [statement for statement in statements if any(
        f"FROM {table} " in statement for table in ("riot_match_raw", "riot_match_materialization", "match_quality")
    )]
    assert len(data_reads) == expected_queries
    assert not any(statement.startswith(("INSERT", "UPDATE", "DELETE")) for statement in statements)
