"""Independent numerical and decision-contract checks; no operational DB."""

from fractions import Fraction
from concurrent.futures import ThreadPoolExecutor
import math
import unittest

from algorithm_settings import recommended_settings, settings_context
from statistical_evidence import (
    apply_family_control,
    beta_cdf,
    beta_quantile,
    compare_posteriors,
    posterior_summary,
)


def _multiply_polynomials(left, right):
    result = [Fraction(0)] * (len(left) + len(right) - 1)
    for i, a in enumerate(left):
        for j, b in enumerate(right):
            result[i + j] += a * b
    return result


def _linear_power(constant, slope, exponent):
    return [math.comb(exponent, k) * constant ** (exponent - k) * slope ** k
            for k in range(exponent + 1)]


def _exact_probability_above(a, b, base_a, base_b, delta):
    """Exact rational polynomial integration for small integer Beta shapes.

    Independent oracle: Beta survival is a finite binomial sum. Expand that
    polynomial, multiply by the baseline density, and integrate coefficients.
    No incomplete beta, numerical quadrature, or normal approximation is used.
    """
    n = a + b - 1
    survival = [Fraction(0)] * (n + 1)
    for j in range(a):
        product = _multiply_polynomials(
            _linear_power(delta, Fraction(1), j),
            _linear_power(1 - delta, Fraction(-1), n - j),
        )
        for k, value in enumerate(product):
            survival[k] += math.comb(n, j) * value
    baseline = [Fraction(0)] * (base_a - 1) + _linear_power(Fraction(1), Fraction(-1), base_b - 1)
    integrand = _multiply_polynomials(survival, baseline)
    normalization = Fraction(math.factorial(base_a + base_b - 1),
                             math.factorial(base_a - 1) * math.factorial(base_b - 1))
    return float(normalization * sum(value * (1 - delta) ** (k + 1) / (k + 1)
                                     for k, value in enumerate(integrand)))


class BetaNumericsTests(unittest.TestCase):
    def test_cdf_matches_analytic_distributions(self):
        for x in (0.0, 0.01, 0.1, 0.35, 0.5, 0.9, 0.99, 1.0):
            with self.subTest(x=x):
                self.assertAlmostEqual(beta_cdf(x, 1, 1), x, places=13)
                self.assertAlmostEqual(beta_cdf(x, 2, 2), 3 * x * x - 2 * x ** 3, places=13)
                self.assertAlmostEqual(beta_cdf(x, 0.5, 0.5), 2 * math.asin(math.sqrt(x)) / math.pi, places=13)

    def test_cdf_symmetry_and_quantiles_across_extreme_shapes(self):
        for a, b in ((4, 4), (6, 5), (104, 4), (4, 104), (5004, 5004), (10004, 4), (4, 10004)):
            for probability in (0.000001, 0.05, 0.5, 0.95, 0.999999):
                with self.subTest(a=a, b=b, probability=probability):
                    quantile = beta_quantile(probability, a, b)
                    self.assertAlmostEqual(beta_cdf(quantile, a, b), probability, delta=2e-9)
                    self.assertAlmostEqual(beta_cdf(quantile, a, b) + beta_cdf(1 - quantile, b, a), 1, delta=2e-10)
                    self.assertAlmostEqual(quantile, 1 - beta_quantile(1 - probability, b, a), delta=2e-10)
        self.assertEqual(beta_quantile(0, 4, 4), 0)
        self.assertEqual(beta_quantile(1, 4, 4), 1)

    def test_empty_and_tiny_samples_use_only_fixed_prior(self):
        empty = posterior_summary(0, 0)
        self.assertEqual((empty["alpha"], empty["beta"], empty["mean"]), (4, 4, 0.5))
        for wins, losses in ((2, 1), (3, 0)):
            with self.subTest(wins=wins, losses=losses):
                summary = posterior_summary(wins, losses)
                self.assertEqual(summary["alpha"], 4 + wins)
                self.assertEqual(summary["beta"], 4 + losses)
                self.assertLess(summary["lower_90"], 0.5)
                self.assertGreater(summary["upper_90"], 0.5)
                self.assertGreater(summary["upper_90"] - summary["lower_90"], 0.4)
        self.assertAlmostEqual(posterior_summary(2, 1)["mean"], 6 / 11)
        self.assertAlmostEqual(posterior_summary(3, 0)["mean"], 7 / 11)

    def test_configured_prior_and_interval_keep_real_ninety_percent_aliases(self):
        configured = recommended_settings()
        configured["evidence"].update({"prior_mean": 0.6, "prior_strength": 10, "credible_mass": 0.8})
        with settings_context(configured, revision=7):
            summary = posterior_summary(2, 3)
        self.assertEqual((summary["alpha"], summary["beta"]), (8, 7))
        self.assertAlmostEqual(summary["mean"], 8 / 15)
        self.assertEqual(summary["credible_mass"], 0.8)
        self.assertGreater(summary["lower"], summary["lower_90"])
        self.assertLess(summary["upper"], summary["upper_90"])
        default = posterior_summary(2, 3)
        self.assertAlmostEqual(default["mean"], 6 / 13)
        self.assertNotEqual(default["lower"], summary["lower"])

    def test_context_local_model_inputs_do_not_leak_or_reuse_stale_cache_entries(self):
        def evaluate(mean):
            configured = recommended_settings()
            configured["evidence"]["prior_mean"] = mean
            with settings_context(configured):
                first = posterior_summary(0, 0)
                second = compare_posteriors(12, 8)
                return first["mean"], second["mean"]

        with ThreadPoolExecutor(max_workers=2) as pool:
            left, right = list(pool.map(evaluate, (0.4, 0.6)))
        self.assertAlmostEqual(left[0], 0.4)
        self.assertAlmostEqual(left[1], (12 + 3.2) / 28)
        self.assertAlmostEqual(right[0], 0.6)
        self.assertAlmostEqual(right[1], (12 + 4.8) / 28)
        self.assertEqual(posterior_summary(0, 0)["mean"], 0.5)

    def test_extreme_outcomes_remain_finite_and_inside_support(self):
        for wins, losses in ((0, 100), (100, 0), (5000, 0), (0, 5000), (10000, 0), (0, 10000)):
            with self.subTest(wins=wins, losses=losses):
                result = posterior_summary(wins, losses)
                self.assertTrue(all(math.isfinite(value) for value in result.values()))
                self.assertGreater(result["lower_90"], 0)
                self.assertLess(result["lower_90"], result["mean"])
                self.assertLess(result["mean"], result["upper_90"])
                self.assertLess(result["upper_90"], 1)

    def test_invalid_inputs_fail_explicitly(self):
        for wins, losses in ((-1, 0), (0, -1), (float("nan"), 0), (0, float("inf"))):
            with self.assertRaises(ValueError):
                posterior_summary(wins, losses)
        for arguments in ((0.5, 0, 4), (0.5, 4, -1), (float("nan"), 4, 4)):
            with self.assertRaises(ValueError):
                beta_cdf(*arguments)
        for q in (-0.1, 1.1, float("nan")):
            with self.assertRaises(ValueError):
                beta_quantile(q, 4, 4)


class PosteriorComparisonTests(unittest.TestCase):
    def test_fixed_reference_probability_matches_exact_binomial_tail(self):
        result = compare_posteriors(2, 1, delta=0)
        # Beta(6, 5) survival at 0.5 is P(Binomial(10, 0.5) <= 5).
        expected = sum(math.comb(10, j) for j in range(6)) / 2 ** 10
        self.assertAlmostEqual(result["prob_above"], expected, places=13)
        self.assertAlmostEqual(result["prob_below"], 1 - expected, places=13)
        self.assertEqual(result["baseline_mean"], 0.5)
        self.assertEqual(result["baseline_lower_90"], result["baseline_upper_90"])
        self.assertIsNone(result["baseline_wins"])
        self.assertIsNone(result["baseline_losses"])
        self.assertTrue(result["baseline_is_fixed"])

    def test_independent_comparison_matches_exact_polynomial_integral(self):
        for wins, losses, base_wins, base_losses, delta in (
            (2, 1, 1, 2, Fraction(3, 100)),
            (3, 0, 0, 3, Fraction(1, 10)),
            (1, 2, 2, 1, Fraction(0)),
        ):
            with self.subTest(counts=(wins, losses, base_wins, base_losses), delta=delta):
                result = compare_posteriors(wins, losses, base_wins, base_losses, delta=float(delta))
                expected_above = _exact_probability_above(4 + wins, 4 + losses, 4 + base_wins, 4 + base_losses, delta)
                expected_below = _exact_probability_above(4 + base_wins, 4 + base_losses, 4 + wins, 4 + losses, delta)
                expected_direction = _exact_probability_above(4 + wins, 4 + losses, 4 + base_wins, 4 + base_losses, Fraction(0))
                self.assertAlmostEqual(result["prob_above"], expected_above, delta=2e-9)
                self.assertAlmostEqual(result["prob_below"], expected_below, delta=2e-9)
                self.assertAlmostEqual(result["prob_direction_above"], expected_direction, delta=2e-9)
                self.assertAlmostEqual(result["direction_probability"], max(expected_direction, 1 - expected_direction), delta=2e-9)
                self.assertLess(result["integration_error_estimate"], 1e-8)

    def test_uncertain_baseline_is_not_an_exact_rate(self):
        fixed = compare_posteriors(75, 25)
        uncertain = compare_posteriors(75, 25, 0, 0)
        self.assertEqual(fixed["baseline_mean"], uncertain["baseline_mean"])
        self.assertLess(uncertain["prob_above"], fixed["prob_above"] - 0.1)
        self.assertLess(uncertain["direction_probability"], fixed["direction_probability"])
        self.assertGreater(uncertain["baseline_upper_90"] - uncertain["baseline_lower_90"], 0.5)
        self.assertEqual(uncertain["baseline_games"], 0)
        self.assertFalse(uncertain["baseline_is_fixed"])

    def test_fixed_reference_can_be_explicit_for_legacy_callers(self):
        result = compare_posteriors(60, 40, baseline_rate=0.6)
        self.assertEqual(result["baseline_mean"], 0.6)
        self.assertEqual(result["baseline_lower_90"], 0.6)
        self.assertEqual(result["baseline_upper_90"], 0.6)
        self.assertAlmostEqual(result["prob_below"], beta_cdf(0.57, 64, 44), delta=1e-12)
        self.assertEqual(compare_posteriors(60, 40, 20, 20, baseline_rate=0.6),
                         compare_posteriors(60, 40, 20, 20, baseline_rate=0.1))

    def test_reflecting_wins_and_losses_reverses_sign_without_changing_certainty(self):
        for counts in ((12, 8, 50, 40), (0, 100, 30, 70), (10000, 0, 9990, 10)):
            with self.subTest(counts=counts):
                wins, losses, base_wins, base_losses = counts
                forward = compare_posteriors(*counts)
                reflected = compare_posteriors(losses, wins, base_losses, base_wins)
                self.assertAlmostEqual(forward["prob_above"], reflected["prob_below"], delta=1e-8)
                self.assertAlmostEqual(forward["prob_below"], reflected["prob_above"], delta=1e-8)
                self.assertAlmostEqual(forward["direction_probability"], reflected["direction_probability"], delta=1e-8)

    def test_large_concentrated_distributions_do_not_lose_density_peaks(self):
        same = compare_posteriors(5000, 5000, 5000, 5000, delta=0)
        self.assertAlmostEqual(same["prob_above"], 0.5, delta=1e-8)
        self.assertAlmostEqual(same["prob_below"], 0.5, delta=1e-8)
        extremes = compare_posteriors(10000, 0, 0, 10000)
        self.assertAlmostEqual(extremes["prob_above"], 1, delta=1e-8)
        self.assertAlmostEqual(extremes["prob_below"], 0, delta=1e-8)
        near_boundary = compare_posteriors(0, 10000, 0, 10000, delta=0)
        self.assertAlmostEqual(near_boundary["prob_above"], 0.5, delta=1e-8)
        self.assertAlmostEqual(near_boundary["prob_below"], 0.5, delta=1e-8)

    def test_delta_probability_is_distinct_from_direction_probability(self):
        result = compare_posteriors(60, 40, 50, 50, delta=0.1)
        self.assertGreater(result["direction_probability"], result["signal_probability"])
        self.assertEqual(result["signal_probability"], max(result["prob_above"], result["prob_below"]))
        impossible = compare_posteriors(60, 40, 50, 50, delta=1)
        self.assertEqual(impossible["prob_above"], 0)
        self.assertEqual(impossible["prob_below"], 0)

    def test_cached_values_cannot_be_mutated_by_callers(self):
        result = compare_posteriors(2, 1)
        result["mean"] = -100
        self.assertAlmostEqual(compare_posteriors(2, 1)["mean"], 6 / 11)
        summary = posterior_summary(2, 1)
        summary["mean"] = -100
        self.assertAlmostEqual(posterior_summary(2, 1)["mean"], 6 / 11)

    def test_partial_baseline_and_invalid_delta_are_rejected(self):
        for kwargs in ({"baseline_wins": 0}, {"baseline_losses": 0},
                       {"delta": -0.1}, {"delta": 1.1}, {"baseline_rate": 1.1}):
            with self.assertRaises(ValueError):
                compare_posteriors(2, 1, **kwargs)


class FamilyControlTests(unittest.TestCase):
    def test_family_uses_both_directions_and_all_rows_before_filtering(self):
        single = [{"games": 100, "signal_probability": 0.99}]
        self.assertTrue(apply_family_control(single)[0]["actionable"])
        self.assertEqual(single[0]["decision_threshold"], 0.975)
        family = [{"games": 100, "signal_probability": 0.99}]
        family += [{"games": 3, "signal_probability": 1.0} for _ in range(99)]
        result = apply_family_control(family)
        self.assertEqual(len(result), 100)
        self.assertFalse(any(row["actionable"] for row in result))
        self.assertIs(result[0], family[0])
        self.assertEqual(result[0]["family_size"], 100)
        self.assertAlmostEqual(result[0]["decision_threshold"], 0.99975)
        self.assertEqual(result[0]["adjusted_error_probability"], 1)

    def test_error_budget_and_custom_keys(self):
        rows = [{"games": 20, "prob": 0.9999}, {"games": 19, "prob": 1.0},
                {"games": 50, "prob": 0.9}]
        result = apply_family_control(rows, probability_key="prob", output_key="selected", alpha=0.01)
        self.assertEqual([row["selected"] for row in result], [True, False, False])
        self.assertAlmostEqual(result[0]["adjusted_error_probability"], 0.0006)
        self.assertTrue(all(row["adjusted_error_probability"] <= 0.01
                            for row in result if row["selected"]))

    def test_validation_precedes_mutation_and_empty_family_is_supported(self):
        self.assertEqual(apply_family_control([]), [])
        rows = [{"games": 20, "signal_probability": 0.999}, {"games": 30, "signal_probability": 1.01}]
        with self.assertRaises(ValueError):
            apply_family_control(rows)
        self.assertNotIn("actionable", rows[0])

    def test_defaults_are_read_from_one_settings_context(self):
        configured = recommended_settings()
        configured["evidence"].update({"family_alpha": 0.01, "min_games": 25})
        rows = [{"games": 24, "signal_probability": 1.0},
                {"games": 25, "signal_probability": 0.998}]
        with settings_context(configured):
            result = apply_family_control(rows)
        self.assertFalse(result[0]["actionable"])
        self.assertTrue(result[1]["actionable"])
        self.assertEqual(result[1]["decision_threshold"], 0.9975)


if __name__ == "__main__":
    unittest.main()
