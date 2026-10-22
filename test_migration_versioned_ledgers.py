"""Full merges cannot silently replace immutable revisions or break feedback CAS.

Empty sources are no-ops; divergent populated ledgers fail atomically. Only
disposable SQLite files and unique opt-in PostgreSQL schemas are used.
"""
from contextlib import closing
from copy import deepcopy
from functools import partial
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
import json
from threading import Thread
from time import perf_counter
import sqlite3
import sys
import types

import pytest

import app
from algorithm_settings import ensure_settings, get_settings_snapshot, save_settings
from frontend.e2e.seed_and_serve import seed
from migrate_postgres import RIOT_SYNC_TABLES, migrate
from recommendation_feedback import save_feedback
from storage import SQLiteStorage
from test_postgres_group_id_width import postgres_groups  # noqa: F401


TABLES = (
    "algorithm_settings_revisions", "algorithm_settings_state",
    "recommendation_preferences", "recommendation_feedback_state", "recommendation_feedback_events",
    "source_metadata", "match_quality", "friend_groups", "friend_group_aliases",
)


def ledger_rows(storage):
    with closing(storage.connect()) as connection:
        return {table: [dict(row) for row in connection.execute(f"SELECT * FROM {table} ORDER BY 1,2")]
                for table in TABLES}


class QuietLedgerHandler(app.DashboardHandler):
    def log_message(self, format, *args):
        pass


@pytest.fixture
def versioned_ledgers(postgres_groups, tmp_path, monkeypatch):
    create, _ = postgres_groups
    _, target = create()
    source = seed(tmp_path / "source.db")
    with closing(source.connect()) as connection:
        ensure_settings(connection)
    target.initialize()
    migrate(source.path, target.dsn)
    monkeypatch.setattr(app, "STORAGE", target)
    monkeypatch.setattr(app, "DB_PATH", tmp_path / "unused.db")
    monkeypatch.setattr(app, "APP_ROOT", tmp_path)
    server = ThreadingHTTPServer(("127.0.0.1", 0), partial(QuietLedgerHandler, directory=tmp_path))
    worker = Thread(target=server.serve_forever, daemon=True)
    worker.start()

    def send(method, path, payload=None):
        client = HTTPConnection("127.0.0.1", server.server_port, timeout=10)
        try:
            body = json.dumps(payload).encode("utf-8") if payload is not None else None
            client.request(method, path, body=body, headers={"Content-Type": "application/json"} if body else {})
            response = client.getresponse()
            content = response.read()
            assert response.getheader("Content-Type", "").startswith("application/json"), content
            return response.status, json.loads(content)
        finally:
            client.close()

    try:
        yield source, target, send
    finally:
        server.shutdown()
        server.server_close()
        worker.join(timeout=5)
        assert not worker.is_alive()


def feedback_payload(preference, revision):
    return {"accounts": ["Alpha#EUW"], "champion": "Ahri", "role": "MIDDLE",
            "preference": preference, "expected_revision": revision}


def save_source_feedback(source, preference):
    with closing(source.connect()) as connection:
        result = save_feedback(connection, ["Alpha#EUW"], "Ahri", "MIDDLE", preference, 0)
        connection.commit()
        return result


def set_source_prior(source, prior_mean):
    with closing(source.connect()) as connection:
        active = get_settings_snapshot(connection)
        proposed = deepcopy(active["settings"])
        proposed["evidence"]["prior_mean"] = prior_mean
        return save_settings(connection, active["revision"], proposed)


def set_target_prior(send, prior_mean):
    status, active = send("GET", "/api/algorithm-settings")
    assert status == 200
    proposed = deepcopy(active["settings"])
    proposed["evidence"]["prior_mean"] = prior_mean
    status, saved = send("PUT", "/api/algorithm-settings", {
        "expected_revision": active["revision"], "settings": proposed,
    })
    assert status == 200
    return saved


def audit_ledger_writes(target):
    with closing(target.connect()) as connection:
        connection.executescript("""
            CREATE TABLE migration_ledger_write_audit(table_name TEXT);
            CREATE FUNCTION migration_audit_ledger_write() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
                INSERT INTO migration_ledger_write_audit(table_name) VALUES(TG_TABLE_NAME);
                RETURN NULL;
            END $$;
        """)
        for table in TABLES[:5]:
            connection.execute(f"CREATE TRIGGER audit_{table} AFTER INSERT OR UPDATE OR DELETE ON {table} "
                               "FOR EACH ROW EXECUTE FUNCTION migration_audit_ledger_write()")
        connection.commit()


def assert_no_ledger_writes(target):
    with closing(target.connect()) as connection:
        assert connection.execute("SELECT COUNT(*) AS count FROM migration_ledger_write_audit").fetchone()["count"] == 0


def test_full_merge_cannot_rewind_feedback_below_retained_events_or_break_next_http_write(versioned_ledgers):
    source, target, send = versioned_ledgers
    status, saved = send("POST", "/api/recommendation-feedback", feedback_payload("like", 0))
    assert status == 200 and saved["revision"] == 1
    before = ledger_rows(target)
    source_before = ledger_rows(source)
    audit_ledger_writes(target)
    migrate(source.path, target.dsn)
    after = ledger_rows(target)
    assert after == before
    assert_no_ledger_writes(target)
    assert after["recommendation_feedback_events"][:len(before["recommendation_feedback_events"])] == before["recommendation_feedback_events"]
    revision = after["recommendation_feedback_state"][0]["revision"]
    assert revision >= max(row["revision"] for row in after["recommendation_feedback_events"])
    assert after["recommendation_preferences"] == before["recommendation_preferences"]
    status, changed = send("POST", "/api/recommendation-feedback", feedback_payload("dislike", revision))
    assert status == 200 and changed["revision"] == revision + 1
    assert ledger_rows(source) == source_before


def test_full_merge_cannot_overwrite_existing_settings_revision_or_reuse_its_cas_token(versioned_ledgers):
    source, target, send = versioned_ledgers
    target_saved = set_target_prior(send, .51)
    source_saved = set_source_prior(source, .52)
    assert target_saved["revision"] == source_saved["revision"] == 3
    before, source_before = ledger_rows(target), ledger_rows(source)
    with pytest.raises(RuntimeError, match="Conflitto revisioni.*settings"):
        migrate(source.path, target.dsn)
    after = ledger_rows(target)
    assert after == before
    by_revision = {row["revision"]: row for row in after["algorithm_settings_revisions"]}
    for historical in before["algorithm_settings_revisions"]:
        assert by_revision[historical["revision"]] == historical
    status, active = send("GET", "/api/algorithm-settings")
    assert status == 200
    if active["revision"] == target_saved["revision"]:
        assert active["fingerprint"] == target_saved["fingerprint"]
    else:
        proposed = deepcopy(target_saved["settings"])
        proposed["evidence"]["prior_mean"] = .53
        status, conflict = send("PUT", "/api/algorithm-settings", {
            "expected_revision": target_saved["revision"], "settings": proposed,
        })
        assert status == 409 and conflict["snapshot"] == active
        assert ledger_rows(target) == after
    assert ledger_rows(source) == source_before


def test_full_merge_cannot_replace_feedback_event_content_at_existing_revision(versioned_ledgers):
    source, target, send = versioned_ledgers
    status, target_saved = send("POST", "/api/recommendation-feedback", feedback_payload("like", 0))
    assert status == 200 and target_saved["revision"] == 1
    source_saved = save_source_feedback(source, "dislike")
    assert source_saved["revision"] == 1
    before, source_before = ledger_rows(target), ledger_rows(source)
    assert before["recommendation_feedback_events"][0]["payload_json"] != source_before["recommendation_feedback_events"][0]["payload_json"]
    with pytest.raises(RuntimeError, match="Conflitto revisioni.*feedback"):
        migrate(source.path, target.dsn)
    after = ledger_rows(target)
    assert after == before
    by_revision = {row["revision"]: row for row in after["recommendation_feedback_events"]}
    assert by_revision[1] == before["recommendation_feedback_events"][0]
    assert ledger_rows(source) == source_before


def test_identical_snapshot_full_merge_remains_idempotent(versioned_ledgers):
    source, target, _ = versioned_ledgers
    before, source_before = ledger_rows(target), ledger_rows(source)
    audit_ledger_writes(target)
    migrate(source.path, target.dsn)
    assert ledger_rows(target) == before
    assert_no_ledger_writes(target)
    assert ledger_rows(source) == source_before


def test_riot_only_keeps_divergent_application_ledgers_untouched(versioned_ledgers):
    source, target, send = versioned_ledgers
    target_saved = set_target_prior(send, .51)
    source_saved = set_source_prior(source, .52)
    assert target_saved["revision"] == source_saved["revision"]
    assert send("POST", "/api/recommendation-feedback", feedback_payload("like", 0))[0] == 200
    save_source_feedback(source, "dislike")
    before, source_before = ledger_rows(target), ledger_rows(source)
    counts = migrate(source.path, target.dsn, tables=RIOT_SYNC_TABLES)
    assert set(counts) == set(RIOT_SYNC_TABLES)
    assert ledger_rows(target) == before
    assert ledger_rows(source) == source_before


def test_empty_source_units_are_noops_even_with_populated_target(versioned_ledgers, tmp_path):
    _, target, send = versioned_ledgers
    saved = set_target_prior(send, .51)
    assert send("POST", "/api/recommendation-feedback", feedback_payload("like", 0))[0] == 200
    empty = SQLiteStorage(tmp_path / "empty-source.db", app.SCHEMA_PATH)
    empty.initialize()
    before = ledger_rows(target)
    audit_ledger_writes(target)
    migrate(empty.path, target.dsn)
    assert ledger_rows(target) == before
    assert_no_ledger_writes(target)
    assert send("POST", "/api/recommendation-feedback", feedback_payload("dislike", 1))[1]["revision"] == 2
    proposed = deepcopy(saved["settings"])
    proposed["evidence"]["prior_mean"] = .52
    status, updated = send("PUT", "/api/algorithm-settings", {"settings": proposed, "expected_revision": saved["revision"]})
    assert status == 200 and updated["revision"] == saved["revision"] + 1


@pytest.mark.parametrize("tables", [
    ("algorithm_settings_state",), ("algorithm_settings_revisions",),
    ("recommendation_feedback_state",), ("recommendation_preferences",), ("recommendation_feedback_events",),
    ("recommendation_feedback_state", "recommendation_preferences"),
    ("recommendation_feedback_state", "recommendation_feedback_events"),
    ("recommendation_preferences", "recommendation_feedback_events"),
])
def test_partial_ledger_subsets_fail_before_opening_any_database(tmp_path, monkeypatch, tables):
    source = SQLiteStorage(tmp_path / "source.db", app.SCHEMA_PATH)
    source.initialize()
    def reject_connect(*args, **kwargs):
        pytest.fail("partial ledger selection opened a database")
    monkeypatch.setattr(sqlite3, "connect", reject_connect)
    monkeypatch.setitem(sys.modules, "psycopg", types.SimpleNamespace(connect=reject_connect))
    with pytest.raises(ValueError, match="unità completa"):
        migrate(source.path, "postgresql://synthetic-fake", tables=tables)


@pytest.mark.parametrize("table", ["algorithm_settings_state", "algorithm_settings_revisions",
                                    "recommendation_feedback_state", "recommendation_preferences",
                                    "recommendation_feedback_events"])
def test_concurrent_writer_aborts_immediately_and_preserves_all_data(versioned_ledgers, table):
    import psycopg

    source, target, _ = versioned_ledgers
    before, source_before = ledger_rows(target), ledger_rows(source)
    with psycopg.connect(target.dsn) as writer:
        writer.execute(f"LOCK TABLE {table} IN ROW EXCLUSIVE MODE")
        started = perf_counter()
        with pytest.raises(RuntimeError, match="Scrittura concorrente.*ledger"):
            migrate(source.path, target.dsn)
        assert perf_counter() - started < 2
    assert ledger_rows(target) == before
    assert ledger_rows(source) == source_before


def test_bootstrap_without_singleton_is_still_protected_from_writer(versioned_ledgers):
    import psycopg

    source, target, _ = versioned_ledgers
    with closing(target.connect()) as connection:
        connection.execute("DELETE FROM algorithm_settings_state")
        connection.execute("DELETE FROM algorithm_settings_revisions")
        connection.commit()
    before = ledger_rows(target)
    with psycopg.connect(target.dsn) as initializer:
        # ensure_settings inserts history before the missing state row.
        initializer.execute("LOCK TABLE algorithm_settings_revisions IN ROW EXCLUSIVE MODE")
        started = perf_counter()
        with pytest.raises(RuntimeError, match="Scrittura concorrente.*settings"):
            migrate(source.path, target.dsn)
        assert perf_counter() - started < 2
    assert ledger_rows(target) == before
    migrate(source.path, target.dsn)
    assert ledger_rows(target) == ledger_rows(source)


def test_partial_target_schema_rejects_merge_but_explicit_replace_restores_it(versioned_ledgers):
    source, target, _ = versioned_ledgers
    with closing(target.connect()) as connection:
        connection.execute("DROP TABLE algorithm_settings_state")
        connection.commit()
        history = [dict(row) for row in connection.execute("SELECT * FROM algorithm_settings_revisions ORDER BY revision")]
    with pytest.raises(RuntimeError, match="Schema.*settings.*incompleto"):
        migrate(source.path, target.dsn)
    with closing(target.connect()) as connection:
        assert connection.execute("SELECT pg_catalog.to_regclass('algorithm_settings_state') AS relation").fetchone()["relation"] is None
        assert [dict(row) for row in connection.execute("SELECT * FROM algorithm_settings_revisions ORDER BY revision")] == history
    migrate(source.path, target.dsn, mode="replace")
    assert ledger_rows(target) == ledger_rows(source)


def test_ledger_comparison_handles_reordered_sqlite_columns(versioned_ledgers):
    source, target, _ = versioned_ledgers
    with closing(source.connect()) as connection:
        connection.executescript("""
            PRAGMA foreign_keys=OFF;
            ALTER TABLE algorithm_settings_state RENAME TO old_settings_state;
            CREATE TABLE algorithm_settings_state(current_revision INTEGER NOT NULL,
                singleton_id INTEGER PRIMARY KEY,
                FOREIGN KEY(current_revision) REFERENCES algorithm_settings_revisions(revision));
            INSERT INTO algorithm_settings_state SELECT current_revision,singleton_id FROM old_settings_state;
            DROP TABLE old_settings_state;
            CREATE TABLE reordered_settings_history(created_at TEXT NOT NULL, revision INTEGER PRIMARY KEY,
                settings_json TEXT NOT NULL, fingerprint TEXT NOT NULL);
            INSERT INTO reordered_settings_history SELECT created_at,revision,settings_json,fingerprint FROM algorithm_settings_revisions;
            DROP TABLE algorithm_settings_revisions;
            ALTER TABLE reordered_settings_history RENAME TO algorithm_settings_revisions;
        """)
        connection.commit()
    before = ledger_rows(target)
    migrate(source.path, target.dsn)
    assert ledger_rows(target) == before


def test_bootstrap_concurrent_table_creation_times_out_atomically(postgres_groups, tmp_path):
    import psycopg

    create, _ = postgres_groups
    _, target = create()
    source = seed(tmp_path / "bootstrap-source.db")
    with closing(source.connect()) as connection:
        ensure_settings(connection)
    with psycopg.connect(target.dsn) as initializer:
        initializer.execute("""CREATE TABLE algorithm_settings_revisions(
            revision INTEGER PRIMARY KEY, fingerprint TEXT NOT NULL,
            settings_json TEXT NOT NULL, created_at TEXT NOT NULL)""")
        started = perf_counter()
        with pytest.raises(RuntimeError, match="Scrittura concorrente.*ledger"):
            migrate(source.path, target.dsn)
        assert perf_counter() - started < 2
        initializer.rollback()
    with closing(target.connect()) as connection:
        assert connection.execute("SELECT COUNT(*) AS count FROM pg_catalog.pg_class WHERE relnamespace=pg_catalog.current_schema()::pg_catalog.regnamespace").fetchone()["count"] == 0
    migrate(source.path, target.dsn)
    assert ledger_rows(target) == ledger_rows(source)


@pytest.mark.parametrize("corruption", ["settings-pointer-missing", "feedback-pointer-missing", "feedback-event-missing"])
def test_incomplete_source_is_not_treated_as_empty_noop(versioned_ledgers, corruption):
    source, target, _ = versioned_ledgers
    with sqlite3.connect(source.path) as connection:
        if corruption == "settings-pointer-missing":
            connection.execute("DELETE FROM algorithm_settings_state")
        elif corruption == "feedback-pointer-missing":
            connection.execute("DELETE FROM recommendation_feedback_state")
        else:
            connection.execute("UPDATE recommendation_feedback_state SET revision=1")
    before = ledger_rows(target)
    with pytest.raises(RuntimeError, match="Ledger.*sorgente incompleto o incoerente"):
        migrate(source.path, target.dsn)
    assert ledger_rows(target) == before


def test_equal_revision_and_fingerprint_but_different_history_timestamp_conflicts(versioned_ledgers):
    source, target, _ = versioned_ledgers
    with closing(source.connect()) as connection:
        connection.execute("UPDATE algorithm_settings_revisions SET created_at='different history timestamp' WHERE revision=2")
        connection.commit()
    before = ledger_rows(target)
    with pytest.raises(RuntimeError, match="Conflitto revisioni.*settings"):
        migrate(source.path, target.dsn)
    assert ledger_rows(target) == before
