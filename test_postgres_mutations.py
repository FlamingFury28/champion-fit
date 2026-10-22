"""Opt-in real PostgreSQL HTTP writes and concurrent revision contracts.

Uses the synthetic SQLite migration and unique disposable schema from the API
suite. No request or write reaches the application's operational database.
"""
from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from copy import deepcopy
from functools import partial
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from threading import Barrier, Thread
from urllib.parse import quote

import pytest

import app
from test_postgres_api import postgres_api_fixture  # noqa: F401


class QuietPostgresHandler(app.DashboardHandler):
    def log_message(self, format: str, *args) -> None:
        pass


@pytest.fixture
def postgres_http(postgres_api_fixture, monkeypatch):
    root, storage, _ = postgres_api_fixture
    monkeypatch.setattr(app, "STORAGE", storage)
    monkeypatch.setattr(app, "DB_PATH", root / "fixture.db")
    monkeypatch.setattr(app, "APP_ROOT", root)

    def archived_facts():
        with closing(storage.connect()) as connection:
            return {
                table: [dict(row) for row in connection.execute(f"SELECT * FROM {table} ORDER BY 1,2")]
                for table in ("match_quality", "match_participants", "source_metadata", "champion_fit")
            }

    before = archived_facts()
    server = ThreadingHTTPServer(("127.0.0.1", 0), partial(QuietPostgresHandler, directory=root))
    worker = Thread(target=server.serve_forever, daemon=True)
    worker.start()

    def request(method, path, payload=None):
        connection = HTTPConnection("127.0.0.1", server.server_port, timeout=20)
        try:
            body = json.dumps(payload).encode("utf-8") if payload is not None else None
            headers = {"Content-Type": "application/json"} if body is not None else {}
            connection.request(method, path, body=body, headers=headers)
            response = connection.getresponse()
            content = response.read()
            assert response.getheader("Content-Type", "").startswith("application/json"), content
            return response.status, json.loads(content)
        finally:
            connection.close()

    try:
        yield request, storage
    finally:
        server.shutdown()
        server.server_close()
        worker.join(timeout=5)
        assert not worker.is_alive()
        assert archived_facts() == before


def race_requests(request, method, path, payloads):
    barrier = Barrier(len(payloads))

    def send(payload):
        barrier.wait(timeout=10)
        return payload, request(method, path, payload)

    with ThreadPoolExecutor(max_workers=len(payloads)) as workers:
        return list(workers.map(send, payloads))


def test_real_postgres_concurrent_annotation_creation_preserves_winner(postgres_http):
    request, storage = postgres_http
    annotation = {
        "match_id": "EUW1-001", "invincible": False, "carryable_loss": False,
        "afk_player": False, "griefer": False, "team_collapse": False,
        "manual_label": "review", "note": "", "confidence": 0.8, "expected_revision": None,
    }
    results = race_requests(request, "POST", "/api/annotations", [
        annotation | {"note": "First editor"}, annotation | {"note": "Second editor"},
    ])
    assert sorted(result[0] for _, result in results) == [200, 409]
    winner, (_, saved) = next((payload, result) for payload, result in results if result[0] == 200)
    status, loaded = request("GET", "/api/annotations?match_id=EUW1-001")
    assert status == 200
    assert loaded["item"]["note"] == winner["note"]
    assert loaded["revision"] == saved["revision"]
    stale_status, _ = request("POST", "/api/annotations", annotation | {"note": "Stale editor"})
    assert stale_status == 409
    update_status, updated = request("POST", "/api/annotations", annotation | {
        "note": "Reviewed again", "expected_revision": saved["revision"],
    })
    assert update_status == 200
    assert updated["revision"] != saved["revision"]
    with closing(storage.connect()) as connection:
        row = connection.execute("SELECT note,updated_at FROM match_annotations WHERE match_id=?", ("EUW1-001",)).fetchone()
        assert row == {"note": "Reviewed again", "updated_at": updated["revision"]}


def test_real_postgres_concurrent_preferences_append_one_revision(postgres_http):
    request, storage = postgres_http
    preference = {"accounts": ["Alpha#EUW"], "champion": "Ahri", "role": "MIDDLE", "expected_revision": 0}
    results = race_requests(request, "POST", "/api/recommendation-feedback", [
        preference | {"preference": "like"}, preference | {"preference": "dislike"},
    ])
    assert sorted(result[0] for _, result in results) == [200, 409]
    winner, (_, saved) = next((payload, result) for payload, result in results if result[0] == 200)
    conflict = next(result[1] for _, result in results if result[0] == 409)
    assert saved["revision"] == conflict["snapshot"]["revision"] == 1
    status, loaded = request("GET", "/api/recommendation-feedback?account=Alpha%23EUW")
    assert status == 200
    assert loaded["revision"] == 1
    with closing(storage.connect()) as connection:
        row = connection.execute("SELECT preference FROM recommendation_preferences WHERE champion='Ahri'").fetchone()
        assert row["preference"] == winner["preference"]
        assert connection.execute("SELECT COUNT(*) count FROM recommendation_feedback_events").fetchone()["count"] == 1
    status, unchanged = request("POST", "/api/recommendation-feedback", winner | {"expected_revision": 1})
    assert status == 200
    assert unchanged["revision"] == 1
    status, cleared = request("POST", "/api/recommendation-feedback", preference | {"preference": "neutral", "expected_revision": 1})
    assert status == 200
    assert cleared["revision"] == 2
    with closing(storage.connect()) as connection:
        assert connection.execute("SELECT COUNT(*) count FROM recommendation_preferences").fetchone()["count"] == 0
        assert connection.execute("SELECT COUNT(*) count FROM recommendation_feedback_events").fetchone()["count"] == 2


def test_real_postgres_friend_group_lifecycle_rolls_back_conflicting_aliases(postgres_http):
    request, storage = postgres_http
    status, _ = request("POST", "/api/friend-groups", {"name": "PG editors", "aliases": ["Élodie#EUW"]})
    assert status == 200
    with closing(storage.connect()) as connection:
        group_id = connection.execute("SELECT id FROM friend_groups WHERE name='PG editors'").fetchone()["id"]
    status, renamed = request("PATCH", f"/api/friend-groups/{group_id}", {"name": "PG reviewers"})
    assert status == 200
    assert renamed["name"] == "PG reviewers"
    status, _ = request("POST", f"/api/friend-groups/{group_id}/aliases", {"aliases": ["Added#EUW", "duofriend#euw"]})
    assert status == 409
    with closing(storage.connect()) as connection:
        aliases = [row["alias"] for row in connection.execute("SELECT alias FROM friend_group_aliases WHERE group_id=?", (group_id,))]
        assert aliases == ["Élodie#EUW"]
    status, added = request("POST", f"/api/friend-groups/{group_id}/aliases", {"aliases": ["éLODIE#euw", "Added#EUW"]})
    assert status == 200
    assert added["added_aliases"] == ["Added#EUW"]
    status, _ = request("DELETE", f"/api/friend-groups/{group_id}/aliases/{quote('éLODIE#euw', safe='')}")
    assert status == 200
    status, _ = request("DELETE", f"/api/friend-groups/{group_id}")
    assert status == 200
    with closing(storage.connect()) as connection:
        assert connection.execute("SELECT COUNT(*) count FROM friend_group_aliases WHERE group_id=?", (group_id,)).fetchone()["count"] == 0
        assert connection.execute("SELECT COUNT(*) count FROM friend_groups WHERE name='Duo storico'").fetchone()["count"] == 1


def test_real_postgres_settings_http_write_rejects_stale_revisions(postgres_http):
    request, storage = postgres_http
    status, before = request("GET", "/api/algorithm-settings")
    assert status == 200
    proposed = deepcopy(before["settings"])
    proposed["evidence"]["prior_mean"] = 0.6
    status, saved = request("PUT", "/api/algorithm-settings", {"expected_revision": before["revision"], "settings": proposed})
    assert status == 200
    assert saved["revision"] == before["revision"] + 1
    assert saved["fingerprint"] != before["fingerprint"]
    status, rejected = request("PUT", "/api/algorithm-settings", {"expected_revision": before["revision"], "settings": before["settings"]})
    assert status == 409
    assert rejected["snapshot"]["revision"] == saved["revision"]
    status, stale = request("GET", f"/api/profile?algorithm_revision={before['revision']}")
    assert status == 409
    assert stale["algorithm_revision"] == saved["revision"]
    status, loaded = request("GET", "/api/algorithm-settings")
    assert status == 200
    assert loaded["settings"] == proposed
    with closing(storage.connect()) as connection:
        revisions = [row["revision"] for row in connection.execute("SELECT revision FROM algorithm_settings_revisions ORDER BY revision")]
        assert revisions == [row["revision"] for row in reversed(loaded["history"])]
