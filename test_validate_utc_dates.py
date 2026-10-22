"""Temporal validators use UTC instants without mutating archived source dates."""
from contextlib import closing
from datetime import datetime, timezone
import sqlite3

import pytest

import validate_algorithm_settings as algorithm
import validate_preferences as preferences


LOADERS = (algorithm.load_observations, preferences.load_observations)
UTC = timezone.utc


def match(account, match_id, date, **changes):
    return {
        "account": account, "match_id": match_id, "date": date,
        "patch": "16.19", "queue": "420", "champion": "Ahri",
        "role": "MIDDLE", "duration_minutes": 30, "win": 1,
    } | changes


@pytest.fixture
def database(tmp_path):
    paths = []

    def create(rows, *, identities=(), aliases=(), exceptions=()):
        path = tmp_path / f"dates-{len(paths)}.db"
        with closing(sqlite3.connect(path)) as connection, connection:
            connection.executescript("""
                CREATE TABLE match_quality(
                    id INTEGER PRIMARY KEY, account TEXT, match_id TEXT, date TEXT,
                    patch TEXT, queue TEXT, champion TEXT, role TEXT,
                    duration_minutes REAL, win INTEGER
                );
                CREATE TABLE riot_account_identities(identity_id TEXT, account TEXT);
                CREATE TABLE riot_identity_puuids(puuid TEXT, identity_id TEXT);
                CREATE TABLE riot_account_aliases(
                    account TEXT, display_riot_id TEXT, normalized_riot_id TEXT, puuid TEXT
                );
                CREATE TABLE riot_identity_policy(identity_id TEXT, state TEXT);
                CREATE TABLE riot_match_raw(match_id TEXT, payload_json TEXT);
                INSERT INTO riot_match_raw VALUES('untouched','{"synthetic":true}');
            """)
            connection.executemany(
                "INSERT INTO match_quality(account,match_id,date,patch,queue,champion,"
                "role,duration_minutes,win) VALUES(:account,:match_id,:date,:patch,"
                ":queue,:champion,:role,:duration_minutes,:win)", rows,
            )
            connection.executemany(
                "INSERT INTO riot_account_identities VALUES(?,?)", identities,
            )
            for account, identity in aliases:
                puuid = f"synthetic-{identity}"
                connection.execute(
                    "INSERT INTO riot_identity_puuids VALUES(?,?)", (puuid, identity),
                )
                connection.execute(
                    "INSERT INTO riot_account_aliases VALUES(?,?,?,?)",
                    (account, account, account.lower(), puuid),
                )
            connection.executemany(
                "INSERT INTO riot_identity_policy VALUES(?,'exception')",
                [(identity,) for identity in exceptions],
            )
        paths.append((path, path.read_bytes()))
        return path

    yield create
    for path, before in paths:
        assert path.read_bytes() == before, "a read-only validator changed its input"


@pytest.mark.parametrize("load", LOADERS, ids=("algorithm", "preferences"))
@pytest.mark.parametrize("earliest,later", [
    ("2026-09-25T00:30:00+14:00", "2026-09-24T23:00:00-10:00"),
    ("20260924T103000Z", "2026-09-25T09:00:00Z"),
    ("2026-W39-4T10:30:00Z", "2026-09-25T09:00:00Z"),
    ("2026-09-24T10:30:00", "2026-09-25T09:00:00Z"),
], ids=("offset-reversal", "compact", "week", "naive-is-utc"))
def test_shared_match_uses_earliest_utc_before_temporal_ordering(database, load, earliest, later):
    path = database([
        match("Beta#EUW", "shared", later),
        match("Alpha#EUW", "middle", "2026-09-24T20:00:00Z"),
        match("Alpha#EUW", "shared", earliest),
    ])

    rows, metadata = load(path)

    assert [row.match_id for row in rows] == ["shared", "shared", "middle"]
    shared = [row for row in rows if row.match_id == "shared"]
    assert {row.account for row in shared} == {"Alpha#EUW", "Beta#EUW"}
    assert {row.occurred_at for row in shared} == {datetime(2026, 9, 24, 10, 30, tzinfo=UTC)}
    assert rows[-1].occurred_at == datetime(2026, 9, 24, 20, tzinfo=UTC)
    assert metadata["unique_matches"] == 2
    assert metadata["raw_json_tables_read"] is False


@pytest.mark.parametrize("load", LOADERS, ids=("algorithm", "preferences"))
def test_distinct_matches_use_utc_and_preserve_microsecond_precision_and_ties(database, load):
    path = database([
        match("Alpha#EUW", "later", "2026-09-24T10:30:00.000500Z"),
        match("Alpha#EUW", "equal-b", "2026-09-24T12:30:00.000499+02:00"),
        match("Alpha#EUW", "equal-a", "20260924T103000.0004999Z"),
    ])

    rows, _ = load(path)

    assert [row.match_id for row in rows] == ["equal-a", "equal-b", "later"]
    assert [row.occurred_at.microsecond for row in rows] == [499, 499, 500]


@pytest.mark.parametrize("load", LOADERS, ids=("algorithm", "preferences"))
def test_global_timestamp_still_includes_sources_from_excluded_contexts(database, load):
    path = database([
        match("Alpha#EUW", "shared", "2026-09-25T09:00:00Z"),
        match("OtherQueue#EUW", "shared", "20260924T103000Z", queue="450"),
        match("OtherRole#EUW", "shared", "2026-W39-4T09:30:00Z", role="INVALID"),
        match("Blocked#EUW", "shared", "2026-09-24T11:00:00+02:00"),
        match("OtherQueue#EUW", "ignored-queue", "bad-date", queue="450"),
        match("OtherRole#EUW", "ignored-role", "bad-date", role="INVALID"),
    ], identities=[("blocked", "Blocked#EUW")], exceptions=["blocked"])

    rows, metadata = load(path)

    assert [(row.account, row.match_id, row.occurred_at) for row in rows] == [
        ("Alpha#EUW", "shared", datetime(2026, 9, 24, 9, tzinfo=UTC)),
    ]
    assert metadata.get("exception_observations_excluded", metadata.get("exception_source_rows_excluded")) == 1
    if load is preferences.load_observations:
        assert metadata["unsupported_context_rows_excluded"] == 4


@pytest.mark.parametrize("invalid", ["", "not-a-date", "2026-02-30T12:00:00Z", "2026-09-24T12:00:00+24:00"])
def test_algorithm_rejects_invalid_eligible_match_instead_of_inventing_a_time(database, invalid):
    path = database([match("Alpha#EUW", "invalid", invalid)])

    with pytest.raises(ValueError):
        algorithm.load_observations(path)


@pytest.mark.parametrize("invalid", ["", "not-a-date"])
def test_algorithm_does_not_hide_invalid_source_behind_valid_shared_match_date(database, invalid):
    path = database([
        match("Alpha#EUW", "shared", "2026-09-24T10:30:00Z"),
        match("Beta#EUW", "shared", invalid),
    ])

    with pytest.raises(ValueError):
        algorithm.load_observations(path)


@pytest.mark.parametrize("invalid", ["", "not-a-date", "2026-02-30T12:00:00Z", "2026-09-24T12:00:00+24:00"])
def test_preferences_excludes_invalid_source_without_discarding_valid_shared_observation(database, invalid):
    path = database([
        match("Alpha#EUW", "shared", "2026-09-24T10:30:00Z"),
        match("Beta#EUW", "shared", invalid),
        match("Alpha#EUW", "invalid-only", invalid),
    ])

    rows, metadata = preferences.load_observations(path)

    assert [(row.account, row.match_id) for row in rows] == [("Alpha#EUW", "shared")]
    assert rows[0].occurred_at == datetime(2026, 9, 24, 10, 30, tzinfo=UTC)
    assert metadata["unsupported_context_rows_excluded"] == 2


def test_preferences_keeps_identity_deduplication_and_conflict_exclusion(database):
    path = database([
        match("Alpha#EUW", "duplicate", "2026-09-25T09:00:00Z"),
        match("OldAlpha#EUW", "duplicate", "2026-W39-4T10:30:00Z"),
        match("Alpha#EUW", "conflict", "20260924T110000Z"),
        match("OldAlpha#EUW", "conflict", "2026-09-24T13:00:00+02:00", champion="Lux"),
    ], identities=[("alpha", "Alpha#EUW")], aliases=[("OldAlpha#EUW", "alpha")])

    rows, metadata = preferences.load_observations(path)

    assert [(row.account, row.match_id) for row in rows] == [("Alpha#EUW", "duplicate")]
    assert rows[0].occurred_at == datetime(2026, 9, 24, 10, 30, tzinfo=UTC)
    assert metadata["duplicate_source_rows_collapsed"] == 1
    assert metadata["conflicting_account_match_groups_excluded"] == 1


def test_algorithm_keeps_duplicate_account_match_rejection(database):
    path = database([
        match("Alpha#EUW", "duplicate", "20260924T103000Z"),
        match("Alpha#EUW", "duplicate", "2026-W39-4T12:30:00+02:00"),
    ])

    with pytest.raises(ValueError, match="duplicate account/match"):
        algorithm.load_observations(path)


@pytest.mark.parametrize("load", LOADERS, ids=("algorithm", "preferences"))
def test_logical_digest_is_stable_across_equivalent_date_formats_and_source_order(database, load):
    raw = [
        match("Alpha#EUW", "shared", "2026-09-25T00:30:00+14:00"),
        match("Beta#EUW", "shared", "2026-W39-5T09:00:00Z"),
        match("Alpha#EUW", "middle", "20260924T200000Z"),
    ]
    canonical = [
        raw[2] | {"date": "2026-09-24T20:00:00.000000+00:00"},
        raw[1] | {"date": "2026-09-25T09:00:00.000000+00:00"},
        raw[0] | {"date": "2026-09-24T10:30:00.000000+00:00"},
    ]

    raw_rows, raw_metadata = load(database(raw))
    canonical_rows, canonical_metadata = load(database(canonical))

    assert raw_rows == canonical_rows
    assert raw_metadata["logical_input_sha256"] == canonical_metadata["logical_input_sha256"]


def test_algorithm_replay_keeps_shared_match_before_holdout_boundary(database):
    path = database([
        match("Alpha#EUW", "shared", "2026-09-25T00:30:00+14:00"),
        match("Beta#EUW", "shared", "2026-09-24T23:00:00-10:00"),
        match("Alpha#EUW", "middle", "2026-09-24T20:00:00Z"),
        match("Alpha#EUW", "target", "2026-09-25T10:00:00Z"),
    ])
    rows, _ = algorithm.load_observations(path)

    replay = algorithm.replay_fold(
        rows,
        algorithm.FoldSpec("boundary", datetime(2026, 9, 25, tzinfo=UTC), datetime(2026, 9, 26, tzinfo=UTC)),
        lookback_days=180, embargo_hours=0, prior_strengths=(8.0,),
    )

    assert [row.match_id for row in replay["training"]] == ["shared", "shared", "middle"]
    assert [row.match_id for row in replay["holdout"]] == ["target"]
    assert replay["predictions"][0]["champion_history_games"] == 2


def test_preferences_replay_targets_the_next_utc_match_after_frozen_prefix(database):
    path = database([
        match("Alpha#EUW", "shared", "2026-09-25T00:30:00+14:00"),
        match("Beta#EUW", "shared", "2026-09-24T23:00:00-10:00"),
        match("Alpha#EUW", "middle", "2026-09-24T20:00:00Z"),
        match("Alpha#EUW", "last", "2026-09-25T10:00:00Z"),
    ])
    rows, _ = preferences.load_observations(path)
    histories = []

    def builder(rows, lifetime_rows, accounts, role, **kwargs):
        histories.append(rows)
        return {
            "profile": [], "known": [{"champion": "Ahri", "performance": None}],
            "discover": [], "trial_plan": {"budget": 0, "items": []},
        }

    events, metadata = preferences.replay_preferences(rows, builder=builder, prefixes=(1,))

    assert [event["target_match_id"] for event in events] == ["middle"]
    assert events[0]["target_time"] == "2026-09-24T20:00:00+00:00"
    assert [row["match_id"] for row in histories[0]] == ["shared"]
    assert histories[0][0]["date"] == "2026-09-24T10:30:00+00:00"
    assert metadata["contract_errors"] == {}
