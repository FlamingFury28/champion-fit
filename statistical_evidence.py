"""Configurable binomial evidence with explicit uncertainty.

All rates and probabilities are fractions, not percentages. Counts describe raw
outcomes; attribution weights belong to a separate explanation layer. A supplied
baseline must contain observations disjoint from the local sample: these
calculations model the two posteriors as independent. ``None`` means an exact
reference (50% by default), whereas an empty sample retains the configured prior.

Family control is a conservative posterior error budget (a union bound over
both directions of every candidate), not a frequentist p-value or FDR claim.
"""

from __future__ import annotations

from functools import lru_cache
import math
from typing import Iterable

from algorithm_settings import current_settings


PRIOR_ALPHA = 4.0
PRIOR_BETA = 4.0
_INTEGRATION_TOLERANCE = 1e-8


def _configured_evidence() -> tuple[float, float, float, float, float, float]:
    """Read one immutable evidence configuration snapshot for a public call."""
    evidence = current_settings()["evidence"]
    prior_mean = float(evidence["prior_mean"])
    prior_strength = float(evidence["prior_strength"])
    return (
        prior_mean,
        prior_strength,
        float(evidence["credible_mass"]),
        float(evidence["meaningful_delta"]),
        float(evidence["family_alpha"]),
        float(evidence["min_games"]),
    )


def _prior_shapes(prior_mean: float, prior_strength: float) -> tuple[float, float]:
    prior_mean = float(prior_mean)
    prior_strength = _positive_shape(prior_strength, "prior_strength")
    if not 0.0 < prior_mean < 1.0:
        raise ValueError("prior_mean must be between 0 and 1")
    return prior_mean * prior_strength, (1.0 - prior_mean) * prior_strength


def _credible_tail(credible_mass: float) -> float:
    credible_mass = float(credible_mass)
    if not 0.0 < credible_mass < 1.0:
        raise ValueError("credible_mass must be between 0 and 1")
    return (1.0 - credible_mass) / 2.0


def _finite_nonnegative(value: float, name: str) -> float:
    result = float(value)
    if not math.isfinite(result) or result < 0:
        raise ValueError(f"{name} must be finite and nonnegative")
    return result


def _positive_shape(value: float, name: str) -> float:
    result = _finite_nonnegative(value, name)
    if result == 0:
        raise ValueError(f"{name} must be positive")
    return result


@lru_cache(maxsize=16384)
def _log_beta(a: float, b: float) -> float:
    return math.lgamma(a) + math.lgamma(b) - math.lgamma(a + b)


def _continued_fraction(x: float, a: float, b: float) -> float:
    """Modified Lentz evaluation of the incomplete-beta continued fraction."""
    tiny = 1e-300
    qab, qap, qam = a + b, a + 1.0, a - 1.0
    c = 1.0
    d = 1.0 - qab * x / qap
    if abs(d) < tiny:
        d = tiny
    d = 1.0 / d
    value = d
    for m in range(1, 501):
        m2 = 2 * m
        coefficient = m * (b - m) * x / ((qam + m2) * (a + m2))
        d = 1.0 + coefficient * d
        c = 1.0 + coefficient / c
        if abs(d) < tiny:
            d = tiny
        if abs(c) < tiny:
            c = tiny
        d = 1.0 / d
        value *= d * c
        coefficient = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2))
        d = 1.0 + coefficient * d
        c = 1.0 + coefficient / c
        if abs(d) < tiny:
            d = tiny
        if abs(c) < tiny:
            c = tiny
        d = 1.0 / d
        change = d * c
        value *= change
        if abs(change - 1.0) <= 3e-14:
            return value
    raise ArithmeticError("Incomplete-beta continued fraction did not converge")


def _cdf(x: float, a: float, b: float) -> float:
    """Internal CDF accepting out-of-support bounds for shifted comparisons."""
    if x <= 0.0:
        return 0.0
    if x >= 1.0:
        return 1.0
    front = math.exp(a * math.log(x) + b * math.log1p(-x) - _log_beta(a, b))
    if x < (a + 1.0) / (a + b + 2.0):
        result = front * _continued_fraction(x, a, b) / a
    else:
        result = 1.0 - front * _continued_fraction(1.0 - x, b, a) / b
    return min(1.0, max(0.0, result))


def beta_cdf(x: float, a: float, b: float) -> float:
    """Return the Beta(a, b) CDF; bounds outside [0, 1] give 0 or 1."""
    x = float(x)
    if not math.isfinite(x):
        raise ValueError("x must be finite")
    return _cdf(x, _positive_shape(a, "a"), _positive_shape(b, "b"))


@lru_cache(maxsize=32768)
def _quantile(q: float, a: float, b: float) -> float:
    if q == 0.0 or q == 1.0:
        return q
    lower, upper = 0.0, 1.0
    for _ in range(50):
        middle = (lower + upper) / 2.0
        if _cdf(middle, a, b) < q:
            lower = middle
        else:
            upper = middle
    return (lower + upper) / 2.0


def beta_quantile(q: float, a: float, b: float) -> float:
    """Invert the Beta CDF by deterministic bisection."""
    q = _finite_nonnegative(q, "q")
    if q > 1.0:
        raise ValueError("q must be at most 1")
    return _quantile(q, _positive_shape(a, "a"), _positive_shape(b, "b"))


@lru_cache(maxsize=16384)
def _summary(wins: float, losses: float, prior_alpha: float, prior_beta: float,
             credible_mass: float) -> tuple[float, ...]:
    """Cached summary with every model input represented in the cache key."""
    a, b = prior_alpha + wins, prior_beta + losses
    tail = _credible_tail(credible_mass)
    return (
        a, b, a / (a + b),
        _quantile(tail, a, b), _quantile(1.0 - tail, a, b),
        _quantile(0.05, a, b), _quantile(0.95, a, b),
    )


def posterior_summary(wins: float, losses: float, *, prior_mean: float | None = None,
                      prior_strength: float | None = None,
                      credible_mass: float | None = None) -> dict:
    """Return a configurable summary plus a genuine central 90% interval."""
    wins = _finite_nonnegative(wins, "wins")
    losses = _finite_nonnegative(losses, "losses")
    configured_mean, configured_strength, configured_mass, _, _, _ = _configured_evidence()
    prior_mean = configured_mean if prior_mean is None else float(prior_mean)
    prior_strength = configured_strength if prior_strength is None else float(prior_strength)
    credible_mass = configured_mass if credible_mass is None else float(credible_mass)
    prior_alpha, prior_beta = _prior_shapes(prior_mean, prior_strength)
    values = _summary(wins, losses, prior_alpha, prior_beta, credible_mass)
    result = dict(zip(("alpha", "beta", "mean", "lower", "upper", "lower_90", "upper_90"), values))
    result.update(prior_mean=prior_mean, prior_strength=prior_strength, credible_mass=credible_mass)
    return result


def _simpson(values_left, values_middle, values_right, width):
    return tuple(width * (left + 4.0 * middle + right) / 6.0
                 for left, middle, right in zip(values_left, values_middle, values_right))


def _integrate_segment(function, left, right, tolerance):
    """Adaptive Simpson for three probabilities, with an absolute error estimate."""
    middle = (left + right) / 2.0
    f_left, f_middle, f_right = function(left), function(middle), function(right)
    initial = _simpson(f_left, f_middle, f_right, right - left)

    def refine(lo, hi, f_lo, f_mid, f_hi, previous, budget, depth):
        mid = (lo + hi) / 2.0
        f_quarter = function((lo + mid) / 2.0)
        f_three_quarters = function((mid + hi) / 2.0)
        first = _simpson(f_lo, f_quarter, f_mid, mid - lo)
        second = _simpson(f_mid, f_three_quarters, f_hi, hi - mid)
        combined = tuple(a + b for a, b in zip(first, second))
        differences = tuple(a - b for a, b in zip(combined, previous))
        error = max(abs(value) for value in differences) / 15.0
        if error <= budget:
            return tuple(value + change / 15.0 for value, change in zip(combined, differences)), error
        if depth == 0:
            raise ArithmeticError("Posterior comparison integration did not converge")
        first_result, first_error = refine(lo, mid, f_lo, f_quarter, f_mid, first, budget / 2.0, depth - 1)
        second_result, second_error = refine(mid, hi, f_mid, f_three_quarters, f_hi, second, budget / 2.0, depth - 1)
        return tuple(a + b for a, b in zip(first_result, second_result)), first_error + second_error

    return refine(left, right, f_left, f_middle, f_right, initial, tolerance, 22)


def _independent_probabilities(a: float, b: float, base_a: float, base_b: float, delta: float):
    """Integrate P(local > base+delta), P(local < base-delta), P(local > base)."""
    base_mean = base_a / (base_a + base_b)
    base_sd = math.sqrt(base_mean * (1.0 - base_mean) / (base_a + base_b + 1.0))
    local_mean = a / (a + b)
    local_sd = math.sqrt(local_mean * (1.0 - local_mean) / (a + b + 1.0))
    base_log_beta = _log_beta(base_a, base_b)
    complements = (local_mean > base_mean + delta, local_mean < base_mean - delta,
                   local_mean > base_mean)

    def integrand(x):
        if x <= 0.0 or x >= 1.0:
            return (0.0, 0.0, 0.0)
        density = math.exp((base_a - 1.0) * math.log(x)
                           + (base_b - 1.0) * math.log1p(-x) - base_log_beta)
        # Integrating the smaller tail avoids repeatedly resolving an entire
        # unit-mass density when one posterior is far above the other.
        return (density * (_cdf(x + delta, a, b) if complements[0]
                           else _cdf(1.0 - x - delta, b, a)),
                density * (_cdf(1.0 - x + delta, b, a) if complements[1]
                           else _cdf(x - delta, a, b)),
                density * (_cdf(x, a, b) if complements[2]
                           else _cdf(1.0 - x, b, a)))

    # Explicit knots capture concentrated densities and CDF transitions. An
    # unsplit Simpson call can entirely miss a narrow peak far from x=0.5.
    knots = {0.0, 1.0}
    for multiplier in (-16, -8, -4, -2, -1, 0, 1, 2, 4, 8, 16):
        knots.add(min(1.0, max(0.0, base_mean + multiplier * base_sd)))
    for shift in (-delta, 0.0, delta):
        for multiplier in (-4, -2, 0, 2, 4):
            knots.add(min(1.0, max(0.0, local_mean + shift + multiplier * local_sd)))
    ordered = sorted(knots)
    results, errors = [], []
    budget = _INTEGRATION_TOLERANCE / (len(ordered) - 1)
    for left, right in zip(ordered, ordered[1:]):
        result, error = _integrate_segment(integrand, left, right, budget)
        results.append(result)
        errors.append(error)
    integrals = tuple(math.fsum(row[index] for row in results) for index in range(3))
    probabilities = tuple(min(1.0, max(0.0, 1.0 - value if complement else value))
                          for value, complement in zip(integrals, complements))
    return probabilities, math.fsum(errors)


@lru_cache(maxsize=8192)
def _comparison(wins, losses, baseline_wins, baseline_losses, delta, baseline_rate,
                prior_alpha, prior_beta, credible_mass):
    local = _summary(wins, losses, prior_alpha, prior_beta, credible_mass)
    a, b, mean, lower, upper, lower_90, upper_90 = local
    if baseline_wins is None:
        base_a = base_b = None
        base_mean = base_lower = base_upper = baseline_rate
        base_lower_90 = base_upper_90 = baseline_rate
        above = _cdf(1.0 - baseline_rate - delta, b, a)
        below = _cdf(baseline_rate - delta, a, b)
        directional_above = _cdf(1.0 - baseline_rate, b, a)
        integration_error = 0.0
    else:
        (base_a, base_b, base_mean, base_lower, base_upper,
         base_lower_90, base_upper_90) = _summary(
            baseline_wins, baseline_losses, prior_alpha, prior_beta, credible_mass,
        )
        (above, below, directional_above), integration_error = _independent_probabilities(a, b, base_a, base_b, delta)
    direction = "above" if mean > base_mean else "below" if mean < base_mean else "neutral"
    return (
        a, b, mean, lower, upper, lower_90, upper_90,
        base_mean, base_lower, base_upper, base_lower_90, base_upper_90,
        above, below, max(directional_above, 1.0 - directional_above),
        directional_above, max(above, below), direction, base_a, base_b, integration_error,
    )


def compare_posteriors(wins: float, losses: float, baseline_wins: float | None = None,
                       baseline_losses: float | None = None, delta: float | None = None,
                       baseline_rate: float = 0.5, *, prior_mean: float | None = None,
                       prior_strength: float | None = None,
                       credible_mass: float | None = None) -> dict:
    """Compare raw local outcomes with an independent baseline or fixed rate.

    ``prob_above`` and ``prob_below`` require a difference exceeding ``delta``.
    ``direction_probability`` concerns either direction with no minimum size.
    ``prob_direction_above`` gives P(local > baseline) without a size threshold.
    ``signal_probability`` is max(prob_above, prob_below). Results are fresh
    dictionaries; expensive numerical results are cached by counts and delta.
    ``baseline_rate`` defaults to 50% and only applies when counts are absent.
    """
    wins = _finite_nonnegative(wins, "wins")
    losses = _finite_nonnegative(losses, "losses")
    configured_mean, configured_strength, configured_mass, configured_delta, _, _ = _configured_evidence()
    prior_mean = configured_mean if prior_mean is None else float(prior_mean)
    prior_strength = configured_strength if prior_strength is None else float(prior_strength)
    credible_mass = configured_mass if credible_mass is None else float(credible_mass)
    delta = configured_delta if delta is None else _finite_nonnegative(delta, "delta")
    delta = _finite_nonnegative(delta, "delta")
    if delta > 1.0:
        raise ValueError("delta must be at most 1")
    baseline_rate = _finite_nonnegative(baseline_rate, "baseline_rate")
    if baseline_rate > 1.0:
        raise ValueError("baseline_rate must be at most 1")
    if (baseline_wins is None) != (baseline_losses is None):
        raise ValueError("Supply both baseline counts or neither")
    if baseline_wins is not None:
        baseline_wins = _finite_nonnegative(baseline_wins, "baseline_wins")
        baseline_losses = _finite_nonnegative(baseline_losses, "baseline_losses")
    prior_alpha, prior_beta = _prior_shapes(prior_mean, prior_strength)
    _credible_tail(credible_mass)
    keys = (
        "alpha", "beta", "mean", "lower", "upper", "lower_90", "upper_90",
        "baseline_mean", "baseline_lower", "baseline_upper", "baseline_lower_90", "baseline_upper_90",
        "prob_above", "prob_below", "direction_probability", "prob_direction_above", "signal_probability",
        "direction", "baseline_alpha", "baseline_beta", "integration_error_estimate",
    )
    result = dict(zip(keys, _comparison(
        wins, losses, baseline_wins, baseline_losses, delta,
        baseline_rate if baseline_wins is None else 0.5,
        prior_alpha, prior_beta, credible_mass,
    )))
    result.update(wins=wins, losses=losses, games=wins + losses,
                  baseline_wins=baseline_wins, baseline_losses=baseline_losses,
                  baseline_games=None if baseline_wins is None else baseline_wins + baseline_losses,
                  delta=delta, baseline_is_fixed=baseline_wins is None,
                  prior_mean=prior_mean, prior_strength=prior_strength,
                  credible_mass=credible_mass)
    return result


def apply_family_control(items: Iterable[dict], probability_key: str = "signal_probability",
                         output_key: str = "actionable", min_games: float | None = None,
                         alpha: float | None = None, games_key: str = "games") -> list[dict]:
    """Annotate all rows in place with a two-direction Bonferroni decision.

    The family includes insufficient samples. Call once on the complete family
    before ranking, filtering or truncating. Returns the rows in their original
    order; a probability threshold alone never overrides ``min_games``.
    """
    rows = list(items)
    _, _, _, _, configured_alpha, configured_min_games = _configured_evidence()
    min_games = configured_min_games if min_games is None else min_games
    alpha = configured_alpha if alpha is None else alpha
    min_games = _finite_nonnegative(min_games, "min_games")
    alpha = _finite_nonnegative(alpha, "alpha")
    if not 0.0 < alpha < 1.0:
        raise ValueError("alpha must be between 0 and 1")
    family_size = len(rows)
    if not family_size:
        return rows
    threshold = 1.0 - alpha / (2.0 * family_size)
    # Validate the complete family before mutating any caller-owned row.
    checked = []
    for item in rows:
        probability = _finite_nonnegative(item[probability_key], probability_key)
        if probability > 1.0:
            raise ValueError(f"{probability_key} must be at most 1")
        checked.append((item, probability, _finite_nonnegative(item[games_key], games_key)))
    for item, probability, games in checked:
        item.update({
            output_key: games >= min_games and probability >= threshold,
            "decision_threshold": threshold,
            "family_size": family_size,
            "adjusted_error_probability": min(1.0, 2.0 * family_size * (1.0 - probability)),
        })
    return rows
