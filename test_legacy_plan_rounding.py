"""Saved-plan scaling preserves exact priority ties and legacy input semantics."""
from contextlib import closing
from copy import deepcopy
from functools import partial
from hashlib import sha256
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
import json
from threading import Thread
from urllib.parse import urlencode

import pytest

import app
from algorithm_settings import ensure_settings
from ingest import MATCH_COLUMNS, normalized_match
from migrate_postgres import TABLES
from recommendation_feedback import save_feedback
from storage import SQLiteStorage
from test_calendar_window_boundaries import persisted_tables
from test_postgres_group_id_width import postgres_groups  # noqa: F401


CHAMPIONS = ("Ahri", "Lux", "Garen")
SAVED_MIXES = {
    "MIDDLE": (7, 4, 1),
    # Signed saved weights have no nonnegative schema/import constraint.
    "TOP": (7, 6, -1),
    "BOTTOM": (0, 0, 0),
    "SUPPORT": (-1, -2, -3),
}


def archive_snapshot(storage):
    with closing(storage.connect()) as connection:
        return {
            table: [dict(row) for row in connection.execute(f"SELECT * FROM {table} ORDER BY 1,2")]
            for table in TABLES
        }


@pytest.fixture(params=["sqlite", "postgres"])
def saved_plan_http(request, tmp_path, monkeypatch):
    if request.param == "sqlite":
        storage = SQLiteStorage(tmp_path / "saved-plan-rounding-owned.db", app.SCHEMA_PATH)
    else:
        create, _ = request.getfixturevalue("postgres_groups")
        _, storage = create()
    storage.initialize()
    with closing(storage.connect()) as connection:
        for champion in CHAMPIONS:
            connection.execute("INSERT INTO champions VALUES(?,?,?)", (champion, champion, f"/{champion}.png"))
        for role, weights in SAVED_MIXES.items():
            for champion, weight in zip(CHAMPIONS, weights):
                fit = ("global", role, champion, 1, 1, 0, 1, 1, 0, 1, 60, 10, .6, .3, .9, .6, .7,
                       1, "synthetic", 1, 0, 0, 0, "none", "", .5)
                connection.execute("INSERT INTO champion_fit VALUES(" + ",".join("?" for _ in fit) + ")", fit)
                connection.execute(
                    "INSERT INTO test_plan VALUES(?,?,?,?,?,?,?,?,?)",
                    (role, champion, weight, "synthetic", 1, 60, .7, .5, f"Saved {role} {champion} priority"),
                )
        row = normalized_match({
            "account": "Alpha#EUW", "match_id": "owned-plan-history", "date": "2026-09-24T12:00:00Z",
            "patch": "16.19", "queue": "420", "champion": "Ahri", "role": "MIDDLE",
            "duration_minutes": 30, "win": True,
        })
        connection.execute(
            "INSERT INTO match_quality(" + ",".join(MATCH_COLUMNS) + ") VALUES("
            + ",".join("?" for _ in MATCH_COLUMNS) + ")", row,
        )
        connection.execute(
            "INSERT INTO match_import_provenance VALUES(?,?,?,?,?,?)",
            ("Alpha#EUW", "owned-plan-history", "owned saved-plan fixture", "known_riot_default", "{}", "2026-09-24"),
        )
        connection.execute(
            "INSERT INTO match_annotations(match_id,manual_label,note,confidence,updated_at) VALUES(?,?,?,?,?)",
            ("owned-plan-history", "team issue", "Keep this reviewed history", .8, "2026-09-24T12:30:00Z"),
        )
        connection.execute("INSERT INTO tracked_account_puuids(puuid,account) VALUES(?,?)", ("owned-alpha", "Alpha#EUW"))
        connection.execute(
            "INSERT INTO match_participants(match_id,puuid,riot_id,champion,win,team_id) VALUES(?,?,?,?,?,?)",
            ("owned-plan-history", "owned-alpha", "Alpha#EUW", "Ahri", 1, 100),
        )
        connection.commit()
        ensure_settings(connection)
        save_feedback(connection, ["Alpha#EUW"], "Ahri", "MIDDLE", "like", 0)
        connection.commit()

    baseline = archive_snapshot(storage)
    assert set(baseline) == persisted_tables(storage)
    for table in ("algorithm_settings_revisions", "recommendation_preferences", "recommendation_feedback_events",
                  "match_import_provenance", "match_annotations"):
        assert baseline[table], table
    sqlite_hash = sha256(storage.path.read_bytes()).hexdigest() if storage.engine == "sqlite" else None
    saved_rows = {(row["role"], row["champion"]): row for row in baseline["test_plan"]}

    monkeypatch.setattr(app, "STORAGE", storage)
    monkeypatch.setattr(app, "DB_PATH", tmp_path / "saved-plan-rounding-owned.db")
    monkeypatch.setattr(app, "APP_ROOT", tmp_path)

    class QuietSavedPlanHandler(app.DashboardHandler):
        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), partial(QuietSavedPlanHandler, directory=tmp_path))
    worker = Thread(target=lambda: server.serve_forever(poll_interval=.01), daemon=True)
    worker.start()

    def query(params):
        original = deepcopy(params)
        client = HTTPConnection("127.0.0.1", server.server_port, timeout=20)
        try:
            client.request("GET", "/api/plan?" + urlencode(params, doseq=True))
            response = client.getresponse()
            assert response.getheader("Content-Type", "").startswith("application/json")
            body = json.loads(response.read().decode("utf-8", errors="strict"))
        finally:
            client.close()
        assert archive_snapshot(storage) == baseline
        if sqlite_hash is not None:
            assert sha256(storage.path.read_bytes()).hexdigest() == sqlite_hash
        assert params == original
        assert response.status == 200, body
        for item in body["items"]:
            source = saved_rows[item["role"], item["champion"]]
            assert item == source | {"allocated_games": item["allocated_games"], "icon_url": f"/{item['champion']}.png"}
        return body

    try:
        yield query
    finally:
        server.shutdown()
        server.server_close()
        worker.join(timeout=5)
        assert not worker.is_alive()


@pytest.mark.parametrize("n,expected,requested", [
    pytest.param("20", (12, 7, 1), 20, id="exact-two-thirds-tie-keeps-source-priority"),
    pytest.param("12", (7, 4, 1), 12, id="original-horizon"),
    pytest.param("24", (14, 8, 2), 24, id="integral-scaling"),
    pytest.param("30", (18, 10, 2), 30, id="exact-half-tie-keeps-source-priority"),
    pytest.param("20.9", (12, 7, 1), 20, id="legacy-finite-fraction-truncates"),
    pytest.param("2e1", (12, 7, 1), 20, id="legacy-finite-exponent"),
])
def test_saved_plan_scaling_keeps_exact_remainder_priority(saved_plan_http, n, expected, requested):
    body = saved_plan_http({"role": "MIDDLE", "n": n})
    assert body["source_total"] == 12
    assert body["requested_n"] == requested
    assert body["role"] == "MIDDLE"
    assert [item["champion"] for item in body["items"]] == list(CHAMPIONS)
    assert tuple(item["allocated_games"] for item in body["items"]) == expected
    assert sum(item["allocated_games"] for item in body["items"]) == requested


def test_unscaled_legacy_horizons_and_nonpositive_source_totals_are_preserved(saved_plan_http):
    cases = [
        ({"role": "MIDDLE"}, (7, 4, 1), 12, 12),
        ({"role": "MIDDLE", "n": "0"}, (7, 4, 1), 12, 12),
        ({"role": "MIDDLE", "n": "-5"}, (7, 4, 1), 12, -5),
        ({"role": "BOTTOM", "n": "20"}, (0, 0, 0), 0, 20),
        ({"role": "SUPPORT", "n": "20"}, (-1, -2, -3), -6, 20),
    ]
    for params, expected, source_total, requested in cases:
        body = saved_plan_http(params)
        assert body["role"] == params["role"]
        assert body["source_total"] == source_total
        assert body["requested_n"] == requested
        assert tuple(item["allocated_games"] for item in body["items"]) == expected


def test_signed_saved_weights_keep_the_legacy_truncation_contract(saved_plan_http):
    for n, expected in [("20", (11, 10, -1)), ("24", (14, 12, -2))]:
        body = saved_plan_http({"role": "TOP", "n": n})
        assert body["role"] == "TOP"
        assert body["source_total"] == 12
        assert body["requested_n"] == int(n)
        assert [item["champion"] for item in body["items"]] == list(CHAMPIONS)
        assert tuple(item["allocated_games"] for item in body["items"]) == expected
        assert sum(item["allocated_games"] for item in body["items"]) == int(n)
