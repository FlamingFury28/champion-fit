"""Friend-group identifiers survive JSON and round-trip to their exact SQL rows."""
from contextlib import closing
from functools import partial
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
import json
from threading import Thread
from urllib.parse import quote, urlencode
import uuid

import pytest

import app
from ingest import ingest_rows
from migrate_postgres import migrate
from storage import SQLiteStorage
from test_postgres_group_id_width import postgres_groups  # noqa: F401
from test_recent_match_ordering import archived_recent_sources


GROUP_IDS = {
    "ordinary": 7,
    "safe-max": 9007199254740991,
    "adjacent-low": 9007199254740992,
    "adjacent-high": 9007199254740993,
    "sql-max": 9223372036854775807,
}
WIRE_IDS = {
    "ordinary": 7,
    "safe-max": 9007199254740991,
    "adjacent-low": "9007199254740992",
    "adjacent-high": "9007199254740993",
    "sql-max": "9223372036854775807",
}


class QuietWireIdHandler(app.DashboardHandler):
    def log_message(self, format, *args):
        pass


def group_rows(storage):
    with closing(storage.connect()) as connection:
        return {
            "groups": [dict(row) for row in connection.execute("SELECT id,name FROM friend_groups ORDER BY id")],
            "aliases": [dict(row) for row in connection.execute(
                "SELECT group_id,alias FROM friend_group_aliases ORDER BY group_id,alias")],
        }


@pytest.fixture(params=["sqlite", "postgres"])
def wire_http(request, tmp_path, monkeypatch):
    source = SQLiteStorage(tmp_path / "group-wire-ids.db", app.SCHEMA_PATH)
    source.initialize()
    prefix = uuid.uuid4().hex
    account, owner = f"Wire-{prefix}#EUW", f"{prefix}-owner"
    names = {label: f"Wire-{prefix}-{label}" for label in GROUP_IDS}
    aliases = {label: f"Original-{prefix}-{label}#EUW" for label in GROUP_IDS}
    with closing(source.connect()) as connection, connection:
        ingest_rows(connection, [{"account": account, "match_id": f"{prefix}-{label}", "date": "20260924T120000Z",
                                  "patch": "16.19", "queue": "420", "champion": "Lux", "role": "MIDDLE",
                                  "duration_minutes": 30, "win": True} for label in GROUP_IDS], "synthetic group wire IDs")
        connection.execute("INSERT INTO tracked_account_puuids VALUES(?,?)", (owner, account))
        for label, group_id in GROUP_IDS.items():
            connection.execute("INSERT INTO friend_groups(id,name) VALUES(?,?)", (group_id, names[label]))
            connection.execute("INSERT INTO friend_group_aliases(group_id,alias) VALUES(?,?)", (group_id, aliases[label]))
            connection.executemany(
                "INSERT INTO match_participants(match_id,puuid,riot_id,champion,win,team_id) VALUES(?,?,?,?,?,?)",
                [(f"{prefix}-{label}", owner, account, "Lux", 1, 100),
                 (f"{prefix}-{label}", f"{prefix}-{label}-friend", aliases[label], "Leona", 1, 100)],
            )
    storage = source
    if request.param == "postgres":
        create, _ = request.getfixturevalue("postgres_groups")
        _, storage = create()
        # Replacement is confined to this test's newly created UUID schema;
        # keeping the source IDs is the contract under review.
        migrate(source.path, storage.dsn, mode="replace")
    monkeypatch.setattr(app, "STORAGE", storage)
    monkeypatch.setattr(app, "DB_PATH", source.path)
    monkeypatch.setattr(app, "APP_ROOT", tmp_path)
    server = ThreadingHTTPServer(("127.0.0.1", 0), partial(QuietWireIdHandler, directory=tmp_path))
    worker = Thread(target=server.serve_forever, daemon=True)
    worker.start()

    def send(method="GET", path=None, payload=None):
        if path is None:
            path = "/api/friends?" + urlencode({"account": account, "role": "ALL", "queue": "all", "days": "all",
                                               "as_of": "2026-09-25T12:00:00Z", "min_shared_games": "1"})
        client = HTTPConnection("127.0.0.1", server.server_port, timeout=10)
        try:
            body = json.dumps(payload).encode("utf-8") if payload is not None else None
            client.request(method, path, body=body, headers={"Content-Type": "application/json"} if body else {})
            response = client.getresponse()
            return response.status, json.loads(response.read())
        finally:
            client.close()

    def archived():
        with closing(storage.connect()) as connection:
            facts = archived_recent_sources(connection)
            facts["match_participants"] = [dict(row) for row in connection.execute(
                "SELECT * FROM match_participants ORDER BY match_id,puuid")]
            return facts

    try:
        yield send, storage, names, aliases, archived
    finally:
        server.shutdown()
        server.server_close()
        worker.join(timeout=5)


def test_manual_groups_keep_safe_numeric_ids_and_exact_distinct_large_strings(wire_http):
    send, storage, names, aliases, archived = wire_http
    before, before_groups = archived(), group_rows(storage)

    status, payload = send()

    assert status == 200
    by_name = {row["name"]: row for row in payload["manual_groups"]}
    assert set(by_name) == set(names.values())
    for label, expected in WIRE_IDS.items():
        actual = by_name[names[label]]["id"]
        assert actual == expected and type(actual) is type(expected)
        assert by_name[names[label]]["aliases"] == [aliases[label]]
    assert len({row["id"] for row in by_name.values()}) == len(GROUP_IDS)
    friends = {row["friend"]: row for row in payload["items"]}
    assert {friends[names[label]]["friend_key"] for label in GROUP_IDS} == {
        f"manual:{value}" for value in GROUP_IDS.values()
    }
    assert type(payload["summary"]["friends_found"]) is int
    assert all(type(row["shared_games"]) is int for row in friends.values())
    # Existing-group saves still expose only the established ok/name response.
    status, saved = send("POST", "/api/friend-groups", {"name": names["ordinary"], "aliases": [aliases["ordinary"]]})
    assert status == 200 and saved == {"ok": True, "name": names["ordinary"]}
    assert group_rows(storage) == before_groups
    assert archived() == before


def test_wire_group_ids_round_trip_through_all_actions_without_changing_other_rows(wire_http):
    send, storage, names, aliases, archived = wire_http
    before = archived()
    expected = group_rows(storage)
    status, payload = send()
    assert status == 200
    by_name = {row["name"]: row for row in payload["manual_groups"]}

    for label, numeric_id in GROUP_IDS.items():
        wire_id = by_name[names[label]]["id"]
        expected_wire = WIRE_IDS[label]
        assert wire_id == expected_wire and type(wire_id) is type(expected_wire)
        path = f"/api/friend-groups/{wire_id}"
        new_name, new_alias = f"Renamed-{label}", f"Added-{label}#EUW"

        status, renamed = send("PATCH", path, {"name": new_name})
        assert status == 200 and renamed == {"ok": True, "id": expected_wire, "name": new_name}
        expected["groups"] = [{**row, "name": new_name} if row["id"] == numeric_id else row for row in expected["groups"]]
        assert group_rows(storage) == expected

        status, added = send("POST", path + "/aliases", {"aliases": [new_alias]})
        assert status == 200 and added == {"ok": True, "id": expected_wire, "added_aliases": [new_alias]}
        expected["aliases"].append({"group_id": numeric_id, "alias": new_alias})
        expected["aliases"].sort(key=lambda row: (row["group_id"], row["alias"]))
        assert group_rows(storage) == expected

        status, removed_alias = send("DELETE", path + "/aliases/" + quote(new_alias, safe=""))
        assert status == 200 and removed_alias == {"ok": True, "id": expected_wire}
        expected["aliases"] = [row for row in expected["aliases"] if row != {"group_id": numeric_id, "alias": new_alias}]
        assert group_rows(storage) == expected

        status, deleted = send("DELETE", path)
        assert status == 200 and deleted == {"ok": True, "id": expected_wire}
        expected["groups"] = [row for row in expected["groups"] if row["id"] != numeric_id]
        expected["aliases"] = [row for row in expected["aliases"] if row["group_id"] != numeric_id]
        assert group_rows(storage) == expected
        assert archived() == before
