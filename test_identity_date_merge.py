"""Account merges select exact UTC instants on disposable SQLite/PG stores."""
from contextlib import closing
from dataclasses import dataclass
import json

import pytest

from account_identity import canonical_account_name, reconcile_account_identity
from check_new_matches import _retry_detail_ids
from riot_sync import identity_evidence
from test_algorithm_settings_snapshots import settings_storage  # noqa: F401


CANONICAL = "Current#EUW"
ALIAS = "Old#EUW"
VERIFIED_AT = "2026-10-01T00:00:00Z"
TABLES = (
    "riot_account_identities", "riot_identity_puuids", "riot_account_aliases",
    "tracked_account_puuids", "riot_accounts_raw", "riot_match_raw",
    "riot_match_list_raw", "riot_match_materialization", "match_quality",
    "match_annotations", "match_import_provenance", "source_metadata",
    "algorithm_settings_revisions", "algorithm_settings_state",
    "recommendation_preferences", "recommendation_feedback_state", "recommendation_feedback_events",
)
PROTECTED = (
    "riot_match_raw", "match_quality", "match_annotations", "match_import_provenance", "source_metadata",
    "algorithm_settings_revisions", "algorithm_settings_state",
    "recommendation_preferences", "recommendation_feedback_state", "recommendation_feedback_events",
)


@dataclass(frozen=True)
class ArchivedRow:
    account: str
    attempted_at: str
    fetched_at: str
    attempts: int


@dataclass(frozen=True)
class MergeCase:
    rows: tuple[ArchivedRow, ...]
    state_order: tuple[str, ...]
    list_order: tuple[str, ...]


def pair(alias_at, canonical_at, winner, *, list_alias_at=None, list_canonical_at=None, list_winner=None):
    other = CANONICAL if winner == ALIAS else ALIAS
    list_winner = list_winner or winner
    list_other = CANONICAL if list_winner == ALIAS else ALIAS
    return MergeCase(
        rows=(
            ArchivedRow(ALIAS, alias_at, list_alias_at or alias_at, 2),
            ArchivedRow(CANONICAL, canonical_at, list_canonical_at or canonical_at, 3),
        ),
        state_order=(winner, other), list_order=(list_winner, list_other),
    )


CASES = [
    pytest.param(pair(
        "2026-09-24T23:00:00+02:00", "2026-09-24T22:30:00Z", CANONICAL,
        list_alias_at="2026-09-24T22:30:00Z", list_canonical_at="2026-09-24T23:00:00+02:00", list_winner=ALIAS,
    ), id="offsets-and-independent-fields"),
    pytest.param(pair("2026-09-24T22:30:00Z", "2026-09-24T22:30:00.100000+00:00", CANONICAL), id="fractional-spelling"),
    pytest.param(pair("20260101T130000.000001+0100", "2026-W01-4T12:00:00.000002Z", CANONICAL), id="compact-and-week-dates"),
    pytest.param(pair("1600-01-01T12:00:00.000002Z", "1600-01-01T12:00:00.000001Z", ALIAS), id="newer-alias-distant-microseconds"),
    pytest.param(pair("2026-09-24T21:00:00Z", "zzz-invalid", ALIAS), id="valid-alias-invalid-canonical"),
    pytest.param(pair("zzz-invalid", "2026-09-24T21:00:00Z", CANONICAL), id="invalid-alias-valid-canonical"),
    pytest.param(pair("2026-09-24T23:00:00+02:00", "2026-09-24T21:00:00Z", CANONICAL), id="equal-instant-canonical-first"),
    pytest.param(pair("zzz-invalid", "bad", CANONICAL), id="all-invalid-canonical-first"),
    pytest.param(MergeCase(
        rows=(
            ArchivedRow("Zebra#EUW", "2026-09-24T23:00:00+02:00", "2026-09-24T23:00:00+02:00", 2),
            ArchivedRow(CANONICAL, "zzz-invalid", "zzz-invalid", 3),
            ArchivedRow("Alpha#EUW", "2026-09-24T21:00:00Z", "2026-09-24T21:00:00Z", 4),
        ),
        state_order=("Alpha#EUW", "Zebra#EUW", CANONICAL),
        list_order=("Alpha#EUW", "Zebra#EUW", CANONICAL),
    ), id="equal-aliases-use-account-order"),
]


def snapshot(connection):
    return {table: [dict(row) for row in connection.execute(f"SELECT * FROM {table} ORDER BY 1,2")]
            for table in TABLES}


def seed(connection, case):
    first_alias = case.rows[0].account
    assert first_alias != CANONICAL
    connection.execute("INSERT INTO riot_account_identities VALUES(?,?)", ("owned-identity", first_alias))
    connection.execute("INSERT INTO riot_identity_puuids VALUES('p1','owned-identity')")
    connection.execute("INSERT INTO tracked_account_puuids VALUES('p1',?)", (first_alias,))
    connection.execute("INSERT INTO riot_accounts_raw VALUES(?,?,?,?,?,?)", (
        "p1", CANONICAL, "Current", "EUW", VERIFIED_AT,
        json.dumps({"puuid": "p1", "gameName": "Current", "tagLine": "EUW"}),
    ))
    for row in case.rows:
        connection.execute("INSERT INTO riot_account_aliases VALUES(?,?,?,?,?,?)", (
            first_alias, row.account.casefold(), row.account, "p1", "riot_account_v1", VERIFIED_AT,
        ))
        # Every source list has duplicates and overlaps. Their union must keep
        # first encounters from the selected list order, without dropping IDs.
        ids = ["M1", "SHARED", f"ONLY-{row.account}", "M1"]
        connection.execute("INSERT INTO riot_match_list_raw VALUES(?,?,?,?)", (
            row.account, "p1", row.fetched_at, json.dumps(ids),
        ))
        selected = row.account == case.state_order[0]
        connection.execute("INSERT INTO riot_match_materialization VALUES(?,?,?,?,?,?,?,?)", (
            row.account, "M1", "invalid_payload" if selected else "unsupported_queue",
            "missing_participants" if selected else f"terminal:{row.account}",
            "" if selected else "puuid_exact", "" if selected else "p1", row.attempts, row.attempted_at,
        ))
    # info is present but incomplete, so only the durable invalid_payload state
    # can distinguish a required provider refetch from a terminal result.
    connection.execute("INSERT INTO riot_match_raw VALUES(?,?,?,?)", (
        "M1", "europe", VERIFIED_AT, json.dumps({"info": {"gameId": 1}}),
    ))
    connection.execute("INSERT INTO match_annotations(match_id,note,updated_at) VALUES('M1','Preserve this note',?)", (VERIFIED_AT,))
    connection.execute("INSERT INTO source_metadata VALUES('owned-fixture','keep')")
    connection.commit()
    assert identity_evidence(connection, first_alias, "p1").puuids == frozenset({"p1"})


def assert_selection(connection, case, source):
    states = [dict(row) for row in connection.execute("SELECT * FROM riot_match_materialization")]
    lists = [dict(row) for row in connection.execute("SELECT * FROM riot_match_list_raw")]
    state_source = next(row for row in source["riot_match_materialization"] if row["account"] == case.state_order[0])
    list_source = next(row for row in source["riot_match_list_raw"] if row["account"] == case.list_order[0])
    expected_ids = list(dict.fromkeys(
        match_id
        for account in case.list_order
        for row in source["riot_match_list_raw"] if row["account"] == account
        for match_id in json.loads(row["match_ids_json"])
    ))
    expected_state = state_source | {"account": CANONICAL, "attempts": sum(row.attempts for row in case.rows)}
    assert states == [expected_state]
    assert len(lists) == 1
    assert lists[0]["account"] == CANONICAL
    assert lists[0]["puuid"] == "p1"
    assert lists[0]["fetched_at"] == list_source["fetched_at"]
    assert json.loads(lists[0]["match_ids_json"]) == expected_ids
    assert _retry_detail_ids(connection, {"M1"}, CANONICAL, "p1") == (["M1"], ["M1"])


@pytest.mark.parametrize("case", CASES)
def test_merge_uses_exact_utc_order_and_is_idempotent(settings_storage, case):
    with closing(settings_storage.connect()) as connection:
        seed(connection, case)
        source = snapshot(connection)

        assert reconcile_account_identity(connection, case.rows[0].account, "p1", CANONICAL) == CANONICAL
        connection.commit()
        merged = snapshot(connection)
        assert canonical_account_name(connection, case.rows[0].account) == CANONICAL
        assert identity_evidence(connection, CANONICAL, "p1").puuids == frozenset({"p1"})

        # A repeated real merge cannot add attempts twice or reorder the union.
        assert reconcile_account_identity(connection, case.rows[0].account, "p1", CANONICAL) == CANONICAL
        connection.commit()
        assert snapshot(connection) == merged
        assert {table: merged[table] for table in PROTECTED} == {table: source[table] for table in PROTECTED}
        assert_selection(connection, case, source)


def test_merge_leaves_its_changes_in_the_callers_rollback(settings_storage):
    case = pair("2026-09-24T20:00:00Z", "2026-09-24T21:00:00Z", CANONICAL)
    with closing(settings_storage.connect()) as connection:
        seed(connection, case)
        source = snapshot(connection)
        if settings_storage.engine == "sqlite":
            connection.execute("BEGIN")
        connection.execute("INSERT INTO source_metadata VALUES('caller-owned','uncommitted')")

        assert reconcile_account_identity(connection, ALIAS, "p1", CANONICAL) == CANONICAL
        assert_selection(connection, case, source)
        with closing(settings_storage.connect()) as observer:
            assert snapshot(observer) == source

        connection.rollback()
        assert snapshot(connection) == source
        with closing(settings_storage.connect()) as observer:
            assert snapshot(observer) == source
