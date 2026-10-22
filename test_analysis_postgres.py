"""Opt-in PostgreSQL 16 projection checks in a disposable, isolated schema.

Set CHAMPION_FIT_TEST_POSTGRES_DSN to a test database before running this file.
The suite never initializes or queries the application's configured database.
"""
from __future__ import annotations

import os
import uuid

import pytest

import app
from analysis_runtime import prepare_analysis
from storage import PostgresStorage


AS_OF = "2026-09-24T12:00:00.000499Z"
ACCOUNT = "Projection#EUW"


@pytest.fixture(scope="module")
def postgres_storage():
    base_dsn = os.environ.get("CHAMPION_FIT_TEST_POSTGRES_DSN")
    if not base_dsn:
        pytest.skip("set CHAMPION_FIT_TEST_POSTGRES_DSN to run isolated PostgreSQL analysis tests")
    psycopg = pytest.importorskip("psycopg")
    from psycopg import sql
    from psycopg.conninfo import make_conninfo

    schema = f"champion_fit_analysis_test_{uuid.uuid4().hex}"
    with psycopg.connect(base_dsn, autocommit=True) as admin:
        assert admin.info.server_version >= 160000, "analysis SQL requires PostgreSQL 16 or later"
        admin.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(schema)))
    try:
        scoped_dsn = make_conninfo(base_dsn, options=f"-c search_path={schema}")
        storage = PostgresStorage(scoped_dsn, app.SCHEMA_PATH)
        storage.initialize()
        yield storage
    finally:
        with psycopg.connect(base_dsn, autocommit=True) as admin:
            admin.execute(sql.SQL("DROP SCHEMA {} CASCADE").format(sql.Identifier(schema)))


@pytest.fixture
def connection(postgres_storage):
    connection = postgres_storage.connect()
    try:
        yield connection
    finally:
        try:
            connection.rollback()
        finally:
            connection.close()


def _seed(connection, dates, *, account=ACCOUNT, win=1):
    connection.execute(
        "INSERT INTO champions(champion,asset_id,icon_url) VALUES('Lux','Lux','/Lux.png') "
        "ON CONFLICT(champion) DO NOTHING"
    )
    connection.executemany(
        """INSERT INTO match_quality
        (account,match_id,date,patch,queue,champion,role,identity_resolution,
         duration_minutes,win,explicit_afk,suspected_quasi_afk,early_surrender,
         anomaly_flags,match_quality_score,loss_attribution_weight,win_evidence_weight,reason)
        VALUES(?,?,?,'16.19','420','Lux','MIDDLE','riot_api',30,?,0,0,0,'none',0.95,?,?,
               'Imported from Riot Match-V5')""",
        [(account, match_id, date, win, 0.0 if win else 0.88, 0.95 if win else 0.0)
         for match_id, date in dates.items()],
    )


def _project(connection, *, days="180", as_of=AS_OF):
    return prepare_analysis(
        connection, {"account": [ACCOUNT], "days": [days], "as_of": [as_of]},
        account_filter=app.account_filter, companion_filter=app.companion_filter,
    )[0]


@pytest.mark.parametrize("timezone", ["UTC", "Europe/Rome", "America/Los_Angeles"])
@pytest.mark.parametrize("days", ["180", "all"])
def test_real_postgres_date_scope_is_independent_of_session_timezone(connection, timezone, days):
    included = {
        "date_only": "2026-08-01",
        "naive": "2026-08-01T12:00:00",
        "naive_at_now": "2026-09-24T12:00:00.000499",
        "utc": "2026-08-01T12:00:00Z",
        "canonical_offset": "2026-08-01T14:00:00+02:00",
        "milliseconds": "2026-09-24T12:00:00.000Z",
        "microseconds": "2026-09-24T12:00:00.000499Z",
        "extra_precision": "2026-09-24T12:00:00.0004999Z",
        "extra_precision_zero": "2026-09-24T12:00:00.0000009Z",
        "offset_at_now": "2026-09-24T14:00:00.000499+02:00",
        "short_offset": "2026-09-24T13:00:00+02",
        "compact_offset": "2026-09-24T13:00:00+0200",
        "offset_seconds": "2026-09-24T13:00:00+02:00:30",
        "compact_date": "20260801T120000Z",
        "week_date": "2026-W31-6T12:00:00Z",
        "arbitrary_separator": "2026-08-01x12:00:00Z",
        "comma_fraction": "2026-08-01T12:00:00,5Z",
        "cutoff_exact": "2026-03-28T02:00:00+02",
        "cutoff_local_previous_day": "2026-03-27T01:00:00-23:00",
    }
    outside = {
        "future_naive": "2026-09-24T13:00:00",
        "future_short_offset": "2026-09-24T13:00:00+00",
        "future_precision": "2026-09-24T12:00:00.0005000Z",
        "future_compact": "20261001T120000Z",
        "future_local_previous_day": "2026-09-23T13:01:00-23:00",
        "invalid": "not a timestamp",
        "invalid_date": "2026-02-30T12:00:00Z",
        "utc_underflow": "0001-01-01T00:00:00+01:00",
        "utc_overflow": "9999-12-31T23:59:59-01:00",
    }
    old = {"older_than_cutoff": "2026-03-28T00:30:00+02"}
    _seed(connection, included | outside | old)
    _seed(connection, {"unselected_account": "2026-08-01T12:00:00Z"}, account="Other#EUW")
    connection.raw.execute("SELECT set_config('TimeZone',%s,true)", (timezone,))
    connection.raw.execute("SELECT set_config('DateStyle','ISO, DMY',true)")

    view = _project(connection, days=days)
    observed = {row["match_id"] for row in view.execute("SELECT match_id FROM match_quality")}
    expected = set(included) | (set(old) if days == "all" else set())
    assert observed == expected
    assert view.context["role"] == "MIDDLE"
    assert view.context["observations"] == len(expected)
    assert view.context["accounts"] == [ACCOUNT]


def test_real_postgres_fractional_rounding_does_not_discard_python_valid_observations(connection):
    _seed(connection, {
        "same_python_instant": "2026-09-24T12:00:00.0000009Z",
        "future_python_instant": "2026-09-24T12:00:00.0000010Z",
    })
    comparison = connection.raw.execute(
        "SELECT CAST(%s AS timestamptz)>CAST(%s AS timestamptz) AS native_rounds_up",
        ("2026-09-24T12:00:00.0000009Z", "2026-09-24T12:00:00Z"),
    ).fetchone()
    assert comparison["native_rounds_up"]
    view = _project(connection, as_of="2026-09-24T12:00:00Z")
    assert [row["match_id"] for row in view.execute("SELECT match_id FROM match_quality")] == [
        "same_python_instant"
    ]


def test_real_postgres_projection_preserves_sources_and_persistent_name_collision(connection):
    from psycopg import sql

    _seed(connection, {"annotated": "2026-08-01T12:00:00Z"}, win=0)
    connection.execute(
        "INSERT INTO match_import_provenance VALUES(?,?,'test','known_riot_default','{}','now')",
        (ACCOUNT, "annotated"),
    )
    connection.execute(
        "INSERT INTO match_annotations(match_id,griefer,note,updated_at) "
        "VALUES('annotated',1,'Preserve annotation','now')"
    )
    connection.execute("INSERT INTO riot_match_raw VALUES('annotated','europe','now','{}')")
    connection.execute("CREATE TABLE analysis_match_quality(sentinel TEXT)")
    connection.execute("INSERT INTO analysis_match_quality VALUES('persistent source')")
    schema = connection.raw.execute("SELECT current_schema() AS name").fetchone()["name"]
    protected = ("match_quality", "match_import_provenance", "match_annotations", "riot_match_raw")
    before = {
        table: connection.raw.execute(sql.SQL("SELECT * FROM {}.{}").format(
            sql.Identifier(schema), sql.Identifier(table),
        )).fetchall()
        for table in protected
    }

    for days in ("180", "all"):
        view = _project(connection, days=days)
        projected = view.execute("SELECT loss_attribution_weight FROM match_quality").fetchone()
        assert projected["loss_attribution_weight"] == 0.0
        assert view.evidence[(ACCOUNT, "annotated")]["attribution_source"] == "manual_annotation"
    after = {
        table: connection.raw.execute(sql.SQL("SELECT * FROM {}.{}").format(
            sql.Identifier(schema), sql.Identifier(table),
        )).fetchall()
        for table in protected
    }
    assert after == before
    assert connection.raw.execute(sql.SQL("SELECT sentinel FROM {}.analysis_match_quality").format(
        sql.Identifier(schema),
    )).fetchone()["sentinel"] == "persistent source"


def _query_recent_reader(connection, postgres_storage, monkeypatch, path, params, timezone="Pacific/Honolulu"):
    monkeypatch.setattr(app, "STORAGE", postgres_storage)
    connection.raw.execute("SELECT set_config('TimeZone',%s,true)", (timezone,))
    view, normalized = prepare_analysis(
        connection, params, account_filter=app.account_filter, companion_filter=app.companion_filter,
    )
    status, payload = app._query_database_raw(path, normalized, view)
    assert status == 200, payload
    return payload


@pytest.mark.parametrize("path,limit", [
    ("/api/matches", 1), ("/api/profile", 20), ("/api/champion", 20),
])
def test_real_postgres_recent_lists_order_utc_before_limit_without_source_or_metadata_leaks(
    connection, postgres_storage, monkeypatch, path, limit,
):
    from test_recent_match_ordering import (
        archived_recent_sources, assert_recent_date_fields, expected_recent_dates,
        mixed_recent_dates, recent_items, recent_params,
    )

    _seed(connection, mixed_recent_dates())
    before = archived_recent_sources(connection)
    source_columns = set(before["match_quality"][0])

    payload = _query_recent_reader(
        connection, postgres_storage, monkeypatch, path, recent_params(accounts=[ACCOUNT], limit=limit),
    )

    items = recent_items(payload, path)
    assert_recent_date_fields(items, expected_recent_dates()[:limit])
    if path == "/api/matches":
        assert source_columns <= set(items[0])
        assert items[0]["match_id"] == "latest"
    assert archived_recent_sources(connection) == before
    columns = connection.execute("SELECT * FROM match_quality WHERE 1=0").description
    assert {column[0] for column in columns} == source_columns


def test_real_postgres_recent_equal_instants_use_deterministic_match_and_account_order(
    connection, postgres_storage, monkeypatch,
):
    from test_recent_match_ordering import assert_recent_date_fields, recent_params

    _seed(connection, {"shared-b": "20260924T120000Z"}, account="Alpha#EUW")
    _seed(connection, {"shared-a": "2026-09-24T14:00:00+02:00"}, account="Beta#EUW")
    _seed(connection, {"shared-a": "2026-09-24T12:00:00Z"}, account="Alpha#EUW")

    payload = _query_recent_reader(
        connection, postgres_storage, monkeypatch, "/api/matches",
        recent_params(accounts=["Alpha#EUW", "Beta#EUW"]),
    )

    assert_recent_date_fields(payload["items"], [
        "2026-09-24T12:00:00Z", "2026-09-24T14:00:00+02:00", "20260924T120000Z",
    ])


@pytest.mark.parametrize("timezone", ["UTC", "Pacific/Honolulu"])
def test_real_postgres_profile_weekdays_use_utc_for_week_compact_and_offset_boundary_dates(
    connection, postgres_storage, monkeypatch, timezone,
):
    from test_recent_match_ordering import assert_recent_date_fields, recent_params

    dates = {"utc-friday": "2026-09-24T21:30:00-03:00", "compact": "20260924T220000Z",
             "week": "2026-W39-4T23:00:00Z"}
    _seed(connection, dates)

    payload = _query_recent_reader(
        connection, postgres_storage, monkeypatch, "/api/profile", recent_params(accounts=[ACCOUNT]), timezone,
    )

    assert {item["weekday"]: item["games"] for item in payload["weekdays"]} == {4: 2, 5: 1}
    assert_recent_date_fields(payload["recent"], [dates["utc-friday"], dates["week"], dates["compact"]])


@pytest.mark.parametrize("case", ["compact-week", "offset-reversal", "empty"])
@pytest.mark.parametrize("timezone", ["UTC", "Pacific/Honolulu"])
def test_real_postgres_profile_extrema_use_utc_within_selected_context(
    connection, postgres_storage, monkeypatch, case, timezone,
):
    from test_recent_match_ordering import (
        PROFILE_EXTREMA_CASES, archived_recent_sources, assert_profile_extrema, recent_params,
    )

    dates = PROFILE_EXTREMA_CASES[case]
    _seed(connection, dates | {"future": "2099-01-01T12:00:00Z",
                               "outside-window": "20260101T120000Z"})
    _seed(connection, {"other-first": "2026-04-01T00:00:00Z",
                       "other-last": "2026-09-25T00:00:00Z"}, account="Other#EUW")
    before = archived_recent_sources(connection)

    payload = _query_recent_reader(
        connection, postgres_storage, monkeypatch, "/api/profile", recent_params(accounts=[ACCOUNT]), timezone,
    )

    assert_profile_extrema(payload, dates)
    assert archived_recent_sources(connection) == before
