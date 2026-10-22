"""Accepted finite exporter durations keep their representable mean in JSON."""
from contextlib import closing, contextmanager
from copy import deepcopy
from functools import partial
from hashlib import sha256
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
import json
import math
import os
from threading import Thread
from urllib.parse import urlencode
import uuid

import pytest

import app
from algorithm_settings import ensure_settings
from ingest import ingest
from migrate_postgres import TABLES, migrate
from storage import PostgresStorage, SQLiteStorage


ACCOUNT = "FiniteDuration#EUW"
PARAMS = {"account": ACCOUNT, "role": "MIDDLE", "queue": "420", "days": "all",
          "as_of": "2026-09-25T12:00:00Z", "flag": "all", "limit": "24"}
ENDPOINTS = ("/api/profile", "/api/champion")


def match(match_id, duration, **changes):
    return {"account": ACCOUNT, "match_id": match_id, "date": "2026-09-24T12:00:00Z",
            "patch": "16.19", "queue": "420", "champion": "Ahri", "role": "MIDDLE",
            "duration_minutes": duration, "win": True, "reason": "Owned finite duration exporter"} | changes


def import_owned(directory, rows):
    original = deepcopy(rows)
    input_path = directory / "snapshot.json"
    input_path.write_text(json.dumps({"source": "finite duration test", "matches": rows}, allow_nan=False), encoding="utf-8")
    original_input = input_path.read_bytes()
    database_path = directory / "owned.db"
    imported = ingest(input_path, database_path)
    storage = SQLiteStorage(database_path, app.SCHEMA_PATH)
    with closing(storage.connect()) as connection:
        ensure_settings(connection)
    assert rows == original
    assert input_path.read_bytes() == original_input
    return storage, input_path, original_input, imported


def snapshot(storage):
    with closing(storage.connect()) as connection:
        return {table: [dict(row) for row in connection.execute(f"SELECT * FROM {table} ORDER BY 1,2")]
                for table in TABLES}


def reject_constant(value):
    raise ValueError(f"Nonstandard JSON constant: {value}")


@contextmanager
def actual_reads(storage, directory):
    class QuietDurationHandler(app.DashboardHandler):
        def log_message(self, *args):
            pass

    patch = pytest.MonkeyPatch()
    patch.setattr(app, "STORAGE", storage)
    patch.setattr(app, "DB_PATH", directory / "owned.db")
    patch.setattr(app, "APP_ROOT", directory)
    server = ThreadingHTTPServer(("127.0.0.1", 0), partial(QuietDurationHandler, directory=directory))
    worker = Thread(target=lambda: server.serve_forever(poll_interval=.01), daemon=True)
    worker.start()

    def read(endpoint, params):
        query = {key: value if isinstance(value, list) else [str(value)] for key, value in params.items()}
        original = deepcopy(query)
        direct_status, direct = app.query_database(endpoint, query)
        client = HTTPConnection("127.0.0.1", server.server_port, timeout=20)
        try:
            client.request("GET", endpoint + "?" + urlencode(params, doseq=True))
            response = client.getresponse()
            raw = response.read().decode("utf-8")
            assert response.getheader("Content-Type", "").startswith("application/json")
            try:
                body = json.loads(raw, parse_constant=reject_constant)
                strict_error = None
            except ValueError as error:
                body, strict_error = None, str(error)
            assert query == original
            return direct_status, direct, response.status, body, strict_error
        finally:
            client.close()

    try:
        yield read
    finally:
        server.shutdown()
        server.server_close()
        worker.join(timeout=5)
        patch.undo()
        assert not worker.is_alive()


def assert_average(body, endpoint, expected):
    value = body["summary" if endpoint == "/api/profile" else "stats"]["avg_duration"]
    assert math.isfinite(value)
    assert value == pytest.approx(expected, rel=1e-14)


def read_unchanged(storage, directory, input_path, input_bytes, endpoint, params):
    before = snapshot(storage)
    source_storage = SQLiteStorage(directory / "owned.db", app.SCHEMA_PATH)
    file_hash = sha256(source_storage.path.read_bytes()).hexdigest()
    original_params = deepcopy(params)
    with actual_reads(storage, directory) as read:
        result = read(endpoint, params)
    assert snapshot(storage) == before
    assert sha256(source_storage.path.read_bytes()).hexdigest() == file_hash
    assert input_path.read_bytes() == input_bytes
    assert params == original_params
    return result


@pytest.mark.parametrize("endpoint", ENDPOINTS, ids=[path.removeprefix("/api/") for path in ENDPOINTS])
@pytest.mark.parametrize("durations,expected", [
    ([30.0, 30.0], 30.0),
    ([1e308, 1e308], 1e308),
    ([1e308, 0.0], 5e307),
    ([1e308, 1e308, 0.0], 6.666666666666666e307),
], ids=["ordinary", "large-finite-pair", "large-and-zero", "overflowing-total-with-zero"])
def test_public_import_finite_duration_means_stay_finite_in_direct_and_http_results(tmp_path, endpoint, durations, expected):
    rows = [match(f"FINITE-{index}", duration) for index, duration in enumerate(durations)]
    storage, source, source_bytes, imported = import_owned(tmp_path, rows)
    assert (imported["inserted"], imported["skipped"]) == (len(rows), 0)
    params = PARAMS | ({"champion": "Ahri"} if endpoint == "/api/champion" else {})

    direct_status, direct, status, body, strict_error = read_unchanged(
        storage, tmp_path, source, source_bytes, endpoint, params)

    assert direct_status == status == 200
    assert strict_error is None, strict_error
    for payload in (direct, body):
        assert_average(payload, endpoint, expected)
        if endpoint == "/api/profile":
            assert len(payload["champions"]) == 1
            assert payload["champions"][0]["champion"] == "Ahri"
            assert math.isfinite(payload["champions"][0]["avg_duration"])
            assert payload["champions"][0]["avg_duration"] == pytest.approx(expected, rel=1e-14)
        else:
            assert payload["stats"]["games"] == len(rows)


@pytest.mark.parametrize("endpoint", ENDPOINTS, ids=[path.removeprefix("/api/") for path in ENDPOINTS])
def test_large_duration_mean_uses_the_exact_scoped_population_and_champion_group(tmp_path, endpoint):
    rows = [match("AHRI-1", 1e308), match("AHRI-2", 1e308),
            match("LUX-1", 30.0, champion="Lux"), match("LUX-2", 30.0, champion="Lux"),
            match("WITH-PARTNER", 0.0), match("OTHER-ROLE", 0.0, role="TOP"),
            match("OTHER-QUEUE", 0.0, queue="440"), match("OTHER-OWNER", 0.0, account="Other#EUW")]
    storage, source, source_bytes, imported = import_owned(tmp_path, rows)
    assert imported["inserted"] == len(rows)
    with closing(storage.connect()) as connection:
        connection.execute("INSERT INTO tracked_account_puuids(puuid,account) VALUES(?,?)", ("owned-partner", "Partner#EUW"))
        connection.execute("INSERT INTO match_participants(match_id,puuid,riot_id,team_id,win,champion) VALUES(?,?,?,?,?,?)",
                           ("WITH-PARTNER", "owned-partner", "Partner#EUW", 100, 1, "Lux"))
        connection.execute("INSERT INTO match_annotations(match_id,note,confidence,updated_at) VALUES(?,?,?,?)",
                           ("AHRI-1", "Preserve the review", .8, "2026-09-24T13:00:00Z"))
        connection.commit()
    params = PARAMS | {"companion_account": "Partner#EUW", "companion_mode": "exclude"}
    if endpoint == "/api/champion":
        params["champion"] = "Ahri"

    direct_status, direct, status, body, strict_error = read_unchanged(
        storage, tmp_path, source, source_bytes, endpoint, params)

    assert direct_status == status == 200
    assert strict_error is None, strict_error
    for payload in (direct, body):
        assert payload["context"]["accounts"] == [ACCOUNT]
        assert payload["context"]["role"] == "MIDDLE"
        assert payload["context"]["queue"] == "420"
        assert payload["context"]["companion_filter_active"] is True
        assert payload["context"]["observations"] == 4
        assert_average(payload, endpoint, 5e307 if endpoint == "/api/profile" else 1e308)
        if endpoint == "/api/profile":
            by_champion = {row["champion"]: row for row in payload["champions"]}
            assert set(by_champion) == {"Ahri", "Lux"}
            assert by_champion["Ahri"]["avg_duration"] == pytest.approx(1e308, rel=1e-14)
            assert by_champion["Lux"]["avg_duration"] == 30.0
            assert payload["summary"]["games"] == 4
        else:
            assert payload["stats"]["games"] == 2


def test_public_import_skips_null_required_duration_and_keeps_the_normal_rounded_mean(tmp_path):
    rows = [match("ZERO", 0.0), match("THIRTY", 30.0), match("THIRTY-ONE", 31.0),
            match("NULL-REQUIRED-DURATION", None)]
    storage, source, source_bytes, imported = import_owned(tmp_path, rows)
    assert (imported["inserted"], imported["skipped"]) == (3, 1)
    direct_status, direct, status, body, strict_error = read_unchanged(
        storage, tmp_path, source, source_bytes, "/api/profile", PARAMS)

    assert direct_status == status == 200
    assert strict_error is None
    for payload in (direct, body):
        assert payload["summary"]["games"] == 3
        assert payload["summary"]["avg_duration"] == 20.3
        assert payload["champions"][0]["avg_duration"] == 20.3


@pytest.fixture(scope="module")
def ordinary_postgres_duration(tmp_path_factory):
    base_dsn = os.environ.get("CHAMPION_FIT_TEST_POSTGRES_DSN")
    if not base_dsn:
        pytest.skip("set CHAMPION_FIT_TEST_POSTGRES_DSN for an owned PostgreSQL duration control")
    psycopg = pytest.importorskip("psycopg")
    from psycopg import sql
    from psycopg.conninfo import make_conninfo

    directory = tmp_path_factory.mktemp("ordinary-finite-duration-postgres")
    source_storage, source, source_bytes, imported = import_owned(directory, [match("ORDINARY-1", 30.0), match("ORDINARY-2", 30.0)])
    assert imported["inserted"] == 2
    schema = "cf_finite_duration_test_" + uuid.uuid4().hex
    with psycopg.connect(base_dsn, autocommit=True) as admin:
        admin.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(schema)))
    try:
        storage = PostgresStorage(make_conninfo(base_dsn, options=f"-c search_path={schema}"), app.SCHEMA_PATH)
        storage.initialize()
        assert migrate(source_storage.path, storage.dsn)["match_quality"] == 2
        yield storage, directory, source, source_bytes
    finally:
        with psycopg.connect(base_dsn, autocommit=True) as admin:
            admin.execute(sql.SQL("DROP SCHEMA {} CASCADE").format(sql.Identifier(schema)))
            assert admin.execute("SELECT 1 FROM pg_namespace WHERE nspname=%s", (schema,)).fetchone() is None


@pytest.mark.parametrize("endpoint", (*ENDPOINTS, "/api/matches"), ids=["profile", "champion", "matches"])
def test_ordinary_duration_public_import_and_supported_postgres_migration_keep_valid_json(ordinary_postgres_duration, endpoint):
    storage, directory, source, source_bytes = ordinary_postgres_duration
    params = PARAMS | ({"champion": "Ahri"} if endpoint == "/api/champion" else {})
    direct_status, direct, status, body, strict_error = read_unchanged(
        storage, directory, source, source_bytes, endpoint, params)

    assert direct_status == status == 200
    assert strict_error is None
    for payload in (direct, body):
        if endpoint == "/api/matches":
            assert len(payload["items"]) == 2
            assert [row["duration_minutes"] for row in payload["items"]] == [30.0, 30.0]
        else:
            assert_average(payload, endpoint, 30.0)
