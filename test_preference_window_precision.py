"""Public preference windows use instants independently of timestamp spelling."""
from copy import deepcopy

import pytest

from preference_recommendations import build_recommendations


CATALOG = {
    "version": "owned-memory", "source_version": "owned-memory",
    "categories": [{"id": "old-style", "label": "Old style"}, {"id": "new-style", "label": "New style"}],
    "champions": [
        {"id": "OlderPick", "name": "Older pick", "classes": ["old-style"], "tags": [], "roles": ["MIDDLE"]},
        {"id": "NewerPick", "name": "Newer pick", "classes": ["new-style"], "tags": [], "roles": ["MIDDLE"]},
        {"id": "OlderNeighbor", "name": "Older neighbor", "classes": ["old-style"], "tags": [], "roles": ["MIDDLE"]},
        {"id": "NewerNeighbor", "name": "Newer neighbor", "classes": ["new-style"], "tags": [], "roles": ["MIDDLE"]},
    ],
}


def observations(older_date, newer_date):
    return [
        {"account": "Owned#EUW", "match_id": "a-low", "champion": "OlderPick", "date": older_date,
         "role": "MIDDLE", "queue": "420", "win": 1, "duration_minutes": 30},
        {"account": "Owned#EUW", "match_id": "z-high", "champion": "NewerPick", "date": newer_date,
         "role": "MIDDLE", "queue": "420", "win": 1, "duration_minutes": 30},
    ]


def build(rows, *, recent_games=1, ranking_scope_rows=None):
    lifetime = deepcopy(rows if ranking_scope_rows is None else ranking_scope_rows)
    accounts, feedback, catalog = ["Owned#EUW"], [], deepcopy(CATALOG)
    inputs = (rows, lifetime, accounts, feedback, catalog, ranking_scope_rows)
    before = deepcopy(inputs)
    try:
        return build_recommendations(
            rows, lifetime, accounts, "MIDDLE", recent_games=recent_games,
            catalog=catalog, feedback=feedback, include_performance=False,
            ranking_scope_rows=ranking_scope_rows, trial_budget=3,
        )
    finally:
        assert inputs == before


def behavior(payload):
    # Explanation dates deliberately retain the archived spelling. Compare the
    # resulting decisions independently of those original-date explanations.
    return {
        "profile": payload["profile"],
        "known": [(item["champion"], item["preference_score"], item["games"]) for item in payload["known"]],
        "discover": [(item["champion"], item["similarity"], item.get("priority_score"), item["source_champions"])
                     for item in payload["discover"]],
        "trial_plan": payload["trial_plan"],
        "coverage": payload["coverage"],
    }


def assert_original_dates(payload, rows):
    for row in rows:
        if row["date"] == "zz-invalid":
            continue
        item = next(item for item in payload["known"] if item["champion"] == row["champion"])
        assert f"Ultima partita: {row['date']}." in item["reasons"]


def assert_newer_preference(payload, *, ranking_scope=False):
    assert payload["profile"] == [{"tag": "new-style", "label": "New style", "games": 1, "accounts": 1, "share": 1.0}]
    assert [(item["champion"], item["preference_score"], item["games"]) for item in payload["known"]] == [
        ("NewerPick", 1.0, 1), ("OlderPick", 0.0, 1),
    ]
    assert [(item["champion"], item["similarity"]) for item in payload["discover"]] == [("NewerNeighbor", 1.0)]
    discovery = payload["discover"][0]
    assert [(source["champion"], source["games"], source["source_kind"]) for source in discovery["source_champions"]] == [
        ("NewerPick", 1, "observed_frequency"),
    ]
    if ranking_scope:
        assert discovery["priority_score"] == 1.0
    assert payload["trial_plan"]["budget"] == 2
    assert [(item["champion"], item["role"], item["games"]) for item in payload["trial_plan"]["items"]] == [
        ("NewerPick", "MIDDLE", 1), ("NewerNeighbor", "MIDDLE", 1),
    ]
    assert payload["coverage"]["games"] == payload["coverage"]["observations"] == 2
    assert payload["coverage"]["preference_observations"] == 1
    assert all(item["performance"] is None for item in payload["known"])


@pytest.mark.parametrize("older,newer,utc_older,utc_newer", [
    pytest.param(
        "1600-01-01T13:00:00.000001+01:00", "1600-01-01T12:00:00.000002Z",
        "1600-01-01T12:00:00.000001+00:00", "1600-01-01T12:00:00.000002+00:00",
        id="distant-microsecond-offset",
    ),
    pytest.param(
        "2026-09-24T13:00:00+01:00", "2026-09-24T12:00:00Z",
        "2026-09-24T12:00:00+00:00", "2026-09-24T12:00:00+00:00",
        id="equal-instant-highest-match-id",
    ),
    pytest.param(
        "20260101T130000.000001+0100", "2026-W01-4T12:00:00.000002Z",
        "2026-01-01T12:00:00.000001+00:00", "2026-01-01T12:00:00.000002+00:00",
        id="compact-week-microsecond",
    ),
    pytest.param(
        "zz-invalid", "0001-01-01T00:00:00Z", "zz-invalid", "0001-01-01T00:00:00+00:00",
        id="minimum-year-before-invalid-sentinel",
    ),
])
def test_one_game_window_is_independent_of_date_spelling(older, newer, utc_older, utc_newer):
    raw = observations(older, newer)
    canonical = observations(utc_older, utc_newer)

    actual, control = build(raw), build(canonical)

    assert_original_dates(actual, raw)
    assert_original_dates(control, canonical)
    assert_newer_preference(control)
    assert_newer_preference(actual)
    assert behavior(actual) == behavior(control)


def test_ranking_scope_window_preserves_microseconds_before_selecting_context_rows():
    rows = observations("1600-01-01T13:00:00.000001+01:00", "1600-01-01T12:00:00.000002Z")
    outside_role = rows[0] | {"match_id": "outside-role", "role": "TOP", "date": "1599-12-31T12:00:00Z"}
    ranking_rows = [rows[1], outside_role, rows[0]]

    payload = build(rows, ranking_scope_rows=ranking_rows)

    assert_original_dates(payload, rows)
    assert_newer_preference(payload, ranking_scope=True)


def test_ordinary_2026_microsecond_window_keeps_the_existing_selection():
    rows = observations("2026-09-24T13:00:00.000001+01:00", "2026-09-24T12:00:00.000002Z")

    payload = build(rows)

    assert_original_dates(payload, rows)
    assert_newer_preference(payload)


def test_unlimited_window_retains_both_preferences_independently_of_date_spelling():
    raw = observations("1600-01-01T13:00:00.000001+01:00", "1600-01-01T12:00:00.000002Z")
    canonical = observations("1600-01-01T12:00:00.000001+00:00", "1600-01-01T12:00:00.000002+00:00")

    actual, control = build(raw, recent_games=None), build(canonical, recent_games=None)

    assert_original_dates(actual, raw)
    assert behavior(actual) == behavior(control)
    assert [(item["tag"], item["share"]) for item in actual["profile"]] == [("new-style", .5), ("old-style", .5)]
    assert [(item["champion"], item["preference_score"]) for item in actual["known"]] == [("NewerPick", .5), ("OlderPick", .5)]
    assert [(item["champion"], item["similarity"]) for item in actual["discover"]] == [("NewerNeighbor", .5), ("OlderNeighbor", .5)]
    assert actual["coverage"]["preference_observations"] == 2
    assert actual["trial_plan"]["budget"] == 3
    assert [(item["champion"], item["games"]) for item in actual["trial_plan"]["items"]] == [
        ("NewerPick", 1), ("NewerNeighbor", 1), ("OlderNeighbor", 1),
    ]


def test_zero_window_keeps_raw_familiarity_without_implicit_preferences():
    rows = observations("1600-01-01T13:00:00.000001+01:00", "1600-01-01T12:00:00.000002Z")

    payload = build(rows, recent_games=0)

    assert_original_dates(payload, rows)
    assert payload["profile"] == payload["discover"] == []
    assert [(item["champion"], item["preference_score"], item["games"]) for item in payload["known"]] == [
        ("NewerPick", 0, 1), ("OlderPick", 0, 1),
    ]
    assert payload["coverage"]["games"] == payload["coverage"]["observations"] == 2
    assert payload["coverage"]["preference_observations"] == 0
    assert payload["trial_plan"]["budget"] == 1
    assert [(item["champion"], item["games"]) for item in payload["trial_plan"]["items"]] == [("NewerPick", 1)]
