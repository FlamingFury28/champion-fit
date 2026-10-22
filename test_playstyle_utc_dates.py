"""Playstyle HTTP scopes and evidence pages use UTC while lifetime stays raw."""
from contextlib import closing
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from functools import partial
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
import json
from threading import Thread
from urllib.parse import urlencode
import uuid

import pytest

import app
from analysis_runtime import parse_time
from ingest import MATCH_COLUMNS, normalized_match
from migrate_postgres import migrate
import playstyle_analysis as ps
from storage import SQLiteStorage
from test_postgres_api import postgres_api_fixture  # noqa: F401


AS_OF = "2026-09-24T14:00:00.000499+02:00"
DATES = {
    "compact": "20260801T120000Z",
    "week": "2026-W39-4T10:00:00Z",
    "offset": "2026-09-24T13:00:00+02:00",
    "naive": "2026-09-24T10:45:00",
    "short-offset": "2026-09-24T12:30:00+02",
    "date-only": "2026-09-24",
    "latest": "2026-09-24T12:00:00.000499Z",
    "extra-precision": "2026-09-24T12:00:00.0004999Z",
    "cutoff": "2026-06-25T21:00:00-03:00",
    "before-cutoff": "2026-06-26T00:00:00+00:01",
    "old-compact": "20260101T120000Z",
    "future-precision": "2026-09-24T12:00:00.000500Z",
    "future": "2099-01-01T12:00:00Z",
    "invalid": "not-a-date",
    "invalid-calendar": "2026-02-30T12:00:00Z",
    "missing": "",
    "utc-underflow": "0001-01-01T00:00:00+01:00",
    "utc-overflow": "9999-12-31T23:59:59-01:00",
}
WITHIN_90_DAYS = {"compact", "week", "offset", "naive", "short-offset", "date-only",
                  "latest", "extra-precision", "cutoff"}


def pure_row(match_id, date, champion="Lux"):
    return {"account": "Audit#EUW", "match_id": match_id, "date": date,
            "champion": champion, "role": "MIDDLE", "queue": "420", "win": 1,
            "duration_minutes": 30}


@pytest.mark.parametrize("now", [
    datetime(2026, 9, 24, 12, 0, 0, 499, tzinfo=timezone.utc),
    datetime(2026, 9, 24, 12, 0, 0, 499),
    datetime(2026, 9, 24, 14, 0, 0, 499, tzinfo=timezone(timedelta(hours=2))),
])
def test_explicit_now_has_priority_and_does_not_mutate_rows_or_raw_options(now):
    rows = [pure_row(key, DATES[key]) for key in ("latest", "future-precision", "invalid")]
    before = deepcopy(rows)

    filters, options, scoped = ps.resolve_filters(
        rows, {"days": ["all"], "as_of": ["2099-01-01T12:00:00Z"]}, now=now,
    )

    assert [row["match_id"] for row in scoped] == ["latest"]
    assert scoped[0]["date_utc"] == "2026-09-24T12:00:00.000499+00:00"
    assert filters == {"role": "ALL", "queue": "420", "days": "all"}
    assert options["pairs"] == [{"role": "MIDDLE", "queue": "420", "games": 3}]
    assert rows == before


def test_lifetime_champions_stay_tried_when_their_dates_are_outside_the_analysis(monkeypatch):
    champions = [{"id": name, "name": name, "roles": ["MIDDLE"], "tags": ["audit"]}
                 for name in ("Lux", "Annie", "Ahri", "Velkoz")]
    entries = {row["id"]: row for row in champions}
    catalog = {"version": "test", "source_version": "test", "sources": [], "champions": champions,
               "categories": [{"id": "audit", "label": "Audit", "kind": "style", "criteria": "test"}]}
    monkeypatch.setattr(ps, "load_catalog", lambda: deepcopy(catalog))
    monkeypatch.setattr(ps, "champion_entry", entries.get)
    monkeypatch.setattr(ps, "champion_categories", lambda name: entries.get(name, {}).get("tags", []))
    rows = [pure_row("current", DATES["latest"]),
            pure_row("old", DATES["old-compact"], "Annie"),
            pure_row("future", DATES["future"], "Ahri"),
            pure_row("invalid", DATES["invalid"], "Velkoz")]
    before = deepcopy(rows)

    payload = ps.analyze(rows, rows, ["Audit#EUW"], {"days": ["90"], "as_of": [AS_OF]})

    assert payload["summary"]["observations"] == 1
    assert [row["champion"] for row in payload["suggestions"]["played"]] == ["Lux"]
    assert payload["suggestions"]["untried"] == []
    assert sum(pair["games"] for pair in payload["options"]["pairs"]) == len(rows)
    assert rows == before


class QuietPlaystyleHandler(app.DashboardHandler):
    def log_message(self, format, *args):
        pass


def archived_rows(storage):
    with closing(storage.connect()) as connection:
        return {table: [dict(row) for row in connection.execute(f"SELECT * FROM {table} ORDER BY 1,2")]
                for table in ("match_quality", "match_import_provenance", "match_annotations", "riot_match_raw")}


@pytest.fixture(params=["sqlite", "postgres"])
def playstyle_http(request, tmp_path, monkeypatch):
    source = SQLiteStorage(tmp_path / "playstyle-utc.db", app.SCHEMA_PATH)
    source.initialize()
    prefix = uuid.uuid4().hex
    servers = []

    def activate(records):
        accounts = {cohort: f"StyleUtc-{prefix}-{cohort}#EUW" for _, _, cohort in records}
        ids = {key: f"{prefix}-{key}" for key, _, _ in records}
        with closing(source.connect()) as connection, connection:
            connection.execute("INSERT INTO champions VALUES('Lux','Lux','/Lux.png')")
            rows = [normalized_match({"account": accounts[cohort], "match_id": ids[key], "date": date,
                                      "champion": "Lux", "role": "MIDDLE", "queue": "420", "patch": "16.19",
                                      "duration_minutes": 30, "win": 1})
                    for key, date, cohort in records]
            # Legacy malformed history is inserted directly; imports reject it.
            connection.executemany(
                "INSERT INTO match_quality(" + ",".join(MATCH_COLUMNS) + ") VALUES("
                + ",".join("?" for _ in MATCH_COLUMNS) + ")", rows,
            )
            for key, date, cohort in records:
                if date == "":
                    connection.execute("UPDATE match_quality SET date='' WHERE account=? AND match_id=?",
                                       (accounts[cohort], ids[key]))
            connection.execute("INSERT INTO match_annotations(match_id,note,updated_at) VALUES(?,?,?)",
                               (next(iter(ids.values())), "Preserve audit note", "now"))
        storage = source
        if request.param == "postgres":
            _, storage, _ = request.getfixturevalue("postgres_api_fixture")
            migrate(source.path, storage.dsn)
        monkeypatch.setattr(app, "STORAGE", storage)
        monkeypatch.setattr(app, "DB_PATH", source.path)
        monkeypatch.setattr(app, "APP_ROOT", tmp_path)
        server = ThreadingHTTPServer(("127.0.0.1", 0), partial(QuietPlaystyleHandler, directory=tmp_path))
        worker = Thread(target=server.serve_forever, daemon=True)
        worker.start()
        servers.append((server, worker))

        def get(path="/api/playstyle-evidence", **additional):
            params = {"account": sorted(accounts.values()), "role": "MIDDLE", "queue": "420", "days": "90",
                      "as_of": AS_OF, "category": "class:mage", "page_size": "2"} | additional
            client = HTTPConnection("127.0.0.1", server.server_port, timeout=10)
            try:
                client.request("GET", path + "?" + urlencode(params, doseq=True))
                response = client.getresponse()
                payload = json.loads(response.read())
                assert response.status == 200, payload
                return payload
            finally:
                client.close()

        return get, storage, accounts, ids

    try:
        yield activate
    finally:
        for server, worker in servers:
            server.shutdown()
            server.server_close()
            worker.join(timeout=5)


@pytest.mark.parametrize("days", ["90", "all"])
def test_playstyle_http_utc_scope_and_pagination_match_analysis_context(playstyle_http, days):
    get, storage, _, ids = playstyle_http([(key, date, "main") for key, date in DATES.items()])
    before = archived_rows(storage)
    expected = WITHIN_90_DAYS | ({"before-cutoff", "old-compact"} if days == "all" else set())
    expected_order = sorted(expected, key=lambda key: (parse_time(DATES[key]), ids[key]), reverse=True)

    styles = get("/api/playstyles", days=days)
    pages = [get(days=days, page=str(page)) for page in range(1, (len(expected) + 1) // 2 + 2)]

    assert styles["summary"]["observations"] == styles["context"]["observations"] == len(expected)
    assert styles["summary"]["unique_games"] == len(expected)
    assert sum(pair["games"] for pair in styles["options"]["pairs"]) == len(DATES)
    assert all(page["total"] == page["context"]["observations"] == len(expected) for page in pages)
    matches = [row for page in pages for row in page["matches"]]
    assert [row["match_id"] for row in matches] == [ids[key] for key in expected_order]
    assert [row["date"] for row in matches] == [DATES[key] for key in expected_order]
    assert [row["date_utc"] for row in matches] == [
        parse_time(DATES[key]).isoformat(timespec="microseconds") for key in expected_order
    ]
    assert next(row for row in matches if row["match_id"] == ids["compact"])["note"] == "Preserve audit note"
    assert all("_analysis_utc_order" not in row for row in matches)
    assert archived_rows(storage) == before


def test_playstyle_http_equal_instants_keep_descending_id_and_account_ties(playstyle_http):
    dates = ["20260924T120000Z", "2026-09-24T14:00:00+02:00", "2026-W39-4T12:00:00Z"]
    get, storage, accounts, ids = playstyle_http([
        ("shared-a", dates[2], "alpha"), ("shared-b", dates[0], "alpha"), ("shared-a", dates[1], "beta"),
    ])
    before = archived_rows(storage)

    pages = [get(days="all", page_size="1", page=str(page)) for page in range(1, 4)]

    assert [page["total"] for page in pages] == [3, 3, 3]
    matches = [row for page in pages for row in page["matches"]]
    assert [(row["match_id"], row["account"]) for row in matches] == [
        (ids["shared-b"], accounts["alpha"]), (ids["shared-a"], accounts["beta"]),
        (ids["shared-a"], accounts["alpha"]),
    ]
    assert [row["date"] for row in matches] == dates
    assert {row["date_utc"] for row in matches} == {"2026-09-24T12:00:00.000000+00:00"}
    assert archived_rows(storage) == before


def test_playstyle_http_all_roles_excludes_invalid_legacy_roles_only_from_scope(playstyle_http):
    get, storage, _, ids = playstyle_http([
        ("valid-role", DATES["latest"], "main"),
        ("invalid-role", DATES["latest"], "main"),
        ("blank-role", DATES["latest"], "main"),
    ])
    with closing(storage.connect()) as connection:
        connection.execute("UPDATE match_quality SET role='INVALID' WHERE match_id=?", (ids["invalid-role"],))
        connection.execute("UPDATE match_quality SET role='' WHERE match_id=?", (ids["blank-role"],))
        connection.commit()
    before = archived_rows(storage)

    styles = get("/api/playstyles", role="ALL", days="all")
    evidence = get(role="ALL", days="all")

    assert styles["summary"]["observations"] == styles["context"]["observations"] == 1
    assert evidence["total"] == evidence["context"]["observations"] == 1
    assert [row["match_id"] for row in evidence["matches"]] == [ids["valid-role"]]
    assert styles["options"]["pairs"] == [{"role": "MIDDLE", "queue": "420", "games": 1}]
    assert archived_rows(storage) == before
