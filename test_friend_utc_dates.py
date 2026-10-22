"""Friends dates and evidence cutoffs follow UTC without rewriting the archive."""
from contextlib import closing
import uuid

import pytest

import app
from analysis_runtime import parse_time
from ingest import ingest_rows
from migrate_postgres import migrate
from storage import SQLiteStorage
from test_postgres_api import postgres_api_fixture  # noqa: F401
from test_recent_match_ordering import archived_recent_sources


@pytest.fixture(params=["sqlite", "postgres"])
def friends_source(request, tmp_path, monkeypatch):
    source = SQLiteStorage(tmp_path / "friend-utc.db", app.SCHEMA_PATH)
    source.initialize()
    prefix = uuid.uuid4().hex
    account = f"FriendUtc-{prefix}#EUW"

    def activate(rows):
        ids = {key: f"{prefix}-{key}" for key, _, _ in rows}
        owner = f"{prefix}-owner"
        base = {"account": account, "patch": "16.19", "queue": "420", "champion": "Lux",
                "role": "MIDDLE", "duration_minutes": 30, "win": True}
        with closing(source.connect()) as connection, connection:
            ingest_rows(connection, [base | {"match_id": ids[key], "date": date}
                                     for key, date, _ in rows], "synthetic Friends UTC dates")
            connection.execute("INSERT INTO tracked_account_puuids(puuid,account) VALUES(?,?)", (owner, account))
            for key, _, friend in rows:
                participants = [(ids[key], owner, account, "Lux", 1, 100)]
                if friend:
                    participants.append((ids[key], f"{prefix}-{friend}", friend, "Leona", 1, 100))
                connection.executemany(
                    "INSERT INTO match_participants(match_id,puuid,riot_id,champion,win,team_id) VALUES(?,?,?,?,?,?)",
                    participants,
                )
        storage = source
        if request.param == "postgres":
            _, storage, _ = request.getfixturevalue("postgres_api_fixture")
            migrate(source.path, storage.dsn)
        monkeypatch.setattr(app, "STORAGE", storage)
        monkeypatch.setattr(app, "DB_PATH", source.path)
        monkeypatch.setattr(app, "APP_ROOT", tmp_path)

        def snapshot():
            with closing(storage.connect()) as connection:
                result = archived_recent_sources(connection)
                result["match_participants"] = [dict(row) for row in connection.execute(
                    "SELECT * FROM match_participants ORDER BY match_id,puuid"
                )]
                return result

        before = snapshot()

        def query(**additional):
            params = {"account": account, "role": "MIDDLE", "queue": "420", "days": "all",
                      "as_of": "2026-09-26T12:00:00Z", "min_shared_games": "1"} | additional
            status, payload = app.query_database("/api/friends", {key: [value] for key, value in params.items()})
            assert status == 200, payload
            return payload

        def assert_source_unchanged():
            assert snapshot() == before

        return query, ids, assert_source_unchanged

    return activate


def canonical(value):
    return parse_time(value).isoformat(timespec="microseconds")


def test_friends_extrema_and_sort_use_real_utc_instants(friends_source):
    rows = [
        ("history-old", "20260101T120000Z", "History#EUW"),
        ("history-new", "2026-W37-4T12:00:00Z", "History#EUW"),
        ("recent", "2026-09-19T23:30:00-02:00", "Recent#EUW"),
        ("offset", "2026-09-20T00:30:00+02:00", "Offset#EUW"),
        ("old-only", "20260102T120000Z", "Old#EUW"),
    ]
    query, _, assert_source_unchanged = friends_source(rows)

    descending = query(sort="last_game:desc")["items"]
    ascending = query(sort="last_game:asc")["items"]

    names = ["Recent#EUW", "Offset#EUW", "History#EUW", "Old#EUW"]
    assert [item["friend"] for item in descending] == names
    assert [item["friend"] for item in ascending] == names[::-1]
    dates = {friend: [date for _, date, name in rows if name == friend] for friend in names}
    for item in descending:
        ordered = sorted(dates[item["friend"]], key=parse_time)
        assert item["first_game"] == canonical(ordered[0])
        assert item["last_game"] == canonical(ordered[-1])
        assert "date_utc" not in item and "_analysis_utc_order" not in item
    assert_source_unchanged()


FILTER_ROWS = [
    ("history-old", "20260101T120000Z", "History#EUW"),
    ("history-new", "2026-09-10T12:00:00Z", "History#EUW"),
    ("old-only", "20260102T120000Z", "Old#EUW"),
    ("before", "2026-09-01T00:30:00+02:00", "Before#EUW"),
    ("after", "2026-08-31T23:30:00-02:00", "After#EUW"),
    ("week", "2026-W39-4T12:00:00Z", "Week#EUW"),
    ("reference-after", "2026-08-31T22:00:00-03:00", None),
    ("reference-before", "2026-09-01T00:15:00+03:00", None),
    ("reference-old", "20260201T120000Z", None),
]


@pytest.mark.parametrize("parameter", ["games_from", "last_game_from"])
@pytest.mark.parametrize("cutoff", ["2026-09-01", "20260901", "2026-W36-2"])
def test_friends_cutoffs_use_utc_for_candidates_and_reference(friends_source, parameter, cutoff):
    query, ids, assert_source_unchanged = friends_source(FILTER_ROWS)

    payload = query(**{parameter: cutoff})

    items = {item["friend"]: item for item in payload["items"]}
    assert set(items) == {"History#EUW", "After#EUW", "Week#EUW"}
    filtered = parameter == "games_from"
    local_ids = {
        "History#EUW": {ids["history-new"]} | (set() if filtered else {ids["history-old"]}),
        "After#EUW": {ids["after"]},
        "Week#EUW": {ids["week"]},
    }
    expected_scope = ({ids[key] for key in ("history-new", "after", "week", "reference-after")}
                      if filtered else set(ids.values()))
    for friend, item in items.items():
        assert item["shared_games"] == len(local_ids[friend])
        assert set(item["local_match_ids"]) == local_ids[friend]
        assert set(item["baseline_match_ids"]) == expected_scope - local_ids[friend]
    assert items["History#EUW"]["first_game"] == canonical(
        "2026-09-10T12:00:00Z" if filtered else "20260101T120000Z"
    )
    assert items["After#EUW"]["last_game"] == "2026-09-01T01:30:00.000000+00:00"
    assert_source_unchanged()
