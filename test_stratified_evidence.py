"""Independent invariants for shared-prior account standardization."""
import copy
import math
import random

import pytest

import stratified_evidence
from algorithm_settings import recommended_settings, settings_context
from statistical_evidence import beta_cdf, compare_posteriors
from stratified_evidence import aggregate_stratified_candidates, stratified_gate_bound, stratified_summary


def cell(wins=60, losses=40, base_wins=50, base_losses=50):
    return dict(wins=wins, losses=losses, baseline_wins=base_wins, baseline_losses=base_losses)


def row(account, match_id, champion="A", role="TOP", win=1):
    return dict(account=account, match_id=match_id, champion=champion, role=role, win=win)


@pytest.mark.parametrize("counts", [cell(), cell(3, 0, 0, 0), cell(0, 0, None, None), cell(9, 15, 9, 20)])
def test_one_account_matches_shared_exact_comparison(counts):
    expected_counts = dict(counts)
    if expected_counts["baseline_wins"] == expected_counts["baseline_losses"] == 0:
        expected_counts["baseline_wins"] = expected_counts["baseline_losses"] = None
    expected = compare_posteriors(**expected_counts)
    actual = stratified_summary({"a": counts}, ["a"])
    for key, value in expected.items():
        assert actual[key] == value
    assert actual["interval_method"] == "beta_exact"
    assert not actual["probabilities_are_lower_bounds"]
    assert actual["prob_direction_below"] == 1 - expected["prob_direction_above"]


def test_simpson_fixture_standardizes_on_common_account_mix():
    # A dominates within both accounts (.30>.20 and .90>.80), but pooled
    # counts reverse the order (.36<.74). Posterior means use Beta(4,4).
    a = {"low": cell(270, 630, 20, 80), "high": cell(90, 10, 720, 180)}
    b = {"low": cell(20, 80, 270, 630), "high": cell(720, 180, 90, 10)}
    estimate_a, estimate_b = stratified_summary(a, ["low", "high"]), stratified_summary(b, ["low", "high"])
    # Fixed independent reference values from SciPy 1.18.0 beta.ppf(.025).
    assert estimate_a["mean"] == pytest.approx(.5860662424539076, abs=1e-14)
    assert estimate_b["mean"] == pytest.approx(.5097895252080273, abs=1e-14)
    assert estimate_a["lower_90"] == pytest.approx(.5367737711477498, abs=1e-11)
    assert estimate_b["lower_90"] == pytest.approx(.4599633006524201, abs=1e-11)
    assert estimate_a["lower_90"] > estimate_b["lower_90"]
    assert estimate_a["account_weighting"] == estimate_b["account_weighting"] == "equal"


def test_intervals_match_independent_reference_and_bonferroni_marginals():
    estimate = stratified_summary({"a": cell(60, 40), "b": cell(90, 10)}, ["a", "b"])
    assert estimate["lower_90"] == pytest.approx(.6500614780210017, abs=1e-11)
    assert estimate["upper_90"] == pytest.approx(.8047995686840361, abs=1e-11)
    # Exactly the average of four simultaneous one-sided .025-tail bounds.
    assert estimate["lower_90"] < estimate["mean"] < estimate["upper_90"]
    assert estimate["probmethod"] == "conservative_marginal_bound"
    assert estimate["probability_evaluation"] == "interval_bound_90"
    assert estimate["probabilities_are_lower_bounds"]


def test_configured_interval_and_delta_reach_summary_and_gate_without_changing_90_aliases():
    cells = {"a": cell(90, 10, 30, 70), "b": cell(90, 10, 30, 70)}
    default = stratified_summary(cells, ["a", "b"])
    configured = recommended_settings()
    configured["evidence"].update({"credible_mass": .8, "meaningful_delta": .1})
    with settings_context(configured):
        changed = stratified_summary(cells, ["a", "b"])
        gate = stratified_gate_bound(cells, ["a", "b"], .95)
    assert changed["credible_mass"] == .8
    assert changed["lower"] > changed["lower_90"]
    assert changed["upper"] < changed["upper_90"]
    assert changed["lower_90"] == default["lower_90"]
    assert changed["upper_90"] == default["upper_90"]
    assert changed["delta"] == gate["delta"] == .1
    assert changed["probability_evaluation"] == "configured_interval_bound"


def test_missing_target_accounts_are_neutral_uncertain_and_shared_by_every_candidate():
    a = stratified_summary({"a": cell(12, 0, 0, 0)}, ["a", "b", "empty"])
    b = stratified_summary({"b": cell(12, 0, 0, 0)}, ["a", "b", "empty"])
    assert a["account_count"] == b["account_count"] == 3
    assert a["observed_account_count"] == b["observed_account_count"] == 1
    assert a["account_coverage"] == b["account_coverage"] == 1 / 3
    assert a["mean"] == b["mean"] == .6
    assert a["lower_90"] == b["lower_90"]
    assert a["upper_90"] == b["upper_90"]
    assert a["lower_90"] < .4
    assert a["baseline_mean"] == a["baseline_lower_90"] == a["baseline_upper_90"] == .5
    assert a["missing_accounts"] == ["b", "empty"]
    assert a["missing_baseline_accounts"] == ["a", "b", "empty"]
    assert a["fixed_baseline_accounts"] == ["a", "b", "empty"]


def test_raw_counts_and_baselines_do_not_mutate_and_account_order_is_irrelevant():
    cells = {"b": cell(31, 29, 0, 0), "a": cell(70, 30)}
    original = copy.deepcopy(cells)
    first = stratified_summary(cells, ["a", "b", "a"])
    second = stratified_summary(dict(reversed(list(cells.items()))), ["b", "a"])
    assert first == second
    assert cells == original
    relabeled = {"x": cells["a"], "y": cells["b"]}
    third = stratified_summary(relabeled, ["y", "x"])
    for field in ("mean", "lower_90", "upper_90", "baseline_mean", "prob_above", "prob_below"):
        assert first[field] == third[field]


def test_unrelated_champion_changes_only_baseline_not_own_posterior():
    original_rows = [row("a", f"a-{index}", win=index % 2) for index in range(20)]
    original_rows += [row("b", f"b-{index}", win=index % 3 == 0) for index in range(20)]
    first = aggregate_stratified_candidates(original_rows)[("TOP", "A")]
    added = original_rows + [row("a", f"new-{index}", champion="B", win=1) for index in range(100)]
    second = aggregate_stratified_candidates(added)[("TOP", "A")]
    first_summary = stratified_summary(first["account_cells"], ["a", "b"])
    second_summary = stratified_summary(second["account_cells"], ["a", "b"])
    for field in ("mean", "lower_90", "upper_90"):
        assert first_summary[field] == second_summary[field]
    assert second_summary["baseline_mean"] > first_summary["baseline_mean"]


def test_global_match_exclusion_prevents_reference_leakage_across_accounts():
    rows = [row("a", "shared", champion="A", win=1),
            row("b", "shared", champion="B", win=0),
            row("a", "local", champion="A", win=0),
            row("a", "reference-a", champion="C", win=0),
            row("b", "reference-b", champion="B", win=1),
            row("c", "other-role", champion="A", role="SUPPORT", win=1)]
    all_candidates = aggregate_stratified_candidates(rows)
    a = all_candidates[("TOP", "A")]
    assert a["accounts"] == ["a", "b", "c"]
    assert a["local_match_ids"] == ["local", "shared"]
    assert a["baseline_match_ids"] == ["reference-a", "reference-b"]
    assert a["account_cells"]["b"]["baseline_wins"] == 1
    assert a["account_cells"]["b"]["baseline_losses"] == 0
    assert a["account_cells"]["c"]["wins"] == a["account_cells"]["c"]["baseline_wins"] == 0
    for item in all_candidates.values():
        candidate_ids = set(item["local_match_ids"])
        for counts in item["account_cells"].values():
            assert not candidate_ids & set(counts["baseline_match_ids"])
            assert not set(counts["local_match_ids"]) & set(counts["baseline_match_ids"])


def test_shared_game_outcomes_keep_observation_and_unique_game_denominators_separate():
    data = aggregate_stratified_candidates([
        row("a", "mirror", win=1), row("b", "mirror", win=0),
        row("a", "own", win=1),
    ])[('TOP', 'A')]
    assert data["unique_games"] == 2
    assert data["observations"] == data["games"] == 3
    assert data["wins"] == 2 and data["losses"] == 1
    assert data["wins"] + data["losses"] == data["observations"]


def test_aggregation_duplicates_order_and_no_mutation():
    rows = [row("b", "2", champion="B", win=0), row("a", "1"), row("a", "3", champion="B")]
    before = copy.deepcopy(rows)
    reference = aggregate_stratified_candidates(rows)
    actual = aggregate_stratified_candidates([*reversed(rows), *rows])
    assert actual == reference
    assert rows == before
    assert aggregate_stratified_candidates([]) == {}


@pytest.mark.parametrize("change", [{"win": 0}, {"champion": "B"}, {"role": "JUNGLE"}])
def test_conflicting_duplicate_is_rejected(change):
    with pytest.raises(ValueError, match="Conflicting duplicate"):
        aggregate_stratified_candidates([row("a", "1"), row("a", "1") | change])


@pytest.mark.parametrize("change", [{"win": .2}, {"win": "1"}, {"account": None}, {"account": ""}, {"match_id": None}])
def test_invalid_raw_rows_are_rejected(change):
    with pytest.raises(ValueError):
        aggregate_stratified_candidates([row("a", "1") | change])


def test_weak_direction_bounds_are_not_false_exact_zero_probabilities():
    estimate = stratified_summary({"a": cell(3, 3, 0, 0), "b": cell(3, 3, 0, 0)}, ["a", "b"])
    assert estimate["direction_probability"] == 0
    assert estimate["prob_direction_above"] == estimate["prob_direction_below"] == 0
    assert estimate["probabilities_are_lower_bounds"]
    assert estimate["mean"] == estimate["baseline_mean"] == .5


def test_exact_zero_mean_difference_is_neutral_for_mirrored_cells_and_empty_support():
    for cells in ({"a": cell(3, 1, 0, 0), "b": cell(1, 3, 0, 0)}, {}):
        estimate = stratified_summary(cells, ["a", "b"])
        assert estimate["mean"] - estimate["baseline_mean"] == 0.0
        assert estimate["direction"] == "neutral"
        assert estimate["signal_probability"] == 0.0
        assert estimate["direction_probability"] == 0.0
        assert estimate["probability_method"] == estimate["probmethod"]


def test_prior_share_is_average_cell_share_and_support_is_explicit():
    estimate = stratified_summary({"a": cell(90, 10, 4, 5)}, ["a", "b"])
    assert estimate["prior_share"] == pytest.approx((8 / 108 + 1) / 2)
    assert estimate["prior_share"] != pytest.approx(8 / 108)
    assert estimate["support_per_account"] == {
        "a": {"games": 100, "baseline_games": 9, "local_missing": False, "baseline_missing": False},
        "b": {"games": 0, "baseline_games": 0, "local_missing": True, "baseline_missing": True},
    }
    single = stratified_summary({"a": cell(90, 10)}, ["a"])
    assert single["prior_share"] == 8 / 108


def test_stronger_outcomes_improve_bounds_without_reducing_uncertainty_to_zero():
    lower_results = []
    signal_results = []
    for wins in (50, 60, 70, 80, 90):
        estimates = stratified_summary({"a": cell(wins, 100 - wins), "b": cell(wins, 100 - wins)},
                                       ["a", "b"], probability_iterations=20)
        lower_results.append(estimates["lower_90"])
        signal_results.append(estimates["prob_above"])
        assert estimates["upper_90"] > estimates["lower_90"]
    assert lower_results == sorted(lower_results)
    assert signal_results == sorted(signal_results)


def test_refined_bounds_are_certified_at_the_returned_probability():
    cells = {"a": cell(82, 18), "b": cell(87, 13)}
    estimate = stratified_summary(cells, ["a", "b"], probability_iterations=20)
    probability = estimate["prob_above"]
    assert .9 < probability < 1
    certified = stratified_gate_bound(cells, ["a", "b"], probability)
    assert certified["above"]
    # Bisection returns the conservative endpoint, within 2^-20 of the
    # construction's frontier. Moving two grid steps higher cannot certify it.
    stricter = stratified_gate_bound(cells, ["a", "b"], min(1, probability + 2 ** -19))
    assert not stricter["above"]
    assert estimate["probability_evaluation"] == "risk_bisection_20"


def test_gate_pass_means_every_marginal_risk_adds_up_to_threshold_budget():
    cells = {"a": cell(190, 10), "b": cell(180, 20)}
    threshold = .999
    result = stratified_gate_bound(cells, ["a", "b"], threshold)
    assert result["above"] and not result["below"]
    assert result["above_difference_lower"] >= .03
    assert result["above_probability_bound"] == threshold
    assert result["below_probability_bound"] == 0
    # Four one-sided risks: two local lower and two baseline upper tails.
    tail = (1 - threshold) / 4
    assert 1 - 4 * tail == threshold


def test_small_or_missing_accounts_cannot_pass_family_gate_via_point_mean_alone():
    for cells in ({"a": cell(3, 0, 0, 0), "b": cell(3, 0, 0, 0)},
                  {"a": cell(900, 0, 0, 0)}):
        estimate = stratified_summary(cells, ["a", "b"])
        gate = stratified_gate_bound(cells, ["a", "b"], 1 - .05 / 500)
        assert estimate["mean"] > .6
        assert not gate["above"]
        assert gate["above_probability_bound"] == 0


def test_single_account_gate_returns_exact_shared_probability():
    counts = cell(30, 10, 0, 0)
    summary = stratified_summary({"a": counts}, ["a"])
    gate = stratified_gate_bound({"a": counts}, ["a"], .95)
    assert gate["above_probability_bound"] == summary["prob_above"]
    assert gate["above"] == (summary["prob_above"] >= .95)


def test_marginal_bound_below_independent_monte_carlo_probability():
    # Monte Carlo is an independent sanity check, not the basis of the bound.
    cells = {"a": cell(30, 10, 20, 20), "b": cell(40, 10, 20, 20)}
    estimate = stratified_summary(cells, ["a", "b"], probability_iterations=20)
    rng = random.Random(9104)
    total = 15000
    successes = 0
    for _ in range(total):
        local = (rng.betavariate(34, 14) + rng.betavariate(44, 14)) / 2
        reference = (rng.betavariate(24, 24) + rng.betavariate(24, 24)) / 2
        successes += local > reference + .03
    observed = successes / total
    assert estimate["prob_above"] <= observed + .01
    assert observed > .95


def test_zero_threshold_is_trivial_and_one_threshold_never_overclaims():
    cells = {"a": cell(), "b": cell()}
    zero = stratified_gate_bound(cells, ["a", "b"], 0)
    one = stratified_gate_bound(cells, ["a", "b"], 1)
    assert zero["above"] and zero["below"]
    assert not one["above"] and not one["below"]


@pytest.mark.parametrize("kwargs", [{"delta": -.1}, {"delta": 1.1}, {"delta": math.nan}, {"probability_iterations": 10}])
def test_invalid_summary_options_are_rejected(kwargs):
    with pytest.raises(ValueError):
        stratified_summary({"a": cell()}, ["a"], **kwargs)


def test_invalid_populations_counts_and_partial_baselines_are_rejected():
    with pytest.raises(ValueError):
        stratified_summary({}, [])
    with pytest.raises(ValueError):
        stratified_summary({"a": cell(wins=-1)}, ["a"])
    with pytest.raises(ValueError):
        stratified_summary({"a": cell(base_wins=None, base_losses=3)}, ["a"])
    with pytest.raises(ValueError):
        stratified_gate_bound({"a": cell()}, ["a"], 1.01)


@pytest.mark.parametrize("offset,certified", [(0.0, False), (.5, False), (1.0, False), (2.0, True)])
def test_gate_and_bisection_require_strict_difference_beyond_numerical_margin(monkeypatch, offset, certified):
    delta = .03
    floor = delta + offset * stratified_evidence.STRICT_COMPARISON_MARGIN
    monkeypatch.setattr(stratified_evidence, "_difference_lower", lambda prepared, risk, above: floor)
    cells = {"a": cell(), "b": cell()}
    gate = stratified_gate_bound(cells, ["a", "b"], .99, delta)
    assert gate["above"] is certified
    assert gate["below"] is certified
    assert gate["above_probability_bound"] == (.99 if certified else 0.0)
    assert gate["below_probability_bound"] == (.99 if certified else 0.0)
    refined = stratified_summary(cells, ["a", "b"], delta, probability_iterations=20)
    if certified:
        assert refined["prob_above"] > .99 and refined["prob_below"] > .99
    else:
        assert refined["prob_above"] == refined["prob_below"] == 0.0


@pytest.mark.parametrize("delta,offset,certified", [(.03, 0.0, False), (.03, .5, False), (.03, 2.0, True),
                                                  (0.0, 0.0, False), (0.0, .5, False), (0.0, 2.0, True)])
@pytest.mark.parametrize("above", [True, False])
def test_coarse_summary_does_not_certify_equality_or_boundary_noise(monkeypatch, delta, offset, certified, above):
    difference = delta + offset * stratified_evidence.STRICT_COMPARISON_MARGIN
    bounds = (.5 + difference, .9, .1, .5) if above else (.1, .5, .5 + difference, .9)
    monkeypatch.setattr(stratified_evidence, "_quantile_bounds", lambda prepared, tail: bounds)
    summary = stratified_summary({"a": cell(), "b": cell()}, ["a", "b"], delta)
    probability_key = "prob_above" if above else "prob_below"
    assert summary[probability_key] == (.9 if certified else 0.0)
    if delta == 0:
        direction_key = "prob_direction_above" if above else "prob_direction_below"
        assert summary[direction_key] == (.9 if certified else 0.0)
