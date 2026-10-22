"""Pure live training and exploration recommendations.

The competitive training plan allocates a fixed match budget to minimize
simulated expected simple regret when selecting a champion. The legacy
``training_plan`` helper separately allocates for posterior variance reduction.
Exploration reformats the taxonomy-based, lifetime-untried catalog produced by
the playstyle analysis.
"""
from __future__ import annotations

from copy import deepcopy
import hashlib
import json
import math
import random

from algorithm_settings import current_settings
from champion_taxonomy import canonical_champion, champion_categories, load_catalog
from decision_models import rank_recommendations
from runtime_metrics import measure, record_metric
from singleflight_cache import SingleFlightLRU


_PLAN_VERSION = "greedy_common_random_numbers_v2"
_PLAN_CACHE = SingleFlightLRU(8)


def _icon_url(champion: str) -> str:
    version = load_catalog()["source_version"]
    return f"https://ddragon.leagueoflegends.com/cdn/{version}/img/champion/{champion}.png"


def _budget(value, default: int) -> int:
    if value is None:
        return default
    if isinstance(value, bool):
        raise ValueError("budget must be an integer between 1 and 2000")
    try:
        parsed = int(value)
    except (TypeError, ValueError) as error:
        raise ValueError("budget must be an integer between 1 and 2000") from error
    if str(value).strip() != str(parsed) or not 1 <= parsed <= 2000:
        raise ValueError("budget must be an integer between 1 and 2000")
    return parsed


def _count(value, name: str) -> float:
    result = float(value or 0)
    if not math.isfinite(result) or result < 0:
        raise ValueError(f"{name} must be finite and nonnegative")
    return result


def _variance(wins: float, losses: float, prior_mean: float, prior_strength: float) -> tuple[float, float]:
    alpha = prior_mean * prior_strength + wins
    beta = (1.0 - prior_mean) * prior_strength + losses
    strength = alpha + beta
    return alpha * beta / (strength * strength * (strength + 1.0)), strength


def training_plan(candidates, accounts, budget=None) -> dict:
    """Allocate a total game budget to the most informative champion/account cells.

    The complete candidate family is evaluated before display filtering. For
    each selected champion/account pair, the expected variance after ``k`` new
    Bernoulli observations is ``V*s/(s+k)``. Each greedy step chooses the largest
    reduction in mean individual variance, with stable ID/role/account ties.
    """
    settings = current_settings()
    evidence = settings["evidence"]
    training = settings["training"]
    default_budget = int(training["budget"])
    budget_total = _budget(budget, default_budget)
    max_candidates = int(training["max_candidates"])
    display_min = int(evidence["display_min_games"])
    prior_mean = float(evidence["prior_mean"])
    prior_strength = float(evidence["prior_strength"])
    target_accounts = sorted(set(str(account) for account in accounts if str(account)))

    family = list(candidates)
    ranked = rank_recommendations(deepcopy(family), limit=max(1, len(family)))
    originals = {
        (str(item.get("champion", "")), str(item.get("role", ""))): item
        for item in family
    }
    selected = []
    for item in ranked:
        original = originals.get((str(item.get("champion", "")), str(item.get("role", ""))))
        if original is None:
            continue
        unique_games = int(original.get("unique_games", item.get("unique_games", item.get("games", 0))) or 0)
        if unique_games < display_min:
            continue
        selected.append((item, original, unique_games))
        if len(selected) >= max_candidates:
            break

    if not selected or not target_accounts:
        return {
            "budget_total": budget_total,
            "budget_assigned": 0,
            "budget_default": default_budget,
            "items": [],
        }

    states = []
    result_items = []
    account_count = len(target_accounts)
    for ranked_item, original, unique_games in selected:
        champion = canonical_champion(ranked_item["champion"])
        role = str(ranked_item["role"])
        raw_cells = original.get("account_cells") or {}
        cells = {str(key): value for key, value in raw_cells.items()}
        allocations = {account: 0 for account in target_accounts}
        current_variances = []
        for account in target_accounts:
            cell = cells.get(account, {})
            wins = _count(cell.get("wins", 0), "wins")
            losses = _count(cell.get("losses", 0), "losses")
            variance, strength = _variance(wins, losses, prior_mean, prior_strength)
            current_variances.append(variance)
            states.append({
                "champion": champion,
                "role": role,
                "account": account,
                "variance": variance,
                "strength": strength,
                "allocated": 0,
                "allocations": allocations,
            })
        result_items.append({
            "champion": champion,
            "role": role,
            "icon_url": _icon_url(champion),
            "games": int(ranked_item.get("games", original.get("games", 0)) or 0),
            "unique_games": unique_games,
            "reliability": ranked_item.get("reliability", "exploratory"),
            "actionable": bool(ranked_item.get("actionable", False)),
            "allocation_games": 0,
            "account_allocations": [],
            "expected_variance_now": math.fsum(current_variances) / account_count,
            "expected_variance_after": None,
            "expected_variance_reduction": None,
            "rationale": (
                "Partite assegnate per ridurre l’incertezza media delle stime individuali; "
                "il piano non prevede l’esito delle prossime partite."
            ),
            "_allocations": allocations,
        })

    for _ in range(budget_total):
        def priority(state):
            k = state["allocated"]
            gain = state["variance"] * state["strength"] / (
                (state["strength"] + k) * (state["strength"] + k + 1.0)
            ) / account_count
            return (-gain, state["champion"], state["role"], state["account"])

        chosen = min(states, key=priority)
        chosen["allocated"] += 1
        chosen["allocations"][chosen["account"]] += 1

    for item in result_items:
        allocations = item.pop("_allocations")
        item["allocation_games"] = sum(allocations.values())
        item["account_allocations"] = [
            {"account": account, "games": allocations[account]} for account in target_accounts
        ]
        after = []
        for state in states:
            if (state["champion"], state["role"]) == (item["champion"], item["role"]):
                after.append(
                    state["variance"] * state["strength"]
                    / (state["strength"] + state["allocated"])
                )
        item["expected_variance_after"] = math.fsum(after) / account_count
        item["expected_variance_reduction"] = (
            item["expected_variance_now"] - item["expected_variance_after"]
        )

    return {
        "budget_total": budget_total,
        "budget_assigned": sum(item["allocation_games"] for item in result_items),
        "budget_default": default_budget,
        "items": result_items,
    }


def _competitive_budget(value) -> int:
    if value is None:
        return 400
    if isinstance(value, bool):
        raise ValueError("budget must be an integer between 20 and 2000")
    try:
        parsed = int(value)
    except (TypeError, ValueError) as error:
        raise ValueError("budget must be an integer between 20 and 2000") from error
    if str(value).strip() != str(parsed) or not 20 <= parsed <= 2000:
        raise ValueError("budget must be an integer between 20 and 2000")
    return parsed


def _regret_scenarios(means, latent, accounts):
    result = {}
    for account in accounts:
        account_result = []
        for scenario, scenario_means in enumerate(means[account]):
            chosen = _best_arm(scenario_means)
            theta = latent[account][scenario]
            account_result.append(max(theta) - theta[chosen])
        result[account] = account_result
    return result


def _mean_regret(regrets, accounts):
    count = sum(len(regrets[account]) for account in accounts)
    return math.fsum(value for account in accounts for value in regrets[account]) / max(count, 1)


def _best_arm(means):
    """One deterministic tie rule for optimization and independent evaluation."""
    return max(range(len(means)), key=means.__getitem__)


def competitive_training_plan(candidates, accounts, budget=None, *, optimization_scenarios=64,
                              evaluation_scenarios=512, seed=None) -> dict:
    """Share complete plans by all inputs; return isolated mutable snapshots."""
    for name, value in (("optimization_scenarios", optimization_scenarios),
                        ("evaluation_scenarios", evaluation_scenarios)):
        if type(value) is not int or value < 1:
            raise ValueError(f"{name} must be a positive integer")
    if seed is not None and type(seed) is not int:
        raise ValueError("seed must be an integer or None")
    budget_total = _competitive_budget(budget)
    target_accounts = sorted(set(str(account) for account in accounts if str(account)))
    family = sorted((deepcopy(item) for item in candidates),
                    key=lambda item: (str(item.get("champion", "")), str(item.get("role", ""))))
    from hierarchical_champion_model import _jsonable
    catalog = load_catalog()
    material = [_PLAN_VERSION, catalog["source_version"], catalog["version"],
                _jsonable(current_settings()), family, target_accounts,
                budget_total, optimization_scenarios, evaluation_scenarios, seed]
    key = hashlib.sha256(json.dumps(material, ensure_ascii=False, sort_keys=True,
                                   separators=(",", ":"), allow_nan=False).encode("utf-8")).hexdigest()
    def compute():
        with measure("plan_optimization"):
            return _compute_competitive_training_plan(
                family, target_accounts, budget_total,
                optimization_scenarios=optimization_scenarios,
                evaluation_scenarios=evaluation_scenarios, seed=seed,
            )
    result, hit = _PLAN_CACHE.get_or_compute(key, compute)
    if hit:
        record_metric("plan_cache_hit", 1)
    return result


def _compute_competitive_training_plan(candidates, accounts, budget=None, *, optimization_scenarios=64,
                                       evaluation_scenarios=512, seed=None) -> dict:
    """Greedy fixed-budget allocation against simulated final simple regret.

    The optimization is a deterministic Monte Carlo heuristic, not a global
    optimum. It uses common random numbers for each candidate allocation and
    an independent scenario set to report final regret and its Monte Carlo SE.
    """
    budget_total = _competitive_budget(budget)
    target_accounts = sorted(set(str(account) for account in accounts if str(account)))
    family = sorted((deepcopy(item) for item in candidates),
                    key=lambda item: (str(item.get("champion", "")), str(item.get("role", ""))))
    if not target_accounts or not family:
        return {
            "budget_total": budget_total, "budget_assigned": 0,
            "budget_default": 400, "budget_unassigned": budget_total,
            "objective": "expected_final_simple_regret", "optimizer": _PLAN_VERSION,
            "simulation_scenarios": evaluation_scenarios, "monte_carlo_se": None,
            "expected_regret_now": None, "expected_regret_after": None, "expected_regret_reduction": None,
            "items": [],
        }

    cells = []
    for item in family:
        shapes = item.get("account_shapes") or {}
        alpha_beta = {}
        for account in target_accounts:
            pair = shapes.get(account, (4.0, 4.0))
            if not isinstance(pair, (list, tuple)) or len(pair) != 2:
                raise ValueError("account_shapes must map accounts to positive Beta shapes")
            alpha, beta = float(pair[0]), float(pair[1])
            if not math.isfinite(alpha + beta) or alpha <= 0 or beta <= 0:
                raise ValueError("account_shapes must map accounts to positive Beta shapes")
            alpha_beta[account] = (alpha, beta)
        cells.append(alpha_beta)

    seed_value = json.dumps(
        [budget_total, target_accounts,
         [(item.get("champion"), item.get("role"), item.get("account_shapes")) for item in family]],
        ensure_ascii=False, sort_keys=True, separators=(",", ":"),
    )
    if seed is None:
        seed = int.from_bytes(hashlib.sha256(seed_value.encode("utf-8")).digest()[:8], "big")
    rng = random.Random(seed)
    arm_count = len(family)
    allocation = {account: [0] * arm_count for account in target_accounts}

    # Fixed pseudo-data make marginal allocation comparisons reproducible.
    latent = {}
    sequences = {}
    for account in target_accounts:
        latent[account] = []
        sequences[account] = []
        for _scenario in range(optimization_scenarios):
            theta = [rng.betavariate(*cells[arm][account]) for arm in range(arm_count)]
            latent[account].append(theta)
            sequences[account].append([
                bytearray(1 if rng.random() < theta[arm] else 0 for _ in range(budget_total))
                for arm in range(arm_count)
            ])
    means = {
        account: [
            [cells[arm][account][0] / sum(cells[arm][account]) for arm in range(arm_count)]
            for _ in range(optimization_scenarios)
        ] for account in target_accounts
    }
    wins = {account: [[0] * arm_count for _ in range(optimization_scenarios)] for account in target_accounts}

    for _step in range(budget_total):
        current = _regret_scenarios(means, latent, target_accounts)
        chosen = None
        best_gain = -math.inf
        for account in target_accounts:
            before = current[account]
            for arm in range(arm_count):
                alpha, beta = cells[arm][account]
                count = allocation[account][arm]
                after_values = []
                for scenario, scenario_means in enumerate(means[account]):
                    success = sequences[account][scenario][arm][count]
                    next_mean = (alpha + wins[account][scenario][arm] + success) / (alpha + beta + count + 1)
                    updated = list(scenario_means)
                    updated[arm] = next_mean
                    selected_index = _best_arm(updated)
                    theta = latent[account][scenario]
                    after_values.append(max(theta) - theta[selected_index])
                gain = math.fsum(old - new for old, new in zip(before, after_values)) / (
                    optimization_scenarios * len(target_accounts)
                )
                tie = (str(family[arm].get("champion", "")), str(family[arm].get("role", "")), account)
                if chosen is None or gain > best_gain + 1e-12 or (abs(gain - best_gain) <= 1e-12 and tie < chosen[1]):
                    best_gain = gain
                    chosen = (account, tie, arm)
        account, _tie, arm = chosen
        count = allocation[account][arm]
        allocation[account][arm] += 1
        alpha, beta = cells[arm][account]
        for scenario in range(optimization_scenarios):
            success = sequences[account][scenario][arm][count]
            wins[account][scenario][arm] += success
            means[account][scenario][arm] = (
                alpha + wins[account][scenario][arm]
            ) / (alpha + beta + allocation[account][arm])

    # Evaluate the frozen integer allocation on independent scenarios.
    eval_rng = random.Random(seed ^ 0x9E3779B97F4A7C15)
    eval_initial, eval_final = [], []
    for account in target_accounts:
        for _scenario in range(evaluation_scenarios):
            theta = [eval_rng.betavariate(*cells[arm][account]) for arm in range(arm_count)]
            baseline_means = [cells[arm][account][0] / sum(cells[arm][account]) for arm in range(arm_count)]
            chosen_before = _best_arm(baseline_means)
            eval_initial.append(max(theta) - theta[chosen_before])
            final_means = []
            for arm in range(arm_count):
                alpha, beta = cells[arm][account]
                count = allocation[account][arm]
                successes = sum(eval_rng.random() < theta[arm] for _ in range(count))
                final_means.append((alpha + successes) / (alpha + beta + count))
            chosen_after = _best_arm(final_means)
            eval_final.append(max(theta) - theta[chosen_after])

    mean_now = math.fsum(eval_initial) / len(eval_initial)
    mean_after = math.fsum(eval_final) / len(eval_final)
    reductions = [before - after for before, after in zip(eval_initial, eval_final)]
    reduction = math.fsum(reductions) / len(reductions)
    variance = math.fsum((value - reduction) ** 2 for value in reductions) / max(1, len(reductions) - 1)
    standard_error = math.sqrt(variance / len(reductions))

    result_items = []
    for index, item in enumerate(family):
        per_account = {account: allocation[account][index] for account in target_accounts}
        games = sum(per_account.values())
        result_items.append({
            "champion": canonical_champion(item["champion"]),
            "role": str(item["role"]),
            "icon_url": item.get("icon_url") or _icon_url(item["champion"]),
            "games": int(item.get("games_observed", 0) or 0),
            "unique_games": int(item.get("unique_games", item.get("games_observed", 0)) or 0),
            "reliability": item.get("reliability", "exploratory"),
            "actionable": bool(item.get("actionable", False)),
            "classification": item.get("classification", "other"),
            "historical_supported": bool(item.get("historical_supported", False)),
            "posterior_win_rate": item.get("posterior_win_rate"),
            "posterior_lift_pp": item.get("posterior_lift_pp"),
            "allocation_games": games,
            "account_allocations": [{"account": account, "games": per_account[account]} for account in target_accounts],
            "expected_regret_now": mean_now,
            "expected_regret_after": mean_after,
            "expected_regret_reduction": reduction,
            "rationale": (
                "Quota assegnata con simulazione Beta-Bernoulli per ridurre il rimpianto semplice finale atteso; "
                "stima Monte Carlo, euristica greedy e non ottimo globale."
            ),
        })

    return {
        "budget_total": budget_total,
        "budget_assigned": sum(item["allocation_games"] for item in result_items),
        "budget_default": 400,
        "budget_unassigned": budget_total - sum(item["allocation_games"] for item in result_items),
        "objective": "expected_final_simple_regret",
        "optimizer": _PLAN_VERSION,
        "simulation_scenarios": evaluation_scenarios,
        "optimization_scenarios": optimization_scenarios,
        "monte_carlo_se": standard_error,
        "expected_regret_now": mean_now,
        "expected_regret_after": mean_after,
        "expected_regret_reduction": reduction,
        "items": result_items,
    }


def _best_matched_tags(tags: set[str], references: list[tuple[str, set[str]]]) -> list[str]:
    matches = []
    for champion, reference in references:
        union = tags | reference
        similarity = len(tags & reference) / len(union) if union else 0.0
        matches.append((-similarity, champion, sorted(tags & reference)))
    return min(matches)[2] if matches else []


def exploration(playstyle_result) -> dict:
    """Return lifetime-untried, role-compatible taxonomy hypotheses only."""
    settings = current_settings()
    limit = int(settings["playstyle"]["suggestion_limit"])
    suggestions = playstyle_result.get("suggestions") or {}
    category_id = suggestions.get("category_id")
    role = str((playstyle_result.get("filters") or {}).get("role") or "")
    played = suggestions.get("played") or []
    references = [
        (canonical_champion(item["champion"]), set(champion_categories(item["champion"])))
        for item in played if item.get("champion")
    ]
    if not references and category_id:
        references = [
            (entry["id"], set(champion_categories(entry["id"])))
            for entry in load_catalog()["champions"]
            if category_id in champion_categories(entry["id"]) and role in entry["roles"]
        ]
    references.sort(key=lambda item: item[0])

    items = []
    for suggestion in suggestions.get("untried") or []:
        champion = canonical_champion(suggestion["champion"])
        compatible_roles = [str(value) for value in suggestion.get("roles", [])]
        if role not in compatible_roles:
            continue
        tags = set(champion_categories(champion))
        items.append({
            "champion": champion,
            "role": role,
            "icon_url": _icon_url(champion),
            "taxonomy_tags": list(suggestion.get("taxonomy_tags") or sorted(tags)),
            "matched_tags": list(suggestion.get("matched_tags") or _best_matched_tags(tags, references)),
            "jaccard_similarity": float(suggestion.get("similarity", 0.0)),
            "classification": "exploration",
            "lifetime_games_selected": 0,
            "rationale": (
                "Ipotesi del catalogo compatibile con il ruolo e mai giocata dagli account "
                "selezionati nello storico completo; non è una probabilità personale di vittoria."
            ),
        })
        if len(items) >= limit:
            break

    catalog = playstyle_result.get("catalog") or {}
    return {
        "items": items,
        "taxonomy_version": catalog.get("version") or load_catalog()["version"],
        "category_id": category_id,
    }
