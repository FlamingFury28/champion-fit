"""Account-standardized raw-outcome evidence using the shared Beta model.

The target is one fixed, equally weighted set of accounts. Missing local cells
retain their neutral prior; an absent baseline is the explicit fixed 50% null.
For multiple accounts, intervals and probability *lower bounds* use only
marginal quantiles and the union bound. They need no independence assumption
between accounts. The separate one-account comparison retains the shared
model's exact numerical integration and its disjoint-sample assumption.
"""
from __future__ import annotations

from collections import defaultdict
import math

from algorithm_settings import current_settings
from statistical_evidence import beta_quantile, compare_posteriors


# Guard strict event comparisons against quantile/float boundary noise. This
# absolute margin (rates are fractions) exceeds the shared quantile solver's
# 50-bisection resolution (~9e-16). It is a practical boundary guard, NOT a
# certified bound on the CDF/quantile approximation's total numerical error.
STRICT_COMPARISON_MARGIN = 1e-10


def _strictly_exceeds(lower_bound, delta):
    # Marginal continuity does not rule out atoms in a dependent difference:
    # D >= lower_bound only certifies D > delta when lower_bound > delta.
    return lower_bound > delta + STRICT_COMPARISON_MARGIN


def _count(value, name):
    value = float(value)
    if not math.isfinite(value) or value < 0:
        raise ValueError(f"{name} must be finite and nonnegative")
    return value


def _prepare(cells, accounts, prior_alpha, prior_beta):
    target = sorted(set(str(account) for account in accounts))
    if not target:
        raise ValueError("At least one target account is required")
    result = []
    for account in target:
        cell = cells.get(account, {})
        wins = _count(cell.get("wins", 0), "wins")
        losses = _count(cell.get("losses", 0), "losses")
        baseline_wins, baseline_losses = cell.get("baseline_wins"), cell.get("baseline_losses")
        if (baseline_wins is None) != (baseline_losses is None):
            raise ValueError("Supply both baseline counts or neither")
        if baseline_wins is not None:
            baseline_wins = _count(baseline_wins, "baseline_wins")
            baseline_losses = _count(baseline_losses, "baseline_losses")
            # Opt-in for descriptive contrasts that retain an unobserved Beta
            # prior. Existing consumers keep their explicit fixed-50% fallback.
            if baseline_wins + baseline_losses == 0 and not cell.get("baseline_prior_only", False):
                baseline_wins = baseline_losses = None
        result.append({
            "account": account, "wins": wins, "losses": losses,
            "baseline_wins": baseline_wins, "baseline_losses": baseline_losses,
            "local_shapes": (prior_alpha + wins, prior_beta + losses),
            "baseline_shapes": None if baseline_wins is None else
                (prior_alpha + baseline_wins, prior_beta + baseline_losses),
        })
    return result


def _validate_delta(delta):
    delta = _count(delta, "delta")
    if delta > 1.0:
        raise ValueError("delta must be at most one")
    return delta


def _quantile_bounds(prepared, tail):
    values = []
    for cell in prepared:
        local_a, local_b = cell["local_shapes"]
        lower = beta_quantile(tail, local_a, local_b)
        upper = beta_quantile(1.0 - tail, local_a, local_b)
        if cell["baseline_shapes"] is None:
            base_lower = base_upper = .5
        else:
            base_a, base_b = cell["baseline_shapes"]
            base_lower = beta_quantile(tail, base_a, base_b)
            base_upper = beta_quantile(1.0 - tail, base_a, base_b)
        values.append((lower, upper, base_lower, base_upper))
    count = len(prepared)
    return tuple(math.fsum(row[index] for row in values) / count for index in range(4))


def _difference_lower(prepared, risk, above):
    """A signed difference floor holding with probability at least 1-risk."""
    count = len(prepared)
    tail = risk / (2.0 * count)
    differences = []
    for cell in prepared:
        local_a, local_b = cell["local_shapes"]
        if above:
            local = beta_quantile(tail, local_a, local_b)
            reference = .5 if cell["baseline_shapes"] is None else beta_quantile(1.0 - tail, *cell["baseline_shapes"])
            differences.append(local - reference)
        else:
            local = beta_quantile(1.0 - tail, local_a, local_b)
            reference = .5 if cell["baseline_shapes"] is None else beta_quantile(tail, *cell["baseline_shapes"])
            differences.append(reference - local)
    return math.fsum(differences) / count


def _probability_bound(prepared, delta, above, iterations=20):
    # If even risk=1 cannot certify the difference, the lower bound is zero.
    if not _strictly_exceeds(_difference_lower(prepared, 1.0, above), delta):
        return 0.0
    low, high = 0.0, 1.0
    for _ in range(iterations):
        middle = (low + high) / 2.0
        if _strictly_exceeds(_difference_lower(prepared, middle, above), delta):
            high = middle  # Certified side: returning 1-high is conservative.
        else:
            low = middle
    return max(0.0, 1.0 - high)


def _coverage(prepared, prior_strength):
    missing = [cell["account"] for cell in prepared if cell["wins"] + cell["losses"] == 0]
    missing_baseline = [
        cell["account"] for cell in prepared
        if (cell["baseline_wins"] or 0) + (cell["baseline_losses"] or 0) == 0
    ]
    count = len(prepared)
    return {
        "accounts": [cell["account"] for cell in prepared],
        "account_count": count, "account_weighting": "equal",
        "observed_account_count": count - len(missing),
        "observed_accounts": count - len(missing),
        "missing_accounts": missing, "account_coverage": (count - len(missing)) / count,
        "missing_baseline_accounts": missing_baseline,
        "baseline_account_coverage": (count - len(missing_baseline)) / count,
        "fixed_baseline_accounts": [cell["account"] for cell in prepared if cell["baseline_shapes"] is None],
        "support_per_account": {
            cell["account"]: {
                "games": cell["wins"] + cell["losses"],
                "baseline_games": (cell["baseline_wins"] or 0) + (cell["baseline_losses"] or 0),
                "local_missing": cell["wins"] + cell["losses"] == 0,
                "baseline_missing": (cell["baseline_wins"] or 0) + (cell["baseline_losses"] or 0) == 0,
            } for cell in prepared
        },
        "prior_share": math.fsum(prior_strength / (prior_strength + cell["wins"] + cell["losses"])
                                 for cell in prepared) / count,
    }


def stratified_summary(cells: dict, accounts: list[str], delta: float | None = None,
                       *, probability_iterations: int = 0,
                       prior_mean: float | None = None,
                       prior_strength: float | None = None,
                       credible_mass: float | None = None) -> dict:
    """Summarize equal-account means and conservative comparison evidence.

    All numerical rates/probabilities are fractions. For K>1, ``prob_above``,
    ``prob_below`` and both directional fields are probability LOWER BOUNDS,
    not complementary exact probabilities. In particular, never replace
    ``prob_direction_below`` with ``1 - prob_direction_above``. The bound can
    be zero when evidence is weak; this does not estimate event probability
    as zero. The fast default reports coarse 0/configured-mass bounds from the
    configured marginal intervals. Use ``stratified_gate_bound`` for a decision
    at the caller's family threshold. For offline analysis only, requesting
    ``probability_iterations=20`` refines these bounds by risk bisection.
    No sample-size or multiple-candidate gate is applied here.
    """
    evidence = current_settings()["evidence"]
    prior_mean = float(evidence["prior_mean"] if prior_mean is None else prior_mean)
    prior_strength = float(evidence["prior_strength"] if prior_strength is None else prior_strength)
    credible_mass = float(evidence["credible_mass"] if credible_mass is None else credible_mass)
    delta = evidence["meaningful_delta"] if delta is None else delta
    if not 0.0 < prior_mean < 1.0 or prior_strength <= 0:
        raise ValueError("prior mean and strength must define positive Beta shapes")
    if not 0.0 < credible_mass < 1.0:
        raise ValueError("credible_mass must be between zero and one")
    prior_alpha = prior_mean * prior_strength
    prior_beta = (1.0 - prior_mean) * prior_strength
    prepared = _prepare(cells, accounts, prior_alpha, prior_beta)
    delta = _validate_delta(delta)
    if probability_iterations not in (0, 20):
        raise ValueError("probability_iterations must be zero (fast) or twenty (refined)")
    count = len(prepared)
    if count == 1:
        cell = prepared[0]
        result = compare_posteriors(
            cell["wins"], cell["losses"], cell["baseline_wins"], cell["baseline_losses"],
            delta=delta, prior_mean=prior_mean, prior_strength=prior_strength,
            credible_mass=credible_mass,
        )
        result.update(prob_direction_below=1.0 - result["prob_direction_above"],
                      probmethod="exact_single_account", probability_method="exact_single_account", interval_method="beta_exact",
                      probabilities_are_lower_bounds=False, **_coverage(prepared, prior_strength))
        return result
    tail = (1.0 - credible_mass) / (2.0 * count)
    lower, upper, base_lower, base_upper = _quantile_bounds(prepared, tail)
    lower_90, upper_90, base_lower_90, base_upper_90 = _quantile_bounds(prepared, .05 / count)
    local_means = [cell["local_shapes"][0] / sum(cell["local_shapes"]) for cell in prepared]
    base_means = [.5 if cell["baseline_shapes"] is None else cell["baseline_shapes"][0] / sum(cell["baseline_shapes"])
                  for cell in prepared]
    mean = math.fsum(local_means) / count
    baseline_mean = math.fsum(base_means) / count
    if probability_iterations:
        above = _probability_bound(prepared, delta, True, probability_iterations)
        below = _probability_bound(prepared, delta, False, probability_iterations)
        direction_above = above if delta == 0 else _probability_bound(prepared, 0.0, True, probability_iterations)
        direction_below = below if delta == 0 else _probability_bound(prepared, 0.0, False, probability_iterations)
    else:
        # Each direction uses K lower and K upper ONE-SIDED bounds, each
        # with tail (1-mass)/(2K): total risk <= 1-mass without independence.
        above = credible_mass if _strictly_exceeds(lower - base_upper, delta) else 0.0
        below = credible_mass if _strictly_exceeds(base_lower - upper, delta) else 0.0
        direction_above = credible_mass if _strictly_exceeds(lower - base_upper, 0.0) else 0.0
        direction_below = credible_mass if _strictly_exceeds(base_lower - upper, 0.0) else 0.0
    return {
        "mean": mean, "lower": lower, "upper": upper,
        "lower_90": lower_90, "upper_90": upper_90, "credible_mass": credible_mass,
        "baseline_mean": baseline_mean, "baseline_lower": base_lower, "baseline_upper": base_upper,
        "baseline_lower_90": base_lower_90, "baseline_upper_90": base_upper_90,
        "prob_above": above, "prob_below": below,
        "prob_direction_above": direction_above, "prob_direction_below": direction_below,
        "direction_probability": max(direction_above, direction_below),
        "signal_probability": max(above, below),
        "direction": "above" if mean > baseline_mean else "below" if mean < baseline_mean else "neutral",
        "delta": delta, "probmethod": "conservative_marginal_bound", "probability_method": "conservative_marginal_bound",
        "probabilities_are_lower_bounds": True,
        "probability_resolution": 2.0 ** -20 if probability_iterations else None,
        "probability_evaluation": ("risk_bisection_20" if probability_iterations else
                                   "interval_bound_90" if credible_mass == .9 else
                                   "configured_interval_bound"),
        "interval_method": "bonferroni_marginal_mean", "baseline_is_fixed": all(cell["baseline_shapes"] is None for cell in prepared),
        "wins": math.fsum(cell["wins"] for cell in prepared),
        "losses": math.fsum(cell["losses"] for cell in prepared),
        "observations": math.fsum(cell["wins"] + cell["losses"] for cell in prepared),
        "prior_mean": prior_mean, "prior_strength": prior_strength,
        **_coverage(prepared, prior_strength),
    }


def stratified_gate_bound(cells: dict, accounts: list[str], threshold: float,
                          delta: float | None = None, *, prior_mean: float | None = None,
                          prior_strength: float | None = None,
                          credible_mass: float | None = None) -> dict:
    """Certify a probability threshold with one risk evaluation per direction.

    This cheap gate is equivalent to asking whether the marginal construction
    can certify the supplied probability. It does not require approximate
    probability inversion and does not apply the caller's independent-game
    minimum or candidate-family accounting.
    """
    evidence = current_settings()["evidence"]
    prior_mean = float(evidence["prior_mean"] if prior_mean is None else prior_mean)
    prior_strength = float(evidence["prior_strength"] if prior_strength is None else prior_strength)
    credible_mass = float(evidence["credible_mass"] if credible_mass is None else credible_mass)
    delta = evidence["meaningful_delta"] if delta is None else delta
    if not 0.0 < prior_mean < 1.0 or prior_strength <= 0:
        raise ValueError("prior mean and strength must define positive Beta shapes")
    if not 0.0 < credible_mass < 1.0:
        raise ValueError("credible_mass must be between zero and one")
    prepared = _prepare(
        cells, accounts, prior_mean * prior_strength, (1.0 - prior_mean) * prior_strength,
    )
    delta = _validate_delta(delta)
    threshold = _count(threshold, "threshold")
    if threshold > 1:
        raise ValueError("threshold must be at most one")
    if len(prepared) == 1:
        cell = prepared[0]
        result = compare_posteriors(
            cell["wins"], cell["losses"], cell["baseline_wins"], cell["baseline_losses"],
            delta=delta, prior_mean=prior_mean, prior_strength=prior_strength,
            credible_mass=credible_mass,
        )
        return {"above": result["prob_above"] >= threshold, "below": result["prob_below"] >= threshold,
                "above_probability_bound": result["prob_above"], "below_probability_bound": result["prob_below"],
                "threshold": threshold, "delta": delta, "probmethod": "exact_single_account",
                "probability_method": "exact_single_account"}
    if threshold == 0.0:
        return {"above": True, "below": True, "above_probability_bound": 0.0,
                "below_probability_bound": 0.0, "threshold": threshold, "delta": delta,
                "probmethod": "conservative_marginal_bound", "probability_method": "conservative_marginal_bound"}
    risk = 1.0 - threshold
    above_lower = _difference_lower(prepared, risk, True)
    below_lower = _difference_lower(prepared, risk, False)
    above_certified = _strictly_exceeds(above_lower, delta)
    below_certified = _strictly_exceeds(below_lower, delta)
    return {"above": above_certified, "below": below_certified,
            "above_probability_bound": threshold if above_certified else 0.0,
            "below_probability_bound": threshold if below_certified else 0.0,
            "above_difference_lower": above_lower, "below_difference_lower": below_lower,
            "threshold": threshold, "delta": delta, "probmethod": "conservative_marginal_bound",
            "probability_method": "conservative_marginal_bound"}


def aggregate_stratified_candidates(rows: list[dict]) -> dict:
    """Build per-account candidate/baseline cells from deduplicated raw rows.

    A duplicate (account, match_id) is ignored only when its champion, role and
    binary outcome agree; conflicting rows fail. Every candidate's match IDs
    are excluded globally from all of its account baselines, including other
    accounts' rows for that same match. ``observations``/``wins``/``losses``
    count account rows; ``unique_games`` counts distinct matches and is kept
    separate for an independent-game gate. Different accounts may have
    opposite results in one game, so wins are never divided by unique_games.
    """
    distinct = {}
    for row in rows:
        if row["account"] is None or row["match_id"] is None:
            raise ValueError("account and match_id must be nonempty")
        account, match_id = str(row["account"]), str(row["match_id"])
        if not account or not match_id:
            raise ValueError("account and match_id must be nonempty")
        win = row["win"]
        if win not in (0, 1):
            raise ValueError("win must be a binary raw outcome")
        normalized = (str(row["role"]), str(row["champion"]), int(win))
        key = (account, match_id)
        if key in distinct and distinct[key] != normalized:
            raise ValueError(f"Conflicting duplicate account/match_id: {account}/{match_id}")
        distinct[key] = normalized
    accounts = sorted({account for account, _ in distinct})
    role_account = defaultdict(dict)
    local_groups = defaultdict(lambda: defaultdict(dict))
    for (account, match_id), (role, champion, win) in sorted(distinct.items()):
        role_account[(role, account)][match_id] = win
        local_groups[(role, champion)][account][match_id] = win
    result = {}
    for (role, champion), local_accounts in sorted(local_groups.items()):
        local_ids = {match_id for matches in local_accounts.values() for match_id in matches}
        cells = {}
        baseline_union = set()
        for account in accounts:
            local = local_accounts.get(account, {})
            baseline = {match_id: win for match_id, win in role_account[(role, account)].items() if match_id not in local_ids}
            baseline_union.update(baseline)
            cells[account] = {
                "wins": sum(local.values()), "losses": len(local) - sum(local.values()),
                "baseline_wins": sum(baseline.values()), "baseline_losses": len(baseline) - sum(baseline.values()),
                "local_match_ids": sorted(local), "baseline_match_ids": sorted(baseline),
            }
        assert not local_ids & baseline_union
        observations = sum(len(matches) for matches in local_accounts.values())
        wins = sum(cell["wins"] for cell in cells.values())
        result[(role, champion)] = {
            "role": role, "champion": champion, "account_cells": cells, "accounts": list(accounts),
            "observations": observations, "games": observations, "wins": wins, "losses": observations - wins,
            "unique_games": len(local_ids), "observed_account_count": len(local_accounts),
            "observed_accounts": len(local_accounts), "account_count": len(accounts),
            "local_match_ids": sorted(local_ids), "baseline_match_ids": sorted(baseline_union),
            "baseline_unique_games": len(baseline_union),
        }
    return result
