import pytest

from validate_competitive_training_plan import benchmark, exact_regret


def test_exact_reference_matches_uniform_arms_analytically():
    # E[max(U,V)] = 2/3, posterior means are initially 1/2.
    assert exact_regret([(1, 1), (1, 1)], [0, 0]) == pytest.approx(1 / 6)
    # One observation selects 2/3 after a win and the unchanged 1/2 after a loss.
    assert exact_regret([(1, 1), (1, 1)], [1, 0]) == pytest.approx(1 / 12)
    assert exact_regret([(1, 1), (1, 1)], [0, 1]) == pytest.approx(1 / 12)


def test_benchmark_reports_exact_optimum_seed_stability_and_preserves_defaults():
    result = benchmark(seeds=(11, 29), scenarios=(4, 8), evaluation_scenarios=32)
    assert result["protocol"]["synthetic_only"]
    assert not result["protocol"]["promotes_model"]
    assert not result["protocol"]["changes_default_scenarios"]
    for case in result["cases"]:
        assert len(case["runs"]) == 4
        assert len(case["stability"]) == 2
        assert case["exact_optimum_allocations"]
        for run in case["runs"]:
            assert sum(run["allocation"]) == 20
            assert run["excess_regret_vs_exact_optimum"] >= -1e-12
            assert run["monte_carlo_se"] >= 0


@pytest.mark.parametrize("options", [{"seeds": []}, {"scenarios": [0]}, {"budget": 31}, {"evaluation_scenarios": True}])
def test_benchmark_rejects_unsupported_reference_controls(options):
    with pytest.raises(ValueError):
        benchmark(**options)
