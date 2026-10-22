"""Recent lists order real UTC instants before applying their display limits."""
from contextlib import closing

import pytest

import app
from analysis_runtime import parse_time
from ingest import ingest_rows
from storage import SQLiteStorage


RECENT_ACCOUNT = "Recent#EUW"
RECENT_AS_OF = "2026-09-26T12:00:00Z"
RECENT_PATHS = ("/api/matches", "/api/profile", "/api/champion")
PROFILE_EXTREMA_CASES = {
    "compact-week": {"first": "20260801T120000Z", "week": "2026-W39-4T23:00:00Z",
                     "last": "2026-09-24T21:30:00-03:00"},
    "offset-reversal": {"first": "2026-09-24T23:00:00+14:00",
                        "last": "2026-09-24T11:00:00-12:00"},
    "empty": {},
}


def mixed_recent_dates():
    return {
        **{f"old-{day:02d}": f"202608{day:02d}T120000Z" for day in range(1, 22)},
        "older-offset": "2026-09-24T23:00:00+14:00",
        "before-precision": "2026-09-24T10:00:00.000498Z",
        "recent-compact": "20260924T220000Z",
        "recent-week": "2026-W39-4T23:00:00Z",
        "latest": "2026-09-24T21:30:00.0004999-03:00",
    }


def expected_recent_dates():
    dates = mixed_recent_dates()
    ids = ["latest", "recent-week", "recent-compact", "before-precision", "older-offset",
           *[f"old-{day:02d}" for day in range(21, 0, -1)]]
    return [dates[match_id] for match_id in ids]


def recent_params(accounts=None, limit=100):
    return {"account": accounts or [RECENT_ACCOUNT], "role": ["MIDDLE"], "champion": ["Lux"],
            "queue": ["420"], "days": ["180"], "as_of": [RECENT_AS_OF], "limit": [str(limit)]}


def recent_items(payload, path):
    return payload["items"] if path == "/api/matches" else payload["recent"]


def seed_recent_rows(connection, dates, account=RECENT_ACCOUNT):
    base = {"account": account, "patch": "16.19", "queue": "420", "champion": "Lux",
            "role": "MIDDLE", "duration_minutes": 30, "win": True,
            "win_evidence_weight": 1, "loss_attribution_weight": 0}
    return ingest_rows(connection, [base | {"match_id": key, "date": date}
                                    for key, date in dates.items()], "synthetic recent ordering")


def archived_recent_sources(connection):
    return {table: [dict(row) for row in connection.execute(
        f"SELECT * FROM {table} ORDER BY account,match_id"
    )] for table in ("match_quality", "match_import_provenance")}


def assert_recent_date_fields(items, expected_dates):
    assert [row["date"] for row in items] == expected_dates
    assert [row["date_utc"] for row in items] == [
        parse_time(date).isoformat(timespec="microseconds") for date in expected_dates
    ]
    assert all("_analysis_utc_order" not in row for row in items)


def assert_profile_extrema(payload, dates):
    ordered = sorted(dates.values(), key=parse_time)
    expected = [parse_time(value).isoformat(timespec="microseconds") for value in ordered]
    assert payload["summary"]["first_game"] == (expected[0] if expected else None)
    assert payload["summary"]["last_game"] == (expected[-1] if expected else None)
    assert payload["summary"]["games"] == len(dates)
    assert_recent_date_fields(payload["recent"], list(reversed(ordered)))


@pytest.fixture
def recent_storage(tmp_path, monkeypatch):
    storage = SQLiteStorage(tmp_path / "recent-order.db", app.SCHEMA_PATH)
    storage.initialize()
    monkeypatch.setattr(app, "STORAGE", storage)
    return storage


@pytest.mark.parametrize("path,limit", [
    ("/api/matches", 1), ("/api/matches", 100), ("/api/profile", 20), ("/api/champion", 20),
])
def test_recent_lists_order_utc_before_limit_and_preserve_archived_source(recent_storage, path, limit):
    with closing(recent_storage.connect()) as connection, connection:
        seed_recent_rows(connection, mixed_recent_dates())
        before = archived_recent_sources(connection)
        source_columns = set(before["match_quality"][0])

    status, payload = app.query_database(path, recent_params(limit=limit))

    assert status == 200, payload
    items = recent_items(payload, path)
    assert_recent_date_fields(items, expected_recent_dates()[:limit])
    if path == "/api/matches":
        assert source_columns <= set(items[0])
        assert items[0]["match_id"] == "latest"
    with closing(recent_storage.connect()) as connection:
        assert archived_recent_sources(connection) == before
        assert {item[0] for item in connection.execute("SELECT * FROM match_quality WHERE 1=0").description} == source_columns


@pytest.mark.parametrize("path", RECENT_PATHS)
def test_equal_instants_use_match_then_account_as_deterministic_tie_break(recent_storage, path):
    with closing(recent_storage.connect()) as connection, connection:
        # Insertion order deliberately disagrees with both tie-break columns.
        seed_recent_rows(connection, {"shared-b": "20260924T120000Z"}, account="Alpha#EUW")
        seed_recent_rows(connection, {"shared-a": "2026-09-24T14:00:00+02:00"}, account="Beta#EUW")
        seed_recent_rows(connection, {"shared-a": "2026-09-24T12:00:00Z"}, account="Alpha#EUW")

    status, payload = app.query_database(path, recent_params(accounts=["Alpha#EUW", "Beta#EUW"]))

    assert status == 200, payload
    assert_recent_date_fields(recent_items(payload, path), [
        "2026-09-24T12:00:00Z", "2026-09-24T14:00:00+02:00", "20260924T120000Z",
    ])


def test_profile_weekdays_use_utc_for_week_compact_and_offset_boundary_dates(recent_storage):
    dates = {"utc-friday": "2026-09-24T21:30:00-03:00", "compact": "20260924T220000Z",
             "week": "2026-W39-4T23:00:00Z"}
    with closing(recent_storage.connect()) as connection, connection:
        seed_recent_rows(connection, dates)

    status, payload = app.query_database("/api/profile", recent_params())

    assert status == 200, payload
    assert {item["weekday"]: item["games"] for item in payload["weekdays"]} == {4: 2, 5: 1}
    assert_recent_date_fields(payload["recent"], [dates["utc-friday"], dates["week"], dates["compact"]])
    assert sum(item["games"] for item in payload["weekdays"]) == len(dates)


@pytest.mark.parametrize("dates", PROFILE_EXTREMA_CASES.values(), ids=PROFILE_EXTREMA_CASES)
def test_profile_extrema_use_utc_within_selected_context_without_changing_source(recent_storage, dates):
    with closing(recent_storage.connect()) as connection, connection:
        seed_recent_rows(connection, dates | {"future": "2099-01-01T12:00:00Z",
                                            "outside-window": "20260101T120000Z"})
        seed_recent_rows(connection, {"other-first": "2026-04-01T00:00:00Z",
                                      "other-last": "2026-09-25T00:00:00Z"}, account="Other#EUW")
        before = archived_recent_sources(connection)

    status, payload = app.query_database("/api/profile", recent_params())

    assert status == 200, payload
    assert_profile_extrema(payload, dates)
    with closing(recent_storage.connect()) as connection:
        assert archived_recent_sources(connection) == before
