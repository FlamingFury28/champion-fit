"""Feedback snapshots keep their revision and projection from one database instant."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing, contextmanager
from functools import partial
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
import json
from threading import Event, Thread

import pytest

import app
import recommendation_feedback as feedback_module
from recommendation_feedback import FeedbackConflictError, read_feedback, save_feedback
from storage import PostgresConnection, SQLiteStorage
from test_identity_friends import add_match
from test_postgres_group_id_width import postgres_groups  # noqa: F401
from test_recommendation_feedback import add_account, add_alias


@pytest.fixture(params=["sqlite", "postgres"])
def feedback_storage(request, tmp_path):
    if request.param == "sqlite":
        storage = SQLiteStorage(tmp_path / "feedback.db", app.SCHEMA_PATH)
    else:
        create, _ = request.getfixturevalue("postgres_groups")
        _, storage = create()
    storage.initialize()
    with closing(storage.connect()) as connection:
        add_account(connection, "identity-a", "Player#EUW", "owner-a", match=False)
        add_account(connection, "identity-b", "Other#EUW", "owner-b", match=False)
        add_alias(connection, "Player#EUW", "Old#EUW", "owner-a")
        add_match(connection, "protected", account="Player#EUW")
        connection.commit()

    def facts():
        with closing(storage.connect()) as connection:
            return {table: [dict(row) for row in connection.execute(f"SELECT * FROM {table} ORDER BY 1,2")]
                    for table in ("match_quality", "tracked_account_puuids", "riot_account_identities",
                                  "riot_identity_puuids", "riot_account_aliases")}

    before = facts()
    yield storage
    assert facts() == before


@contextmanager
def feedback_http(storage, root, monkeypatch):
    class QuietFeedbackHandler(app.DashboardHandler):
        def log_message(self, *args):
            pass

    monkeypatch.setattr(app, "STORAGE", storage)
    monkeypatch.setattr(app, "DB_PATH", root / "feedback.db")
    monkeypatch.setattr(app, "APP_ROOT", root)
    server = ThreadingHTTPServer(("127.0.0.1", 0), partial(QuietFeedbackHandler, directory=root))
    worker = Thread(target=server.serve_forever, daemon=True)
    worker.start()

    def send(method, body=None):
        client = HTTPConnection("127.0.0.1", server.server_port, timeout=20)
        try:
            path = "/api/recommendation-feedback" + ("?account=Player%23EUW" if method == "GET" else "")
            client.request(method, path, body=json.dumps(body).encode("utf-8") if body is not None else None,
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


def save(storage, preference, revision):
    with closing(storage.connect()) as connection:
        result = save_feedback(connection, ["Player#EUW"], "Ahri", "MIDDLE", preference, revision)
        connection.commit()
        return result


class CapturedCursor:
    def __init__(self, cursor, captured, resume):
        self.cursor, self.captured, self.resume = cursor, captured, resume

    def fetchall(self):
        rows = self.cursor.fetchall()
        self.captured.set()
        assert self.resume.wait(10), "feedback reader was not released"
        return rows

    def __iter__(self):
        return iter(self.fetchall())


def test_postgres_conflict_snapshot_cannot_attach_a_later_revision_to_old_preferences(
    feedback_storage, tmp_path, monkeypatch,
):
    if feedback_storage.engine != "postgres":
        pytest.skip("SQLite HTTP writes already hold BEGIN IMMEDIATE through the conflict snapshot")
    initial = save(feedback_storage, "like", 0)
    captured, resume = Event(), Event()
    original_connect = feedback_storage.connect

    class CapturedConflictConnection(PostgresConnection):
        target = False
        failed_cas = False

        def execute(self, query, params=()):
            cursor = super().execute(query, params)
            normalized = " ".join(query.split())
            if self.target and normalized.startswith("UPDATE recommendation_feedback_state SET revision=revision"):
                self.failed_cas = cursor.rowcount == 0
            if self.target and self.failed_cas and normalized.startswith("SELECT") and "recommendation_preferences" in normalized:
                self.target = False
                return CapturedCursor(cursor, captured, resume)
            return cursor

    claimed = False

    def connect():
        nonlocal claimed
        connection = CapturedConflictConnection(original_connect().raw)
        connection.target = not claimed
        claimed = True
        return connection

    monkeypatch.setattr(feedback_storage, "connect", connect)
    payload = {"accounts": ["Player#EUW"], "champion": "Ahri", "role": "MIDDLE",
               "preference": "dislike", "expected_revision": 0}
    with feedback_http(feedback_storage, tmp_path, monkeypatch) as send:
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(send, "POST", payload)
            try:
                assert captured.wait(10), "conflict did not materialize preferences"
                status, second = send("POST", payload | {"expected_revision": 1})
                assert status == 200 and second["revision"] == 2
                assert [item["preference"] for item in second["items"]] == ["dislike"]
            finally:
                resume.set()
            status, conflict = pending.result(timeout=10)
            assert status == 409
        assert conflict["snapshot"] == {key: value for key, value in initial.items() if key != "ok"}
        status, current = send("GET")
        assert status == 200 and current["revision"] == 2
        assert current["items"] == second["items"]
    with closing(original_connect()) as connection:
        assert connection.execute("SELECT COUNT(*) AS n FROM recommendation_feedback_events").fetchone()["n"] == 2


def test_direct_snapshot_keeps_its_projection_and_revision_together(feedback_storage):
    initial = save(feedback_storage, "like", 0)
    captured, resume = Event(), Event()

    class CapturedRead:
        def __init__(self, connection):
            self.connection = connection
            self.armed = True

        def __getattr__(self, name):
            return getattr(self.connection, name)

        def execute(self, query, params=()):
            cursor = self.connection.execute(query, params)
            if self.armed and query.lstrip().startswith("SELECT") and "recommendation_preferences" in query:
                self.armed = False
                return CapturedCursor(cursor, captured, resume)
            return cursor

    def read():
        with closing(feedback_storage.connect()) as connection:
            return read_feedback(CapturedRead(connection), ["Old#EUW"])

    with ThreadPoolExecutor(max_workers=2) as pool:
        pending = pool.submit(read)
        try:
            assert captured.wait(10), "reader did not materialize preferences"
            latest = pool.submit(save, feedback_storage, "dislike", 1).result(timeout=10)
            assert latest["revision"] == 2
        finally:
            resume.set()
        observed = pending.result(timeout=10)
    assert observed == {key: value for key, value in initial.items() if key != "ok"}
    with closing(feedback_storage.connect()) as connection:
        assert read_feedback(connection, ["Player#EUW"])["items"] == latest["items"]


def test_empty_projection_keeps_seed_and_later_revision_without_phantom_items(feedback_storage):
    with closing(feedback_storage.connect()) as connection:
        assert read_feedback(connection, []) == {"revision": 0, "items": []}
    assert save(feedback_storage, "neutral", 0) == {"revision": 0, "items": [], "ok": True}
    assert save(feedback_storage, "like", 0)["revision"] == 1
    assert save(feedback_storage, "neutral", 1) == {"revision": 2, "items": [], "ok": True}
    assert save(feedback_storage, "neutral", 2) == {"revision": 2, "items": [], "ok": True}
    with closing(feedback_storage.connect()) as connection:
        assert read_feedback(connection, ["Old#EUW"]) == {"revision": 2, "items": []}
        assert connection.execute("SELECT COUNT(*) AS n FROM recommendation_feedback_events").fetchone()["n"] == 2


def test_snapshot_filters_identities_and_aliases_but_keeps_the_shared_revision(feedback_storage):
    first = save(feedback_storage, "like", 0)
    with closing(feedback_storage.connect()) as connection:
        second = save_feedback(connection, ["Other#EUW"], "Ahri", "MIDDLE", "dislike", 1)
        connection.commit()
        assert second["revision"] == 2
        assert read_feedback(connection, ["Old#EUW", "Player#EUW"]) == {"revision": 2, "items": first["items"]}
        other = read_feedback(connection, ["Other#EUW"])
        assert [(item["account"], item["preference"]) for item in other["items"]] == [("Other#EUW", "dislike")]
        assert other["revision"] == 2
        assert read_feedback(connection, ["Missing#EUW"]) == {"revision": 2, "items": []}


def test_missing_state_is_still_an_error_without_writes_or_initialization(feedback_storage):
    save(feedback_storage, "like", 0)
    with closing(feedback_storage.connect()) as connection:
        connection.execute("DELETE FROM recommendation_feedback_state")
        connection.commit()
        before = [dict(row) for row in connection.execute("SELECT * FROM recommendation_preferences")]
        with pytest.raises(RuntimeError, match="not initialized"):
            read_feedback(connection, ["Player#EUW"])
        assert [dict(row) for row in connection.execute("SELECT * FROM recommendation_preferences")] == before
        assert connection.execute("SELECT COUNT(*) AS n FROM recommendation_feedback_state").fetchone()["n"] == 0
        assert connection.execute("SELECT COUNT(*) AS n FROM recommendation_feedback_events").fetchone()["n"] == 1


@pytest.mark.parametrize("operation", ["save", "noop", "conflict"])
def test_snapshot_and_mutation_leave_the_callers_transaction_open(feedback_storage, operation):
    if operation == "conflict":
        baseline = save(feedback_storage, "like", 0)
    else:
        baseline = {"revision": 0, "items": []}
    with closing(feedback_storage.connect()) as connection:
        connection.execute("INSERT INTO source_metadata(key,value) VALUES('caller-work','kept')")
        if operation == "conflict":
            with pytest.raises(FeedbackConflictError) as raised:
                save_feedback(connection, ["Player#EUW"], "Ahri", "MIDDLE", "dislike", 0)
            assert raised.value.snapshot == {key: value for key, value in baseline.items() if key != "ok"}
        else:
            preference = "like" if operation == "save" else "neutral"
            saved = save_feedback(connection, ["Old#EUW"], "Ahri", "MIDDLE", preference, 0)
            assert saved["revision"] == (1 if operation == "save" else 0)
            assert read_feedback(connection, ["Player#EUW"]) == {key: value for key, value in saved.items() if key != "ok"}
        assert feedback_module._has_active_transaction(connection)
        assert connection.execute("SELECT value FROM source_metadata WHERE key='caller-work'").fetchone()["value"] == "kept"
        with closing(feedback_storage.connect()) as observer:
            assert read_feedback(observer, ["Player#EUW"]) == {key: value for key, value in baseline.items() if key != "ok"}
            assert observer.execute("SELECT COUNT(*) AS n FROM source_metadata WHERE key='caller-work'").fetchone()["n"] == 0
        connection.rollback()
        assert read_feedback(connection, ["Player#EUW"]) == {key: value for key, value in baseline.items() if key != "ok"}
        assert connection.execute("SELECT COUNT(*) AS n FROM source_metadata WHERE key='caller-work'").fetchone()["n"] == 0
