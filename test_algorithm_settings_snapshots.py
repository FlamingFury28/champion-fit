"""Settings acknowledgements and reads remain coherent across real writers."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from contextlib import closing, contextmanager
from functools import partial
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
import json
import os
from threading import Event, Thread
import uuid

import pytest

import algorithm_settings
from algorithm_settings import (
    ensure_settings,
    fingerprint_settings,
    get_settings_snapshot,
    recommended_settings,
    save_settings,
)
import app
from storage import PostgresStorage, SQLiteStorage


@pytest.fixture(params=["sqlite", "postgres"])
def settings_storage(request, tmp_path):
    schema = None
    if request.param == "postgres":
        base = os.environ.get("CHAMPION_FIT_TEST_POSTGRES_DSN")
        if not base:
            pytest.skip("set CHAMPION_FIT_TEST_POSTGRES_DSN for isolated PostgreSQL settings tests")
        psycopg = pytest.importorskip("psycopg")
        from psycopg import sql
        from psycopg.conninfo import make_conninfo

        schema = "champion_fit_settings_snapshot_test_" + uuid.uuid4().hex
        with psycopg.connect(base, autocommit=True) as admin:
            admin.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(schema)))
        storage = PostgresStorage(make_conninfo(base, options=f"-c search_path={schema}"), app.SCHEMA_PATH)
    else:
        storage = SQLiteStorage(tmp_path / "settings.db", app.SCHEMA_PATH)
    try:
        storage.initialize()
        with closing(storage.connect()) as connection:
            ensure_settings(connection)
        yield storage
    finally:
        if schema is not None:
            with psycopg.connect(base, autocommit=True) as admin:
                admin.execute(sql.SQL("DROP SCHEMA {} CASCADE").format(sql.Identifier(schema)))


@contextmanager
def settings_http(storage, root, monkeypatch):
    class QuietSettingsHandler(app.DashboardHandler):
        def log_message(self, *args):
            pass

    monkeypatch.setattr(app, "STORAGE", storage)
    monkeypatch.setattr(app, "DB_PATH", root / "settings.db")
    monkeypatch.setattr(app, "APP_ROOT", root)
    server = ThreadingHTTPServer(("127.0.0.1", 0), partial(QuietSettingsHandler, directory=root))
    worker = Thread(target=server.serve_forever, daemon=True)
    worker.start()

    def send(method, body=None):
        client = HTTPConnection("127.0.0.1", server.server_port, timeout=20)
        try:
            client.request(method, "/api/algorithm-settings",
                           body=json.dumps(body).encode("utf-8") if body is not None else None,
                           headers={"Content-Type": "application/json"})
            response = client.getresponse()
            assert response.getheader("Content-Type", "").startswith("application/json")
            return response.status, json.loads(response.read())
        finally:
            client.close()

    try:
        yield send
    finally:
        server.shutdown()
        server.server_close()
        worker.join(timeout=5)
        assert not worker.is_alive()


def proposed_settings(budget):
    settings = recommended_settings()
    settings["training"]["budget"] = budget
    return settings


def assert_snapshot(snapshot, revision, settings, history_revisions):
    assert snapshot["revision"] == revision
    assert snapshot["settings"] == settings
    assert snapshot["fingerprint"] == fingerprint_settings(settings)
    assert [item["revision"] for item in snapshot["history"]] == history_revisions
    active = next(item for item in snapshot["history"] if item["revision"] == revision)
    assert active["settings"] == snapshot["settings"]
    assert active["fingerprint"] == snapshot["fingerprint"]


def test_http_ack_keeps_its_own_revision_when_next_writer_finishes_first(
    settings_storage, tmp_path, monkeypatch,
):
    committed, resume = Event(), Event()
    original_commit = algorithm_settings._commit

    def pause_after_first_commit(connection):
        revision = connection.execute(
            "SELECT current_revision FROM algorithm_settings_state WHERE singleton_id=1"
        ).fetchone()["current_revision"]
        original_commit(connection)
        if revision == 3:
            # The second writer is free to commit: this pause holds no CAS lock.
            assert not algorithm_settings._has_active_transaction(connection)
            committed.set()
            assert resume.wait(10), "first HTTP response was not released"

    monkeypatch.setattr(algorithm_settings, "_commit", pause_after_first_commit)
    first_settings, second_settings = proposed_settings(31), proposed_settings(32)
    with settings_http(settings_storage, tmp_path, monkeypatch) as send:
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(send, "PUT", {"expected_revision": 2, "settings": first_settings})
            try:
                assert committed.wait(10), "first HTTP save did not commit"
                status, current = send("GET")
                assert status == 200 and current["revision"] == 3
                status, second = send("PUT", {"expected_revision": 3, "settings": second_settings})
                assert status == 200
                assert_snapshot(second, 4, second_settings, [4, 3, 2, 1])
            finally:
                resume.set()
            status, first = pending.result(timeout=10)
            assert status == 200
        assert_snapshot(first, 3, first_settings, [3, 2, 1])
        status, final = send("GET")
        assert status == 200
        assert_snapshot(final, 4, second_settings, [4, 3, 2, 1])
        assert final["history"][1] == first["history"][0]


def test_direct_reader_does_not_mix_active_settings_with_later_history(settings_storage):
    captured, resume = Event(), Event()

    class CapturedCursor:
        def __init__(self, cursor):
            self.cursor = cursor

        def pause(self, result):
            captured.set()
            assert resume.wait(10), "settings reader was not released"
            return result

        def fetchone(self):
            return self.pause(self.cursor.fetchone())

        def fetchall(self):
            return self.pause(self.cursor.fetchall())

    class CapturedRead:
        def __init__(self, connection):
            self.connection = connection
            self.armed = True

        def execute(self, query, params=()):
            cursor = self.connection.execute(query, params)
            if self.armed and query.lstrip().startswith("SELECT") and "algorithm_settings" in query:
                self.armed = False
                # Capture real results before another connection commits. This
                # supports either one fetchall or the old separate fetchone.
                return CapturedCursor(cursor)
            return cursor

    def read():
        with closing(settings_storage.connect()) as connection:
            return get_settings_snapshot(CapturedRead(connection))

    def write():
        with closing(settings_storage.connect()) as connection:
            return save_settings(connection, 2, proposed_settings(31))

    with ThreadPoolExecutor(max_workers=2) as pool:
        pending = pool.submit(read)
        try:
            assert captured.wait(10), "reader did not materialize settings"
            saved = pool.submit(write).result(timeout=10)
            assert_snapshot(saved, 3, proposed_settings(31), [3, 2, 1])
        finally:
            resume.set()
        observed = pending.result(timeout=10)
    assert_snapshot(observed, 2, recommended_settings(), [2, 1])


@pytest.mark.parametrize("caller_transaction", [False, True], ids=["owned-transaction", "caller-savepoint"])
def test_snapshot_failure_rolls_back_save_and_preserves_caller_work(
    settings_storage, monkeypatch, caller_transaction,
):
    class SnapshotUnavailable(RuntimeError):
        pass

    original_snapshot = algorithm_settings._snapshot
    with closing(settings_storage.connect()) as connection:
        before = original_snapshot(connection)
        connection.rollback()
        connection.execute("CREATE TABLE caller_work(value INTEGER NOT NULL)")
        connection.commit()
        if caller_transaction:
            connection.execute("INSERT INTO caller_work(value) VALUES(7)")

        def unavailable(active_connection):
            row = active_connection.execute(
                "SELECT current_revision FROM algorithm_settings_state WHERE singleton_id=1"
            ).fetchone()
            assert row["current_revision"] == 3
            raise SnapshotUnavailable("forced snapshot failure after activation")

        with monkeypatch.context() as fault:
            fault.setattr(algorithm_settings, "_snapshot", unavailable)
            with pytest.raises(SnapshotUnavailable, match="forced snapshot failure"):
                save_settings(connection, 2, proposed_settings(31))
        assert algorithm_settings._has_active_transaction(connection) is caller_transaction
        assert original_snapshot(connection) == before
        assert [row["value"] for row in connection.execute("SELECT value FROM caller_work").fetchall()] == (
            [7] if caller_transaction else []
        )
        connection.rollback()
        assert connection.execute("SELECT COUNT(*) AS n FROM caller_work").fetchone()["n"] == 0
        assert original_snapshot(connection) == before


def test_snapshot_preserves_nonlatest_active_revision_historical_fingerprint_and_open_transaction(settings_storage):
    with closing(settings_storage.connect()) as connection:
        save_settings(connection, 2, proposed_settings(31))
        connection.execute("UPDATE algorithm_settings_state SET current_revision=2 WHERE singleton_id=1")
        connection.execute("UPDATE algorithm_settings_revisions SET fingerprint='legacy-fingerprint' WHERE revision=2")
        connection.execute("CREATE TABLE caller_work(value INTEGER NOT NULL)")
        connection.commit()
        connection.execute("INSERT INTO caller_work(value) VALUES(7)")

        snapshot = get_settings_snapshot(connection)

        assert snapshot["revision"] == 2
        assert snapshot["fingerprint"] == "legacy-fingerprint"
        assert snapshot["settings"] == recommended_settings()
        assert [item["revision"] for item in snapshot["history"]] == [3, 2, 1]
        assert snapshot["history"][0]["settings"] == proposed_settings(31)
        assert snapshot["history"][1]["fingerprint"] == "legacy-fingerprint"
        assert algorithm_settings._has_active_transaction(connection)
        assert connection.execute("SELECT value FROM caller_work").fetchone()["value"] == 7
        connection.rollback()
        assert connection.execute("SELECT COUNT(*) AS n FROM caller_work").fetchone()["n"] == 0


@pytest.mark.parametrize("initial_store", ["empty-tables", "missing-tables"])
def test_snapshot_still_initializes_only_an_uninitialized_store(settings_storage, initial_store):
    with closing(settings_storage.connect()) as connection:
        if initial_store == "empty-tables":
            connection.execute("DELETE FROM algorithm_settings_state")
            connection.execute("DELETE FROM algorithm_settings_revisions")
        else:
            connection.execute("DROP TABLE algorithm_settings_state")
            connection.execute("DROP TABLE algorithm_settings_revisions")
        connection.commit()

        snapshot = get_settings_snapshot(connection)

        assert_snapshot(snapshot, 2, recommended_settings(), [2, 1])
    with closing(settings_storage.connect()) as reopened:
        assert get_settings_snapshot(reopened) == snapshot


def test_snapshot_rejects_a_legacy_pointer_without_a_matching_revision(settings_storage):
    with closing(settings_storage.connect()) as connection:
        # Some old stores lack the FK. SQLite's INTEGER affinity also permits
        # a fractional pointer; it must never be truncated into a valid ID.
        connection.execute("DROP TABLE algorithm_settings_state")
        connection.execute(
            "CREATE TABLE algorithm_settings_state(singleton_id INTEGER PRIMARY KEY,current_revision INTEGER NOT NULL)"
        )
        connection.execute("INSERT INTO algorithm_settings_state VALUES(1,99)")
        connection.commit()
        missing_revisions = (99, 2.5) if settings_storage.engine == "sqlite" else (99,)
        for revision in missing_revisions:
            connection.execute("UPDATE algorithm_settings_state SET current_revision=? WHERE singleton_id=1", (revision,))
            connection.commit()
            with pytest.raises(algorithm_settings._SettingsStoreUninitialized):
                algorithm_settings._snapshot(connection)
