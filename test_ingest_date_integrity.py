"""Malformed exporter dates cannot replace archived match facts or judgments."""
from contextlib import closing

import pytest

import app
from analysis_runtime import prepare_analysis
from ingest import ingest_rows
from storage import SQLiteStorage


MATCH = {
    "account": "DateAudit#EUW", "match_id": "M1", "date": "2026-09-24T10:00:00Z",
    "patch": "16.19", "queue": "420", "champion": "Lux", "role": "MIDDLE",
    "duration_minutes": 30, "win": False,
    "loss_attribution_weight": 0.4, "reason": "Reviewed export",
}


@pytest.fixture
def storage(tmp_path):
    result = SQLiteStorage(tmp_path / "date-integrity.db", app.SCHEMA_PATH)
    result.initialize()
    return result


def _archived_snapshot(storage):
    with closing(storage.connect()) as connection:
        return {
            table: [dict(row) for row in connection.execute(
                f"SELECT * FROM {table} ORDER BY account,match_id"
            )]
            for table in ("match_quality", "match_import_provenance")
        }


def _analytical_matches(storage):
    with closing(storage.connect()) as connection:
        view, _ = prepare_analysis(
            connection,
            {"account": [MATCH["account"]], "role": ["MIDDLE"], "queue": ["420"],
             "days": ["180"], "as_of": ["2026-09-25T12:00:00Z"]},
            account_filter=app.account_filter, companion_filter=app.companion_filter,
        )
        return {row["match_id"] for row in view.execute("SELECT match_id FROM match_quality")}


@pytest.mark.parametrize("invalid_date", [
    "not-a-date", "24/09/2026", "2026", "2026-02-30T12:00:00Z",
    "2026-09-24T25:00:00Z", "2026-09-24T12:00:00+24:00",
    "0001-01-01T00:00:00+01:00", "9999-12-31T23:59:59-01:00",
])
def test_invalid_dates_preserve_existing_match_and_provenance_and_create_no_new_ledger(storage, invalid_date):
    with closing(storage.connect()) as connection, connection:
        assert ingest_rows(connection, [MATCH], "trusted")["inserted"] == 1
    before = _archived_snapshot(storage)
    assert _analytical_matches(storage) == {"M1"}
    broken = MATCH | {
        "date": invalid_date, "champion": "Ahri", "reason": "Must not replace review",
        "loss_attribution_weight": 0.9,
    }

    with closing(storage.connect()) as connection, connection:
        result = ingest_rows(connection, [broken, broken | {"match_id": "BROKEN_NEW"}], "broken")

    assert (result["inserted"], result["updated"], result["skipped"]) == (0, 0, 2)
    assert _archived_snapshot(storage) == before
    assert _analytical_matches(storage) == {"M1"}


@pytest.mark.parametrize("date", [
    "2026-09-24", "2026-09-24T10:00:00", "2026-09-24 10:00:00",
    "2026-09-24T10:00:00.0004999Z", "2026-09-24T10:00:00,5Z",
    "20260924T100000Z", "2026-W39-4T10:00:00Z", "2026-09-24x10:00:00Z",
    "2026-09-24T12:00:00+02", "2026-09-24T12:00:00+0200",
    "2026-09-24T12:00:00+02:00:30", " 2026-09-24T12:00:00+02:00 ",
])
def test_supported_iso_dates_remain_importable_without_reformatting(storage, date):
    with closing(storage.connect()) as connection, connection:
        result = ingest_rows(connection, [MATCH | {"date": date}], "supported format")
        stored = connection.execute("SELECT date FROM match_quality WHERE match_id='M1'").fetchone()
        assert stored["date"] == date.strip()
    assert (result["inserted"], result["updated"], result["skipped"]) == (1, 0, 0)
    assert _analytical_matches(storage) == {"M1"}


@pytest.mark.parametrize("date", ["0001-01-01T00:00:00Z", "9999-12-31T23:59:59.999999Z"])
def test_representable_utc_year_boundaries_remain_importable(storage, date):
    with closing(storage.connect()) as connection, connection:
        result = ingest_rows(connection, [MATCH | {"date": date}], "valid UTC boundary")
        assert result["inserted"] == 1
        assert connection.execute("SELECT date FROM match_quality").fetchone()["date"] == date
