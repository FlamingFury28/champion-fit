"""Feedback timestamps survive public identity reconciliation on owned stores."""
from contextlib import closing
import json

import pytest

from account_identity import AccountIdentityConflict, reconcile_account_identity
from migrate_postgres import TABLES
from recommendation_feedback import read_feedback
from test_algorithm_settings_snapshots import settings_storage  # noqa: F401


OWNED = "owned-feedback-identity"
OTHER = "other-feedback-identity"
ALIAS = "Old#EUW"
CURRENT = "Current#EUW"
RECORDED_AT = "2026-09-01T00:00:00Z"
ALLOWED_CHANGES = {
    "recommendation_preferences", "riot_account_identities", "riot_account_aliases",
    "tracked_account_puuids", "riot_match_list_raw",
}

DATE_CASES = [
    pytest.param("2026-09-24T23:00:00+02:00", "2026-09-24T22:30:00Z", "2026-09-24T22:30:00Z", id="offset-reversal"),
    pytest.param("2026-09-24T22:30:00Z", "2026-09-24T22:30:00.100000+00:00", "2026-09-24T22:30:00.100000+00:00", id="fractional-spelling"),
    pytest.param("2026-09-24T09:00:00+00:00", "2026-09-24 10:00:00", "2026-09-24 10:00:00", id="legacy-naive-is-utc"),
    pytest.param("20260101T130000.000001+0100", "2026-W01-4T12:00:00.000002Z", "2026-W01-4T12:00:00.000002Z", id="basic-week-microsecond"),
    pytest.param("1600-01-01T13:00:00.000001+01:00", "1600-01-01T12:00:00.000002Z", "1600-01-01T12:00:00.000002Z", id="distant-exact-microsecond"),
    pytest.param("zzz-invalid", "2026-09-24T22:30:00Z", "2026-09-24T22:30:00Z", id="valid-legacy-invalid-stable"),
    pytest.param("0001-01-01T00:00:00Z", "zzz-invalid", "0001-01-01T00:00:00Z", id="minimum-valid-stable-invalid-legacy"),
    pytest.param("zzz-stable", "aaa-legacy", "zzz-stable", id="all-invalid-retains-max-raw"),
    pytest.param("2026-09-24T21:00:00Z", "2026-09-24T23:00:00+02:00", "2026-09-24T23:00:00+02:00", id="equal-instants-retain-max-raw"),
    pytest.param("2026-09-24T21:00:00Z", "2026-09-24T22:30:00Z", "2026-09-24T22:30:00Z", id="ordinary-control"),
]


def snapshot(connection):
    return {
        table: sorted((dict(row) for row in connection.execute(f"SELECT * FROM {table}")),
                      key=lambda row: json.dumps(row, sort_keys=True))
        for table in TABLES
    }


def seed(connection, stable_at, legacy_at):
    connection.executemany("INSERT INTO riot_account_identities VALUES(?,?)", [(OWNED, ALIAS), (OTHER, "Other#EUW")])
    connection.executemany("INSERT INTO riot_identity_puuids VALUES(?,?)", [("p1", OWNED), ("p2", OTHER)])
    connection.executemany("INSERT INTO tracked_account_puuids VALUES(?,?)", [("p1", ALIAS), ("p2", "Other#EUW")])
    connection.execute("INSERT INTO riot_accounts_raw VALUES(?,?,?,?,?,?)", (
        "p1", CURRENT, "Current", "EUW", RECORDED_AT, json.dumps({"puuid": "p1", "gameName": "Current", "tagLine": "EUW"}),
    ))
    connection.executemany("INSERT INTO riot_account_aliases VALUES(?,?,?,?,?,?)", [
        (ALIAS, name.casefold(), name, "p1", "riot_account_v1", RECORDED_AT) for name in (ALIAS, CURRENT)
    ])
    connection.executemany("INSERT INTO riot_match_list_raw VALUES(?,?,?,?)", [
        (name, "p1", RECORDED_AT, '["M1"]') for name in (ALIAS, CURRENT)
    ])
    connection.execute("INSERT INTO match_annotations(match_id,note,updated_at) VALUES('M1','Keep annotation',?)", (RECORDED_AT,))
    connection.execute("INSERT INTO source_metadata VALUES('owned-feedback-date-fixture','keep')")
    connection.executemany("INSERT INTO recommendation_preferences VALUES(?,?,?,?,?,?)", [
        # The representative spelling belongs to the stable identity even
        # when the legacy row supplies the most recent timestamp.
        (OWNED, ALIAS, "LeBlanc", "MIDDLE", "like", stable_at),
        (ALIAS, ALIAS, "Leblanc", "MIDDLE", "like", legacy_at),
        (OWNED, ALIAS, "Ahri", "TOP", "dislike", RECORDED_AT),
        # A later timestamp and a conflicting preference owned by somebody
        # else must neither win the date merge nor trigger a conflict.
        (OTHER, "Other#EUW", "LeBlanc", "MIDDLE", "dislike", "9999-12-31T23:59:59.999999Z"),
    ])
    connection.execute("UPDATE recommendation_feedback_state SET revision=2 WHERE singleton_id=1")
    connection.executemany("INSERT INTO recommendation_feedback_events VALUES(?,?,?)", [
        (revision, RECORDED_AT, json.dumps({"changes": [{"identity_key": identity, "requested_account": account,
          "champion": "LeBlanc", "role": "MIDDLE", "from": None, "to": preference}]}))
        for revision, identity, account, preference in ((1, OWNED, ALIAS, "like"), (2, OTHER, "Other#EUW", "dislike"))
    ])
    connection.commit()


def assert_payload(connection, expected_at):
    expected = {
        "revision": 2,
        "items": [
            {"account": CURRENT, "champion": "Ahri", "role": "TOP", "preference": "dislike", "updated_at": RECORDED_AT},
            {"account": CURRENT, "champion": "LeBlanc", "role": "MIDDLE", "preference": "like", "updated_at": expected_at},
        ],
    }
    assert read_feedback(connection, [CURRENT]) == expected
    assert read_feedback(connection, [ALIAS]) == expected
    merged = [dict(row) for row in connection.execute("SELECT * FROM recommendation_preferences WHERE identity_key=? AND role='MIDDLE'", (OWNED,))]
    assert merged == [{"identity_key": OWNED, "account": CURRENT, "champion": "LeBlanc", "role": "MIDDLE", "preference": "like", "updated_at": expected_at}]
    assert connection.execute("SELECT COUNT(*) value FROM recommendation_preferences WHERE identity_key=?", (ALIAS,)).fetchone()["value"] == 0


@pytest.mark.parametrize("stable_at,legacy_at,expected_at", DATE_CASES)
def test_public_identity_merge_keeps_the_latest_feedback_instant_and_original_spelling(
    settings_storage, stable_at, legacy_at, expected_at,
):
    with closing(settings_storage.connect()) as connection:
        seed(connection, stable_at, legacy_at)
        before = snapshot(connection)
        other_before = read_feedback(connection, ["Other#EUW"])

        assert reconcile_account_identity(connection, ALIAS, "p1", CURRENT) == CURRENT
        connection.commit()
        merged = snapshot(connection)
        assert reconcile_account_identity(connection, ALIAS, "p1", CURRENT) == CURRENT
        connection.commit()

        assert snapshot(connection) == merged
        assert {table: merged[table] for table in TABLES if table not in ALLOWED_CHANGES} == {
            table: before[table] for table in TABLES if table not in ALLOWED_CHANGES
        }
        assert read_feedback(connection, ["Other#EUW"]) == other_before
        assert [row for row in merged["recommendation_preferences"] if row["identity_key"] == OTHER] == [
            row for row in before["recommendation_preferences"] if row["identity_key"] == OTHER
        ]
        assert len(merged["recommendation_preferences"]) == 3
        assert_payload(connection, expected_at)


def test_conflicting_preferences_veto_the_whole_identity_merge_without_changing_dates(settings_storage):
    with closing(settings_storage.connect()) as connection:
        seed(connection, "2026-09-24T21:00:00Z", "2026-09-24T22:30:00Z")
        connection.execute("UPDATE recommendation_preferences SET preference='dislike' WHERE identity_key=?", (ALIAS,))
        connection.commit()
        before = snapshot(connection)
        public_before = read_feedback(connection, [ALIAS])

        with pytest.raises(AccountIdentityConflict, match="Feedback raccomandazioni discordante"):
            reconcile_account_identity(connection, ALIAS, "p1", CURRENT)

        assert snapshot(connection) == before
        assert read_feedback(connection, [ALIAS]) == public_before
        connection.rollback()
        with closing(settings_storage.connect()) as observer:
            assert snapshot(observer) == before


def test_feedback_date_merge_remains_inside_the_callers_transaction(settings_storage):
    expected_at = "2026-09-24T22:30:00Z"
    with closing(settings_storage.connect()) as connection:
        seed(connection, "2026-09-24T21:00:00Z", expected_at)
        before = snapshot(connection)
        if settings_storage.engine == "sqlite":
            connection.execute("BEGIN")
        connection.execute("INSERT INTO source_metadata VALUES('caller-owned','uncommitted')")

        assert reconcile_account_identity(connection, ALIAS, "p1", CURRENT) == CURRENT
        assert_payload(connection, expected_at)
        with closing(settings_storage.connect()) as observer:
            assert snapshot(observer) == before

        connection.rollback()
        assert snapshot(connection) == before
        with closing(settings_storage.connect()) as observer:
            assert snapshot(observer) == before
