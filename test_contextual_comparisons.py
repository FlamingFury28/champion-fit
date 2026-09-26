from copy import deepcopy
from datetime import datetime, timedelta, timezone

import pytest

from algorithm_settings import recommended_settings, settings_context
from contextual_comparisons import build_contrast, encounter_data


def outcome(account, match_id, win, *, champion="Ahri", role="MIDDLE", date="2099-01-01"):
    return {
        "account": account,
        "match_id": match_id,
        "champion": champion,
        "role": role,
        "win": win,
        "date": date,
        "positive_evidence": float(win),
        "negative_evidence": float(1 - win),
    }


def roster(match_id, own_champion, own_win, other, *, ally=False):
    return [
        {
            "match_id": match_id,
            "team_id": 100,
            "win": own_win,
            "champion": own_champion,
        },
        {
            "match_id": match_id,
            "team_id": 100 if ally else 200,
            "win": own_win if ally else 1 - own_win,
            "champion": other,
        },
    ]


def all_items(payload):
    keys = ("beats", "loses_to") if "beats" in payload else ("better_with", "worse_with")
    return [item for key in keys for item in payload[key]]


def test_build_contrast_keeps_opposite_accounts_and_globally_disjoint_ids():
    rows = [
        outcome("A", "shared", 1),
        outcome("B", "shared", 0, champion="Zed"),
        outcome("A", "a-reference", 0),
        outcome("B", "b-reference", 1, champion="Zed"),
    ]

    contrast = build_contrast(rows, [rows[0], rows[0], rows[1]], ["A", "B"])

    assert contrast["games"] == 2
    assert contrast["unique_games"] == 1
    assert contrast["wins"] == contrast["losses"] == 1
    assert contrast["account_cells"]["A"]["baseline_match_ids"] == ["a-reference"]
    assert contrast["account_cells"]["B"]["baseline_match_ids"] == ["b-reference"]
    assert set(contrast["local_match_ids"]).isdisjoint(contrast["baseline_match_ids"])


def test_build_contrast_rejects_conflicting_duplicate_within_account():
    rows = [outcome("A", "m1", 1)]
    conflict = outcome("A", "m1", 0)

    with pytest.raises(ValueError, match="Conflicting duplicate"):
        build_contrast(rows, [rows[0], conflict], ["A"])


def test_build_contrast_accepts_minimal_friend_outcomes_and_uses_player_role():
    rows = [outcome("A", "with-friend", 1), outcome("A", "without-friend", 0)]

    contrast = build_contrast(
        rows,
        [{"account": "A", "match_id": "with-friend", "win": 1}],
        ["A"],
    )

    assert contrast["roles"] == ["MIDDLE"]
    assert contrast["account_cells"]["A"]["baseline_match_ids"] == ["without-friend"]


def test_encounter_uses_equal_account_posterior_weight_and_preserves_missing_account():
    rows = []
    rosters = {}
    for number in range(100):
        candidate_id = f"a-candidate-{number}"
        baseline_id = f"a-baseline-{number}"
        rows.extend([outcome("A", candidate_id, 1), outcome("A", baseline_id, 0)])
        rosters[candidate_id] = roster(candidate_id, "Ahri", 1, "Lux")
        rosters[baseline_id] = roster(baseline_id, "Ahri", 0, "Zed")
    rows.extend([outcome("B", "b-candidate", 0), outcome("B", "b-baseline", 1)])
    rosters["b-candidate"] = roster("b-candidate", "Ahri", 0, "Lux")
    rosters["b-baseline"] = roster("b-baseline", "Ahri", 1, "Zed")

    payload = encounter_data(rows, rosters, ["A", "B"], champion="Ahri", role="MIDDLE")
    lux = next(item for item in all_items(payload) if item["champion"] == "Lux")

    assert lux["games"] == 101
    assert lux["unique_games"] == 101
    assert lux["account_weighting"] == "equal"
    assert lux["posterior_win_rate"] == pytest.approx(70.4, abs=0.1)
    assert lux["baseline_win_rate"] == pytest.approx(29.6, abs=0.1)
    assert lux["exposure_rate"] == 50.0
    assert lux["recent_share"] == 100.0

    missing = encounter_data(rows, rosters, ["A", "B", "C"], champion="Ahri", role="MIDDLE")
    lux_missing = next(item for item in all_items(missing) if item["champion"] == "Lux")
    assert lux_missing["missing_accounts"] == ["C"]
    assert lux_missing["statistical_actionable"] is False
    assert lux_missing["actionable"] is False


def test_all_roles_mixed_context_and_missing_role_baseline_are_vetoes():
    rows = [
        outcome("A", "lux-mid", 1, role="MIDDLE"),
        outcome("A", "lux-top", 1, role="TOP"),
        outcome("A", "zed-mid", 0, role="MIDDLE"),
    ]
    rosters = {
        "lux-mid": roster("lux-mid", "Ahri", 1, "Lux"),
        "lux-top": roster("lux-top", "Ahri", 1, "Lux"),
        "zed-mid": roster("zed-mid", "Ahri", 0, "Zed"),
    }

    payload = encounter_data(rows, rosters, ["A"], champion="Ahri", role="ALL")
    lux = next(item for item in all_items(payload) if item["champion"] == "Lux")

    assert lux["mixed_role_context"] is True
    assert lux["mixed_role_accounts"] == ["A"]
    assert lux["missing_role_baselines"] == [{"account": "A", "role": "TOP"}]
    assert lux["statistical_actionable"] is False
    assert lux["actionable"] is False
    assert lux["decision_reason"] == "Seleziona un ruolo per una conclusione relativa"


def test_all_roles_across_accounts_with_different_single_roles_is_vetoed():
    rows = []
    rosters = {}
    for account, role in (("A", "MIDDLE"), ("B", "TOP")):
        for number in range(30):
            candidate_id = f"{account}-lux-{number}"
            reference_id = f"{account}-zed-{number}"
            rows.extend([
                outcome(account, candidate_id, 1, role=role),
                outcome(account, reference_id, 0, role=role),
            ])
            rosters[candidate_id] = roster(candidate_id, "Ahri", 1, "Lux")
            rosters[reference_id] = roster(reference_id, "Ahri", 0, "Zed")

    payload = encounter_data(rows, rosters, ["A", "B"], champion="Ahri", role="ALL")
    lux = next(item for item in all_items(payload) if item["champion"] == "Lux")

    assert lux["games"] == lux["unique_games"] == 60
    assert lux["probability_meaningful_advantage"] >= 98.75
    assert lux["mixed_role_context"] is True
    assert lux["mixed_role_accounts"] == []
    assert lux["statistical_actionable"] is False
    assert lux["actionable"] is False
    assert lux["decision_reason"] == "Seleziona un ruolo per una conclusione relativa"


def test_ally_shape_uses_full_family_before_configured_limit():
    rows = []
    rosters = {}
    for number, (ally, win) in enumerate((
        ("Leona", 1), ("Nautilus", 1), ("Yuumi", 0), ("Sona", 0),
    )):
        match_id = f"m{number}"
        rows.append(outcome("A", match_id, win))
        rosters[match_id] = roster(match_id, "Ahri", win, ally, ally=True)
    settings = deepcopy(recommended_settings())
    settings["matchup"]["limit"] = 1

    with settings_context(settings):
        payload = encounter_data(
            rows, rosters, ["A"], relation="ally", champion="Ahri", min_games=2,
        )

    assert payload["family_size"] == 4
    assert payload["games_with_teammates"] == 4
    assert payload["allied_slots_observed"] == 4
    assert payload["min_games"] == 2
    assert payload["better_with"] == []
    assert payload["worse_with"] == []
    assert payload["exploratory"] == []
    assert payload["coverage"] == {"games_with_roster": 4, "roster_coverage": 100.0}


def test_recent_90d_count_is_independent_from_configured_recent_window():
    match_id = "month-old"
    date = (datetime.now(timezone.utc) - timedelta(days=30)).date().isoformat()
    rows = [outcome("A", match_id, 1, date=date), outcome("A", "reference", 0, date=date)]
    rosters = {
        match_id: roster(match_id, "Ahri", 1, "Lux"),
        "reference": roster("reference", "Ahri", 0, "Zed"),
    }
    settings = deepcopy(recommended_settings())
    settings["matchup"]["recent_days"] = 7

    with settings_context(settings):
        payload = encounter_data(rows, rosters, ["A"], champion="Ahri", role="MIDDLE")

    lux = next(item for item in all_items(payload) if item["champion"] == "Lux")
    assert lux["recent_games"] == 0
    assert lux["recent_90d_games"] == 1
    assert lux["recent_share"] == 0.0


def test_recent_windows_are_relative_to_explicit_historical_as_of():
    rows = [
        outcome("A", "candidate", 1, date="2025-01-10T12:00:00Z"),
        outcome("A", "reference", 0, date="2024-10-01T12:00:00Z"),
    ]
    rosters = {
        "candidate": roster("candidate", "Ahri", 1, "Lux"),
        "reference": roster("reference", "Ahri", 0, "Zed"),
    }

    payload = encounter_data(
        rows, rosters, ["A"], champion="Ahri", role="MIDDLE",
        as_of="2025-01-15T00:00:00Z",
    )

    lux = next(item for item in all_items(payload) if item["champion"] == "Lux")
    assert lux["recent_games"] == 1
    assert lux["recent_90d_games"] == 1
    assert lux["recent_share"] == 100.0


@pytest.mark.parametrize(
    ("kwargs", "message"),
    [
        ({"min_games": True}, "min_games"),
        ({"min_reliability": "unknown"}, "min_reliability"),
        ({"include_exploratory": "yes"}, "include_exploratory"),
    ],
)
def test_synergy_filter_arguments_are_validated(kwargs, message):
    with pytest.raises(ValueError, match=message):
        encounter_data([], {}, ["A"], relation="ally", **kwargs)
