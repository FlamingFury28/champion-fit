"""Malformed GET identifiers fail before driver binding on both HTTP stores."""
from contextlib import closing, contextmanager
from copy import deepcopy
from functools import partial
from hashlib import sha256
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
import json
import os
from threading import Thread
from urllib.parse import urlencode
import uuid

import pytest

import app
from algorithm_settings import ensure_settings
from frontend.e2e.seed_and_serve import seed
from migrate_postgres import TABLES, migrate
from storage import PostgresStorage


COMMON = {
    "account": ["Alpha#EUW"], "queue": "all", "days": "all", "role": "ALL",
    "as_of": "2026-09-24T12:00:00Z", "flag": "all", "limit": "24",
}
CONTROLS = [
    ("known-account", "/api/matches", COMMON, 200),
    ("unknown-unicode-account", "/api/matches", COMMON | {"account": ["Élodie 友達#EUW"]}, 200),
    ("known-annotation", "/api/annotations", {"match_id": "EUW1-002"}, 200),
    ("unknown-unicode-annotation", "/api/annotations", {"match_id": "Élodie 友達 unknown"}, 200),
    ("nul-friend-search", "/api/friends", COMMON | {"friend_q": "Beta\x00", "min_shared_games": "1"}, 200),
    ("nul-champion-search", "/api/champions", COMMON | {"search": "Ahri\x00"}, 200),
    ("nul-queue-invalid", "/api/matches", COMMON | {"queue": "420\x00"}, 400),
    ("nul-feedback-prevalidated", "/api/recommendation-feedback", {"account": ["Bad\x00#EUW"]}, 400),
]
MALFORMED_IDENTIFIERS = [
    ("account", "/api/matches", COMMON | {"account": ["Alpha#EUW\x00"]}),
    ("account-mixed-repeated", "/api/matches", COMMON | {"account": ["Alpha#EUW", "Bad\x00#EUW"]}),
    ("companion", "/api/matches", COMMON | {"companion_account": ["Beta#EUW\x00"], "companion_mode": "exclude"}),
    ("annotation-match-id", "/api/annotations", {"match_id": "EUW1-002\x00"}),
    ("account-comma-separated", "/api/matches", COMMON | {"account": ["Alpha#EUW,Bad\x00#EUW"]}),
    ("companion-comma-separated", "/api/matches", COMMON | {
        "companion_account": ["Beta#EUW,Other\x00#EUW"], "companion_mode": "exclude",
    }),
]


def snapshot(storage):
    with closing(storage.connect()) as connection:
        return {table: [dict(row) for row in connection.execute(f"SELECT * FROM {table} ORDER BY 1,2")]
                for table in TABLES}


def payload_hash(body):
    return sha256(json.dumps(body, sort_keys=True, ensure_ascii=True).encode()).hexdigest()


@contextmanager
def owned_http(storage, directory):
    class QuietIdentifierHandler(app.DashboardHandler):
        def log_message(self, *args):
            pass

    patch = pytest.MonkeyPatch()
    patch.setattr(app, "STORAGE", storage)
    patch.setattr(app, "DB_PATH", directory / "owned.db")
    patch.setattr(app, "APP_ROOT", directory)
    server = ThreadingHTTPServer(("127.0.0.1", 0), partial(QuietIdentifierHandler, directory=directory))
    worker = Thread(target=lambda: server.serve_forever(poll_interval=.01), daemon=True)
    worker.start()

    def get(endpoint, params):
        client = HTTPConnection("127.0.0.1", server.server_port, timeout=20)
        try:
            client.request("GET", endpoint + "?" + urlencode(params, doseq=True))
            response = client.getresponse()
            assert response.getheader("Content-Type", "").startswith("application/json")
            return response.status, json.loads(response.read())
        finally:
            client.close()

    try:
        yield get
    finally:
        server.shutdown()
        server.server_close()
        worker.join(timeout=5)
        patch.undo()
        assert not worker.is_alive()


@pytest.fixture(scope="module")
def identifier_source(tmp_path_factory):
    directory = tmp_path_factory.mktemp("get-identifier-text-owned")
    source = seed(directory / "owned.db")
    with closing(source.connect()) as connection:
        ensure_settings(connection)
    before = snapshot(source)
    file_before = sha256(source.path.read_bytes()).hexdigest()
    controls = {}
    # Capture controls through the real HTTP stack on this exact source before
    # either engine's malformed requests. PostgreSQL receives the same archive.
    with owned_http(source, directory) as get:
        for name, endpoint, params, expected_status in CONTROLS:
            status, body = get(endpoint, params)
            assert status == expected_status, body
            controls[name] = (status, body, payload_hash(body))
    assert snapshot(source) == before
    assert sha256(source.path.read_bytes()).hexdigest() == file_before
    return directory, source, controls


@pytest.fixture(scope="module", params=["sqlite", "postgres"])
def identifier_storage(request, identifier_source):
    directory, source, controls = identifier_source
    if request.param == "sqlite":
        yield source, directory, source, controls
        return
    base_dsn = os.environ.get("CHAMPION_FIT_TEST_POSTGRES_DSN")
    if not base_dsn:
        pytest.skip("set CHAMPION_FIT_TEST_POSTGRES_DSN for an owned PostgreSQL schema")
    psycopg = pytest.importorskip("psycopg")
    from psycopg import sql
    from psycopg.conninfo import make_conninfo

    schema = "cf_get_identifier_text_" + uuid.uuid4().hex
    with psycopg.connect(base_dsn, autocommit=True) as admin:
        assert admin.info.server_version >= 160000
        admin.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(schema)))
    try:
        storage = PostgresStorage(make_conninfo(base_dsn, options=f"-c search_path={schema}"), app.SCHEMA_PATH)
        # The standard initialization installs the round(double,integer)
        # compatibility function used by the real PostgreSQL API projection.
        storage.initialize()
        counts = migrate(source.path, storage.dsn)
        assert counts["match_quality"] == 6
        yield storage, directory, source, controls
    finally:
        with psycopg.connect(base_dsn, autocommit=True) as admin:
            admin.execute(sql.SQL("DROP SCHEMA {} CASCADE").format(sql.Identifier(schema)))
            assert admin.execute("SELECT 1 FROM pg_namespace WHERE nspname=%s", (schema,)).fetchone() is None


@pytest.fixture(scope="module")
def identifier_http(identifier_storage):
    storage, directory, source, controls = identifier_storage
    with owned_http(storage, directory) as get:
        yield get, storage, source, controls


@pytest.mark.parametrize("name,endpoint,params", MALFORMED_IDENTIFIERS,
                         ids=[case[0] for case in MALFORMED_IDENTIFIERS])
def test_malformed_get_identifiers_are_bad_requests_without_changes_or_server_failure(identifier_http, name, endpoint, params):
    get, storage, source, controls = identifier_http
    before = snapshot(storage)
    file_before = sha256(source.path.read_bytes()).hexdigest()
    original_params = deepcopy(params)

    status, body = get(endpoint, params)
    # Even when the malformed assertion is red, verify the next request can
    # still read the original facts and the prior complete control payload.
    valid_status, valid_body = get("/api/matches", COMMON)
    assert (valid_status, valid_body) == controls["known-account"][:2]
    assert payload_hash(valid_body) == controls["known-account"][2]
    assert snapshot(storage) == before
    assert sha256(source.path.read_bytes()).hexdigest() == file_before
    assert params == original_params
    assert status == 400, body
    assert isinstance(body.get("error"), str) and body["error"]


@pytest.mark.parametrize("name,endpoint,params,expected_status", CONTROLS,
                         ids=[case[0] for case in CONTROLS])
def test_supported_get_controls_keep_their_prior_payload_on_both_engines(identifier_http, name, endpoint, params, expected_status):
    get, storage, source, controls = identifier_http
    before = snapshot(storage)
    file_before = sha256(source.path.read_bytes()).hexdigest()
    status, body = get(endpoint, params)

    assert status == expected_status
    assert (status, body) == controls[name][:2]
    assert payload_hash(body) == controls[name][2]
    if name == "known-account":
        assert len(body["items"]) == 4
        assert body["context"]["accounts"] == ["Alpha#EUW"]
    elif name == "unknown-unicode-account":
        assert body["items"] == []
        assert body["context"]["accounts"] == ["Élodie 友達#EUW"]
    elif name == "known-annotation":
        assert body["item"]["match_id"] == "EUW1-002"
        assert body["item"]["note"] == "Fixture annotation"
        assert body["item"]["manual_label"] == "team issue"
        assert body["item"]["confidence"] == .8
        assert body["revision"] == body["item"]["updated_at"]
    elif name == "unknown-unicode-annotation":
        assert body == {"item": None, "revision": None}
    elif name in {"nul-friend-search", "nul-champion-search"}:
        assert body["items"] == []
    elif name == "nul-feedback-prevalidated":
        assert body == {"error": "accounts must not contain NUL"}
    else:
        assert body["error"]
    assert snapshot(storage) == before
    assert sha256(source.path.read_bytes()).hexdigest() == file_before


@pytest.mark.parametrize("params", [
    {"account": ["Alpha#EUW", "Bad\x00#EUW"], "companion_account": ["Beta#EUW"]},
    {"account": ["Alpha#EUW"], "companion_account": ["Beta#EUW,Other\x00#EUW"]},
], ids=["invalid-account-after-valid", "invalid-companion-after-valid-account"])
def test_complete_scope_is_validated_before_any_canonical_account_lookup(monkeypatch, params):
    original = deepcopy(params)

    def unexpected_resolution(*args, **kwargs):
        pytest.fail("malformed scope reached canonical account lookup")

    monkeypatch.setattr("account_identity.canonical_account_name", unexpected_resolution)
    with pytest.raises(ValueError) as error:
        app.canonical_account_params(object(), params)
    assert str(error.value)
    assert params == original
