"""Group-name ownership uses the same Unicode semantics on both HTTP backends."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from functools import partial
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
import json
from threading import Barrier, Thread
from urllib.parse import urlencode

import pytest

import app
from ingest import MATCH_COLUMNS, normalized_match
from storage import SQLiteStorage
from test_postgres_group_id_width import postgres_groups  # noqa: F401
from test_recent_match_ordering import archived_recent_sources


NAME_VARIANTS = [("Équipe", "éQUIPE"), ("Straße", "STRASSE")]


class QuietNameHandler(app.DashboardHandler):
    def log_message(self, format, *args):
        pass


@pytest.fixture(params=["sqlite", "postgres"])
def name_http(request, tmp_path, monkeypatch):
    if request.param == "sqlite":
        storage = SQLiteStorage(tmp_path / "names.db", app.SCHEMA_PATH)
    else:
        create, _ = request.getfixturevalue("postgres_groups")
        _, storage = create()
    storage.initialize()
    with closing(storage.connect()) as connection:
        connection.execute("INSERT INTO champions VALUES('Lux','Lux','/Lux.png')")
        row = normalized_match({"account": "Names#EUW", "match_id": "protected", "date": "20260924T120000Z",
                                "patch": "16.19", "queue": "420", "champion": "Lux", "role": "MIDDLE",
                                "duration_minutes": 30, "win": True})
        connection.execute(
            "INSERT INTO match_quality(" + ",".join(MATCH_COLUMNS) + ") VALUES("
            + ",".join("?" for _ in MATCH_COLUMNS) + ")", row,
        )
        connection.execute(
            "INSERT INTO match_import_provenance VALUES('Names#EUW','protected','test','known_riot_default','{}','now')"
        )
        connection.commit()
    monkeypatch.setattr(app, "STORAGE", storage)
    monkeypatch.setattr(app, "DB_PATH", tmp_path / "names.db")
    monkeypatch.setattr(app, "APP_ROOT", tmp_path)
    server = ThreadingHTTPServer(("127.0.0.1", 0), partial(QuietNameHandler, directory=tmp_path))
    worker = Thread(target=server.serve_forever, daemon=True)
    worker.start()

    def send(method, path, payload=None):
        client = HTTPConnection("127.0.0.1", server.server_port, timeout=20)
        try:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8") if payload is not None else None
            client.request(method, path, body=body, headers={"Content-Type": "application/json"} if body else {})
            response = client.getresponse()
            return response.status, json.loads(response.read())
        finally:
            client.close()

    def groups():
        params = {"account": "Names#EUW", "role": "ALL", "queue": "all", "days": "all",
                  "as_of": "2026-09-25T12:00:00Z"}
        status, payload = send("GET", "/api/friends?" + urlencode(params))
        assert status == 200, payload
        return payload["manual_groups"]

    def snapshot():
        with closing(storage.connect()) as connection:
            return {
                **archived_recent_sources(connection),
                "groups": [dict(row) for row in connection.execute("SELECT id,name FROM friend_groups ORDER BY id")],
                "aliases": [dict(row) for row in connection.execute(
                    "SELECT group_id,alias FROM friend_group_aliases ORDER BY group_id,alias")],
            }

    try:
        yield send, groups, storage, snapshot
    finally:
        server.shutdown()
        server.server_close()
        worker.join(timeout=5)


def create(send, name, alias):
    status, body = send("POST", "/api/friend-groups", {"name": name, "aliases": [alias]})
    assert status == 200, body


def assert_facts_unchanged(before, after):
    assert after["match_quality"] == before["match_quality"]
    assert after["match_import_provenance"] == before["match_import_provenance"]


@pytest.mark.parametrize("original,variant", NAME_VARIANTS)
def test_unicode_names_reuse_one_owner_and_allow_only_its_own_rename(name_http, original, variant):
    send, groups, _, snapshot = name_http
    before = snapshot()
    create(send, original, "First#EUW")
    original_group = groups()[0]

    create(send, variant, "Second#EUW")

    assert groups() == [original_group | {"aliases": ["First#EUW", "Second#EUW"]}]
    create(send, "Other", "Other#EUW")
    other = next(row for row in groups() if row["name"] == "Other")
    before_conflict = snapshot()
    status, body = send("PATCH", f"/api/friend-groups/{other['id']}", {"name": variant})
    assert status == 409 and body["error"] == "friend group name already exists"
    assert snapshot() == before_conflict

    status, renamed = send("PATCH", f"/api/friend-groups/{original_group['id']}", {"name": variant})
    assert status == 200 and renamed["id"] == original_group["id"] and renamed["name"] == variant
    after_rename = snapshot()
    create(send, original, "First#EUW")
    assert snapshot() == after_rename
    assert next(row for row in groups() if row["id"] == original_group["id"])["name"] == variant
    assert_facts_unchanged(before, snapshot())


def test_names_keep_outer_trim_internal_spaces_and_distinct_unicode_spellings(name_http):
    send, groups, _, snapshot = name_http
    before = snapshot()
    create(send, " \u00a0Team One\t ", "First#EUW")
    original = groups()[0]
    assert original["name"] == "Team One"
    create(send, " tEAM oNE\n ", "Second#EUW")
    create(send, "Team  One", "DoubleSpace#EUW")
    create(send, "Équipe", "Composed#EUW")
    create(send, "E\u0301quipe", "Decomposed#EUW")
    by_name = {row["name"]: row for row in groups()}
    assert set(by_name) == {"Team One", "Team  One", "Équipe", "E\u0301quipe"}
    assert by_name["Team One"]["id"] == original["id"]
    assert by_name["Team One"]["aliases"] == ["First#EUW", "Second#EUW"]
    assert by_name["Équipe"]["id"] != by_name["E\u0301quipe"]["id"]
    before_conflict = snapshot()
    status, _ = send("PATCH", f"/api/friend-groups/{by_name['Team  One']['id']}", {"name": "  TEAM ONE  "})
    assert status == 409 and snapshot() == before_conflict
    status, renamed = send("PATCH", f"/api/friend-groups/{original['id']}", {"name": "  tEaM OnE  "})
    assert status == 200 and renamed["name"] == "tEaM OnE"
    assert_facts_unchanged(before, snapshot())


@pytest.mark.parametrize("original,variant", NAME_VARIANTS)
def test_ambiguous_legacy_name_owners_return_conflict_without_merging(name_http, original, variant):
    send, groups, storage, snapshot = name_http
    with closing(storage.connect()) as connection:
        connection.executemany("INSERT INTO friend_groups(id,name) VALUES(?,?)", [(10, original), (20, variant), (30, "Other")])
        connection.executemany("INSERT INTO friend_group_aliases(group_id,alias) VALUES(?,?)",
                               [(10, "First#EUW"), (20, "Second#EUW"), (30, "Other#EUW")])
        connection.commit()
    before = snapshot()

    for method, path, body in (
        ("POST", "/api/friend-groups", {"name": variant, "aliases": ["New#EUW"]}),
        ("PATCH", "/api/friend-groups/10", {"name": original}),
        ("PATCH", "/api/friend-groups/30", {"name": variant}),
    ):
        status, response = send(method, path, body)
        assert status == 409 and response["error"] == "multiple friend groups use this name"
        assert snapshot() == before
    assert len(groups()) == 3


def race(send, operations):
    barrier = Barrier(len(operations))

    def perform(operation):
        barrier.wait(timeout=10)
        return send(*operation)

    with ThreadPoolExecutor(max_workers=len(operations)) as executor:
        return list(executor.map(perform, operations))


@pytest.mark.parametrize("original,variant", NAME_VARIANTS)
def test_concurrent_unicode_creates_reuse_one_name_owner(name_http, original, variant):
    send, groups, _, snapshot = name_http
    before = snapshot()

    responses = race(send, [("POST", "/api/friend-groups", {"name": name, "aliases": [alias]})
                            for name, alias in ((original, "First#EUW"), (variant, "Second#EUW"))])

    assert [status for status, _ in responses] == [200, 200]
    actual = groups()
    assert len(actual) == 1 and actual[0]["name"] in {original, variant}
    assert actual[0]["aliases"] == ["First#EUW", "Second#EUW"]
    assert_facts_unchanged(before, snapshot())


@pytest.mark.parametrize("original,variant", NAME_VARIANTS)
def test_concurrent_unicode_renames_have_one_winner_without_moving_aliases(name_http, original, variant):
    send, groups, _, snapshot = name_http
    create(send, "First", "First#EUW")
    create(send, "Second", "Second#EUW")
    old_groups = {row["name"]: row for row in groups()}
    before = snapshot()
    operations = [("PATCH", f"/api/friend-groups/{old_groups[name]['id']}", {"name": proposed})
                  for name, proposed in (("First", original), ("Second", variant))]

    responses = race(send, operations)

    assert sorted(status for status, _ in responses) == [200, 409]
    actual = {row["id"]: row for row in groups()}
    assert set(actual) == {row["id"] for row in old_groups.values()}
    for (old_name, old_group), (status, _) in zip(old_groups.items(), responses):
        expected_name = (original if old_name == "First" else variant) if status == 200 else old_name
        assert actual[old_group["id"]]["name"] == expected_name
    after = snapshot()
    assert after["aliases"] == before["aliases"]
    assert_facts_unchanged(before, after)


@pytest.mark.parametrize("original,variant", NAME_VARIANTS)
def test_concurrent_create_and_rename_share_the_same_unicode_name_lock(name_http, original, variant):
    send, groups, _, snapshot = name_http
    create(send, "Other", "Existing#EUW")
    existing = groups()[0]
    before = snapshot()

    responses = race(send, [
        ("POST", "/api/friend-groups", {"name": original, "aliases": ["New#EUW"]}),
        ("PATCH", f"/api/friend-groups/{existing['id']}", {"name": variant}),
    ])

    create_status, rename_status = [status for status, _ in responses]
    assert create_status == 200 and rename_status in {200, 409}
    actual = groups()
    assert len({row["name"].casefold() for row in actual}) == len(actual)
    owner = next(row for row in actual if row["name"].casefold() == original.casefold())
    if rename_status == 200:
        assert actual == [existing | {"name": variant, "aliases": ["Existing#EUW", "New#EUW"]}]
    else:
        assert len(actual) == 2
        assert next(row for row in actual if row["id"] == existing["id"]) == existing
        assert owner["id"] != existing["id"] and owner["aliases"] == ["New#EUW"]
    assert_facts_unchanged(before, snapshot())
