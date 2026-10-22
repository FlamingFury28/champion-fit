"""Public calendar windows retain valid UTC boundary facts on owned stores."""
from contextlib import closing
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from functools import partial
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
import json
import os
from threading import Thread
from urllib.parse import urlencode
import uuid

import pytest

import app
from algorithm_settings import ensure_settings, recommended_settings, settings_context
from contextual_comparisons import encounter_data
from ingest import ingest_rows
from migrate_postgres import TABLES, migrate
from playstyle_analysis import resolve_filters
from storage import PostgresStorage, SQLiteStorage


ACCOUNT = "Calendar#EUW"
DATES = {
    "MINIMUM": "0001-01-01T00:00:00Z",
    "DISTANT": "1600-06-01T12:00:00Z",
    "ORDINARY": "2026-09-24T12:00:00Z",
    "MAXIMUM": "9999-12-31T23:59:59.999999Z",
}
ENDPOINTS = ("/api/matches", "/api/recommendations", "/api/playstyles", "/api/matchups", "/api/synergy")


def snapshot(storage):
    with closing(storage.connect()) as connection:
        return {table: [dict(row) for row in connection.execute(f"SELECT * FROM {table} ORDER BY 1,2")]
                for table in TABLES}


def persisted_tables(storage):
    with closing(storage.connect()) as connection:
        if storage.engine == "sqlite":
            rows = connection.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
            )
        else:
            rows = connection.execute(
                "SELECT table_name AS name FROM information_schema.tables "
                "WHERE table_schema=current_schema() AND table_type='BASE TABLE'"
            )
        return {row["name"] for row in rows}


@pytest.fixture(scope="module", params=["sqlite", "postgres"])
def calendar_storage(request, tmp_path_factory):
    directory = tmp_path_factory.mktemp("calendar-window-owned")
    schema = None
    storage = SQLiteStorage(directory / "fixture.db", app.SCHEMA_PATH)
    if request.param == "postgres":
        base_dsn = os.environ.get("CHAMPION_FIT_TEST_POSTGRES_DSN")
        if not base_dsn:
            pytest.skip("set CHAMPION_FIT_TEST_POSTGRES_DSN for an owned PostgreSQL schema")
        psycopg = pytest.importorskip("psycopg")
        from psycopg import sql
        from psycopg.conninfo import make_conninfo

        schema = f"champion_fit_calendar_test_{uuid.uuid4().hex}"
        with psycopg.connect(base_dsn, autocommit=True) as admin:
            assert admin.info.server_version >= 160000
            admin.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(schema)))
        postgres_dsn = make_conninfo(base_dsn, options=f"-c search_path={schema}")
    try:
        storage.initialize()
        rows = [{"account": ACCOUNT, "match_id": match_id, "date": date, "patch": "16.16",
                 "queue": "420", "champion": "Ahri", "role": "MIDDLE", "duration_minutes": 30,
                 "win": True, "reason": "Owned calendar-window fixture"} for match_id, date in DATES.items()]
        original = deepcopy(rows)
        with closing(storage.connect()) as connection:
            ensure_settings(connection)
            result = ingest_rows(connection, rows, "owned_calendar_window_test")
            connection.commit()
        assert result["inserted"] == len(DATES) and result["skipped"] == 0
        assert rows == original
        if schema is not None:
            migrate(storage.path, postgres_dsn)
            storage = PostgresStorage(postgres_dsn, app.SCHEMA_PATH)
            storage.initialize()
        yield storage, directory
    finally:
        if schema is not None:
            with psycopg.connect(base_dsn, autocommit=True) as admin:
                admin.execute(sql.SQL("DROP SCHEMA {} CASCADE").format(sql.Identifier(schema)))


@pytest.fixture(scope="module")
def calendar_http(calendar_storage):
    storage, directory = calendar_storage

    class QuietCalendarHandler(app.DashboardHandler):
        def log_message(self, *args):
            pass

    patch = pytest.MonkeyPatch()
    patch.setattr(app, "STORAGE", storage)
    patch.setattr(app, "DB_PATH", directory / "fixture.db")
    patch.setattr(app, "APP_ROOT", directory)
    server = ThreadingHTTPServer(("127.0.0.1", 0), partial(QuietCalendarHandler, directory=directory))
    worker = Thread(target=lambda: server.serve_forever(poll_interval=.01), daemon=True)
    worker.start()
    requests = []

    def send(endpoint, as_of, days):
        params = {"account": ACCOUNT, "role": "MIDDLE", "queue": "all", "days": days,
                  "as_of": as_of, "algorithm_revision": "2", "flag": "all", "limit": "24"}
        if endpoint == "/api/recommendations":
            params["champion"] = "Ahri"
        elif endpoint in {"/api/matchups", "/api/synergy"}:
            params["champion"] = "ALL"
        client = HTTPConnection("127.0.0.1", server.server_port, timeout=20)
        try:
            requests.append(("GET", endpoint))
            client.request("GET", endpoint + "?" + urlencode(params))
            response = client.getresponse()
            assert response.getheader("Content-Type", "").startswith("application/json")
            return response.status, json.loads(response.read())
        finally:
            client.close()

    try:
        yield send, storage, requests
    finally:
        server.shutdown()
        server.server_close()
        worker.join(timeout=5)
        patch.undo()
        assert not worker.is_alive()


@pytest.mark.parametrize("as_of,days,expected_ids", [
    pytest.param(DATES["MINIMUM"], "90", ("MINIMUM",), id="minimum-90-days"),
    pytest.param(DATES["MINIMUM"], "180", ("MINIMUM",), id="minimum-180-days"),
    pytest.param(DATES["MINIMUM"], "365", ("MINIMUM",), id="minimum-365-days"),
    pytest.param("0001-04-01T00:00:00Z", "90", ("MINIMUM",), id="cutoff-exactly-minimum-sql-padding"),
    pytest.param(DATES["MINIMUM"], "all", ("MINIMUM",), id="all-history-encounter-recency"),
    pytest.param("1600-07-01T00:00:00Z", "90", ("DISTANT",), id="distant-control"),
    pytest.param(DATES["MAXIMUM"], "90", ("MAXIMUM",), id="maximum-microsecond-control"),
    pytest.param(DATES["MAXIMUM"], "all", ("MAXIMUM", "ORDINARY", "DISTANT", "MINIMUM"), id="maximum-all-history-keeps-earlier-facts"),
    pytest.param(DATES["MINIMUM"], "invalid", None, id="invalid-period-control"),
])
def test_public_calendar_windows_keep_boundary_facts_without_changing_archives(calendar_http, as_of, days, expected_ids):
    send, storage, requests = calendar_http
    before = snapshot(storage)
    request_count = len(requests)

    # Collect every public path before asserting the result, so an early
    # projection failure cannot conceal REC, playstyle or encounter failures.
    responses = {endpoint: send(endpoint, as_of, days) for endpoint in ENDPOINTS}

    assert snapshot(storage) == before
    # Check coverage against the actual fixture schema, so new archives cannot
    # silently escape the unchanged-data assertion or require a magic count.
    assert set(before) == persisted_tables(storage)
    assert {row["match_id"]: row["date"] for row in before["match_quality"]} == DATES
    assert requests[request_count:] == [("GET", endpoint) for endpoint in ENDPOINTS]
    expected_status = 400 if expected_ids is None else 200
    statuses = {endpoint: status for endpoint, (status, _) in responses.items()}
    errors = {endpoint: payload.get("error") for endpoint, (_, payload) in responses.items()}
    assert statuses == dict.fromkeys(ENDPOINTS, expected_status), {"statuses": statuses, "errors": errors}

    if expected_ids is None:
        assert all(error and error != "date value out of range" for error in errors.values())
        assert errors["/api/matches"] == "days deve essere 90, 180, 365 oppure all"
        assert errors["/api/recommendations"] == "Periodo non valido: scegli 90, 180, 365 giorni o tutto lo storico"
        return

    expected_count = len(expected_ids)
    for _, payload in responses.values():
        assert payload["algorithm_revision"] == 2
        assert payload["context"]["accounts"] == [ACCOUNT]
        assert payload["context"]["role"] == "MIDDLE"
        assert payload["context"]["queue"] == "all"
        assert str(payload["context"]["days"]) == days
        assert payload["context"]["observations"] == expected_count
        assert payload["context"]["unique_games"] == expected_count
    matches = responses["/api/matches"][1]["items"]
    assert [(row["match_id"], row["date"]) for row in matches] == [(match_id, DATES[match_id]) for match_id in expected_ids]
    recommendations = responses["/api/recommendations"][1]
    assert recommendations["candidate"]["champion"] == "Ahri"
    assert recommendations["candidate"]["performance"]["games"] == expected_count
    assert recommendations["context"]["period"] == {"unit": "days", "value": 0 if days == "all" else int(days)}
    assert responses["/api/matchups"][1]["games"] == expected_count


def test_public_playstyle_period_still_rejects_unrepresentable_calendar_windows():
    # These positive integers were already rejected by the public filter API;
    # boundary clipping must not turn unrepresentable durations into all time.
    for days in (999999999, 10**400):
        with pytest.raises(OverflowError):
            resolve_filters([], {"days": [str(days)], "as_of": ["2026-09-24T12:00:00Z"]})


def test_public_encounter_recency_retains_microseconds_at_both_window_boundaries():
    now = datetime(1600, 6, 1, 12, 0, 0, 123456, tzinfo=timezone.utc)
    rows = []
    rosters = {}
    for match_id, days, microseconds in (("at-seven", 7, 0), ("before-seven", 7, 1),
                                        ("at-ninety", 90, 0), ("before-ninety", 90, 1)):
        played_at = now - timedelta(days=days, microseconds=microseconds)
        rows.append({"account": ACCOUNT, "match_id": match_id, "champion": "Ahri", "role": "MIDDLE",
                     "queue": "420", "date": played_at.isoformat(timespec="microseconds"), "win": 1,
                     "positive_evidence": 1.0, "negative_evidence": 0.0})
        rosters[match_id] = [
            {"match_id": match_id, "team_id": 100, "win": 1, "champion": "Ahri"},
            {"match_id": match_id, "team_id": 200, "win": 0, "champion": "Lux"},
        ]
    settings = recommended_settings()
    settings["matchup"]["recent_days"] = 7
    before = deepcopy((rows, rosters, settings))

    with settings_context(settings):
        payload = encounter_data(rows, rosters, [ACCOUNT], relation="enemy", champion="Ahri", role="MIDDLE", as_of=now)

    items = [*payload["beats"], *payload["loses_to"]]
    assert len(items) == 1 and items[0]["champion"] == "Lux"
    assert items[0]["games"] == 4
    assert items[0]["recent_games"] == 1
    assert items[0]["recent_90d_games"] == 3
    assert (rows, rosters, settings) == before
