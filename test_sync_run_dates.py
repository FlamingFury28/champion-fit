"""Recent synchronization diagnostics order real UTC instants before limiting."""
from contextlib import closing
from functools import partial
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
import json
from threading import Thread

import pytest

import app
from storage import SQLiteStorage
from sync_runs import recent_runs
from test_postgres_group_id_width import postgres_groups  # noqa: F401


DATES = {
    "offset-new": "2026-09-24T23:15:00-10:00",
    "offset-old": "2026-09-25T00:45:00+14:00",
    "compact": "20260925T080000Z",
    "week": "2026-W39-5T08:00:00Z",
    "naive": "2026-09-25T08:00:00",
    "microearly": "2026-09-25T08:00:00.000001Z",
    "invalid-high": "zzzz-not-a-timestamp",
    "overflow": "0001-01-01T00:00:00+01:00",
}
ORDER = ["offset-new", "microearly", "week", "naive", "compact", "offset-old", "overflow", "invalid-high"]


@pytest.fixture(params=["sqlite", "postgres"])
def journal(request, tmp_path):
    if request.param == "sqlite":
        storage = SQLiteStorage(tmp_path / "journal.db", app.SCHEMA_PATH)
    else:
        create, _ = request.getfixturevalue("postgres_groups")
        _, storage = create()
    storage.initialize()
    with closing(storage.connect()) as connection:
        for run_id, date in DATES.items():
            connection.execute(
                "INSERT INTO riot_sync_runs(run_id,operation,status,started_at,finished_at,pid,requested_accounts,counts_json) "
                "VALUES(?,'incremental','failed',?,?,1,1,?)",
                (run_id, date, "original-finish", json.dumps({"inserted": 2, "private": "Private#EUW"})),
            )
            connection.execute(
                "INSERT INTO riot_sync_run_accounts(run_id,requested_account,status) VALUES(?,'Private#EUW','failed')",
                (run_id,),
            )
        connection.commit()
    return storage


def snapshot(storage):
    with closing(storage.connect()) as connection:
        return {table: [dict(row) for row in connection.execute(f"SELECT * FROM {table} ORDER BY 1,2")]
                for table in ("riot_sync_runs", "riot_sync_run_accounts")}


def test_recent_runs_orders_utc_before_limit_and_preserves_diagnostics(journal):
    before = snapshot(journal)
    with closing(journal.connect()) as connection:
        limited = recent_runs(connection, 3)
        all_runs = recent_runs(connection, 50)
    assert [row["run_id"] for row in limited] == ORDER[:3]
    assert [row["run_id"] for row in all_runs] == ORDER
    for row in all_runs:
        assert row["started_at"] == DATES[row["run_id"]]
        assert row["finished_at"] == "original-finish"
        assert row["status"] == "failed"
        assert row["counts"] == {"inserted": 2}
    assert "Private#EUW" not in json.dumps(all_runs)
    assert snapshot(journal) == before


def test_recent_runs_keeps_existing_minimum_and_maximum_result_bounds(journal):
    with closing(journal.connect()) as connection:
        connection.executemany(
            "INSERT INTO riot_sync_runs(run_id,operation,status,started_at,pid,requested_accounts) "
            "VALUES(?,'historical','completed','2020-01-01T00:00:00Z',1,0)",
            [(f"old-{index:03}",) for index in range(60)],
        )
        connection.commit()
        assert [row["run_id"] for row in recent_runs(connection, 0)] == ORDER[:1]
        rows = recent_runs(connection, 1000)
        assert len(rows) == 50
        assert [row["run_id"] for row in rows[:6]] == ORDER[:6]
        assert all(row["run_id"].startswith("old-") for row in rows[6:])


def test_fresh_http_sync_status_exposes_the_same_recent_utc_order(journal, tmp_path, monkeypatch):
    monkeypatch.setattr(app, "STORAGE", journal)
    monkeypatch.setattr(app, "APP_ROOT", tmp_path)
    monkeypatch.setattr(app, "DB_PATH", tmp_path / "unused.db")

    class QuietHandler(app.DashboardHandler):
        def log_message(self, format, *args):
            pass

    before = snapshot(journal)
    server = ThreadingHTTPServer(("127.0.0.1", 0), partial(QuietHandler, directory=tmp_path))
    worker = Thread(target=server.serve_forever, daemon=True)
    worker.start()
    client = HTTPConnection("127.0.0.1", server.server_port, timeout=10)
    try:
        client.request("GET", "/api/sync-status")
        response = client.getresponse()
        payload = json.loads(response.read())
        assert response.status == 200, payload
        assert [row["run_id"] for row in payload["recent_runs"]] == ORDER[:5]
        assert payload["recent_runs"][0]["started_at"] == DATES["offset-new"]
        assert "Private#EUW" not in json.dumps(payload)
    finally:
        client.close()
        server.shutdown()
        server.server_close()
        worker.join(timeout=5)
    assert snapshot(journal) == before
