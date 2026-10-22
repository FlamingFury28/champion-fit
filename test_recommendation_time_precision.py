"""Recent-game windows preserve exact UTC instants on both HTTP backends."""
from contextlib import closing
from functools import partial
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
import json
from threading import Thread
from urllib.parse import urlencode

import pytest

import app
from algorithm_settings import recommended_settings, save_settings
from analysis_runtime import parse_time
from ingest import MATCH_COLUMNS, normalized_match, valid_normalized_match
from recommendation_runtime import _latest_matches_per_account
from test_algorithm_settings_snapshots import settings_storage  # noqa: F401


@pytest.fixture
def recommendation_http(settings_storage, tmp_path, monkeypatch):
    class QuietRecommendationHandler(app.DashboardHandler):
        def log_message(self, *args):
            pass

    monkeypatch.setattr(app, "STORAGE", settings_storage)
    monkeypatch.setattr(app, "DB_PATH", tmp_path / "precision.db")
    monkeypatch.setattr(app, "APP_ROOT", tmp_path)
    server = ThreadingHTTPServer(("127.0.0.1", 0), partial(QuietRecommendationHandler, directory=tmp_path))
    worker = Thread(target=server.serve_forever, daemon=True)
    worker.start()

    def send():
        params = {"account": "Precision#EUW", "role": "MIDDLE", "queue": "420",
                  "as_of": "2026-10-01T00:00:00Z"}
        client = HTTPConnection("127.0.0.1", server.server_port, timeout=20)
        try:
            client.request("GET", "/api/recommendations?" + urlencode(params))
            response = client.getresponse()
            assert response.getheader("Content-Type", "").startswith("application/json")
            return response.status, json.loads(response.read())
        finally:
            client.close()

    try:
        yield send, settings_storage
    finally:
        server.shutdown()
        server.server_close()
        worker.join(timeout=5)
        assert not worker.is_alive()


def archived_inputs(storage):
    with closing(storage.connect()) as connection:
        return {name: [dict(row) for row in connection.execute(f"SELECT * FROM {name} ORDER BY 1,2")]
                for name in ("match_quality", "match_import_provenance", "match_annotations",
                             "algorithm_settings_revisions", "algorithm_settings_state")}


@pytest.mark.parametrize("year", ["1600", "2026"], ids=["distant-date-precision", "ordinary-date-control"])
def test_http_one_game_window_selects_the_newest_microsecond(recommendation_http, year):
    send, storage = recommendation_http
    dates = {}
    with closing(storage.connect()) as connection:
        for champion, match_id, microsecond in (("Ahri", "z-older", 1), ("Lux", "a-newer", 2)):
            source = {"account": "Precision#EUW", "match_id": match_id,
                      "date": f"{year}-01-01T12:00:00.{microsecond:06d}Z", "patch": "16.19",
                      "queue": "420", "champion": champion, "role": "MIDDLE",
                      "duration_minutes": 30, "win": True}
            assert valid_normalized_match(source)
            dates[match_id] = source["date"]
            connection.execute("INSERT INTO champions VALUES(?,?,?)", (champion, champion, "/synthetic.png"))
            connection.execute("INSERT INTO match_quality(" + ",".join(MATCH_COLUMNS) + ") VALUES("
                               + ",".join("?" for _ in MATCH_COLUMNS) + ")", normalized_match(source))
            connection.execute("INSERT INTO match_import_provenance VALUES(?,?,?,?,?,?)",
                               (source["account"], match_id, "synthetic", "known_riot_default", "{}",
                                "2026-10-01T00:00:00Z"))
        connection.commit()
        settings = recommended_settings()
        settings["recommendations"]["period"] = {"value": 1, "unit": "games"}
        save_settings(connection, 2, settings)
    assert parse_time(dates["z-older"]) < parse_time(dates["a-newer"])
    before = archived_inputs(storage)

    status, payload = send()

    assert status == 200
    assert payload["context"]["period"] == {"value": 1, "unit": "games"}
    assert payload["context"]["observations"] == 1
    assert payload["algorithm_revision"] == 3
    assert [(item["champion"], item["games"]) for item in payload["known"]] == [("Lux", 1)]
    assert archived_inputs(storage) == before


def test_game_window_compares_compact_week_dates_and_offsets_by_utc():
    rows = [
        {"account": "A", "match_id": "z-older", "date": "20260101T130000.000001+0100"},
        {"account": "A", "match_id": "a-newer", "date": "2026-W01-4T12:00:00.000002Z"},
    ]
    assert _latest_matches_per_account(rows, 1) == [rows[1]]


@pytest.mark.parametrize("maximum", [1, 2])
def test_game_window_keeps_descending_id_ties_and_independent_account_limits(maximum):
    rows = [
        {"account": "A", "match_id": "a-same", "date": "2026-01-01T12:00:00Z"},
        {"account": "B", "match_id": "only-b", "date": "2026-01-01T11:00:00Z"},
        {"account": "A", "match_id": "z-same", "date": "20260101T130000+0100"},
        {"account": "A", "match_id": "zz-invalid", "date": "bad"},
    ]
    result = _latest_matches_per_account(rows, maximum)
    assert [row["match_id"] for row in result if row["account"] == "A"] == ["z-same", "a-same"][:maximum]
    assert [row["match_id"] for row in result if row["account"] == "B"] == ["only-b"]


def test_invalid_dates_remain_below_the_earliest_valid_utc_instant():
    rows = [
        {"account": "A", "match_id": "z-invalid", "date": None},
        {"account": "A", "match_id": "a-valid", "date": "0001-01-01T00:00:00Z"},
        {"account": "A", "match_id": "y-overflow", "date": "0001-01-01T00:00:00+01:00"},
    ]
    assert _latest_matches_per_account(rows, 1) == [rows[1]]
    assert _latest_matches_per_account(rows, 3) == [rows[1], rows[0], rows[2]]
