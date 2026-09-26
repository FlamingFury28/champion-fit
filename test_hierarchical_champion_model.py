import math

import pytest

from hierarchical_champion_model import MODEL_VALIDATED, _fit, _predict, _standardized_prediction
from algorithm_settings import current_settings


def test_hierarchical_fit_pools_small_cells_and_models_match_patch_and_account_effects():
    rows = []
    for account, account_shift in (("A", 1), ("B", 0)):
        for patch, patch_shift in (("16.1", 1), ("16.2", 0)):
            for index in range(24):
                champion = "Ahri" if index < 2 else ("Lux" if index % 2 else "Orianna")
                win = int((index + account_shift + patch_shift) % 3 != 0)
                rows.append({
                    "account": account,
                    "match_id": f"{account}-{patch}-{index}",
                    "champion": champion,
                    "role": "MIDDLE",
                    "queue": "420",
                    "patch": patch,
                    "win": win,
                })

    fit = _fit(rows)
    result = _predict(rows, ["A", "B"], fit, current_settings())

    assert fit["iterations"] <= 60
    assert fit["match_effect_levels"] == len(rows)
    assert fit["effects"]["account"]
    assert fit["effects"]["champion_role"]
    assert fit["effects"]["role"]
    assert fit["effects"]["queue"]
    assert set(fit["effects"]["patch"]) == {"16.1", "16.2"}
    assert {item["champion"] for item in result["items"]} == {"Ahri", "Lux", "Orianna"}
    assert all(0 <= item["credible_lower_90"] <= item["posterior_win_rate"] <= item["credible_upper_90"] <= 100
               for item in result["items"])
    assert all(item["account_coverage"] <= item["account_count"] for item in result["items"])
    assert all(item["model_status"] == "exploratory" and not item["actionable"] for item in result["items"])
    assert result["validation"]["validated"] is MODEL_VALIDATED is False


def test_lobby_rows_share_a_random_intercept_and_outcomes_remain_binary():
    rows = [
        {"account": "A", "match_id": "shared", "champion": "Ahri", "role": "MIDDLE", "queue": "420", "patch": "16.1", "win": 1},
        {"account": "B", "match_id": "shared", "champion": "Lux", "role": "MIDDLE", "queue": "420", "patch": "16.1", "win": 0},
        {"account": "A", "match_id": "next-a", "champion": "Ahri", "role": "MIDDLE", "queue": "420", "patch": "16.1", "win": 1},
        {"account": "B", "match_id": "next-b", "champion": "Lux", "role": "MIDDLE", "queue": "420", "patch": "16.1", "win": 0},
    ]

    fit = _fit(rows)

    assert fit["match_effect_levels"] == 3
    assert "shared" in fit["effects"]["match"]
    assert all(value in (0, 1) for value in (row["win"] for row in fit["rows"]))


def test_logistic_normal_delta_gradient_includes_attenuation_derivative():
    variances = {group: {} for group in ("account", "champion_role", "role", "queue", "patch", "match")}
    effects = {group: {} for group in variances}
    categories = {
        "account": "A", "champion_role": "Ahri\x1fMIDDLE", "role": "MIDDLE",
        "queue": "420", "patch": "16.1",
    }
    for group, category in categories.items():
        effects[group][category] = 0.0
        variances[group][category] = 0.25
    fit = {
        "intercept": 0.4, "intercept_variance": 0.25,
        "effects": effects, "variances": variances,
    }

    mean, _, _, gradients = _standardized_prediction(
        fit, ["A"], "MIDDLE", [(("420", "16.1"), 1.0)], "Ahri",
    )

    eta_variance = 0.25 * 6
    attenuation = math.sqrt(1.0 + math.pi * eta_variance / 8.0)
    expected = mean * (1.0 - mean) / attenuation
    assert gradients[("intercept", "")] == pytest.approx(expected)
    assert gradients[("account", "A")] == pytest.approx(expected)
