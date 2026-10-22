import pytest

from live_recommendations import competitive_training_plan


def _candidates():
    return [
        {
            "champion": "Ahri", "role": "MIDDLE", "games_observed": 4, "unique_games": 4,
            "posterior_win_rate": 55.0, "posterior_lift_pp": 5.0,
            "classification": "promising", "account_shapes": {"A": [5.5, 4.5], "B": [4.5, 5.5]},
        },
        {
            "champion": "Lux", "role": "MIDDLE", "games_observed": 80, "unique_games": 80,
            "posterior_win_rate": 53.0, "posterior_lift_pp": 3.0,
            "classification": "other", "historical_supported": True,
            "account_shapes": {"A": [53.0, 47.0], "B": [51.0, 49.0]},
        },
    ]


def test_default_and_limit_budgets_are_exact_integer_allocations():
    default = competitive_training_plan(_candidates(), ["A", "B"], optimization_scenarios=8, evaluation_scenarios=16)
    minimum = competitive_training_plan(_candidates(), ["A"], 20, optimization_scenarios=8, evaluation_scenarios=16)
    maximum = competitive_training_plan(_candidates(), ["A"], 2000, optimization_scenarios=2, evaluation_scenarios=4)

    assert default["budget_total"] == 400
    assert default["budget_assigned"] == 400
    assert sum(item["allocation_games"] for item in default["items"]) == 400
    assert sum(row["games"] for item in default["items"] for row in item["account_allocations"]) == 400
    assert minimum["budget_assigned"] == 20
    assert maximum["budget_assigned"] == 2000
    assert default["objective"] == "expected_final_simple_regret"
    assert default["monte_carlo_se"] is not None


def test_plan_is_reproducible_and_empty_candidate_family_is_explicit():
    args = (_candidates(), ["A", "B"], 20)
    first = competitive_training_plan(*args, optimization_scenarios=8, evaluation_scenarios=16)
    second = competitive_training_plan(*args, optimization_scenarios=8, evaluation_scenarios=16)
    empty = competitive_training_plan([], ["A"], 20, optimization_scenarios=8, evaluation_scenarios=16)

    assert first["items"] == second["items"]
    assert empty["budget_assigned"] == 0
    assert empty["budget_unassigned"] == 20


@pytest.mark.parametrize("budget", [True, 0, 19, 2001, "20.0", "400.5"])
def test_invalid_budgets_are_rejected(budget):
    with pytest.raises(ValueError, match="budget"):
        competitive_training_plan(_candidates(), ["A"], budget, optimization_scenarios=2, evaluation_scenarios=4)


def test_greedy_uses_the_same_tie_rule_as_evaluation():
    from live_recommendations import _best_arm, _regret_scenarios
    candidates = [
        {"champion": "Ahri", "role": "MIDDLE", "account_shapes": {"A": [2, 1]}},
        {"champion": "Lux", "role": "MIDDLE", "account_shapes": {"A": [2, 2]}},
    ]
    assert _best_arm([2 / 3, 2 / 3]) == 0
    assert _regret_scenarios({"A": [[2 / 3, 2 / 3]]}, {"A": [[.9, .2]]}, ["A"]) == {"A": [0.]}
    plan = competitive_training_plan(candidates, ["A"], 20, optimization_scenarios=64, evaluation_scenarios=16)
    # Before the correction, the one-step evaluator favored the updated tied
    # arm and assigned [11, 9] despite the different final selection rule.
    assert [item["allocation_games"] for item in plan["items"]] == [2, 18]


def test_complete_plan_cache_invalidates_metadata_scenarios_seed_settings_and_shapes(monkeypatch):
    from copy import deepcopy
    import live_recommendations as module
    module._PLAN_CACHE.clear()
    calls = []
    original = module._compute_competitive_training_plan
    def tracked(*args, **kwargs):
        calls.append(1)
        return original(*args, **kwargs)
    monkeypatch.setattr(module, "_compute_competitive_training_plan", tracked)
    candidates = _candidates()
    options = {"optimization_scenarios": 2, "evaluation_scenarios": 4}
    first = module.competitive_training_plan(candidates, ["A"], 20, **options)
    first["items"][0]["classification"] = "corrupted"
    assert module.competitive_training_plan(candidates, ["A"], 20, **options)["items"][0]["classification"] != "corrupted"
    assert len(calls) == 1
    for field, value in (("classification", "other"), ("icon_url", "synthetic-icon"), ("historical_supported", True)):
        modified = deepcopy(candidates)
        modified[0][field] = value
        module.competitive_training_plan(modified, ["A"], 20, **options)
    module.competitive_training_plan(candidates, ["A"], 20, **(options | {"evaluation_scenarios": 5}))
    module.competitive_training_plan(candidates, ["A"], 20, **(options | {"optimization_scenarios": 3}))
    module.competitive_training_plan(candidates, ["A"], 20, seed=42, **options)
    module.competitive_training_plan(candidates, ["A"], 21, **options)
    module.competitive_training_plan(candidates, ["B"], 20, **options)
    changed = deepcopy(candidates)
    changed[0]["account_shapes"]["A"][0] += 1
    module.competitive_training_plan(changed, ["A"], 20, **options)
    from hierarchical_champion_model import _jsonable
    settings = _jsonable(module.current_settings())
    settings["synthetic_cache_setting"] = 1
    monkeypatch.setattr(module, "current_settings", lambda: settings)
    module.competitive_training_plan(candidates, ["A"], 20, **options)
    assert len(calls) == 11
    assert len(module._PLAN_CACHE) <= 8


@pytest.mark.parametrize("option,value", [("optimization_scenarios", 0), ("evaluation_scenarios", True), ("seed", "42")])
def test_invalid_simulation_controls_fail_explicitly(option, value):
    with pytest.raises(ValueError, match=option):
        competitive_training_plan(_candidates(), ["A"], 20, **{option: value})


def test_plan_cache_shares_concurrent_work_and_does_not_cache_failures(monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    import threading
    import live_recommendations as module
    module._PLAN_CACHE.clear()
    started, release = threading.Event(), threading.Event()
    calls = []
    original = module._compute_competitive_training_plan
    def tracked(*args, **kwargs):
        calls.append(1)
        started.set()
        assert release.wait(5)
        return original(*args, **kwargs)
    monkeypatch.setattr(module, "_compute_competitive_training_plan", tracked)
    options = {"optimization_scenarios": 2, "evaluation_scenarios": 4}
    with ThreadPoolExecutor(2) as pool:
        first = pool.submit(module.competitive_training_plan, _candidates(), ["A"], 20, **options)
        assert started.wait(5)
        second = pool.submit(module.competitive_training_plan, _candidates(), ["A"], 20, **options)
        release.set()
        assert first.result(timeout=5) == second.result(timeout=5)
    assert len(calls) == 1
    module._PLAN_CACHE.clear()
    def fail(*args, **kwargs):
        raise ValueError("synthetic optimizer failure")
    monkeypatch.setattr(module, "_compute_competitive_training_plan", fail)
    with pytest.raises(ValueError, match="synthetic"):
        module.competitive_training_plan(_candidates(), ["A"], 20, **options)
    monkeypatch.setattr(module, "_compute_competitive_training_plan", original)
    assert module.competitive_training_plan(_candidates(), ["A"], 20, **options)["budget_assigned"] == 20


def test_plan_timings_and_cache_hits_are_request_local():
    import live_recommendations as module
    from runtime_metrics import metrics_scope
    module._PLAN_CACHE.clear()
    with metrics_scope("synthetic_plan_test") as metrics:
        for _ in range(2):
            module.competitive_training_plan(_candidates(), ["A"], 20,
                                             optimization_scenarios=2, evaluation_scenarios=4)
    assert metrics["plan_optimization_calls"] == 1
    assert metrics["plan_optimization_ms"] >= 0
    assert metrics["plan_cache_hit"] == 1
