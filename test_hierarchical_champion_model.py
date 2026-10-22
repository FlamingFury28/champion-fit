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


def test_supported_negative_history_is_not_a_positive_competitive_signal(monkeypatch):
    import hierarchical_champion_model as model
    rows = [{"account": "A", "match_id": f"{champion}-{i}", "champion": champion,
             "role": "MIDDLE", "queue": "420", "patch": "16.1", "win": win}
            for champion, win in (("Ahri", 0), ("Lux", 1)) for i in range(100)]
    # Check both current exploratory and hypothetical validated branches.
    for validated in (False, True):
        monkeypatch.setattr(model, "MODEL_VALIDATED", validated)
        items = {item["champion"]: item for item in model._predict(rows, ["A"], model._fit(rows), current_settings())["items"]}
        negative = items["Ahri"]
        assert negative["historical_performance"]["supported"]
        assert negative["historical_direction"] == "worse"
        assert not negative["historical_supported"]
        assert not negative["actionable"]
        assert not negative["validated_positive"]
        assert negative["classification"] != "supported"
        assert items["Lux"]["historical_supported"]


def test_solver_reports_iteration_limit_and_final_gradient_independently(monkeypatch):
    import hierarchical_champion_model as model
    rows = [{"account": "A", "match_id": f"M{i}", "champion": "Ahri",
             "role": "MIDDLE", "queue": "420", "patch": "16.1", "win": int(i < 8)}
            for i in range(10)]
    monkeypatch.setattr(model, "_MAX_ITERATIONS", 1)
    fit = model._fit(rows)
    diagnostic = fit["diagnostics"]
    assert diagnostic["iterations"] == 1
    assert not diagnostic["converged"]
    assert diagnostic["final_max_change"] >= diagnostic["convergence_tolerance"]
    # Reconstruct the final penalized intercept gradient from coefficients.
    gradient = -fit["intercept"] / model._INTERCEPT_SD ** 2
    for row in rows:
        eta = fit["intercept"] + sum(fit["effects"][group][category]
                                       for group, category in model._row_features(row).items())
        gradient += row["win"] - model._logistic(eta)
    assert diagnostic["gradient_max_abs"] >= abs(gradient) - 1e-12
    assert model._fit([])["diagnostics"]["empty_sample"]
    assert model.MODEL_VALIDATED is False


def test_model_cache_singleflight_isolates_results_and_invalidates_inputs(monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    from copy import deepcopy
    import threading
    import hierarchical_champion_model as model
    model._CACHE.clear()
    rows = [{"account": "A", "match_id": "M1", "champion": "Ahri", "role": "MIDDLE",
             "queue": "420", "patch": "16.1", "win": 1}]
    started, release = threading.Event(), threading.Event()
    calls = []
    original = model._fit
    def tracked(values):
        calls.append(1)
        started.set()
        assert release.wait(5)
        return original(values)
    monkeypatch.setattr(model, "_fit", tracked)
    with ThreadPoolExecutor(2) as pool:
        first = pool.submit(model.analyze, rows, ["A"])
        assert started.wait(5)
        second = pool.submit(model.analyze, rows, ["A"])
        release.set()
        results = [first.result(timeout=5), second.result(timeout=5)]
    assert len(calls) == 1
    results[0]["items"].clear()
    assert results[1]["items"]
    assert model.analyze(rows, ["A"])["items"]
    for field, value in (("win", 0), ("patch", "16.2"), ("champion", "Lux"),
                         ("match_id", "M2"), ("queue", "440"), ("role", "TOP")):
        changed = deepcopy(rows)
        changed[0][field] = value
        model.analyze(changed, ["A"])
    model.analyze(rows, ["A", "B"])
    settings = model._jsonable(model.current_settings())
    settings["evidence"]["credible_mass"] = .8
    monkeypatch.setattr(model, "current_settings", lambda: settings)
    result = model.analyze(rows, ["A"])
    assert result["items"][0]["credible_mass"] == .8
    assert len(calls) == 9
    assert len(model._CACHE) <= 8


def test_model_failure_is_not_cached(monkeypatch):
    import hierarchical_champion_model as model
    model._CACHE.clear()
    original = model._fit
    def fail(rows):
        raise ValueError("synthetic fit failure")
    monkeypatch.setattr(model, "_fit", fail)
    with pytest.raises(ValueError, match="synthetic"):
        model.analyze([], ["A"])
    monkeypatch.setattr(model, "_fit", original)
    assert model.analyze([], ["A"])["diagnostics"]["empty_sample"]


def test_model_timings_and_cache_hits_are_request_local():
    import hierarchical_champion_model as model
    from runtime_metrics import metrics_scope
    model._CACHE.clear()
    with metrics_scope("synthetic_model_test") as metrics:
        model.analyze([], ["synthetic"])
        model.analyze([], ["synthetic"])
    assert metrics["model_fit_calls"] == 1
    assert metrics["model_predict_calls"] == 1
    assert metrics["model_fit_ms"] >= 0
    assert metrics["model_cache_hit"] == 1
