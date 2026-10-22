"""Evidence pagination follows UTC instants without rewriting archived dates."""
from contextlib import closing

import pytest

import app
from migrate_postgres import migrate
from storage import SQLiteStorage
from test_postgres_api import postgres_api_fixture  # noqa: F401
from test_recent_match_ordering import (
    RECENT_ACCOUNT, archived_recent_sources, assert_recent_date_fields,
    expected_recent_dates, mixed_recent_dates, recent_params, seed_recent_rows,
)


@pytest.fixture(params=["sqlite", "postgres"])
def evidence_source(request, tmp_path, monkeypatch):
    source = SQLiteStorage(tmp_path / "evidence-dates.db", app.SCHEMA_PATH)
    source.initialize()

    def activate():
        storage = source
        if request.param == "postgres":
            _, storage, _ = request.getfixturevalue("postgres_api_fixture")
            migrate(source.path, storage.dsn)
        monkeypatch.setattr(app, "STORAGE", storage)
        monkeypatch.setattr(app, "DB_PATH", source.path)
        monkeypatch.setattr(app, "APP_ROOT", tmp_path)
        return storage

    return source, activate


def query_evidence(*, accounts=None, limit=2, offset=0):
    params = recent_params(accounts=accounts, limit=limit)
    params["offset"] = [str(offset)]
    status, payload = app.query_database("/api/recommendation-evidence", params)
    assert status == 200, payload
    return payload


def test_evidence_orders_utc_before_pagination_and_preserves_original_dates(evidence_source):
    source, activate = evidence_source
    with closing(source.connect()) as connection, connection:
        seed_recent_rows(connection, mixed_recent_dates())
    storage = activate()
    with closing(storage.connect()) as connection:
        before = archived_recent_sources(connection)

    pages = [query_evidence(limit=2, offset=offset) for offset in (0, 2, 4)]

    assert all(page["total"] == len(mixed_recent_dates()) for page in pages)
    assert all(page["summary"]["games"] == len(mixed_recent_dates()) for page in pages)
    assert all(page["summary"]["wins"] == len(mixed_recent_dates()) for page in pages)
    assert_recent_date_fields([row for page in pages for row in page["items"]], expected_recent_dates()[:6])
    assert [row["match_id"] for row in pages[0]["items"]] == ["latest", "recent-week"]
    with closing(storage.connect()) as connection:
        assert archived_recent_sources(connection) == before


def test_evidence_equal_instants_keep_match_and_account_ties_across_pages(evidence_source):
    source, activate = evidence_source
    # Account names are unique to this test so a module-scoped PostgreSQL schema
    # can also contain the other test's independently migrated synthetic rows.
    alpha, beta = f"{RECENT_ACCOUNT}-Alpha", f"{RECENT_ACCOUNT}-Beta"
    dates = ["2026-09-24T12:00:00Z", "2026-09-24T14:00:00+02:00", "20260924T120000Z"]
    with closing(source.connect()) as connection, connection:
        seed_recent_rows(connection, {"shared-b": dates[2]}, account=alpha)
        seed_recent_rows(connection, {"shared-a": dates[1]}, account=beta)
        seed_recent_rows(connection, {"shared-a": dates[0]}, account=alpha)
    activate()

    pages = [query_evidence(accounts=[alpha, beta], limit=1, offset=offset) for offset in range(3)]

    assert [page["total"] for page in pages] == [3, 3, 3]
    assert [(row["match_id"], row["account"]) for page in pages for row in page["items"]] == [
        ("shared-a", alpha), ("shared-a", beta), ("shared-b", alpha),
    ]
    assert_recent_date_fields([row for page in pages for row in page["items"]], dates)
