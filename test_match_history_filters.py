"""The history's statistics cover the full filtered set, independently of paging."""
from contextlib import closing

import pytest

import app
from ingest import ingest_rows
from storage import SQLiteStorage


@pytest.fixture
def history_storage(tmp_path, monkeypatch):
    storage = SQLiteStorage(tmp_path / "history.db", app.SCHEMA_PATH)
    storage.initialize()
    monkeypatch.setattr(app, "STORAGE", storage)
    base = {"account": "History#EUW", "patch": "16.19", "queue": "420", "champion": "Lux",
            "role": "MIDDLE", "duration_minutes": 30, "win": True, "date": "2026-09-20T12:00:00Z"}
    rows = [base | {"match_id": f"history-{i:03}", "win": i % 2 == 0} for i in range(53)]
    rows += [base | {"match_id": name} | extra for name, extra in [
        ("other-champion", {"champion": "Ahri"}),
        ("other-role", {"role": "SUPPORT"}),
        ("other-queue", {"queue": "440"}),
        ("old", {"date": "2025-01-01T12:00:00Z"}),
        ("other-account", {"account": "Other#EUW"}),
    ]]
    with closing(storage.connect()) as connection, connection:
        ingest_rows(connection, rows, "history filters fixture")
    return storage


def params(**overrides):
    return {key: [value] for key, value in {
        "account": "History#EUW", "champion": "Lux", "role": "MIDDLE", "queue": "420",
        "days": "90", "as_of": "2026-09-26T12:00:00Z", **overrides,
    }.items()}


def test_history_filters_share_full_totals_and_pages_do_not_repeat(history_storage):
    status, profile = app.query_database("/api/profile", params())
    assert status == 200, profile
    assert profile["summary"]["games"] == 53
    assert profile["summary"]["wins"] == 27
    assert profile["summary"]["win_rate"] == 50.9
    assert profile["champion_options"] == ["Ahri", "Lux"]
    assert len(profile["recent"]) == 20
    assert {row["champion"] for row in profile["recent"]} == {"Lux"}
    assert sum(row["games"] for row in profile["roles"]) == 53
    assert sum(row["games"] for row in profile["weekdays"]) == 53
    ids = []
    for offset, count, next_offset in [(0, 24, 24), (24, 24, 48), (48, 5, None), (90, 0, None)]:
        status, page = app.query_database("/api/matches", params(offset=str(offset)))
        assert status == 200, page
        assert page["total"] == 53
        assert page["offset"] == offset
        assert page["next_offset"] == next_offset
        assert len(page["items"]) == count
        ids.extend(row["match_id"] for row in page["items"])
    assert ids == [f"history-{i:03}" for i in range(53)]
    with closing(history_storage.connect()) as connection:
        assert connection.execute("SELECT COUNT(*) FROM match_quality").fetchone()[0] == 58


@pytest.mark.parametrize("filters,expected", [
    ({"champion": "Ahri"}, 1), ({"role": "SUPPORT"}, 1), ({"queue": "440"}, 1),
    ({"days": "all"}, 54), ({"champion": "Zed"}, 0),
    ({"role": "ALL", "queue": "all", "days": "all", "champion": ""}, 57),
])
def test_each_filter_updates_both_statistics_and_list(history_storage, filters, expected):
    status, profile = app.query_database("/api/profile", params(**filters))
    assert status == 200, profile
    status, page = app.query_database("/api/matches", params(**filters))
    assert status == 200, page
    assert profile["summary"]["games"] == page["total"] == expected


def test_loss_filter_counts_only_matching_rows_across_pages(history_storage):
    status, first = app.query_database("/api/matches", params(flag="loss"))
    status2, last = app.query_database("/api/matches", params(flag="loss", offset="24"))
    assert status == status2 == 200
    assert first["total"] == last["total"] == 26
    assert len(first["items"]) == 24 and len(last["items"]) == 2
    assert all(row["win"] == 0 for row in first["items"] + last["items"])
    assert last["next_offset"] is None


@pytest.mark.parametrize("offset", ["-1", "1.5", "nan", "no", str(2**63)])
def test_invalid_history_offset_is_rejected(history_storage, offset):
    status, _ = app.query_database("/api/matches", params(offset=offset))
    assert status == 400
