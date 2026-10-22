"""Legacy saved plans preserve account/role/companion scope on both HTTP backends."""
from contextlib import closing
from functools import partial
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
import json
from threading import Thread
from urllib.parse import urlencode

import pytest

import app
from ingest import MATCH_COLUMNS, normalized_match
from storage import SQLiteStorage
from test_postgres_group_id_width import postgres_groups  # noqa: F401


class QuietPlanHandler(app.DashboardHandler):
    def log_message(self, *_args):
        pass


@pytest.fixture(params=["sqlite", "postgres"])
def legacy_plan_http(request, tmp_path, monkeypatch):
    if request.param == "sqlite":
        storage = SQLiteStorage(tmp_path / "legacy-plan.db", app.SCHEMA_PATH)
    else:
        create, _ = request.getfixturevalue("postgres_groups")
        _, storage = create()
    storage.initialize()
    with closing(storage.connect()) as connection:
        for champion, role, allocation in [("Ahri", "MIDDLE", 30), ("Lux", "SUPPORT", 20), ("Garen", "TOP", 10)]:
            connection.execute("INSERT INTO champions VALUES(?,?,?)", (champion, champion, "/" + champion + ".png"))
            fit = ("global", role, champion, 1, 1, 0, 1, 1, 0, 1, 60, 10, .6, .3, .9, .6, .7,
                   1, "synthetic", 1, 0, 0, 0, "none", "", .5)
            connection.execute("INSERT INTO champion_fit VALUES(" + ",".join("?" for _ in fit) + ")", fit)
            connection.execute(
                "INSERT INTO test_plan VALUES(?,?,?,?,?,?,?,?,?)",
                (role, champion, allocation, "synthetic", 1, 60, .7, .5, "Saved synthetic priority"),
            )
        connection.executemany(
            "INSERT INTO tracked_account_puuids(puuid,account) VALUES(?,?)",
            [("owner-alpha", "Alpha#EUW"), ("owner-beta", "Beta#EUW"), ("owner-gamma", "Gamma#EUW")],
        )
        for match_id, account, owner, champion, role, companion in [
            ("shared-alpha", "Alpha#EUW", "owner-alpha", "Ahri", "MIDDLE", True),
            ("solo-alpha", "Alpha#EUW", "owner-alpha", "Lux", "SUPPORT", False),
            ("shared-gamma", "Gamma#EUW", "owner-gamma", "Garen", "TOP", True),
        ]:
            row = normalized_match({
                "account": account, "match_id": match_id, "date": "2026-09-24T12:00:00Z",
                "patch": "16.19", "queue": "420", "champion": champion, "role": role,
                "duration_minutes": 30, "win": True,
            })
            connection.execute(
                "INSERT INTO match_quality(" + ",".join(MATCH_COLUMNS) + ") VALUES("
                + ",".join("?" for _ in MATCH_COLUMNS) + ")", row,
            )
            connection.execute(
                "INSERT INTO match_import_provenance VALUES(?,?,?,?,?,?)",
                (account, match_id, "synthetic legacy plan", "known_riot_default", "{}", "2026-09-24"),
            )
            participants = [(match_id, owner, account, champion, 1, 100)]
            if companion:
                participants.append((match_id, "owner-beta", "Beta#EUW", "Leona", 1, 100))
            connection.executemany(
                "INSERT INTO match_participants(match_id,puuid,riot_id,champion,win,team_id) VALUES(?,?,?,?,?,?)",
                participants,
            )
        connection.commit()

    def snapshot():
        with closing(storage.connect()) as connection:
            return {
                table: [dict(row) for row in connection.execute("SELECT * FROM " + table + " ORDER BY " + order)]
                for table, order in [
                    ("champions", "champion"), ("champion_fit", "role,champion"), ("test_plan", "role,champion"),
                    ("match_quality", "account,match_id"), ("match_import_provenance", "account,match_id"),
                    ("tracked_account_puuids", "puuid"), ("match_participants", "match_id,puuid"),
                ]
            }

    before = snapshot()
    monkeypatch.setattr(app, "STORAGE", storage)
    monkeypatch.setattr(app, "DB_PATH", tmp_path / "unused.db")
    monkeypatch.setattr(app, "APP_ROOT", tmp_path)
    server = ThreadingHTTPServer(("127.0.0.1", 0), partial(QuietPlanHandler, directory=tmp_path))
    worker = Thread(target=server.serve_forever, daemon=True)
    worker.start()

    def query(params):
        with closing(HTTPConnection("127.0.0.1", server.server_port, timeout=20)) as client:
            client.request("GET", "/api/plan?" + urlencode(params))
            response = client.getresponse()
            payload = json.loads(response.read())
        assert snapshot() == before
        assert response.status == 200, payload
        return payload

    try:
        yield query
    finally:
        server.shutdown()
        server.server_close()
        worker.join(timeout=5)


@pytest.mark.parametrize(("params", "expected"), [
    ({}, ["Ahri", "Lux", "Garen"]),
    ({"role": "MIDDLE"}, ["Ahri"]),
    ({"account": "Alpha#EUW"}, ["Ahri", "Lux"]),
    ({"account": "Alpha#EUW", "role": "SUPPORT"}, ["Lux"]),
    ({"account": "Gamma#EUW"}, ["Garen"]),
    ({"account": "Alpha#EUW", "companion_account": "Beta#EUW", "companion_mode": "only"}, ["Ahri"]),
    ({"account": "Alpha#EUW", "companion_account": "Beta#EUW", "companion_mode": "exclude"}, ["Lux"]),
    ({"companion_account": "Beta#EUW", "companion_mode": "exclude"}, ["Lux"]),
    ({"companion_account": "Beta#EUW", "companion_mode": "exclude", "role": "MIDDLE"}, []),
    # Preserve companion_filter's existing guard against other owned accounts.
    ({"companion_account": "Beta#EUW", "companion_mode": "only"}, []),
    ({"companion_account": "Beta#EUW", "companion_mode": "only", "role": "MIDDLE"}, []),
    ({"account": "Gamma#EUW", "companion_account": "Beta#EUW", "companion_mode": "only", "role": "TOP"}, ["Garen"]),
    ({"account": "Missing#EUW", "companion_account": "Beta#EUW", "companion_mode": "exclude"}, []),
    ({"account": "Alpha#EUW", "companion_account": "Alpha#EUW", "companion_mode": "exclude"}, ["Ahri", "Lux"]),
])
def test_legacy_plan_applies_the_complete_scope_without_mutating_sources(legacy_plan_http, params, expected):
    payload = legacy_plan_http(params)
    assert [item["champion"] for item in payload["items"]] == expected
    assert payload["source_total"] == sum(item["allocated_games"] for item in payload["items"])
    assert payload["requested_n"] == payload["source_total"]
    assert payload["role"] == params.get("role", "")


def test_legacy_plan_scales_only_the_companion_filtered_saved_mix(legacy_plan_http):
    payload = legacy_plan_http({"companion_account": "Beta#EUW", "companion_mode": "exclude", "n": "7"})
    assert [(item["champion"], item["allocated_games"]) for item in payload["items"]] == [("Lux", 7)]
    assert payload["source_total"] == 20
    assert payload["requested_n"] == 7
