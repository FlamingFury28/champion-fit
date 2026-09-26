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
