"""Malformed champion text cannot escape feedback validation or change its ledger."""
from contextlib import closing, contextmanager
from copy import deepcopy
from functools import partial
from hashlib import sha256
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
import json
from threading import Thread

import pytest

import app
from algorithm_settings import ensure_settings
from frontend.e2e.seed_and_serve import seed
from migrate_postgres import TABLES, migrate
from recommendation_feedback import _validated_champion, read_feedback, save_feedback
from test_postgres_group_id_width import postgres_groups  # noqa: F401
from test_recommendation_feedback import add_observed_champion


INVALID_CHAMPIONS = [
    pytest.param("\ud800", id="isolated-high"),
    pytest.param("\udfff", id="isolated-low"),
    pytest.param("Ah\ud800ri", id="high-inside-known-name"),
    pytest.param("Ah\udfffri", id="low-inside-known-name"),
]
OBSERVED_CHAMPION = "Héroïne 👩\u200d🚀"
CHAMPION_ERROR = "champion must be a known champion string"
FEEDBACK_TABLES = {
    "recommendation_preferences", "recommendation_feedback_state", "recommendation_feedback_events",
}


def snapshot(storage):
    with closing(storage.connect()) as connection:
        return {table: [dict(row) for row in connection.execute(f"SELECT * FROM {table} ORDER BY 1,2")]
                for table in TABLES}


def payload(revision, champion="Ahri"):
    return {"accounts": ["Alpha#EUW"], "champion": champion, "role": "MIDDLE",
            "preference": "dislike", "expected_revision": revision}


def current_revision(archive):
    return archive["recommendation_feedback_state"][0]["revision"]


@pytest.fixture(params=["sqlite", "postgres"])
def champion_storage(request, tmp_path):
    # The PostgreSQL case follows the supported public migration path from the
    # same synthetic SQLite archive, including an observed unknown champion.
    source = seed(tmp_path / "champion-feedback-owned.db")
    with closing(source.connect()) as connection:
        ensure_settings(connection)
        add_observed_champion(connection, "Alpha#EUW", "owned-unicode-history", OBSERVED_CHAMPION)
        save_feedback(connection, ["Alpha#EUW"], "Ahri", "MIDDLE", "like", 0)
        connection.commit()
    if request.param == "sqlite":
        storage = source
    else:
        create, _ = request.getfixturevalue("postgres_groups")
        _, storage = create()
        storage.initialize()
        assert migrate(source.path, storage.dsn)["match_quality"] == 7
    yield storage, source


@contextmanager
def champion_http(storage, root, monkeypatch):
    class QuietChampionHandler(app.DashboardHandler):
        def log_message(self, *args):
            pass

    monkeypatch.setattr(app, "STORAGE", storage)
    monkeypatch.setattr(app, "DB_PATH", root / "champion-feedback-owned.db")
    monkeypatch.setattr(app, "APP_ROOT", root)
    server = ThreadingHTTPServer(("127.0.0.1", 0), partial(QuietChampionHandler, directory=root))
    worker = Thread(target=lambda: server.serve_forever(poll_interval=.01), daemon=True)
    worker.start()

    def send(body):
        # Isolated code units arrive through legal, escaped JSON, rather than
        # malformed UTF-8 network bytes. Ordinary emoji uses a valid JSON pair.
        encoded = json.dumps(body, ensure_ascii=True, allow_nan=False).encode("ascii")
        assert json.loads(encoded) == body
        client = HTTPConnection("127.0.0.1", server.server_port, timeout=20)
        try:
            client.request("POST", "/api/recommendation-feedback", body=encoded,
                           headers={"Content-Type": "application/json"})
            response = client.getresponse()
            assert response.getheader("Content-Type", "").startswith("application/json")
            raw = response.read().decode("utf-8", errors="strict")
            return response.status, json.loads(raw), raw
        finally:
            client.close()

    try:
        yield send
    finally:
        server.shutdown()
        server.server_close()
        worker.join(timeout=5)
        assert not worker.is_alive()


@pytest.mark.parametrize("champion", INVALID_CHAMPIONS)
def test_champion_domain_guard_rejects_surrogates_before_alias_or_database_lookup(champion):
    class NoDatabaseAccess:
        def execute(self, *args, **kwargs):
            pytest.fail("malformed champion reached database lookup")

    # save_feedback resolves the account scope before the champion. Exercise
    # this focused domain boundary directly to verify it never needs SQL.
    with pytest.raises(ValueError) as raised:
        _validated_champion(NoDatabaseAccess(), champion, "MIDDLE", "like", [])
    assert type(raised.value) is ValueError
    assert str(raised.value) == CHAMPION_ERROR
    assert str(raised.value).encode("utf-8").decode("utf-8") == CHAMPION_ERROR


@pytest.mark.parametrize("champion", INVALID_CHAMPIONS)
def test_surrogate_champion_is_utf8_json_400_without_cas_or_archive_changes(
    champion_storage, tmp_path, monkeypatch, champion,
):
    storage, source = champion_storage
    before = snapshot(storage)
    revision = current_revision(before)
    request_body = payload(revision, champion)
    original = deepcopy(request_body)
    file_before = sha256(source.path.read_bytes()).hexdigest()
    with champion_http(storage, tmp_path, monkeypatch) as send:
        status, body, raw = send(request_body)
        after_bad = snapshot(storage)
        file_after_bad = sha256(source.path.read_bytes()).hexdigest()
        # Recovery uses the exact same CAS revision, including in the red run.
        recovery_status, recovered, _ = send(payload(revision))

    assert request_body == original
    assert after_bad == before, (status, body)
    assert file_after_bad == file_before
    assert current_revision(after_bad) == revision
    assert after_bad["recommendation_feedback_events"] == before["recommendation_feedback_events"]
    assert recovery_status == 200 and recovered["revision"] == revision + 1, recovered
    after_good = snapshot(storage)
    assert len(after_good["recommendation_feedback_events"]) == len(before["recommendation_feedback_events"]) + 1
    assert all(after_good[table] == before[table] for table in TABLES if table not in FEEDBACK_TABLES)
    with closing(storage.connect()) as connection:
        loaded = read_feedback(connection, ["Alpha#EUW"])
    assert loaded["revision"] == revision + 1
    assert [(item["champion"], item["preference"]) for item in loaded["items"]] == [("Ahri", "dislike")]
    assert status == 400, (body, raw)
    assert body == {"error": CHAMPION_ERROR}


def test_unknown_valid_unicode_champion_keeps_400_message_and_same_revision_recovery(
    champion_storage, tmp_path, monkeypatch,
):
    storage, source = champion_storage
    before = snapshot(storage)
    revision = current_revision(before)
    file_before = sha256(source.path.read_bytes()).hexdigest()
    with champion_http(storage, tmp_path, monkeypatch) as send:
        status, body, raw = send(payload(revision, "Étoile 👩\u200d🚀"))
        assert snapshot(storage) == before
        assert sha256(source.path.read_bytes()).hexdigest() == file_before
        recovery_status, recovered, _ = send(payload(revision))

    assert status == 400
    assert "Étoile" in body["error"] and "🚀" in body["error"]
    assert "must be observed in role MIDDLE for every target account" in body["error"]
    assert body["error"] != CHAMPION_ERROR
    assert "Étoile" in raw and "🚀" in raw
    assert recovery_status == 200 and recovered["revision"] == revision + 1
    after_good = snapshot(storage)
    assert all(after_good[table] == before[table] for table in TABLES if table not in FEEDBACK_TABLES)


@pytest.mark.parametrize("champion,expected", [
    pytest.param(" Áhri ", "Ahri", id="normal-Unicode-alias"),
    pytest.param(OBSERVED_CHAMPION, OBSERVED_CHAMPION, id="observed-Unicode-and-emoji"),
])
def test_supported_champion_aliases_and_observed_unicode_history_remain_writable(
    champion_storage, tmp_path, monkeypatch, champion, expected,
):
    storage, _ = champion_storage
    before = snapshot(storage)
    revision = current_revision(before)
    request_body = payload(revision, champion)
    original = deepcopy(request_body)
    with champion_http(storage, tmp_path, monkeypatch) as send:
        status, saved, _ = send(request_body)
    assert request_body == original
    assert status == 200 and saved["revision"] == revision + 1, saved
    assert any(item["champion"] == expected and item["preference"] == "dislike" for item in saved["items"])
    with closing(storage.connect()) as connection:
        assert read_feedback(connection, ["Alpha#EUW"])["items"] == saved["items"]
    after = snapshot(storage)
    assert len(after["recommendation_feedback_events"]) == len(before["recommendation_feedback_events"]) + 1
    assert all(after[table] == before[table] for table in TABLES if table not in FEEDBACK_TABLES)
