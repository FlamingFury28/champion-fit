import json
import socket
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from functools import partial
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from pathlib import Path
from threading import Thread

import pytest

import app
import algorithm_settings
from storage import SQLiteStorage


class QuietDashboardHandler(app.DashboardHandler):
    def log_message(self, format: str, *args) -> None:
        pass


@pytest.fixture
def isolated_server(tmp_path: Path, monkeypatch):
    web_root = tmp_path / "dist"
    assets = web_root / "assets"
    app_assets = web_root / "app"
    assets.mkdir(parents=True)
    app_assets.mkdir()

    index_bytes = b"<!doctype html><title>Test SPA</title><main>spa-entry</main>"
    asset_bytes = b"console.log('fixture');"
    app_asset_bytes = b"real app asset"
    (web_root / "index.html").write_bytes(index_bytes)
    (assets / "app-a1b2c3.js").write_bytes(asset_bytes)
    (app_assets / "real-a1b2c3.txt").write_bytes(app_asset_bytes)

    database_path = tmp_path / "fixture.db"
    storage = SQLiteStorage(database_path, Path(app.SCHEMA_PATH))
    storage.initialize()

    # query_database resolves these globals when a request arrives. Point all
    # filesystem-backed state at the temporary test directory before starting
    # the server so the personal database and Riot checkpoints are untouched.
    monkeypatch.setattr(app, "STORAGE", storage)
    monkeypatch.setattr(app, "DB_PATH", database_path)
    monkeypatch.setattr(app, "APP_ROOT", tmp_path)

    handler = partial(QuietDashboardHandler, directory=web_root)
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()

    try:
        yield {
            "host": "127.0.0.1",
            "port": server.server_port,
            "index": index_bytes,
            "asset": asset_bytes,
            "app_asset": app_asset_bytes,
            "database": database_path,
        }
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def request(server, method: str, path: str, headers: dict[str, str] | None = None, payload=None):
    connection = HTTPConnection(server["host"], server["port"], timeout=5)
    try:
        body = json.dumps(payload).encode("utf-8") if payload is not None else None
        request_headers = {"Content-Type": "application/json"} if payload is not None else {}
        request_headers.update(headers or {})
        connection.request(method, path, body=body, headers=request_headers)
        response = connection.getresponse()
        response_headers = {
            name.lower(): value for name, value in response.getheaders()
        }
        return response.status, response_headers, response.read()
    finally:
        connection.close()


@pytest.mark.parametrize(
    "path",
    (
        "/",
        "/app",
        "/app/overview",
        "/app/profile?account=Test%23EUW",
        "/app/champions/Ahri?role=MIDDLE",
    ),
)
def test_spa_get_returns_the_entry_document(isolated_server, path):
    status, headers, body = request(isolated_server, "GET", path)

    assert status == 200
    assert body == isolated_server["index"]
    assert headers["cache-control"] == "no-cache, must-revalidate"
    assert headers["pragma"] == "no-cache"
    assert headers["content-type"].startswith("text/html")


def test_spa_head_has_get_headers_without_a_body(isolated_server):
    status, headers, body = request(
        isolated_server,
        "HEAD",
        "/app/champions/Ahri?role=MIDDLE",
    )

    assert status == 200
    assert body == b""
    assert int(headers["content-length"]) == len(isolated_server["index"])
    assert headers["cache-control"] == "no-cache, must-revalidate"
    assert headers["content-type"].startswith("text/html")


def test_real_files_take_precedence_over_the_spa_fallback(isolated_server):
    status, _, body = request(isolated_server, "GET", "/app/real-a1b2c3.txt")

    assert status == 200
    assert body == isolated_server["app_asset"]


def test_hashed_vite_assets_are_immutable(isolated_server):
    path = "/assets/app-a1b2c3.js"
    status, headers, body = request(isolated_server, "GET", path)

    assert status == 200
    assert body == isolated_server["asset"]
    assert headers["cache-control"] == "public, max-age=31536000, immutable"

    status, cached_headers, cached_body = request(
        isolated_server,
        "GET",
        path,
        {"If-Modified-Since": headers["last-modified"]},
    )
    assert status == 304
    assert cached_body == b""
    assert cached_headers["cache-control"] == "public, max-age=31536000, immutable"


@pytest.mark.parametrize(
    "path",
    (
        "/assets/missing-a1b2c3.js",
        "/unknown",
    ),
)
def test_missing_assets_and_unknown_paths_remain_404(isolated_server, path):
    status, headers, body = request(isolated_server, "GET", path)

    assert status == 404
    assert body != isolated_server["index"]
    assert headers.get("cache-control") != "public, max-age=31536000, immutable"


@pytest.mark.parametrize("path", sorted(app.LEGACY_PAGE_PATHS))
def test_legacy_html_pages_serve_spa_entry(isolated_server, path):
    status, headers, body = request(isolated_server, "GET", path)

    assert status == 200
    assert body == isolated_server["index"]
    assert headers["cache-control"] == "no-cache, must-revalidate"
    assert headers["content-type"].startswith("text/html")


def test_legacy_champion_query_is_preserved_for_frontend_redirect(isolated_server):
    status, _, body = request(
        isolated_server,
        "GET",
        "/champion.html?champion=Ahri&role=MIDDLE&account=Main%23EUW",
    )

    assert status == 200
    assert body == isolated_server["index"]


@pytest.mark.parametrize("method", ("GET", "HEAD"))
def test_missing_api_remains_a_json_404(isolated_server, method):
    status, headers, body = request(isolated_server, method, "/api/not-real")

    assert status == 404
    assert headers["content-type"] == "application/json; charset=utf-8"
    if method == "GET":
        assert json.loads(body) == {"error": "Endpoint not found"}
    else:
        assert body == b""


@pytest.mark.parametrize("error,status", [
    (sqlite3.OperationalError("database is locked"), 503),
    (sqlite3.OperationalError("no such table: secret_table"), 500),
    (TimeoutError("private database timeout"), 503),
    (RuntimeError("postgresql://user:password@host/private"), 500),
])
def test_api_failures_return_redacted_json_and_correlated_diagnostics(isolated_server, monkeypatch, caplog, error, status):
    def fail(*args, **kwargs):
        raise error
    monkeypatch.setattr(app, "query_database", fail)
    response_status, headers, body = request(isolated_server, "GET", "/api/champions?account=private-puuid")
    assert response_status == status
    assert headers["content-type"] == "application/json; charset=utf-8"
    assert headers["cache-control"] == "no-store"
    assert len(headers["x-request-id"]) == 32
    assert set(json.loads(body)) == {"error"}
    assert "private" not in body.decode()
    assert "secret_table" not in body.decode()
    assert "password" not in caplog.text
    assert "private-puuid" not in caplog.text
    assert headers["x-request-id"] in caplog.text
    if status == 503:
        assert headers["retry-after"] == "1"


def test_api_error_head_sends_no_body_bytes(isolated_server, monkeypatch):
    def fail(*args):
        raise sqlite3.OperationalError("database is locked")
    monkeypatch.setattr(app, "query_database", fail)
    with socket.create_connection((isolated_server["host"], isolated_server["port"]), timeout=5) as client:
        client.sendall(b"HEAD /api/champions HTTP/1.0\r\nHost: localhost\r\n\r\n")
        chunks = []
        while chunk := client.recv(4096):
            chunks.append(chunk)
    headers, body = b"".join(chunks).split(b"\r\n\r\n", 1)
    assert b"503" in headers.split(b"\r\n", 1)[0]
    assert b"Content-Length:" in headers
    assert body == b""


@pytest.mark.parametrize("connection_error", [sqlite3.OperationalError("database is locked"), TimeoutError("private DB timeout")])
@pytest.mark.parametrize("method,path,payload", [
    ("PUT", "/api/algorithm-settings", {}),
    ("PATCH", "/api/friend-groups/1", {"name": "test"}),
    ("DELETE", "/api/friend-groups/1", None),
    ("POST", "/api/friend-groups", {"name": "test", "aliases": ["A#EUW"]}),
    ("POST", "/api/recommendation-feedback", {
        "accounts": ["A#EUW"], "champion": "Ahri", "role": "MIDDLE",
        "preference": "like", "expected_revision": 0,
    }),
    ("POST", "/api/annotations", {
        "match_id": "M1", "invincible": False, "carryable_loss": False,
        "afk_player": False, "griefer": False, "team_collapse": False,
        "manual_label": "", "note": "", "confidence": 0.5, "expected_revision": None,
    }),
])
def test_mutation_connection_failures_use_the_same_json_contract(isolated_server, monkeypatch, method, path, payload, connection_error):
    def fail():
        raise connection_error
    monkeypatch.setattr(app.STORAGE, "connect", fail)
    status, headers, body = request(isolated_server, method, path, payload=payload)
    assert status == 503
    assert headers["content-type"] == "application/json; charset=utf-8"
    assert "error" in json.loads(body)


def test_real_sqlite_driver_codes_and_postgres_states_distinguish_retryable_errors():
    with sqlite3.connect(":memory:") as connection:
        with pytest.raises(sqlite3.OperationalError) as error:
            connection.execute("SELECT * FROM missing")
        assert app.backend_error_status(error.value) == 500
    psycopg = pytest.importorskip("psycopg")
    assert app.backend_error_status(psycopg.errors.LockNotAvailable()) == 503
    assert app.backend_error_status(psycopg.errors.QueryCanceled()) == 503
    assert app.backend_error_status(psycopg.errors.UndefinedTable()) == 500
    assert app.backend_error_status(psycopg.errors.InvalidPassword()) == 500


def test_database_commit_failure_rolls_back_annotation_before_json_error(isolated_server, monkeypatch):
    with sqlite3.connect(isolated_server["database"]) as source:
        source.execute("""INSERT INTO match_quality(account,match_id,date,patch,queue,champion,role,
            identity_resolution,duration_minutes,win,explicit_afk,suspected_quasi_afk,early_surrender,
            anomaly_flags,match_quality_score,loss_attribution_weight,win_evidence_weight,reason)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            ("A#EUW", "M1", "2026-10-01T00:00:00Z", "16.1", "420", "Ahri", "MIDDLE",
             "puuid", 30.0, 1, 0, 0, 0, "", 1.0, 1.0, 1.0, ""))
    original_connect = app.STORAGE.connect

    class CommitFailure:
        def __init__(self):
            self.connection = original_connect()
        def __getattr__(self, name):
            return getattr(self.connection, name)
        def commit(self):
            raise sqlite3.OperationalError("database is locked")

    monkeypatch.setattr(app.STORAGE, "connect", CommitFailure)
    payload = {
        "match_id": "M1", "invincible": False, "carryable_loss": False,
        "afk_player": False, "griefer": False, "team_collapse": False,
        "manual_label": "", "note": "private note", "confidence": 0.5,
        "expected_revision": None,
    }
    status, headers, body = request(isolated_server, "POST", "/api/annotations", payload=payload)
    assert status == 503
    assert headers["content-type"] == "application/json; charset=utf-8"
    assert "private note" not in body.decode()
    with sqlite3.connect(isolated_server["database"]) as source:
        assert source.execute("SELECT COUNT(*) FROM match_annotations").fetchone()[0] == 0


def test_sync_api_adds_redacted_durable_outcomes_preserving_legacy_fields(isolated_server):
    from sync_runs import SyncRun
    with SyncRun(app.STORAGE, "incremental", ["private-A", "private-B"]) as run:
        run.complete_account("private-A", {"inserted": 2})
        run.fail_account("private-B", RuntimeError("private-error-credentials"))
    status, _, body = request(isolated_server, "GET", "/api/sync-status")
    payload = json.loads(body)
    assert status == 200
    assert payload["mode"] == "snapshot"
    assert payload["last_completed_at"] is None
    assert not payload["automatic_api_calls"]
    last = payload["recent_runs"][0]
    assert last["status"] == "partial"
    assert last["completed_accounts"] == 1
    assert last["failed_accounts"] == 1
    assert last["counts"] == {"inserted": 2}
    assert "private-" not in body.decode()


def test_disconnected_client_during_error_response_does_not_escape_or_leak_driver_text(caplog):
    class DisconnectedHandler:
        path = "/api/champions?account=private-puuid"
        command = "GET"
        close_connection = False
        def _send_json_error(self, status, message):
            self._response_status = status
            raise BrokenPipeError("private transport text")

    def fail(_handler):
        raise sqlite3.OperationalError("private credentials and query")

    handler = DisconnectedHandler()
    app.api_operation(fail)(handler)
    assert handler.close_connection
    assert handler._response_status == 500
    assert "private" not in caplog.text
    events = [json.loads(record.message) for record in caplog.records]
    assert events[-1]["outcome"] == "failed"


def test_api_head_uses_the_api_before_static_fallback(isolated_server):
    status, headers, body = request(isolated_server, "HEAD", "/api/sync-status")

    assert status == 200
    assert body == b""
    assert int(headers["content-length"]) > 0
    assert headers["content-type"] == "application/json; charset=utf-8"
    assert isolated_server["database"].is_file()


def test_deleted_friend_group_can_be_recreated_with_the_same_alias(isolated_server):
    payload = {"name": "Original", "aliases": ["Buddy#EUW"]}
    assert request(isolated_server, "POST", "/api/friend-groups", payload=payload)[0] == 200
    _, _, body = request(isolated_server, "GET", "/api/friends")
    group_id = json.loads(body)["manual_groups"][0]["id"]

    assert request(isolated_server, "DELETE", f"/api/friend-groups/{group_id}")[0] == 200
    # Every request opens a new SQLite connection: the cascade must survive
    # connection boundaries, not just run on the initialization connection.
    with app.STORAGE.connect() as connection:
        assert connection.execute("SELECT COUNT(*) FROM friend_group_aliases").fetchone()[0] == 0

    payload["name"] = "Recreated"
    assert request(isolated_server, "POST", "/api/friend-groups", payload=payload)[0] == 200
    _, _, body = request(isolated_server, "GET", "/api/friends")
    groups = json.loads(body)["manual_groups"]
    assert len(groups) == 1
    assert groups[0]["name"] == "Recreated"
    assert groups[0]["aliases"] == ["Buddy#EUW"]


@pytest.mark.parametrize("payload", (
    [],
    {"name": 42, "aliases": ["Buddy#EUW"]},
    {"name": "Buddy", "aliases": "Buddy#EUW"},
    {"name": "Buddy", "aliases": [42]},
    {"name": "Buddy", "aliases": []},
))
def test_friend_group_create_rejects_coercions_and_invalid_shapes(isolated_server, payload):
    status, headers, body = request(
        isolated_server, "POST", "/api/friend-groups", payload=payload,
    )

    assert status == 400
    assert headers["content-type"] == "application/json; charset=utf-8"
    assert json.loads(body)["error"]


def test_friend_group_patch_requires_a_nonempty_string_name(isolated_server):
    assert request(
        isolated_server, "POST", "/api/friend-groups",
        payload={"name": "Buddy", "aliases": ["Buddy#EUW"]},
    )[0] == 200
    _, _, body = request(isolated_server, "GET", "/api/friends")
    group_id = json.loads(body)["manual_groups"][0]["id"]

    for payload in ({"name": 7}, {"name": "  "}, {"name": "Buddy", "aliases": []}):
        assert request(
            isolated_server, "PATCH", f"/api/friend-groups/{group_id}", payload=payload,
        )[0] == 400


def test_friend_group_rename_collision_is_case_insensitive_and_deterministic(isolated_server):
    for name, alias in (("Alpha", "Alpha#EUW"), ("Beta", "Beta#EUW")):
        assert request(
            isolated_server, "POST", "/api/friend-groups",
            payload={"name": name, "aliases": [alias]},
        )[0] == 200
    _, _, body = request(isolated_server, "GET", "/api/friends")
    groups = {group["name"]: group for group in json.loads(body)["manual_groups"]}

    status, headers, body = request(
        isolated_server, "PATCH", f"/api/friend-groups/{groups['Beta']['id']}",
        payload={"name": "aLpHa"},
    )

    assert status == 409
    assert headers["content-type"] == "application/json; charset=utf-8"
    assert json.loads(body) == {"error": "friend group name already exists"}
    _, _, refreshed = request(isolated_server, "GET", "/api/friends")
    assert {group["name"] for group in json.loads(refreshed)["manual_groups"]} == {"Alpha", "Beta"}


def test_preexisting_case_variant_group_names_return_conflict(isolated_server):
    with app.STORAGE.connect() as connection:
        connection.executemany(
            "INSERT INTO friend_groups(name) VALUES(?)",
            [("Alpha",), ("alpha",), ("Gamma",)],
        )
        gamma_id = connection.execute(
            "SELECT id FROM friend_groups WHERE name='Gamma'",
        ).fetchone()["id"]
        connection.commit()

    status, _, body = request(
        isolated_server, "POST", "/api/friend-groups",
        payload={"name": "ALPHA", "aliases": ["New#EUW"]},
    )
    assert status == 409
    assert json.loads(body) == {"error": "multiple friend groups use this name"}

    status, _, body = request(
        isolated_server, "PATCH", f"/api/friend-groups/{gamma_id}",
        payload={"name": "aLpHa"},
    )
    assert status == 409
    assert json.loads(body) == {"error": "multiple friend groups use this name"}
    with app.STORAGE.connect() as connection:
        assert connection.execute("SELECT COUNT(*) FROM friend_groups").fetchone()[0] == 3
        assert connection.execute("SELECT COUNT(*) FROM friend_group_aliases").fetchone()[0] == 0


def test_concurrent_case_variant_posts_reuse_one_sqlite_group(isolated_server):
    payloads = (
        {"name": "Shared Duo", "aliases": ["One#EUW"]},
        {"name": "sHaReD dUo", "aliases": ["Two#EUW"]},
    )
    with ThreadPoolExecutor(max_workers=2) as executor:
        responses = list(executor.map(
            lambda payload: request(
                isolated_server, "POST", "/api/friend-groups", payload=payload,
            ),
            payloads,
        ))

    assert [response[0] for response in responses] == [200, 200]
    with app.STORAGE.connect() as connection:
        groups = connection.execute(
            "SELECT id,name FROM friend_groups WHERE lower(name)=lower('shared duo')",
        ).fetchall()
        assert len(groups) == 1
        aliases = connection.execute(
            "SELECT alias FROM friend_group_aliases WHERE group_id=? ORDER BY alias",
            (groups[0]["id"],),
        ).fetchall()
        assert [row["alias"] for row in aliases] == ["One#EUW", "Two#EUW"]


def _seed_context_matches(storage):
    today = __import__("datetime").date.today().isoformat()
    with storage.connect() as connection:
        connection.executemany(
            "INSERT INTO champions(champion,asset_id,icon_url) VALUES(?,?,?)",
            [(name, name, "") for name in ("Ahri", "Lux", "Zed", "Nami", "Leona")],
        )
        rows = [
            ("Player#EUW", "recent-420", today, "420", "Ahri", 1),
            ("Player#EUW", "recent-440", today, "440", "Ahri", 0),
            ("Player#EUW", "old-420", "2020-01-01", "420", "Ahri", 0),
        ]
        connection.executemany(
            """INSERT INTO match_quality
               (account,match_id,date,patch,queue,champion,role,identity_resolution,
                duration_minutes,win,explicit_afk,suspected_quasi_afk,early_surrender,
                anomaly_flags,match_quality_score,loss_attribution_weight,win_evidence_weight,reason)
               VALUES(?,?,?,'test',?,?,'MIDDLE','test',30,?,0,0,0,'none',1,1,1,'test')""",
            rows,
        )
        participants = [
            ("recent-420", "own-420", "Player#EUW", 100, 1, "Ahri", 1, "player#euw"),
            ("recent-420", "ally-420", "Ally420#EUW", 100, 1, "Nami", 2, "ally420#euw"),
            ("recent-420", "enemy-420", "Enemy420#EUW", 200, 0, "Lux", 6, "enemy420#euw"),
            ("recent-440", "own-440", "Player#EUW", 100, 0, "Ahri", 1, "player#euw"),
            ("recent-440", "ally-440", "Ally440#EUW", 100, 0, "Leona", 2, "ally440#euw"),
            ("recent-440", "enemy-440", "Enemy440#EUW", 200, 1, "Zed", 6, "enemy440#euw"),
            ("old-420", "own-old", "Player#EUW", 100, 0, "Ahri", 1, "player#euw"),
            ("old-420", "enemy-old", "OldEnemy#EUW", 200, 1, "Zed", 6, "oldenemy#euw"),
        ]
        connection.executemany(
            """INSERT INTO match_participants
               (match_id,puuid,riot_id,team_id,win,champion,participant_id,normalized_riot_id)
               VALUES(?,?,?,?,?,?,?,?)""",
            participants,
        )
        connection.execute(
            "INSERT INTO tracked_account_puuids(puuid,account) VALUES('own-420','Player#EUW')",
        )
        connection.execute(
            "INSERT INTO tracked_account_puuids(puuid,account) VALUES('own-440','Player#EUW')",
        )
        connection.execute(
            "INSERT INTO tracked_account_puuids(puuid,account) VALUES('own-old','Player#EUW')",
        )
        connection.commit()


@pytest.mark.parametrize("endpoint", ("/api/matchups", "/api/synergy", "/api/champion"))
def test_context_endpoints_apply_queue_and_days(isolated_server, endpoint):
    _seed_context_matches(app.STORAGE)
    path = (
        f"{endpoint}?account=Player%23EUW&champion=Ahri&role=MIDDLE"
        "&queue=420&days=90"
    )

    status, _, body = request(isolated_server, "GET", path)
    payload = json.loads(body)

    assert status == 200
    assert payload["context"]["queue"] == "420"
    assert payload["context"]["days"] == "90"
    assert payload["context"]["observations"] == 1
    if endpoint == "/api/champion":
        assert payload["stats"]["games"] == 1


def test_friend_search_matches_a_named_groups_alias(isolated_server):
    _seed_context_matches(app.STORAGE)
    assert request(
        isolated_server, "POST", "/api/friend-groups",
        payload={"name": "Duo storico", "aliases": ["Ally420#EUW"]},
    )[0] == 200

    status, _, body = request(
        isolated_server, "GET",
        "/api/friends?account=Player%23EUW&queue=420&days=90&min_shared_games=1&friend_q=ally420",
    )

    assert status == 200
    items = json.loads(body)["items"]
    assert [item["friend"] for item in items] == ["Duo storico"]


def test_checkpoint_is_recoverable_state_not_an_active_sync(isolated_server):
    checkpoint = app.APP_ROOT / ".champion_fit.riot-test.checkpoint.json"
    checkpoint.write_text("{}", encoding="utf-8")
    with app.STORAGE.connect() as connection:
        connection.execute(
            "INSERT INTO source_metadata(key,value) VALUES('last_sync_at','2026-09-24T10:00:00+00:00')",
        )
        connection.commit()

    status, _, body = request(isolated_server, "GET", "/api/sync-status")
    payload = json.loads(body)

    assert status == 200
    assert payload["mode"] == "snapshot"
    assert payload["sync_active"] is False
    assert payload["checkpoint_accounts"] == 1
    assert payload["last_checkpoint_at"] is not None
    assert payload["last_completed_at"] == "2026-09-24T10:00:00+00:00"


def test_fresh_v1_heartbeat_marks_sync_active(isolated_server):
    marker = app.DB_PATH.with_name(
        f".{app.DB_PATH.stem}.riot-sync-live.active.json"
    )
    marker.write_text(json.dumps({
        "version": 1,
        "heartbeat_at": datetime.now(timezone.utc).isoformat(),
    }), encoding="utf-8")

    status, _, body = request(isolated_server, "GET", "/api/sync-status")
    payload = json.loads(body)

    assert status == 200
    assert payload["mode"] == "importing"
    assert payload["sync_active"] is True


def test_stale_and_invalid_heartbeats_are_ignored(isolated_server):
    prefix = f".{app.DB_PATH.stem}.riot-sync-"
    (app.DB_PATH.parent / f"{prefix}stale.active.json").write_text(json.dumps({
        "version": 1,
        "heartbeat_at": (
            datetime.now(timezone.utc)
            - timedelta(seconds=app.SYNC_HEARTBEAT_MAX_AGE_SECONDS + 1)
        ).isoformat(),
    }), encoding="utf-8")
    (app.DB_PATH.parent / f"{prefix}invalid.active.json").write_text(
        "{invalid json", encoding="utf-8",
    )
    (app.DB_PATH.parent / f"{prefix}wrong-version.active.json").write_text(json.dumps({
        "version": 2,
        "heartbeat_at": datetime.now(timezone.utc).isoformat(),
    }), encoding="utf-8")

    status, _, body = request(isolated_server, "GET", "/api/sync-status")
    payload = json.loads(body)

    assert status == 200
    assert payload["mode"] == "snapshot"
    assert payload["sync_active"] is False


def test_infinite_integer_query_returns_400(isolated_server):
    status, headers, body = request(
        isolated_server, "GET", "/api/matches?limit=Infinity&queue=420&days=all",
    )

    assert status == 400
    assert headers["content-type"] == "application/json; charset=utf-8"
    assert "finite" in json.loads(body)["error"]


def test_oversized_and_incomplete_json_bodies_are_rejected(isolated_server):
    with socket.create_connection((isolated_server["host"], isolated_server["port"]), timeout=5) as client:
        client.sendall(
            b"POST /api/friend-groups HTTP/1.1\r\n"
            b"Host: localhost\r\nContent-Type: application/json\r\n"
            + f"Content-Length: {app.MAX_JSON_BODY_BYTES + 1}\r\n".encode("ascii")
            + b"Connection: close\r\n\r\n"
        )
        oversized_response = b""
        while True:
            chunk = client.recv(4096)
            if not chunk:
                break
            oversized_response += chunk

    assert b" 400 " in oversized_response.split(b"\r\n", 1)[0]
    assert b"JSON body is too large" in oversized_response

    with socket.create_connection((isolated_server["host"], isolated_server["port"]), timeout=5) as client:
        client.sendall(
            b"POST /api/friend-groups HTTP/1.1\r\n"
            b"Host: localhost\r\nContent-Type: application/json\r\n"
            b"Content-Length: 100\r\nConnection: close\r\n\r\n{}"
        )
        client.shutdown(socket.SHUT_WR)
        response = b""
        while True:
            chunk = client.recv(4096)
            if not chunk:
                break
            response += chunk

    assert b" 400 " in response.split(b"\r\n", 1)[0]
    assert b"JSON body is incomplete" in response


def test_slow_json_body_times_out(isolated_server, monkeypatch):
    monkeypatch.setattr(app, "REQUEST_BODY_TIMEOUT_SECONDS", 0.1)
    with socket.create_connection((isolated_server["host"], isolated_server["port"]), timeout=5) as client:
        client.sendall(
            b"POST /api/friend-groups HTTP/1.1\r\n"
            b"Host: localhost\r\nContent-Type: application/json\r\n"
            b"Content-Length: 100\r\nConnection: close\r\n\r\n{}"
        )
        response = b""
        while True:
            chunk = client.recv(4096)
            if not chunk:
                break
            response += chunk

    assert b" 408 " in response.split(b"\r\n", 1)[0]
    assert b"JSON body read timed out" in response


@pytest.mark.parametrize("fail", (False, True))
def test_settings_bootstrap_has_explicit_commit_or_rollback(monkeypatch, fail):
    events = []

    class Connection:
        def commit(self): events.append("commit")
        def rollback(self): events.append("rollback")
        def close(self): events.append("close")

    class Storage:
        def connect(self):
            events.append("connect")
            return Connection()

    monkeypatch.setattr(app, "STORAGE", Storage())
    monkeypatch.setattr(algorithm_settings, "ensure_settings", lambda connection: events.append("ensure"))

    def migrate(connection):
        events.append("migrate")
        if fail:
            raise RuntimeError("migration failed")

    monkeypatch.setattr(algorithm_settings, "migrate_recommendation_settings", migrate)

    if fail:
        with pytest.raises(RuntimeError, match="migration failed"):
            app.bootstrap_algorithm_settings()
        assert events == ["connect", "ensure", "migrate", "rollback", "close"]
    else:
        app.bootstrap_algorithm_settings()
        assert events == ["connect", "ensure", "migrate", "commit", "close"]
