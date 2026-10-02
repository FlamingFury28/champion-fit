from __future__ import annotations

import math

import pytest

from observed_performance import clopper_pearson_interval, observed_performance


def observations(account, prefix, outcomes, **extra):
    return [
        {"account": account, "match_id": f"{prefix}-{index}", "win": win, **extra}
        for index, win in enumerate(outcomes, 1)
    ]


@pytest.mark.parametrize(
    ("wins", "games", "expected"),
    [
        (0, 0, (None, None)),
        (0, 1, (0.0, 0.95)),
        (1, 1, (0.05, 1.0)),
        (1, 3, (0.0169524275084415, 0.8646496378284161)),
        (5, 5, (0.05 ** (1 / 5), 1.0)),
        (5, 10, (0.2224411010081294, 0.7775588989918706)),
        (10, 20, (0.3019539112864935, 0.6980460887135065)),
    ],
)
def test_exact_clopper_pearson_known_values(wins, games, expected):
    actual = clopper_pearson_interval(wins, games, 0.9)
    if expected[0] is None:
        assert actual == expected
    else:
        assert actual == pytest.approx(expected, abs=2e-12)


def test_exact_interval_preserves_tiny_valid_tail_probability():
    confidence = math.nextafter(1.0, 0.0)
    lower, upper = clopper_pearson_interval(0, 100, confidence)
    tail = (1.0 - confidence) / 2.0
    assert lower == 0
    assert upper == pytest.approx(1.0 - tail ** (1 / 100), abs=2e-12)
    assert upper < 1


def test_one_to_three_observations_remain_observed_without_a_prior():
    rows = observations("A", "all", [1, 0, 1, 0, 1, 0])
    for count in (1, 2, 3):
        candidate = observations("A", "choice", [1] * count)
        result = observed_performance(rows + candidate, candidate, ["A"])
        assert result["observations"] == result["games"] == count
        assert result["wins"] == count
        assert result["win_rate"] == 100
        assert result["interval_high"] == 100
        assert result["interval_low"] == pytest.approx(100 * 0.05 ** (1 / count))
        assert result["supported"] is False


def test_complement_excludes_candidate_match_ids_globally():
    rows = [
        {"account": "A", "match_id": "shared", "win": 1},
        {"account": "B", "match_id": "shared", "win": 0},
        {"account": "A", "match_id": "base-a", "win": 0},
        {"account": "B", "match_id": "base-b", "win": 1},
        {"account": "B", "match_id": "choice-b", "win": 1},
    ]
    candidate = [
        {"account": "A", "match_id": "shared", "win": 1},
        {"account": "B", "match_id": "choice-b", "win": 1},
    ]
    result = observed_performance(rows, candidate, ["A", "B"])
    assert result["baseline_games"] == 2
    assert result["per_account"]["A"]["baseline_games"] == 1
    assert result["per_account"]["B"]["baseline_games"] == 1
    assert result["baseline_win_rate"] == 50
    assert result["lift_pp"] == 50


def test_shared_candidate_match_separates_unique_games_from_observations():
    candidate = [
        {"account": "A", "match_id": "shared", "win": 1},
        {"account": "B", "match_id": "shared", "win": 0},
    ]
    baseline = observations("A", "base-a", [0]) + observations("B", "base-b", [1])
    result = observed_performance(candidate + baseline, candidate, ["A", "B"])
    assert result["games"] == 1
    assert result["observations"] == 2
    assert result["wins"] == result["losses"] == 1


def test_equal_account_weighting_does_not_pool_unequal_exposure():
    candidate = (
        observations("A", "candidate-a", [1])
        + observations("B", "candidate-b", [1] * 9 + [0])
    )
    baseline = observations("A", "base-a", [0]) + observations("B", "base-b", [0] * 10)
    result = observed_performance(candidate + baseline, candidate, ["A", "B"])
    assert result["wins"] == 10
    assert result["observations"] == 11
    assert result["win_rate"] == pytest.approx(95.0)
    assert result["baseline_win_rate"] == 0
    assert result["lift_pp"] == pytest.approx(95.0)


def test_unobserved_and_incomparable_accounts_are_explicit_and_block_support():
    candidate = observations("A", "candidate", [1] * 20) + observations("C", "candidate-c", [1] * 20)
    baseline = observations("A", "base", [0] * 20) + observations("B", "base-b", [1] * 20)
    result = observed_performance(candidate + baseline, candidate, ["A", "B", "C"])
    assert result["comparable_accounts"] == ["A"]
    assert result["missing_accounts"] == ["B"]
    assert result["missing_baseline_accounts"] == ["C"]
    assert result["per_account"]["B"]["win_rate"] is None
    assert result["per_account"]["C"]["baseline_win_rate"] is None
    assert result["supported"] is False
    assert result["direction"] == "better"
    assert result["decision_candidate_low"] is None
    assert result["decision_baseline_high"] is None


def test_paired_candidate_summary_uses_the_same_accounts_as_the_baseline():
    candidate = observations("A", "candidate-a", [1]) + observations("C", "candidate-c", [0])
    baseline = observations("A", "base-a", [0]) + observations("B", "base-b", [1])

    result = observed_performance(candidate + baseline, candidate, ["A", "B", "C"])

    assert result["win_rate"] == 50
    assert result["paired_candidate_win_rate"] == 100
    assert result["baseline_win_rate"] == 0
    assert result["lift_pp"] == 100
    assert result["paired_candidate_low"] == pytest.approx(result["per_account"]["A"]["interval_low"])
    assert result["paired_candidate_high"] == pytest.approx(result["per_account"]["A"]["interval_high"])


def test_clear_raw_difference_can_be_supported_without_a_minimum_games_gate():
    candidate = observations("A", "candidate", [1] * 10)
    baseline = observations("A", "base", [0] * 10)
    result = observed_performance(candidate + baseline, candidate, ["A"], confidence=0.9, family_size=1)
    assert result["supported"] is True
    assert result["direction"] == "better"
    assert result["lift_pp"] == 100


def test_family_size_only_tightens_the_support_decision_not_descriptive_interval():
    candidate = observations("A", "candidate", [1] * 10 + [0] * 10)
    baseline = observations("A", "base", [0] * 20)
    one = observed_performance(candidate + baseline, candidate, ["A"], family_size=1)
    many = observed_performance(candidate + baseline, candidate, ["A"], family_size=40)
    assert (one["interval_low"], one["interval_high"]) == pytest.approx(
        (many["interval_low"], many["interval_high"])
    )
    assert one["supported"] is True
    assert many["supported"] is False
    assert one["family_size"] == 1
    assert many["family_size"] == 40
    assert one["family_alpha"] == many["family_alpha"] == 0.05
    assert one["meaningful_delta"] == many["meaningful_delta"] == 0.03
    assert one["meaningful_delta_pp"] == many["meaningful_delta_pp"] == 3
    assert one["decision_side_alpha"] == pytest.approx(0.025)
    assert many["decision_side_alpha"] == pytest.approx(0.000625)
    assert one["decision_candidate_low"] > one["decision_baseline_high"] + 3
    assert many["decision_candidate_low"] <= many["decision_baseline_high"] + 3


def test_family_alpha_is_independent_from_descriptive_confidence():
    candidate = observations("A", "candidate", [1] * 10)
    baseline = observations("A", "base", [0] * 10)
    scope = candidate + baseline
    low_confidence = observed_performance(
        scope, candidate, ["A"], confidence=.8, family_alpha=.05
    )
    high_confidence = observed_performance(
        scope, candidate, ["A"], confidence=.95, family_alpha=.05
    )
    strict_family = observed_performance(
        scope, candidate, ["A"], confidence=.8, family_alpha=.001
    )
    assert low_confidence["interval_low"] != high_confidence["interval_low"]
    assert low_confidence["supported"] == high_confidence["supported"] is True
    assert strict_family["supported"] is False


@pytest.mark.parametrize("family_alpha", [True, 0, 1, float("nan")])
def test_family_alpha_validation_is_strict(family_alpha):
    rows = observations("A", "candidate", [1])
    with pytest.raises(ValueError):
        observed_performance(rows, rows, ["A"], family_alpha=family_alpha)


def test_extreme_valid_confidence_and_family_size_remain_conservative():
    candidate = observations("A", "candidate", [1] * 10)
    baseline = observations("A", "base", [0] * 10)
    scope = candidate + baseline
    confidence = math.nextafter(1.0, 0.0)
    extreme_confidence = observed_performance(scope, candidate, ["A"], confidence=confidence)
    extreme_family = observed_performance(scope, candidate, ["A"], family_size=10**400)
    assert extreme_confidence["interval_low"] is not None
    assert extreme_confidence["supported"] is True
    assert extreme_family["supported"] is False


def test_weights_and_unrelated_fields_cannot_change_raw_outcome_summary():
    rows = observations("A", "base", [0, 1, 0], loss_attribution_weight=0.01)
    candidate = observations("A", "candidate", [1, 0, 1], positive_evidence=999)
    scope = rows + candidate
    first = observed_performance(scope, candidate, ["A"])
    for row in rows:
        row.update(loss_attribution_weight=1, win_evidence_weight=0, arbitrary="changed")
    for row in candidate:
        row.update(positive_evidence=0, negative_evidence=999)
    assert observed_performance(rows + candidate, candidate, ["A"]) == first


def test_identical_duplicates_are_deduplicated_and_conflicts_are_rejected():
    candidate = [
        {"account": "A", "match_id": "choice", "win": 1},
        {"account": "A", "match_id": "choice", "win": True, "weight": 0},
    ]
    scope = observations("A", "base", [0]) + [candidate[0]]
    result = observed_performance(scope, candidate, ["A"])
    assert result["observations"] == result["games"] == 1
    with pytest.raises(ValueError, match="conflicting duplicate"):
        observed_performance(scope, candidate + [{"account": "A", "match_id": "choice", "win": 0}], ["A"])
    with pytest.raises(ValueError, match="conflicting duplicate"):
        observed_performance([
            {"account": "A", "match_id": "base", "win": 0},
            {"account": "A", "match_id": "base", "win": 1},
        ], [], ["A"])


def test_candidate_must_be_a_consistent_subset_of_the_scope():
    candidate = [{"account": "A", "match_id": "choice", "win": 1}]
    with pytest.raises(ValueError, match="outside the comparison scope"):
        observed_performance(observations("A", "base", [0]), candidate, ["A"])
    with pytest.raises(ValueError, match="conflicts with comparison scope"):
        observed_performance([
            {"account": "A", "match_id": "choice", "win": 0},
        ], candidate, ["A"])


def test_missing_candidate_has_null_rates_and_no_synthetic_neutral_value():
    result = observed_performance(observations("A", "base", [1, 0]), [], ["A"])
    assert result["games"] == result["observations"] == 0
    assert result["win_rate"] is result["interval_low"] is result["interval_high"] is None
    assert result["baseline_win_rate"] is result["lift_pp"] is None
    assert result["missing_accounts"] == ["A"]
    assert result["direction"] == "missing"
    assert result["supported"] is False
