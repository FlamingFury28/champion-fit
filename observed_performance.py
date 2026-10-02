"""Prior-free descriptive performance for observed choices.

The estimator keeps account/match observations distinct from unique matches,
uses a globally disjoint complement, and never fills an unobserved account
with a neutral value.  Multi-account rates give equal weight to accounts that
actually expose the quantity being summarized.
"""

from __future__ import annotations

import math
from collections.abc import Iterable, Mapping
from typing import Any

from statistical_evidence import beta_quantile


def _mapping(row: Any) -> Mapping[str, Any]:
    if isinstance(row, Mapping):
        return row
    try:
        return {key: row[key] for key in row.keys()}
    except (AttributeError, TypeError):
        raise ValueError("each observation must be mapping-like") from None


def _outcome(value: Any) -> int:
    if value in (0, 1, False, True):
        return int(value)
    raise ValueError("win must be a binary raw outcome")


def _targets(
    accounts: Iterable[str], rows: Iterable[Any], candidate_rows: Iterable[Any]
) -> list[str]:
    targets = list(dict.fromkeys(str(account) for account in accounts if str(account)))
    if targets:
        return targets
    inferred = {
        str(_mapping(row).get("account") or "")
        for row in (*list(rows), *list(candidate_rows))
    }
    return sorted(account for account in inferred if account)


def _deduplicate(rows: Iterable[Any], targets: set[str]) -> dict[tuple[str, str], int]:
    result: dict[tuple[str, str], int] = {}
    for source in rows:
        row = _mapping(source)
        account = str(row.get("account") or "")
        match_id = str(row.get("match_id") or "")
        if not account or not match_id:
            raise ValueError("account and match_id must be nonempty")
        if account not in targets:
            continue
        win = _outcome(row.get("win"))
        key = account, match_id
        if key in result and result[key] != win:
            raise ValueError(f"conflicting duplicate account/match_id: {account}/{match_id}")
        result[key] = win
    return result


def clopper_pearson_interval(
    wins: int, games: int, confidence: float = 0.9
) -> tuple[float | None, float | None]:
    """Return an exact two-sided binomial interval as fractions.

    The endpoints invert equal-tail binomial tests through Beta quantiles.  An
    empty sample has no estimate and therefore returns ``(None, None)``.
    """
    if type(wins) is not int or type(games) is not int:
        raise ValueError("wins and games must be integers")
    if games < 0 or wins < 0 or wins > games:
        raise ValueError("wins must be between zero and games")
    if isinstance(confidence, bool) or not isinstance(confidence, (int, float)):
        raise ValueError("confidence must be a finite number between zero and one")
    confidence = float(confidence)
    if not math.isfinite(confidence) or not 0 < confidence < 1:
        raise ValueError("confidence must be a finite number between zero and one")
    return _clopper_pearson_alpha(wins, games, 1.0 - confidence)


def _clopper_pearson_alpha(
    wins: int, games: int, alpha: float
) -> tuple[float | None, float | None]:
    if games == 0:
        return None, None
    if alpha <= 0:
        return 0.0, 1.0
    tail = alpha / 2.0
    lower = 0.0 if wins == 0 else beta_quantile(tail, wins, games - wins + 1)
    # Beta symmetry preserves the small tail when ``1 - tail`` would round to
    # exactly one for a valid confidence immediately below 1.
    upper = (
        1.0 if wins == games
        else 1.0 - beta_quantile(tail, games - wins, wins + 1)
    )
    return lower, upper


def _rate(wins: int, games: int) -> float | None:
    return wins / games if games else None


def _percent(value: float | None) -> float | None:
    return None if value is None else value * 100.0


def _mean(values: Iterable[float]) -> float:
    collected = list(values)
    return math.fsum(collected) / len(collected)


def _divide_alpha(alpha: float, denominator: int) -> float:
    try:
        return alpha / denominator
    except OverflowError:
        return 0.0


def _mean_interval_alpha(cells: list[dict[str, Any]], alpha: float) -> tuple[float | None, float | None]:
    if not cells:
        return None, None
    cell_alpha = _divide_alpha(alpha, len(cells))
    intervals = [
        _clopper_pearson_alpha(cell["wins"], cell["games"], cell_alpha)
        for cell in cells
    ]
    return (
        _mean(interval[0] for interval in intervals if interval[0] is not None),
        _mean(interval[1] for interval in intervals if interval[1] is not None),
    )


def observed_performance(
    rows: Iterable[Any],
    candidate_rows: Iterable[Any],
    accounts: Iterable[str],
    confidence: float = 0.9,
    family_size: int = 1,
    meaningful_delta: float = 0.03,
    family_alpha: float = 0.05,
) -> dict[str, Any]:
    """Describe raw observed outcomes against a globally disjoint complement.

    ``win_rate`` is the mean of account-specific observed rates, excluding
    accounts with no candidate observations.  ``lift_pp`` is paired and uses
    only accounts with both candidate and complementary observations.  The
    displayed intervals have the requested simultaneous confidence across the
    account cells in that estimate.  ``supported`` uses a stricter union bound
    over both sides of every comparison in the complete candidate family.
    """
    row_list = list(rows)
    candidate_list = list(candidate_rows)
    targets = _targets(accounts, row_list, candidate_list)
    target_set = set(targets)
    if not targets:
        raise ValueError("at least one target account is required")
    if type(family_size) is not int or family_size < 1:
        raise ValueError("family_size must be a positive integer")
    if isinstance(meaningful_delta, bool) or not isinstance(meaningful_delta, (int, float)):
        raise ValueError("meaningful_delta must be a finite number between zero and one")
    meaningful_delta = float(meaningful_delta)
    if not math.isfinite(meaningful_delta) or not 0 <= meaningful_delta < 1:
        raise ValueError("meaningful_delta must be a finite number between zero and one")
    if isinstance(family_alpha, bool) or not isinstance(family_alpha, (int, float)):
        raise ValueError("family_alpha must be a finite number between zero and one")
    family_alpha = float(family_alpha)
    if not math.isfinite(family_alpha) or not 0 < family_alpha < 1:
        raise ValueError("family_alpha must be a finite number between zero and one")
    # Validate confidence even for an entirely missing candidate.
    clopper_pearson_interval(0, 0, confidence)
    confidence = float(confidence)
    alpha = 1.0 - confidence

    scope = _deduplicate(row_list, target_set)
    candidate = _deduplicate(candidate_list, target_set)
    for key, win in candidate.items():
        if key not in scope:
            raise ValueError(f"candidate observation is outside the comparison scope: {key[0]}/{key[1]}")
        if scope[key] != win:
            raise ValueError(f"candidate conflicts with comparison scope: {key[0]}/{key[1]}")
    candidate_match_ids = {match_id for _, match_id in candidate}
    complement = {
        key: win for key, win in scope.items() if key[1] not in candidate_match_ids
    }

    per_account: dict[str, dict[str, Any]] = {}
    exposed_cells: list[dict[str, Any]] = []
    comparable_candidate_cells: list[dict[str, Any]] = []
    comparable_baseline_cells: list[dict[str, Any]] = []
    missing_accounts: list[str] = []
    missing_baseline_accounts: list[str] = []
    comparable_accounts: list[str] = []

    for account in targets:
        local = [win for (owner, _), win in candidate.items() if owner == account]
        baseline = [win for (owner, _), win in complement.items() if owner == account]
        local_games, local_wins = len(local), sum(local)
        baseline_games, baseline_wins = len(baseline), sum(baseline)
        local_rate = _rate(local_wins, local_games)
        baseline_rate = _rate(baseline_wins, baseline_games)
        local_interval = clopper_pearson_interval(local_wins, local_games, confidence)
        baseline_interval = clopper_pearson_interval(baseline_wins, baseline_games, confidence)
        comparable = local_games > 0 and baseline_games > 0
        per_account[account] = {
            "games": local_games,
            "wins": local_wins,
            "losses": local_games - local_wins,
            "win_rate": _percent(local_rate),
            "interval_low": _percent(local_interval[0]),
            "interval_high": _percent(local_interval[1]),
            "baseline_games": baseline_games,
            "baseline_wins": baseline_wins,
            "baseline_losses": baseline_games - baseline_wins,
            "baseline_win_rate": _percent(baseline_rate),
            "baseline_low": _percent(baseline_interval[0]),
            "baseline_high": _percent(baseline_interval[1]),
            "lift_pp": None if not comparable else (local_rate - baseline_rate) * 100.0,
            "comparable": comparable,
        }
        if local_games == 0:
            missing_accounts.append(account)
            continue
        local_cell = {"wins": local_wins, "games": local_games}
        exposed_cells.append(local_cell)
        if baseline_games == 0:
            missing_baseline_accounts.append(account)
            continue
        comparable_accounts.append(account)
        comparable_candidate_cells.append(local_cell)
        comparable_baseline_cells.append({"wins": baseline_wins, "games": baseline_games})

    observations = len(candidate)
    wins = sum(candidate.values())
    games = len(candidate_match_ids)
    observed_rate = _mean(cell["wins"] / cell["games"] for cell in exposed_cells) if exposed_cells else None
    interval = _mean_interval_alpha(exposed_cells, alpha)
    baseline_rate = (
        _mean(cell["wins"] / cell["games"] for cell in comparable_baseline_cells)
        if comparable_baseline_cells else None
    )
    paired_candidate_rate = (
        _mean(cell["wins"] / cell["games"] for cell in comparable_candidate_cells)
        if comparable_candidate_cells else None
    )
    paired_candidate_interval = _mean_interval_alpha(comparable_candidate_cells, alpha)
    baseline_interval = _mean_interval_alpha(comparable_baseline_cells, alpha)
    paired_lift = (
        _mean(
            candidate_cell["wins"] / candidate_cell["games"]
            - baseline_cell["wins"] / baseline_cell["games"]
            for candidate_cell, baseline_cell in zip(
                comparable_candidate_cells, comparable_baseline_cells
            )
        )
        if comparable_accounts else None
    )
    direction = (
        "missing" if paired_lift is None else
        "better" if paired_lift > 0 else
        "worse" if paired_lift < 0 else
        "neutral"
    )

    supported = False
    decision_side_alpha = _divide_alpha(family_alpha, family_size * 2)
    candidate_decision: tuple[float | None, float | None] = (None, None)
    baseline_decision: tuple[float | None, float | None] = (None, None)
    if comparable_accounts and not missing_accounts and not missing_baseline_accounts:
        # At most two binomial cells per selected account and candidate.  This
        # allocation controls the full family without assuming independence.
        candidate_decision = _mean_interval_alpha(comparable_candidate_cells, decision_side_alpha)
        baseline_decision = _mean_interval_alpha(comparable_baseline_cells, decision_side_alpha)
        supported = bool(
            candidate_decision[0] is not None
            and baseline_decision[1] is not None
            and (
                candidate_decision[0] > baseline_decision[1] + meaningful_delta
                or baseline_decision[0] > candidate_decision[1] + meaningful_delta
            )
        )

    baseline_match_ids = {
        match_id for (account, match_id) in complement
        if account in comparable_accounts
    }
    return {
        "games": games,
        "observations": observations,
        "wins": wins,
        "losses": observations - wins,
        "win_rate": _percent(observed_rate),
        "interval_low": _percent(interval[0]),
        "interval_high": _percent(interval[1]),
        "confidence": confidence,
        "baseline_games": len(baseline_match_ids),
        "paired_candidate_win_rate": _percent(paired_candidate_rate),
        "paired_candidate_low": _percent(paired_candidate_interval[0]),
        "paired_candidate_high": _percent(paired_candidate_interval[1]),
        "baseline_win_rate": _percent(baseline_rate),
        "baseline_low": _percent(baseline_interval[0]),
        "baseline_high": _percent(baseline_interval[1]),
        "lift_pp": _percent(paired_lift),
        "comparable_accounts": comparable_accounts,
        "missing_accounts": missing_accounts,
        "missing_baseline_accounts": missing_baseline_accounts,
        "per_account": per_account,
        "supported": supported,
        "direction": direction,
        "family_size": family_size,
        "family_alpha": family_alpha,
        "meaningful_delta": meaningful_delta,
        "meaningful_delta_pp": _percent(meaningful_delta),
        "decision_side_alpha": decision_side_alpha,
        "decision_candidate_low": _percent(candidate_decision[0]),
        "decision_candidate_high": _percent(candidate_decision[1]),
        "decision_baseline_low": _percent(baseline_decision[0]),
        "decision_baseline_high": _percent(baseline_decision[1]),
        "method": "raw_outcome_clopper_pearson_equal_account_union_bound",
    }
