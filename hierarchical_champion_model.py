"""Hierarchical, account-standardized champion outcome estimates.

The outcome is the unweighted binary match result. A penalized logistic model
uses partially pooled random intercepts for account, champion-role, role,
queue, patch, and match. A diagonal Laplace approximation supplies uncertainty
for the displayed estimates; the match intercept accounts for shared-lobby
dependence during fitting. Since there is no completed temporal validation for
this model, outputs are explicitly marked exploratory.
"""
from __future__ import annotations

from collections import defaultdict
from collections.abc import Mapping
from copy import deepcopy
import hashlib
import json
import math
import threading
from collections import OrderedDict

from algorithm_settings import current_settings
from champion_taxonomy import canonical_champion, load_catalog
from observed_performance import observed_performance


MODEL_VERSION = "hierarchical_logit_laplace_v1"
MODEL_VALIDATED = False
_INTERCEPT_SD = 1.5
_EFFECT_SD = {
    "account": 0.60,
    "champion_role": 0.45,
    "role": 0.30,
    "queue": 0.25,
    "patch": 0.25,
    "match": 0.55,
}
_CACHE_LIMIT = 8
_CACHE: OrderedDict[str, dict] = OrderedDict()
_CACHE_LOCK = threading.RLock()


def _validation_summary() -> dict:
    return {
        "status": "validated" if MODEL_VALIDATED else "exploratory",
        "validated": MODEL_VALIDATED,
        "model_version": MODEL_VERSION,
        "message": (
            "Il modello gerarchico non ha ancora superato il confronto temporale richiesto; "
            "i risultati descrivono associazioni storiche e restano esplorativi."
        ) if not MODEL_VALIDATED else "Modello convalidato su split temporali locali.",
    }


def _logistic(value: float) -> float:
    if value >= 0:
        return 1.0 / (1.0 + math.exp(-min(value, 40.0)))
    exponential = math.exp(max(value, -40.0))
    return exponential / (1.0 + exponential)


def _category(value) -> str:
    return str(value or "<unknown>")


def _row_features(row: dict) -> dict[str, str]:
    champion = canonical_champion(str(row.get("champion") or ""))
    role = _category(row.get("role"))
    from playstyle_analysis import canonical_queue
    return {
        "account": _category(row.get("account")),
        "champion_role": f"{champion}\x1f{role}",
        "role": role,
        "queue": _category(canonical_queue(row.get("queue"))),
        "patch": _category(row.get("patch")),
        "match": _category(row.get("match_id")),
    }


def _fit(rows: list[dict]) -> dict:
    valid = [row for row in rows if row.get("win") in (0, 1, False, True)]
    if not valid:
        return {"intercept": 0.0, "intercept_variance": _INTERCEPT_SD**2,
                "effects": {key: {} for key in _EFFECT_SD},
                "variances": {key: {} for key in _EFFECT_SD},
                "features": [], "rows": []}

    features = [_row_features(row) for row in valid]
    outcomes = [int(row["win"]) for row in valid]
    indexes: dict[str, dict[str, list[int]]] = {
        key: defaultdict(list) for key in _EFFECT_SD
    }
    for index, values in enumerate(features):
        for key, value in values.items():
            indexes[key][value].append(index)

    rate = (sum(outcomes) + 0.5) / (len(outcomes) + 1.0)
    intercept = math.log(rate / (1.0 - rate))
    effects = {key: {category: 0.0 for category in levels} for key, levels in indexes.items()}
    eta = [intercept] * len(valid)
    for key, values in enumerate(features):
        eta[key] += math.fsum(effects[group][category] for group, category in values.items())

    intercept_variance = _INTERCEPT_SD**2
    variances = {key: {} for key in _EFFECT_SD}
    intercept_precision = 1.0 / (_INTERCEPT_SD**2)
    for _iteration in range(60):
        max_change = 0.0
        gradient = math.fsum(y - _logistic(value) for y, value in zip(outcomes, eta)) - intercept * intercept_precision
        information = math.fsum(
            _logistic(value) * (1.0 - _logistic(value)) for value in eta
        ) + intercept_precision
        step = max(-1.0, min(1.0, gradient / information)) if information else 0.0
        intercept += step
        eta = [value + step for value in eta]
        max_change = max(max_change, abs(step))
        intercept_variance = 1.0 / information if information else _INTERCEPT_SD**2

        for group, categories in indexes.items():
            sd = _EFFECT_SD[group]
            precision = 1.0 / (sd * sd)
            for category, members in categories.items():
                coefficient = effects[group][category]
                gradient = -coefficient * precision
                information = precision
                for index in members:
                    probability = _logistic(eta[index])
                    gradient += outcomes[index] - probability
                    information += probability * (1.0 - probability)
                step = max(-1.0, min(1.0, gradient / information)) if information else 0.0
                effects[group][category] = coefficient + step
                if step:
                    for index in members:
                        eta[index] += step
                variances[group][category] = 1.0 / information if information else sd * sd
                max_change = max(max_change, abs(step))
        if max_change < 1e-6:
            break

    # A random lobby intercept is integrated out for a future match. Retaining
    # its fitted variance in the diagnostics makes the dependency correction
    # inspectable without treating historical match effects as predictive.
    return {
        "intercept": intercept,
        "intercept_variance": intercept_variance,
        "effects": effects,
        "variances": variances,
        "features": features,
        "rows": valid,
        "iterations": _iteration + 1,
        "match_effect_levels": len(effects["match"]),
    }


def predict_observation(row: dict, fit: dict) -> float:
    """Predict a future binary outcome without leaking its match random effect."""
    features = _row_features(row)
    eta = float(fit["intercept"])
    variance = float(fit["intercept_variance"])
    for group in ("account", "champion_role", "role", "queue", "patch"):
        mean, coefficient_variance = _coefficient(fit, group, features[group])
        eta += mean
        variance += coefficient_variance
    return _logistic(eta / math.sqrt(1.0 + math.pi * variance / 8.0))


def _moment_beta(mean: float, variance: float) -> tuple[float, float]:
    mean = min(0.999, max(0.001, float(mean)))
    if variance <= 1e-8:
        concentration = 1_000_000.0
    else:
        concentration = min(1_000_000.0, max(2.0, mean * (1.0 - mean) / variance - 1.0))
    return mean * concentration, (1.0 - mean) * concentration


def _cache_key(rows: list[dict], accounts: list[str], settings: dict) -> str:
    material = [
        [str(row.get(key, "")) for key in ("account", "match_id", "champion", "role", "queue", "patch", "win")]
        for row in rows
    ]
    payload = json.dumps([MODEL_VERSION, accounts, _jsonable(settings), material], ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _jsonable(value):
    if isinstance(value, Mapping):
        return {str(key): _jsonable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(item) for item in value]
    return value


def _normal_cdf(value: float) -> float:
    return 0.5 * (1.0 + math.erf(value / math.sqrt(2.0)))


def _normal_quantile(probability: float) -> float:
    low, high = -8.0, 8.0
    for _ in range(80):
        middle = (low + high) / 2.0
        if _normal_cdf(middle) < probability:
            low = middle
        else:
            high = middle
    return (low + high) / 2.0


def _coefficient(fit: dict, group: str, category: str) -> tuple[float, float]:
    return (
        fit["effects"][group].get(category, 0.0),
        fit["variances"][group].get(category, _EFFECT_SD[group] ** 2),
    )


def _standardized_prediction(fit: dict, accounts: list[str], role: str,
                             context_weights: list[tuple[tuple[str, str], float]],
                             champion: str | None = None) -> tuple[float, float, dict[str, tuple[float, float]], dict]:
    """Delta-method prediction and variance with shared effects kept correlated."""
    if not accounts or not context_weights:
        return 0.5, 0.25, {account: (0.5, 0.25) for account in accounts}, {}
    means_by_account = {}
    gradients = defaultdict(float)
    role_mean, role_variance = _coefficient(fit, "role", role)
    intercept = float(fit["intercept"])
    intercept_variance = float(fit["intercept_variance"])
    for account in accounts:
        account_mean, account_variance = _coefficient(fit, "account", account)
        account_grad = 0.0
        account_mean_rate = 0.0
        for (queue, patch), weight in context_weights:
            queue_mean, queue_variance = _coefficient(fit, "queue", queue)
            patch_mean, patch_variance = _coefficient(fit, "patch", patch)
            champion_mean, champion_variance = (0.0, 0.0)
            if champion is not None:
                champion_mean, champion_variance = _coefficient(
                    fit, "champion_role", f"{champion}\x1f{role}",
                )
            eta = intercept + account_mean + role_mean + queue_mean + patch_mean + champion_mean
            eta_variance = (intercept_variance + account_variance + role_variance
                            + queue_variance + patch_variance + champion_variance)
            # Logistic-normal moment approximation for each context cell.
            attenuation = math.sqrt(1.0 + math.pi * eta_variance / 8.0)
            adjusted = eta / attenuation
            rate = _logistic(adjusted)
            derivative = rate * (1.0 - rate) * weight / (attenuation * len(accounts))
            account_mean_rate += weight * rate
            account_grad += rate * (1.0 - rate) * weight / attenuation
            gradients[("role", role)] += derivative
            gradients[("queue", queue)] += derivative
            gradients[("patch", patch)] += derivative
            gradients[("intercept", "")] += derivative
            if champion is not None:
                gradients[("champion_role", f"{champion}\x1f{role}")] += derivative
        means_by_account[account] = account_mean_rate
        # The account intercept is the only account-specific coefficient; its
        # remaining uncertainty and all common effects are in ``gradients``.
        gradients[("account", account)] += account_grad / len(accounts)
    mean = math.fsum(means_by_account.values()) / len(accounts)
    variance = 0.0
    for (group, category), derivative in gradients.items():
        if group == "intercept":
            coefficient_variance = intercept_variance
        else:
            _, coefficient_variance = _coefficient(fit, group, category)
        variance += derivative * derivative * coefficient_variance
    per_account = {}
    for account in accounts:
        # Marginal account score includes uncertainty shared across contexts;
        # this is an approximation for the Beta-Bernoulli allocation model.
        local_gradients = defaultdict(float)
        local_mean = 0.0
        account_mean, account_variance = _coefficient(fit, "account", account)
        for (queue, patch), weight in context_weights:
            queue_mean, queue_variance = _coefficient(fit, "queue", queue)
            patch_mean, patch_variance = _coefficient(fit, "patch", patch)
            champion_mean, champion_variance = (0.0, 0.0)
            if champion is not None:
                champion_mean, champion_variance = _coefficient(fit, "champion_role", f"{champion}\x1f{role}")
            eta = intercept + account_mean + role_mean + queue_mean + patch_mean + champion_mean
            eta_variance = (intercept_variance + account_variance + role_variance
                            + queue_variance + patch_variance + champion_variance)
            attenuation = math.sqrt(1.0 + math.pi * eta_variance / 8.0)
            rate = _logistic(eta / attenuation)
            derivative = rate * (1.0 - rate) * weight / attenuation
            local_mean += weight * rate
            local_gradients[("intercept", "")] += derivative
            local_gradients[("account", account)] += derivative
            local_gradients[("role", role)] += derivative
            local_gradients[("queue", queue)] += derivative
            local_gradients[("patch", patch)] += derivative
            if champion is not None:
                local_gradients[("champion_role", f"{champion}\x1f{role}")] += derivative
        local_variance = 0.0
        for (group, category), derivative in local_gradients.items():
            if group == "intercept":
                coefficient_variance = intercept_variance
            else:
                _, coefficient_variance = _coefficient(fit, group, category)
            local_variance += derivative * derivative * coefficient_variance
        per_account[account] = (local_mean, min(max(local_variance, 1e-8), local_mean * (1.0 - local_mean) * 0.95))
    return mean, max(variance, 1e-8), per_account, dict(gradients)


def _predict(rows: list[dict], accounts: list[str], fit: dict, settings: dict) -> dict:
    if not rows or not accounts:
        return {
            "items": [], "posterior_cells": {}, "fit": fit,
            "validation": _validation_summary(),
        }
    candidates: dict[tuple[str, str], list[dict]] = defaultdict(list)
    match_ids_by_context = defaultdict(set)
    for row in rows:
        champion = canonical_champion(str(row.get("champion") or ""))
        role = _category(row.get("role"))
        features = _row_features(row)
        candidates[(champion, role)].append(row)
        match_ids_by_context[(role, features["queue"], features["patch"])].add(
            str(row.get("match_id") or "")
        )
    ordered_candidates = sorted(candidates)
    family_size = max(1, len(ordered_candidates))
    target_accounts = sorted(set(str(account) for account in accounts if str(account)))
    contexts_by_role = defaultdict(list)
    for (role, queue, patch), match_ids in match_ids_by_context.items():
        if match_ids:
            contexts_by_role[role].append(((queue, patch), len(match_ids)))
    context_weights = {}
    for role, raw in contexts_by_role.items():
        total = sum(count for _, count in raw)
        context_weights[role] = [(cell, count / total) for cell, count in sorted(raw)] if total else []

    evidence = settings["evidence"]
    confidence = float(evidence["credible_mass"])
    delta = float(evidence["meaningful_delta"])
    family_alpha = float(evidence["family_alpha"])
    z = _normal_quantile((1.0 + confidence) / 2.0)
    items = []
    posterior_cells = {}
    for champion, role in ordered_candidates:
        arm_rows = candidates[(champion, role)]
        role_rows = [row for row in rows if _category(row.get("role")) == role]
        observed = observed_performance(
            role_rows, arm_rows, target_accounts, confidence=confidence,
            family_size=family_size, meaningful_delta=delta, family_alpha=family_alpha,
        )
        mean, variance, _, candidate_gradients = _standardized_prediction(
            fit, target_accounts, role, context_weights.get(role, []), champion,
        )
        baseline, baseline_variance, _, baseline_gradients = _standardized_prediction(
            fit, target_accounts, role, context_weights.get(role, []), None,
        )
        lift = mean - baseline
        covariance = 0.0
        for key, candidate_derivative in candidate_gradients.items():
            baseline_derivative = baseline_gradients.get(key)
            if baseline_derivative is None:
                continue
            group, category = key
            coefficient_variance = (float(fit["intercept_variance"]) if group == "intercept"
                                    else _coefficient(fit, group, category)[1])
            covariance += candidate_derivative * baseline_derivative * coefficient_variance
        lift_se = math.sqrt(max(1e-8, variance + baseline_variance - 2.0 * covariance))
        positive_probability = _normal_cdf(lift / lift_se) if lift_se else float(lift > 0)
        meaningful_probability = _normal_cdf((lift - delta) / lift_se) if lift_se else float(lift > delta)
        status = ("supported" if observed["supported"] and MODEL_VALIDATED else
                  "promising" if lift > 0 and positive_probability >= 0.5 else "other")
        _, _, account_predictions, _ = _standardized_prediction(
            fit, target_accounts, role, context_weights.get(role, []), champion,
        )
        posterior_cells[(champion, role)] = {
            account: _moment_beta(*account_predictions[account]) for account in target_accounts
        }
        low = max(0.0, mean - z * math.sqrt(variance))
        high = min(1.0, mean + z * math.sqrt(variance))
        item = {
            "scope": "selected_accounts",
            "champion": champion,
            "role": role,
            "icon_url": f"https://ddragon.leagueoflegends.com/cdn/{load_catalog()['source_version']}/img/champion/{champion}.png",
            "games_observed": observed["observations"],
            "unique_games": len({str(row.get("match_id")) for row in arm_rows}),
            "wins": observed["wins"],
            "losses": observed["losses"],
            "raw_win_rate": observed["win_rate"],
            "posterior_win_rate": mean * 100.0,
            "account_adjusted_fit_score": mean * 100.0,
            "posterior_fit_probability": mean,
            "credible_lower_90": low * 100.0,
            "credible_upper_90": high * 100.0,
            "credible_lower": low * 100.0,
            "credible_upper": high * 100.0,
            "credible_mass": confidence,
            "posterior_lift_pp": lift * 100.0,
            "fit_delta_vs_account_baseline_pp": lift * 100.0,
            "baseline_win_rate": baseline * 100.0,
            "probability_meaningful_advantage": meaningful_probability * 100.0,
            "probability_direction_above": positive_probability * 100.0,
            "decision_threshold": (1.0 - family_alpha / (2.0 * family_size)) * 100.0,
            "family_size": family_size,
            "historical_supported": bool(observed["supported"]),
            "historical_direction": observed["direction"],
            "positive_evidence": 0.0,
            "informative_losses_equivalent": 0.0,
            "effective_sample_size": observed["observations"],
            "uncertainty_width_90": (high - low) * 100.0,
            "probability_above_high_fit_threshold": None,
            "classification": status,
            "actionable": bool(observed["supported"] and MODEL_VALIDATED),
            "reliability": "reliable" if observed["supported"] and MODEL_VALIDATED else "exploratory",
            "validated_positive": int(observed["supported"] and MODEL_VALIDATED),
            "blacklist_strong": 0,
            "blacklist_provisional": 0,
            "blacklist_tier": "none",
            "blacklist_reason": "",
            "value_of_information": 0.0,
            "allocated_games": 0,
            "account_coverage": len({str(row.get("account")) for row in arm_rows}),
            "account_count": len(target_accounts),
            "accounts_played": len({str(row.get("account")) for row in arm_rows}),
            "accounts": ",".join(sorted({str(row.get("account")) for row in arm_rows})),
            "record_kind": "account",
            "theoretical_fit_prior": None,
            "quantitative_rationale": (
                "Vittorie e sconfitte binarie; pesi di attribuzione esclusi. "
                "Stima gerarchica esplorativa in attesa di validazione temporale."
            ),
            "account_performance": observed["per_account"],
            "historical_performance": observed,
            "model_version": MODEL_VERSION,
            "model_validated": MODEL_VALIDATED,
            "model_status": "validated" if MODEL_VALIDATED else "exploratory",
            "rationale": (
                "Stima logistica gerarchica con pooling parziale per account, champion/ruolo, ruolo, modalità, patch e lobby. "
                "La matrice è esplorativa finché il modello non supera la validazione temporale locale."
            ),
        }
        items.append(item)

    items.sort(key=lambda item: (
        -int(bool(item["historical_supported"])), -float(item["posterior_win_rate"]),
        -float(item["probability_meaningful_advantage"]), -int(item["unique_games"]),
        item["champion"], item["role"],
    ))
    return {
        "items": items,
        "posterior_cells": posterior_cells,
        "fit": fit,
        "validation": _validation_summary(),
    }


def analyze(rows: list[dict], accounts: list[str]) -> dict:
    """Fit/cache a scoped model; importing matches or changing scope invalidates the key."""
    settings = current_settings()
    selected = sorted(set(str(account) for account in accounts if str(account)))
    key = _cache_key(rows, selected, settings)
    with _CACHE_LOCK:
        cached = _CACHE.get(key)
        if cached is not None:
            _CACHE.move_to_end(key)
            return deepcopy(cached)
    fit = _fit(rows)
    result = _predict(rows, selected, fit, settings)
    # Keep solver-only arrays out of the public payload; posterior cells are
    # retained for the fixed-budget allocator and consist only of Beta shapes.
    result.pop("fit", None)
    with _CACHE_LOCK:
        _CACHE[key] = deepcopy(result)
        _CACHE.move_to_end(key)
        while len(_CACHE) > _CACHE_LIMIT:
            _CACHE.popitem(last=False)
    return result


def training_candidates(analysis: dict, accounts: list[str], max_candidates: int) -> list[dict]:
    """Include uncertain positive cells and always retain the best supported comparator."""
    items = list(analysis.get("items") or [])
    if not items or max_candidates <= 0:
        return []
    ordered = sorted(items, key=lambda item: (
        -float(item.get("posterior_win_rate") or 0),
        -float(item.get("probability_direction_above") or 0),
        -int(item.get("unique_games") or 0), item["champion"], item["role"],
    ))
    promising = [item for item in ordered if item["classification"] == "promising"]
    supported = [item for item in ordered if item.get("historical_supported")]
    comparator = supported[0] if supported else ordered[0]
    if max_candidates == 1:
        cells = analysis.get("posterior_cells") or {}
        return [comparator | {"account_shapes": {
            account: list(cells.get((comparator["champion"], comparator["role"]), {}).get(account, (4.0, 4.0)))
            for account in accounts
        }}]
    selected = []
    for item in promising:
        if item["champion"] != comparator["champion"] or item["role"] != comparator["role"]:
            selected.append(item)
        if len(selected) >= max_candidates - 1:
            break
    if comparator not in selected:
        selected.append(comparator)
    selected = selected[:max_candidates]
    cells = analysis.get("posterior_cells") or {}
    return [
        item | {"account_shapes": {
            account: list(cells.get((item["champion"], item["role"]), {}).get(account, (4.0, 4.0)))
            for account in accounts
        }}
        for item in selected
    ]
