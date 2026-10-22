"""Accepted ISO date spellings must select the same Friends evidence."""
import pytest

import app
from test_identity_friends import identity_db, add_match, participant


DATE_FILTERS = [
    (app.friend_games_from, "games_from"),
    (app.friend_last_game_from, "last_game_from"),
]


@pytest.mark.parametrize("parser,parameter", DATE_FILTERS)
@pytest.mark.parametrize("value", ["2026-01-01", "20260101", "2026-W01-4", " 20260101 "])
def test_friend_dates_normalize_accepted_iso_formats(parser, parameter, value):
    assert parser({parameter: [value]}) == "2026-01-01"


@pytest.mark.parametrize("parser,parameter", DATE_FILTERS)
@pytest.mark.parametrize("value", ["", "invalid", "2026-02-30", "2026-W54-1", "2026-01-01T00:00:00"])
def test_friend_dates_keep_invalid_input_unfiltered(parser, parameter, value):
    assert parser({parameter: [value]}) == ""


@pytest.mark.parametrize("parser,parameter", DATE_FILTERS)
def test_friend_dates_keep_missing_input_unfiltered(parser, parameter):
    assert parser({}) == ""


@pytest.mark.parametrize("parameter", ["games_from", "last_game_from"])
@pytest.mark.parametrize("alternate", ["20260101", "2026-W01-4"])
def test_friend_query_uses_equivalent_iso_date_filters(identity_db, parameter, alternate):
    connection, _ = identity_db
    connection.execute("INSERT INTO tracked_account_puuids(puuid,account) VALUES('owner','Player#EUW')")
    for match_id, date, friend in [
        ("older", "2025-12-31T12:00:00Z", "Current"),
        ("latest", "2026-09-01T12:00:00Z", "Current"),
        ("old-friend", "2025-12-31T12:00:00Z", "Old"),
    ]:
        add_match(connection, match_id)
        connection.execute("UPDATE match_quality SET date=? WHERE match_id=?", (date, match_id))
        participant(connection, match_id, "owner", "Player#EUW", "Ahri")
        participant(connection, match_id, friend, f"{friend}#EUW", "Leona")
    connection.commit()
    params = {"account": ["Player#EUW"], "min_shared_games": ["1"],
              "queue": ["420"], "days": ["all"]}
    status, expected = app.query_database("/api/friends", params | {parameter: ["2026-01-01"]})
    assert status == 200
    assert [(item["friend"], item["shared_games"]) for item in expected["items"]] == [
        ("Current#EUW", 1 if parameter == "games_from" else 2),
    ]

    status, actual = app.query_database("/api/friends", params | {parameter: [alternate]})
    assert status == 200
    assert actual == expected
