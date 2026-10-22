"""Revision domains agree over HTTP on SQLite and opt-in real PostgreSQL."""
from __future__ import annotations

import json
from contextlib import closing
from copy import deepcopy
from functools import partial
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from threading import Thread

import pytest

import app
from algorithm_settings import ensure_settings, recommended_settings, save_settings
from frontend.e2e.seed_and_serve import seed
from recommendation_feedback import save_feedback
from storage import SQL_INTEGER_MAX
from test_postgres_api import postgres_api_fixture  # noqa: F401


class QuietRevisionHandler(app.DashboardHandler):
    def log_message(self, format: str, *args) -> None:
        pass


@pytest.fixture(params=["sqlite", "postgres"])
def revision_http(request, tmp_path, monkeypatch):
    if request.param == "postgres":
        root, storage, _ = request.getfixturevalue("postgres_api_fixture")
    else:
        root = tmp_path
        storage = seed(root / "fixture.db")
        with closing(storage.connect()) as connection:
            ensure_settings(connection)
    monkeypatch.setattr(app, "STORAGE", storage)
    monkeypatch.setattr(app, "DB_PATH", root / "fixture.db")
    monkeypatch.setattr(app, "APP_ROOT", root)

    def snapshot():
        with closing(storage.connect()) as connection:
            return {
                table: [dict(row) for row in connection.execute(f"SELECT * FROM {table} ORDER BY 1,2")]
                for table in (
                    "algorithm_settings_state", "algorithm_settings_revisions",
                    "recommendation_feedback_state", "recommendation_feedback_events",
                    "recommendation_preferences", "match_quality", "match_participants",
                )
            }

    server = ThreadingHTTPServer(("127.0.0.1", 0), partial(QuietRevisionHandler, directory=root))
    worker = Thread(target=server.serve_forever, daemon=True)
    worker.start()

    def send(method, path, payload=None):
        connection = HTTPConnection("127.0.0.1", server.server_port, timeout=20)
        try:
            body = json.dumps(payload).encode("utf-8") if payload is not None else None
            connection.request(method, path, body=body,
                               headers={"Content-Type": "application/json"} if body is not None else {})
            response = connection.getresponse()
            assert response.getheader("Content-Type", "").startswith("application/json")
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    try:
        yield send, snapshot
    finally:
        server.shutdown()
        server.server_close()
        worker.join(timeout=5)
        assert not worker.is_alive()


def revision_request(send, domain, revision):
    if domain == "settings":
        status, active = send("GET", "/api/algorithm-settings")
        assert status == 200
        return send("PUT", "/api/algorithm-settings", {
            "settings": active["settings"], "expected_revision": revision,
        })
    return send("POST", "/api/recommendation-feedback", {
        "accounts": ["Alpha#EUW"], "champion": "Ahri", "role": "MIDDLE",
        "preference": "like", "expected_revision": revision,
    })


@pytest.mark.parametrize("domain", ["settings", "feedback"])
def test_invalid_revision_domains_are_bad_requests_without_writes(revision_http, domain):
    send, snapshot = revision_http
    before = snapshot()
    for revision in (SQL_INTEGER_MAX + 1, 10**400, -1, True, 1.5, None, "1"):
        status, payload = revision_request(send, domain, revision)
        assert status == 400, (revision, payload)
        assert payload["error"]
        assert snapshot() == before


@pytest.mark.parametrize("domain", ["settings", "feedback"])
def test_representable_maximum_revision_preserves_conflict_snapshot(revision_http, domain):
    send, snapshot = revision_http
    before = snapshot()
    status, payload = revision_request(send, domain, SQL_INTEGER_MAX)
    assert status == 409
    if domain == "settings":
        status, current = send("GET", "/api/algorithm-settings")
        assert status == 200
        assert payload["snapshot"] == current
    else:
        status, current = send("GET", "/api/recommendation-feedback?account=Alpha%23EUW")
        assert status == 200
        assert payload["snapshot"]["revision"] == current["revision"]
        assert payload["snapshot"]["items"] == current["items"]
    assert snapshot() == before


def test_ordinary_writes_still_advance_and_stale_revisions_do_not_overwrite(revision_http):
    send, _ = revision_http
    status, active = send("GET", "/api/algorithm-settings")
    assert status == 200
    proposed = deepcopy(active["settings"])
    proposed["evidence"]["prior_mean"] = .51 if proposed["evidence"]["prior_mean"] != .51 else .52
    status, saved = send("PUT", "/api/algorithm-settings", {
        "settings": proposed, "expected_revision": active["revision"],
    })
    assert status == 200 and saved["revision"] == active["revision"] + 1
    status, stale = send("PUT", "/api/algorithm-settings", {
        "settings": active["settings"], "expected_revision": active["revision"],
    })
    assert status == 409 and stale["snapshot"] == saved

    status, feedback = send("GET", "/api/recommendation-feedback?account=Alpha%23EUW")
    assert status == 200
    payload = {
        "accounts": ["Alpha#EUW"], "champion": "Ahri", "role": "MIDDLE",
        "preference": "dislike", "expected_revision": feedback["revision"],
    }
    status, saved = send("POST", "/api/recommendation-feedback", payload)
    assert status == 200 and saved["revision"] == feedback["revision"] + 1
    status, stale = send("POST", "/api/recommendation-feedback", payload | {"preference": "like"})
    assert status == 409 and stale["snapshot"]["revision"] == saved["revision"]
    assert stale["snapshot"]["items"] == saved["items"]


@pytest.mark.parametrize("domain", ["settings", "feedback"])
@pytest.mark.parametrize("revision", [SQL_INTEGER_MAX + 1, 10**400], ids=["above-sql64", "huge-json-integer"])
def test_direct_writers_reject_out_of_range_revision_before_database_access(domain, revision):
    class NoDatabaseAccess:
        def execute(self, *args, **kwargs):
            pytest.fail("invalid revision reached the database")

    with pytest.raises(ValueError, match="expected_revision"):
        if domain == "settings":
            save_settings(NoDatabaseAccess(), revision, recommended_settings())
        else:
            save_feedback(NoDatabaseAccess(), ["Alpha#EUW"], "Ahri", "MIDDLE", "like", revision)
