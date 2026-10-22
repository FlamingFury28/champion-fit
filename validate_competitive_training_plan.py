"""Synthetic allocator benchmark, with exact two-arm Beta-Binomial reference.

No database, account history, tuning or model promotion is performed. The
reference assumes independent Beta arms, as the present allocator does; it
does not validate the hierarchical-to-Beta approximation or real outcomes.
"""
from __future__ import annotations

import argparse
from fractions import Fraction
from itertools import product
import json
import math
from pathlib import Path

from live_recommendations import _PLAN_VERSION, competitive_training_plan


def _beta_integer(alpha, beta):
    return Fraction(math.factorial(alpha - 1) * math.factorial(beta - 1),
                    math.factorial(alpha + beta - 1))


def _cdf_polynomial(alpha, beta):
    degree = alpha + beta - 1
    coefficients = [0] * (degree + 1)
    for k in range(alpha, degree + 1):
        for j in range(degree - k + 1):
            coefficients[k + j] += math.comb(degree, k) * math.comb(degree - k, j) * (-1) ** j
    return coefficients


def exact_regret(shapes, allocation):
    """Enumerate every success count, integrating integer-shape Beta arms."""
    if len(shapes) != 2 or len(allocation) != 2:
        raise ValueError("exact reference requires two arms")
    if any(type(x) is not int or not 1 <= x <= 12 for pair in shapes for x in pair):
        raise ValueError("exact reference requires integer shapes from 1 to 12")
    if any(type(n) is not int or n < 0 for n in allocation) or sum(allocation) > 30:
        raise ValueError("exact reference supports at most 30 allocated observations")
    cdfs = [_cdf_polynomial(*pair) for pair in shapes]
    expected_max_theta = 1 - sum((Fraction(a * b, i + j + 1)
                                 for i, a in enumerate(cdfs[0])
                                 for j, b in enumerate(cdfs[1])), Fraction())
    selected_mean = Fraction()
    for successes in product(*(range(n + 1) for n in allocation)):
        probability = Fraction(1)
        means = []
        for (alpha, beta), n, k in zip(shapes, allocation, successes):
            probability *= math.comb(n, k) * _beta_integer(alpha + k, beta + n - k) / _beta_integer(alpha, beta)
            means.append(Fraction(alpha + k, alpha + beta + n))
        selected_mean += probability * max(means)
    return float(expected_max_theta - selected_mean)


def benchmark(*, seeds=(11, 29, 47), scenarios=(16, 64, 256), evaluation_scenarios=512, budget=20):
    seeds, scenarios = tuple(seeds), tuple(scenarios)
    if not seeds or any(type(seed) is not int for seed in seeds):
        raise ValueError("seeds must contain integers")
    if not scenarios or any(type(count) is not int or count < 1 for count in scenarios):
        raise ValueError("scenarios must contain positive integers")
    if type(evaluation_scenarios) is not int or evaluation_scenarios < 1:
        raise ValueError("evaluation_scenarios must be a positive integer")
    if type(budget) is not int or not 20 <= budget <= 30:
        raise ValueError("benchmark budget must be an integer between 20 and 30")
    cases = {"symmetric": [(1, 1), (1, 1)], "unequal": [(2, 1), (2, 2)]}
    results = []
    for name, shapes in cases.items():
        regrets = [exact_regret(shapes, [n, budget - n]) for n in range(budget + 1)]
        optimum = min(regrets)
        initial = exact_regret(shapes, [0, 0])
        candidates = [{"champion": champion, "role": "MIDDLE", "account_shapes": {"synthetic": list(pair)}}
                      for champion, pair in zip(("Ahri", "Lux"), shapes)]
        runs = []
        for count, seed in product(scenarios, seeds):
            plan = competitive_training_plan(candidates, ["synthetic"], budget,
                                            optimization_scenarios=count,
                                            evaluation_scenarios=evaluation_scenarios, seed=seed)
            allocation = [item["allocation_games"] for item in plan["items"]]
            exact_after = regrets[allocation[0]]
            exact_reduction = initial - exact_after
            runs.append({"seed": seed, "optimization_scenarios": count,
                         "evaluation_scenarios": evaluation_scenarios, "allocation": allocation,
                         "exact_regret_after": exact_after, "excess_regret_vs_exact_optimum": exact_after - optimum,
                         "estimated_regret_reduction": plan["expected_regret_reduction"],
                         "exact_regret_reduction": exact_reduction,
                         "evaluation_error": plan["expected_regret_reduction"] - exact_reduction,
                         "monte_carlo_se": plan["monte_carlo_se"]})
        stability = [{"optimization_scenarios": count,
                      "first_arm_allocation_range": [min(r["allocation"][0] for r in runs if r["optimization_scenarios"] == count),
                                                     max(r["allocation"][0] for r in runs if r["optimization_scenarios"] == count)]}
                     for count in scenarios]
        results.append({"case": name, "shapes": shapes, "budget": budget,
                        "exact_optimum_regret": optimum,
                        "exact_optimum_allocations": [[n, budget - n] for n, regret in enumerate(regrets)
                                                       if abs(regret - optimum) < 1e-12],
                        "stability": stability, "runs": runs})
    return {"protocol": {"reference": "exact_integer_beta_binomial_enumeration",
                         "optimizer": _PLAN_VERSION,
                         "independent_arms": True, "synthetic_only": True,
                         "changes_default_scenarios": False, "promotes_model": False}, "cases": results}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--seeds", type=int, nargs="+", default=[11, 29, 47])
    parser.add_argument("--scenarios", type=int, nargs="+", default=[16, 64, 256])
    parser.add_argument("--evaluation-scenarios", type=int, default=512)
    parser.add_argument("--budget", type=int, default=20)
    args = parser.parse_args(argv)
    rendered = json.dumps(benchmark(seeds=args.seeds, scenarios=args.scenarios,
                                    evaluation_scenarios=args.evaluation_scenarios,
                                    budget=args.budget), indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered, encoding="utf-8")
    else:
        print(rendered, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
