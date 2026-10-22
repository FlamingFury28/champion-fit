"""Invalid JSON bodies remain client errors without mutations or server failure."""
from contextlib import closing
from functools import partial
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
import json
from threading import Thread

import pytest

import app
from algorithm_settings import ensure_settings, recommended_settings
from recommendation_feedback import save_feedback
from storage import SQLiteStorage
from test_identity_friends import add_match


ANNOTATION = {
    "match_id": "protected", "invincible": False, "carryable_loss": False,
    "afk_player": False, "griefer": False, "team_collapse": False,
    "manual_label": "", "note": "Reviewed note", "confidence": 1,
    "expected_revision": "original",
}
ROUTES = [
    ("POST", "/api/friend-groups", "create-group"),
    ("POST", "/api/friend-groups/1/aliases", "add-aliases"),
    ("POST", "/api/annotations", "annotation"),
    ("PUT", "/api/algorithm-settings", "settings"),
    ("POST", "/api/algorithm-settings/preview", "preview"),
]


@pytest.fixture
def json_http(tmp_path, monkeypatch):
    storage = SQLiteStorage(tmp_path / "http-json.db", app.SCHEMA_PATH)
    storage.initialize()
    with closing(storage.connect()) as connection:
        ensure_settings(connection)
        add_match(connection, "protected", account="Body#EUW")
        connection.execute("INSERT INTO match_import_provenance VALUES('Body#EUW','protected','fixture','known_riot_default','{}','now')")
        connection.execute("INSERT INTO tracked_account_puuids(puuid,account) VALUES('body-owner','Body#EUW')")
        group_id = connection.execute("INSERT INTO friend_groups(name) VALUES('Protected group') RETURNING id").fetchone()["id"]
        assert group_id == 1
        connection.execute("INSERT INTO friend_group_aliases(group_id,alias) VALUES(1,'Protected#EUW')")
        connection.execute("INSERT INTO match_annotations(match_id,note,updated_at) VALUES('protected','Saved note','original')")
        save_feedback(connection, ["Body#EUW"], "Ahri", "MIDDLE", "like", 0)
        connection.commit()

    monkeypatch.setattr(app, "STORAGE", storage)
    monkeypatch.setattr(app, "DB_PATH", storage.path)
    monkeypatch.setattr(app, "APP_ROOT", tmp_path)

    class QuietBodyHandler(app.DashboardHandler):
        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), partial(QuietBodyHandler, directory=tmp_path))
    worker = Thread(target=server.serve_forever, daemon=True)
    worker.start()

    def send(method, path, body=None):
        client = HTTPConnection("127.0.0.1", server.server_port, timeout=10)
        try:
            client.request(method, path, body=body, headers={"Content-Type": "application/json"} if body else {})
            response = client.getresponse()
            assert response.getheader("Content-Type", "").startswith("application/json")
            return response.status, json.loads(response.read())
        finally:
            client.close()

    def snapshot():
        with closing(storage.connect()) as connection:
            return {table: [dict(row) for row in connection.execute(f"SELECT * FROM {table} ORDER BY 1,2")]
                    for table in ("match_quality", "match_import_provenance", "match_annotations", "friend_groups", "friend_group_aliases",
                                  "recommendation_preferences", "recommendation_feedback_state",
                                  "recommendation_feedback_events", "algorithm_settings_state",
                                  "algorithm_settings_revisions")}

    try:
        yield send, storage, snapshot, worker
    finally:
        server.shutdown()
        server.server_close()
        worker.join(timeout=5)
        assert not worker.is_alive()


def nested_body(kind, depth):
    # Construct valid JSON directly, so generating a malformed request never
    # needs Python's recursive serializer or changes to its recursion limit.
    nested = "[" * depth + "0" + "]" * depth
    templates = {
        "create-group": '{"name":@,"aliases":["New#EUW"]}',
        "add-aliases": '{"aliases":@}',
        "annotation": json.dumps(ANNOTATION).replace('"Reviewed note"', "@"),
        "settings": '{"expected_revision":2,"settings":@}',
        "preview": '{"expected_revision":2,"settings":@}',
    }
    return templates[kind].replace("@", nested).encode("utf-8")


def valid_body(kind):
    return json.dumps({
        "create-group": {"name": "New group", "aliases": ["New#EUW"]},
        "add-aliases": {"aliases": ["New#EUW"]},
        "annotation": ANNOTATION,
        "settings": {"expected_revision": 2, "settings": recommended_settings()},
        "preview": {"expected_revision": 2, "settings": recommended_settings(),
                    "scope": {"account": ["Body#EUW"]}, "filters": {"queue": "420", "role": "MIDDLE", "days": "all"}},
    }[kind]).encode("utf-8")


@pytest.mark.parametrize("method,path,kind", ROUTES, ids=[route[2] for route in ROUTES])
def test_parser_depth_limit_is_a_400_without_database_access_and_next_request_succeeds(
    json_http, monkeypatch, method, path, kind,
):
    send, storage, snapshot, worker = json_http
    before = snapshot()
    body = nested_body(kind, 20_000)
    # Stay below every endpoint's byte cap; this exercises parser failure,
    # independently of the existing request-size rejection.
    assert len(body) < min(app.MAX_JSON_BODY_BYTES, 131_072)

    def unexpected_connect():
        raise AssertionError("JSON rejected by the parser reached the database")

    with monkeypatch.context() as guarded:
        guarded.setattr(storage, "connect", unexpected_connect)
        status, result = send(method, path, body)
    assert status == 400
    assert result["error"]
    assert snapshot() == before
    assert worker.is_alive()

    status, accepted = send(method, path, valid_body(kind))
    assert status == 200, accepted
    if kind == "settings":
        assert accepted["revision"] == 3
    elif kind == "preview":
        assert accepted["base_revision"] == 2
        assert snapshot() == before
    else:
        assert accepted["ok"] is True
    status, loaded = send("GET", "/api/annotations?match_id=protected")
    assert status == 200
    assert loaded["item"]["note"] == ("Reviewed note" if kind == "annotation" else "Saved note")
    after = snapshot()
    assert after["match_quality"] == before["match_quality"]
    assert after["match_import_provenance"] == before["match_import_provenance"]
    for table in ("recommendation_preferences", "recommendation_feedback_state", "recommendation_feedback_events"):
        assert after[table] == before[table]


@pytest.mark.parametrize("method,path,kind", ROUTES, ids=[route[2] for route in ROUTES])
@pytest.mark.parametrize("invalid", ["top-array", "invalid-shape", "malformed-json"])
def test_other_bad_body_shapes_remain_400_and_leave_state_intact(json_http, method, path, kind, invalid):
    send, _, snapshot, worker = json_http
    body = {"top-array": b"[]", "invalid-shape": nested_body(kind, 10), "malformed-json": b'{"unfinished":'}[invalid]
    before = snapshot()
    status, result = send(method, path, body)
    assert status == 400
    assert result["error"]
    assert snapshot() == before
    assert worker.is_alive()
    assert send("GET", "/api/annotations?match_id=protected")[0] == 200
