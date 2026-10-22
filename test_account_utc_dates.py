"""Account HTTP dates describe UTC history while raw coverage stays unchanged."""
import json
import uuid
from contextlib import closing
from functools import partial
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from threading import Thread
from urllib.parse import urlencode

import pytest

import app
from ingest import MATCH_COLUMNS, normalized_match
from migrate_postgres import migrate
from storage import SQLiteStorage
from test_postgres_api import postgres_api_fixture  # noqa: F401


MAIN_DATES = {
    "compact": "20260801T120000Z", "week": "2026-W39-4T23:00:00Z",
    "offset-last": "2026-09-24T21:30:00-03:00", "offset-early": "2026-09-24T23:00:00+14:00",
    "invalid-role": "2026-08-15T12:00:00Z", "invalid-text": "not-a-date",
    "invalid-calendar": "2026-02-30T12:00:00Z", "utc-underflow": "0001-01-01T00:00:00+01:00",
    "utc-overflow": "9999-12-31T23:59:59-01:00",
}


class QuietAccountHandler(app.DashboardHandler):
    def log_message(self, format, *args):
        pass


def archived_rows(storage):
    with closing(storage.connect()) as connection:
        return {table: [dict(row) for row in connection.execute(f"SELECT * FROM {table} ORDER BY 1,2")]
                for table in ("match_quality", "match_import_provenance", "riot_match_list_raw", "riot_match_materialization")}


@pytest.fixture(params=["sqlite", "postgres"])
def account_http(request, tmp_path, monkeypatch):
    source = SQLiteStorage(tmp_path / "account-dates.db", app.SCHEMA_PATH)
    source.initialize()
    prefix = f"DateAudit-{uuid.uuid4().hex}"
    names = {key: f"{prefix}-{key}#EUW" for key in ("main", "other", "current", "empty", "invalid", "future", "offset")}
    aliases = {key: f"{prefix}-{key}#EUW" for key in ("old", "shared")}
    with closing(source.connect()) as connection, connection:
        connection.execute("INSERT INTO champions VALUES('Lux','Lux','/Lux.png')")
        records = [(names["main"], key, date, "INVALID" if key == "invalid-role" else "MIDDLE")
                   for key, date in MAIN_DATES.items()]
        records += [
            (names["other"], "other", "2026-09-01", "MIDDLE"),
            (names["current"], "current", "2026-09-02", "MIDDLE"),
            (names["invalid"], "bad-calendar", "2026-02-30", "MIDDLE"),
            (names["invalid"], "bad-overflow", "9999-12-31T23:59:59-01:00", "INVALID"),
            (names["future"], "invalid-role-first", "2020-01-01T00:00:00Z", "INVALID"),
            (names["future"], "ordinary", "2026-09-01T00:00:00Z", "MIDDLE"),
            (names["future"], "future", "2099-01-01T00:00:00Z", "MIDDLE"),
            (names["offset"], "first", "2026-09-24T23:00:00+14:00", "MIDDLE"),
            (names["offset"], "last", "2026-09-24T11:00:00-12:00", "MIDDLE"),
        ]
        rows = [normalized_match({"account": account, "match_id": f"{prefix}-{key}", "date": date,
                                  "role": role, "champion": "Lux", "patch": "16.19", "queue": "420",
                                  "duration_minutes": 30, "win": index % 2})
                for index, (account, key, date, role) in enumerate(records)]
        # Direct insertion represents legacy malformed rows that are still raw
        # history; the normalized importer now deliberately rejects those rows.
        connection.executemany(
            "INSERT INTO match_quality(" + ",".join(MATCH_COLUMNS) + ") VALUES(" + ",".join("?" for _ in MATCH_COLUMNS) + ")", rows,
        )
        connection.executemany("INSERT INTO tracked_account_puuids VALUES(?,?)", [
            (f"{prefix}-owner", names["main"]), (f"{prefix}-other", names["other"]),
            (f"{prefix}-empty", names["empty"]),
        ])
        connection.executemany("INSERT INTO riot_account_identities VALUES(?,?)", [
            (f"{prefix}-identity", names["main"]), (f"{prefix}-other-identity", names["other"]),
        ])
        connection.executemany("INSERT INTO riot_identity_puuids VALUES(?,?)", [
            (f"{prefix}-owner", f"{prefix}-identity"), (f"{prefix}-other", f"{prefix}-other-identity"),
        ])
        connection.executemany("INSERT INTO riot_account_aliases VALUES(?,?,?,?,?,?)", [
            (owner, alias.casefold(), alias, puuid, "verified_account_puuid", "now")
            for owner, alias, puuid in (
                (names["main"], aliases["old"], f"{prefix}-owner"),
                (names["main"], aliases["shared"], f"{prefix}-owner"),
                (names["other"], aliases["shared"], f"{prefix}-other"),
                (names["main"], names["current"], f"{prefix}-owner"),
            )
        ])
        raw_ids = [f"{prefix}-{key}" for key in MAIN_DATES] + [f"{prefix}-pending", f"{prefix}-unsupported"]
        connection.execute("INSERT INTO riot_match_list_raw VALUES(?,?,?,?)",
                           (names["main"], f"{prefix}-owner", "now", json.dumps(raw_ids)))
        connection.executemany(
            "INSERT INTO riot_match_materialization(account,match_id,status,last_attempt_at) VALUES(?,?,?,?)",
            [(names["main"], raw_ids[-2], "identity_unresolved", "now"),
             (names["main"], raw_ids[-1], "unsupported_queue", "now")],
        )
    storage = source
    if request.param == "postgres":
        _, storage, _ = request.getfixturevalue("postgres_api_fixture")
        migrate(source.path, storage.dsn)
    monkeypatch.setattr(app, "STORAGE", storage)
    monkeypatch.setattr(app, "DB_PATH", source.path)
    monkeypatch.setattr(app, "APP_ROOT", tmp_path)
    server = ThreadingHTTPServer(("127.0.0.1", 0), partial(QuietAccountHandler, directory=tmp_path))
    worker = Thread(target=server.serve_forever, daemon=True)
    worker.start()

    def get(search=prefix):
        connection = HTTPConnection("127.0.0.1", server.server_port, timeout=10)
        try:
            connection.request("GET", "/api/accounts?" + urlencode({"q": search}))
            response = connection.getresponse()
            payload = json.loads(response.read())
            assert response.status == 200, payload
            return payload["items"]
        finally:
            connection.close()

    try:
        yield get, storage, names, aliases
    finally:
        server.shutdown()
        server.server_close()
        worker.join(timeout=5)


def test_account_http_extrema_follow_utc_and_preserve_archive_and_coverage(account_http):
    get, storage, names, _ = account_http
    before = archived_rows(storage)
    accounts = {row["account"]: row for row in get()}
    row = accounts[names["main"]]
    assert row["first_game"] == "2026-08-01T12:00:00.000000+00:00"
    assert row["last_game"] == "2026-09-25T00:30:00.000000+00:00"
    assert (row["raw_games"], row["eligible_games"], row["analyzed_games"], row["games"], row["wins"]) == (11, 10, 9, 11, 4)
    offset = accounts[names["offset"]]
    assert offset["first_game"] == "2026-09-24T09:00:00.000000+00:00"
    assert offset["last_game"] == "2026-09-24T23:00:00.000000+00:00"
    assert archived_rows(storage) == before


def test_account_http_keeps_invalid_empty_future_and_invalid_role_history(account_http):
    get, _, names, _ = account_http
    accounts = {row["account"]: row for row in get()}
    assert set(accounts) == set(names.values())
    for key, count in (("invalid", 2), ("empty", 0)):
        row = accounts[names[key]]
        assert row["first_game"] is None and row["last_game"] is None
        assert (row["raw_games"], row["eligible_games"], row["analyzed_games"], row["games"]) == (count,) * 4
    future = accounts[names["future"]]
    assert future["first_game"] == "2020-01-01T00:00:00.000000+00:00"
    assert future["last_game"] == "2099-01-01T00:00:00.000000+00:00"
    assert future["analyzed_games"] == 3


def test_account_http_alias_search_does_not_merge_ambiguous_or_current_names(account_http):
    get, _, names, aliases = account_http
    accounts = {row["account"]: row for row in get()}
    assert accounts[names["main"]]["aliases"] == [aliases["old"]]
    assert get(aliases["old"].upper()) == [accounts[names["main"]]]
    assert get(names["current"]) == [accounts[names["current"]]]
    assert get(aliases["shared"]) == []
    assert accounts[names["current"]]["analyzed_games"] == 1
