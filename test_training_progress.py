"""Progress consumes local facts without moving the goalposts or fetching Riot."""
from contextlib import closing
from datetime import datetime, timedelta, timezone
import json
from uuid import uuid4

import pytest

import app
from ingest import ingest_rows
from storage import SQLiteStorage
from training_progress import load_plan, progress, save_plan
from test_web_server import isolated_server, request  # noqa: F401


START = datetime(2026, 9, 20, 12, tzinfo=timezone.utc)


def game(match_id, **extra):
    return {"account": "Alpha#EUW", "match_id": match_id, "champion": "Ahri", "role": "MIDDLE",
            "queue": "420", "date": "2026-09-21T12:00:00Z", "duration_minutes": 30,
            "win": True, "patch": "16.19", **extra}


def chosen_plan():
    return {"plan_fingerprint": "a" * 64, "budget_total": 20,
            "context": {"accounts": ["Alpha#EUW", "Beta#EUW"], "queue": "420", "days": "90", "companion_filter_active": False},
            "items": [{"champion": "Ahri", "role": "MIDDLE", "allocation_games": 3,
                       "account_allocations": [{"account": "Alpha#EUW", "games": 2}, {"account": "Beta#EUW", "games": 1}]}]}


@pytest.fixture
def archive(tmp_path):
    storage = SQLiteStorage(tmp_path / "progress.db", app.SCHEMA_PATH)
    storage.initialize()
    with closing(storage.connect()) as connection:
        ingest_rows(connection, [game("baseline", date="2026-09-19T12:00:00Z")], "progress test")
        connection.commit()
    return storage


def count(connection, snapshot):
    return progress(connection, snapshot, companion_filter=app.companion_filter, now=START + timedelta(days=4))


def test_progress_is_frozen_deduplicated_scoped_and_capped(archive):
    plan_id = str(uuid4())
    with closing(archive.connect()) as connection:
        snapshot = save_plan(connection, plan_id, chosen_plan(), {}, now=START)
        connection.commit()
        rows = [game("new"), game("same-shared", account="Beta#EUW"), game("same-shared"), game("extra"),
                game("old-backfill", date="2026-09-10"), game("other-queue", queue="440"),
                game("other-champion", champion="Lux"), game("other-role", role="SUPPORT"),
                game("other-account", account="Other#EUW"), game("future", date="2026-09-25T01:00:00Z")]
        ingest_rows(connection, rows, "manual import")
        ingest_rows(connection, rows, "repeat manual import")
        connection.execute("UPDATE match_quality SET date='2026-09-21' WHERE match_id='baseline'")
        connection.execute("INSERT INTO match_annotations(match_id,note,updated_at) VALUES('new','Preserve me','2026-09-21')")
        connection.commit()
    # Reopening demonstrates durability independently of browser or analysis settings.
    with closing(archive.connect()) as connection:
        saved = load_plan(connection, plan_id)
        assert saved == snapshot
        result = count(connection, saved)
        assert (result["planned"], result["completed"], result["remaining"], result["extra"]) == (3, 3, 0, 1)
        assert result["budget_total"] == 20
        assert result["items"][0]["accounts"][0]["completed"] == 2
        assert connection.execute("SELECT note FROM match_annotations").fetchone()[0] == "Preserve me"
        assert load_plan(connection, plan_id) == snapshot


def test_progress_uses_utc_instants_and_keeps_partial_allocation(archive):
    with closing(archive.connect()) as connection:
        saved = save_plan(connection, str(uuid4()), chosen_plan(), {}, now=START)
        ingest_rows(connection, [game("after", date="2026-09-20T14:00:00.000001+02:00"),
                                 game("equal", date="2026-09-20T14:00:00+02:00"),
                                 game("before", date="2026-09-20T13:59:59+02:00")], "manual import")
        result = count(connection, saved)
        assert (result["completed"], result["remaining"]) == (1, 2)


def test_identity_pin_survives_rename_without_following_reused_name(archive):
    with closing(archive.connect()) as connection:
        connection.execute("INSERT INTO riot_account_identities(identity_id,account) VALUES('alpha','Alpha#EUW')")
        saved = save_plan(connection, str(uuid4()), chosen_plan(), {}, now=START)
        connection.execute("UPDATE riot_account_identities SET account='Renamed#EUW' WHERE identity_id='alpha'")
        connection.execute("UPDATE match_quality SET account='Renamed#EUW'")
        ingest_rows(connection, [game("renamed", account="Renamed#EUW"), game("unrelated-owner")], "manual import")
        assert count(connection, saved)["completed"] == 1
        assert count(connection, saved)["items"][0]["accounts"][0]["account"] == "Renamed#EUW"
        connection.execute("INSERT INTO riot_identity_policy(puuid,identity_id,state,resume_state,source,note,updated_at,history_json) "
                           "VALUES('p','alpha','exception','verified','user','','2026-09-21','[]')")
        result = count(connection, saved)
        assert result["completed"] == 0
        assert result["unavailable_accounts"] == ["Alpha#EUW"]


@pytest.mark.parametrize("mode,expected", [("only", 1), ("exclude", 1)])
def test_companion_context_is_retained(archive, mode, expected):
    plan = chosen_plan()
    plan["context"]["companion_filter_active"] = True
    with closing(archive.connect()) as connection:
        saved = save_plan(connection, str(uuid4()), plan, {"companion_account": ["Friend#EUW"], "companion_mode": [mode]}, now=START)
        ingest_rows(connection, [game("together"), game("alone")], "manual import")
        connection.execute("INSERT INTO match_participants(match_id,puuid,riot_id) VALUES('together','friend','Friend#EUW')")
        assert count(connection, saved)["completed"] == expected


def test_http_preview_start_retry_and_stale_plan(isolated_server):
    with closing(app.STORAGE.connect()) as connection:
        ingest_rows(connection, [game(f"http-{i}", date=(datetime.now(timezone.utc) - timedelta(days=1)).isoformat(), win=i % 2 == 0)
                                 for i in range(8)], "HTTP fixture")
        connection.commit()
    status, _, raw = request(isolated_server, "GET", "/api/training-plan?budget=20&role=MIDDLE&queue=420&days=all")
    assert status == 200, raw
    preview = json.loads(raw)
    body = {"id": str(uuid4()), "fingerprint": preview["plan_fingerprint"],
            "params": {"budget": ["20"], "role": ["MIDDLE"], "queue": ["420"], "days": ["all"]}}
    status, _, raw = request(isolated_server, "POST", "/api/training-progress", payload=body)
    assert status == 200, raw
    result = json.loads(raw)
    assert result["planned"] == 20
    assert result["completed"] == 0
    with closing(app.STORAGE.connect()) as connection:
        ingest_rows(connection, [game("http-new", date=datetime.now(timezone.utc).isoformat())], "manual import")
        connection.commit()
    status, _, raw = request(isolated_server, "GET", f'/api/training-progress?id={body["id"]}')
    assert status == 200, raw
    assert json.loads(raw)["completed"] == 1
    assert json.loads(raw)["remaining"] == 19
    assert request(isolated_server, "POST", "/api/training-progress", payload=body)[0] == 200
    assert request(isolated_server, "GET", f'/api/training-progress?id={body["id"]}')[0] == 200
    bad = {**body, "id": str(uuid4()), "fingerprint": "b" * 64}
    assert request(isolated_server, "POST", "/api/training-progress", payload=bad)[0] == 409
    assert request(isolated_server, "POST", "/api/training-progress", payload={**body, "id": str(uuid4())})[0] == 409
    bad["params"] = {"as_of": ["2026-01-01"]}
    assert request(isolated_server, "POST", "/api/training-progress", payload=bad)[0] == 400
    assert request(isolated_server, "GET", "/api/training-progress?id=invalid")[0] == 400
    assert request(isolated_server, "GET", f"/api/training-progress?id={uuid4()}")[0] == 404
    with closing(app.STORAGE.connect()) as connection:
        assert connection.execute("SELECT COUNT(*) FROM training_plan_runs").fetchone()[0] == 1
