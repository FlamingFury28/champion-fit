"""Numeric HTTP boundaries stay predictable on SQLite and real PostgreSQL."""
from contextlib import closing
from functools import partial
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
import json
from threading import Thread
from urllib.parse import quote, urlencode
import uuid

import pytest

import app
from ingest import ingest_rows
from migrate_postgres import migrate
from storage import SQLiteStorage
from test_postgres_api import postgres_api_fixture  # noqa: F401


MAX_SQL_INTEGER = 2**63 - 1
PROTECTED_TABLES = ("match_quality", "match_import_provenance", "match_annotations", "friend_groups",
                    "friend_group_aliases", "recommendation_preferences", "recommendation_feedback_state",
                    "recommendation_feedback_events")


def snapshot(storage):
    with closing(storage.connect()) as connection:
        return {table: [dict(row) for row in connection.execute(f"SELECT * FROM {table} ORDER BY 1,2")]
                for table in PROTECTED_TABLES}


class QuietNumericHandler(app.DashboardHandler):
    def log_message(self, format, *args):
        pass


@pytest.fixture(params=["sqlite", "postgres"])
def numeric_http(request, tmp_path, monkeypatch):
    source = SQLiteStorage(tmp_path / "numeric-boundaries.db", app.SCHEMA_PATH)
    source.initialize()
    prefix = uuid.uuid4().hex
    account, match_id = f"Boundary-{prefix}#EUW", f"{prefix}-match"
    group_name, alias = f"Boundary-{prefix}", f"BoundaryAlias-{prefix}#EUW"
    with closing(source.connect()) as connection, connection:
        ingest_rows(connection, [{"account": account, "match_id": match_id, "date": "20260924T120000Z",
                                  "patch": "16.19", "queue": "420", "champion": "Lux", "role": "MIDDLE",
                                  "duration_minutes": 30, "win": True}], "synthetic numeric API boundaries")
        connection.execute("INSERT INTO friend_groups(name) VALUES(?)", (group_name,))
        group_id = connection.execute("SELECT id FROM friend_groups WHERE name=?", (group_name,)).fetchone()[0]
        connection.execute("INSERT INTO friend_group_aliases(group_id,alias) VALUES(?,?)", (group_id, alias))
        connection.execute("INSERT INTO match_annotations(match_id,note,confidence,updated_at) VALUES(?,?,?,?)",
                           (match_id, "Preserve saved note", 0.5, "base-revision"))
    storage = source
    if request.param == "postgres":
        _, storage, _ = request.getfixturevalue("postgres_api_fixture")
        migrate(source.path, storage.dsn)
    with closing(storage.connect()) as connection:
        group_id = connection.execute("SELECT id FROM friend_groups WHERE name=?", (group_name,)).fetchone()["id"]
    monkeypatch.setattr(app, "STORAGE", storage)
    monkeypatch.setattr(app, "DB_PATH", source.path)
    monkeypatch.setattr(app, "APP_ROOT", tmp_path)
    server = ThreadingHTTPServer(("127.0.0.1", 0), partial(QuietNumericHandler, directory=tmp_path))
    worker = Thread(target=server.serve_forever, daemon=True)
    worker.start()

    def send(method, path, payload=None):
        client = HTTPConnection("127.0.0.1", server.server_port, timeout=10)
        try:
            body = json.dumps(payload).encode("utf-8") if payload is not None else None
            client.request(method, path, body=body, headers={"Content-Type": "application/json"} if body else {})
            response = client.getresponse()
            content = response.read()
            result = (json.loads(content) if response.getheader("Content-Type", "").startswith("application/json")
                      else content.decode("utf-8"))
            return response.status, result
        finally:
            client.close()

    try:
        yield send, storage, account, match_id, group_id, alias
    finally:
        server.shutdown()
        server.server_close()
        worker.join(timeout=5)


def test_evidence_offset_accepts_signed64_max_and_rejects_outside_domain(numeric_http):
    send, storage, account, match_id, _, _ = numeric_http
    before = snapshot(storage)
    params = {"account": account, "role": "MIDDLE", "queue": "420", "days": "all",
              "as_of": "2026-09-25T12:00:00Z", "champion": "Lux", "limit": "20"}

    status, ordinary = send("GET", "/api/recommendation-evidence?" + urlencode(params | {"offset": "0"}))
    assert status == 200
    assert ordinary["items"][0]["match_id"] == match_id
    assert ordinary["items"][0]["date"] == "20260924T120000Z"
    status, maximum = send("GET", "/api/recommendation-evidence?" + urlencode(params | {"offset": MAX_SQL_INTEGER}))
    assert status == 200
    assert maximum["offset"] == MAX_SQL_INTEGER and maximum["items"] == []
    assert maximum["total"] == ordinary["total"] == 1
    for value in (MAX_SQL_INTEGER + 1, -1, -MAX_SQL_INTEGER - 2):
        status, payload = send("GET", "/api/recommendation-evidence?" + urlencode(params | {"offset": value}))
        assert status == 400, payload
    assert snapshot(storage) == before


def test_group_ids_reject_outside_domain_and_preserve_exact_maximum_resource(numeric_http):
    send, storage, _, _, group_id, alias = numeric_http
    before = snapshot(storage)
    for invalid in (0, -1, MAX_SQL_INTEGER + 1, -MAX_SQL_INTEGER - 2):
        for method, suffix, payload in (
            ("DELETE", "", None), ("PATCH", "", {"name": "Rejected rename"}),
            ("POST", "/aliases", {"aliases": ["Rejected#EUW"]}),
            ("DELETE", "/aliases/" + quote(alias, safe=""), None),
        ):
            status, body = send(method, f"/api/friend-groups/{invalid}{suffix}", payload)
            assert status == 400, body
    assert snapshot(storage) == before

    # The parent key is BIGSERIAL on PostgreSQL; explicitly stored signed64
    # IDs must be addressed exactly rather than clamped to another resource.
    with closing(storage.connect()) as connection:
        connection.execute("INSERT INTO friend_groups(id,name) VALUES(?,?)", (MAX_SQL_INTEGER, f"Maximum-{group_id}"))
        connection.commit()
    status, renamed = send("PATCH", f"/api/friend-groups/{MAX_SQL_INTEGER}", {"name": f"Renamed maximum-{group_id}"})
    assert status == 200 and renamed["id"] == str(MAX_SQL_INTEGER)
    maximum_aliases = [f"Maximum-first-{group_id}#EUW", f"Maximum-second-{group_id}#EUW"]
    status, added_maximum = send("POST", f"/api/friend-groups/{MAX_SQL_INTEGER}/aliases", {"aliases": maximum_aliases})
    assert status == 200 and added_maximum["id"] == str(MAX_SQL_INTEGER)
    assert added_maximum["added_aliases"] == maximum_aliases
    status, removed_alias = send(
        "DELETE", f"/api/friend-groups/{MAX_SQL_INTEGER}/aliases/{quote(maximum_aliases[0], safe='')}",
    )
    assert status == 200 and removed_alias["id"] == str(MAX_SQL_INTEGER)
    with closing(storage.connect()) as connection:
        assert connection.execute("SELECT name FROM friend_groups WHERE id=?", (MAX_SQL_INTEGER,)).fetchone()["name"] == f"Renamed maximum-{group_id}"
        assert [dict(row) for row in connection.execute(
            "SELECT group_id,alias FROM friend_group_aliases WHERE group_id=?", (MAX_SQL_INTEGER,),
        )] == [{"group_id": MAX_SQL_INTEGER, "alias": maximum_aliases[1]}]
    status, deleted = send("DELETE", f"/api/friend-groups/{MAX_SQL_INTEGER}")
    assert status == 200 and deleted["id"] == str(MAX_SQL_INTEGER)
    with closing(storage.connect()) as connection:
        assert connection.execute("SELECT 1 FROM friend_groups WHERE id=?", (MAX_SQL_INTEGER,)).fetchone() is None
        assert connection.execute("SELECT 1 FROM friend_group_aliases WHERE group_id=?", (MAX_SQL_INTEGER,)).fetchone() is None
    status, missing = send("POST", f"/api/friend-groups/{MAX_SQL_INTEGER}/aliases", {"aliases": ["Missing#EUW"]})
    assert status == 400 and "Gruppo non trovato" in missing["error"]

    added = f"Added-{group_id}#EUW"
    assert send("POST", f"/api/friend-groups/{group_id}/aliases", {"aliases": [added]})[0] == 200
    assert send("DELETE", f"/api/friend-groups/{group_id}/aliases/{quote(added, safe='')}")[0] == 200
    assert snapshot(storage) == before


def test_annotation_confidence_rejects_huge_numbers_before_float_and_keeps_valid_values(numeric_http):
    send, storage, _, match_id, _, _ = numeric_http
    before = snapshot(storage)
    annotation = {"match_id": match_id, "invincible": False, "carryable_loss": False, "afk_player": False,
                  "griefer": False, "team_collapse": False, "manual_label": "review", "note": "Valid note",
                  "confidence": 0.5, "expected_revision": "base-revision"}
    for invalid in (10**400, -(10**400), -0.01, 1.01, True, "0.5", float("nan"), float("inf"), -float("inf")):
        status, payload = send("POST", "/api/annotations", annotation | {"confidence": invalid})
        assert status == 400, payload
    assert snapshot(storage) == before

    for confidence in (0, 0.5, 1):
        status, saved = send("POST", "/api/annotations", annotation | {"confidence": confidence})
        assert status == 200, saved
        annotation["expected_revision"] = saved["revision"]
        status, loaded = send("GET", "/api/annotations?" + urlencode({"match_id": match_id}))
        assert status == 200
        assert loaded["item"]["confidence"] == confidence
    after = snapshot(storage)
    unrelated_before = [row for row in before["match_annotations"] if row["match_id"] != match_id]
    unrelated_after = [row for row in after["match_annotations"] if row["match_id"] != match_id]
    assert after | {"match_annotations": unrelated_after} == before | {"match_annotations": unrelated_before}
