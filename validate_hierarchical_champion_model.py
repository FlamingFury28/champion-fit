"""Temporal validation for the hierarchical champion outcome model.

Run with ``python validate_hierarchical_champion_model.py --db champion_fit.db``.
The input loader opens SQLite read-only, removes registered identity
exceptions, and keeps Ranked Solo/Duo observations. Match IDs are globally
time-split with a 24-hour embargo. This measures held-out association, not a
causal champion effect or the outcome of counterfactual picks.
"""
from __future__ import annotations

import argparse
from collections import defaultdict
from datetime import datetime, timedelta, timezone
import json
import math
from pathlib import Path
import statistics

from hierarchical_champion_model import _fit, predict_observation
from validate_algorithm_settings import Observation, _date, load_observations, monthly_folds


LOOKBACK_DAYS = 180
EMBARGO_HOURS = 24
PRIOR_STRENGTH = 8.0
MODELS = ("hierarchical", "current_champion_beta", "account_rate", "constant_0_5")


def _row(observation: Observation) -> dict:
    return {
        "account": observation.account,
        "match_id": observation.match_id,
        "date": observation.occurred_at.isoformat(),
        "champion": observation.champion,
        "role": observation.role,
        "queue": "420",
        "patch": observation.patch,
        "win": observation.win,
    }


def _log_loss(probability: float, win: int) -> float:
    probability = min(1.0 - 1e-12, max(1e-12, probability))
    return -(win * math.log(probability) + (1 - win) * math.log1p(-probability))


def _scores(rows: list[dict], predictions: dict[str, list[float]]) -> dict:
    result = {}
    for model in MODELS:
        observations = []
        for row, probability in zip(rows, predictions[model]):
            observations.append({
                "account": row["account"], "match_id": row["match_id"], "win": row["win"],
                "probability": probability,
                "log_loss": _log_loss(probability, row["win"]),
                "brier": (probability - row["win"]) ** 2,
            })
        by_account = defaultdict(list)
        by_match = defaultdict(list)
        for item in observations:
            by_account[item["account"]].append(item)
            by_match[item["match_id"]].append(item)
        bins = []
        for index in range(10):
            cell = [item for item in observations
                    if index / 10 <= item["probability"] < (index + 1) / 10
                    or (index == 9 and item["probability"] == 1.0)]
            if cell:
                predicted = statistics.fmean(item["probability"] for item in cell)
                observed = statistics.fmean(item["win"] for item in cell)
                bins.append({"lower": index / 10, "upper": (index + 1) / 10,
                             "count": len(cell), "predicted": predicted, "observed": observed})
        result[model] = {
            "observations": len(observations),
            "unique_matches": len(by_match),
            "accounts": len(by_account),
            "observation": {
                "log_loss": statistics.fmean(item["log_loss"] for item in observations),
                "brier": statistics.fmean(item["brier"] for item in observations),
            },
            "match_equal": {
                "log_loss": statistics.fmean(statistics.fmean(item["log_loss"] for item in values)
                                             for values in by_match.values()),
                "brier": statistics.fmean(statistics.fmean(item["brier"] for item in values)
                                          for values in by_match.values()),
            },
            "account_equal": {
                "log_loss": statistics.fmean(statistics.fmean(item["log_loss"] for item in values)
                                             for values in by_account.values()),
                "brier": statistics.fmean(statistics.fmean(item["brier"] for item in values)
                                          for values in by_account.values()),
            },
            "calibration_bias": statistics.fmean(item["probability"] - item["win"] for item in observations),
            "calibration_bins": bins,
        }
    return result


def _top_picks(training: list[dict], holdout: list[dict], fit: dict) -> dict:
    candidate_counts = defaultdict(lambda: [0, 0])
    account_counts = defaultdict(lambda: [0, 0])
    for row in training:
        cell = candidate_counts[(row["account"], row["role"], row["champion"])]
        cell[0] += row["win"]
        cell[1] += 1
        account = account_counts[row["account"]]
        account[0] += row["win"]
        account[1] += 1

    recent_patch = max(training, key=lambda row: row["date"])["patch"] if training else ""
    candidates_by_account_role = defaultdict(list)
    for (account, role, champion), (wins, games) in candidate_counts.items():
        representative = {
            "account": account, "match_id": "future", "champion": champion,
            "role": role, "queue": "420", "patch": recent_patch, "win": 0,
        }
        hierarchical = predict_observation(representative, fit)
        beta = (wins + PRIOR_STRENGTH * 0.5) / (games + PRIOR_STRENGTH)
        candidates_by_account_role[(account, role)].append((champion, hierarchical, beta))

    top = {}
    for key, candidates in candidates_by_account_role.items():
        top[key] = {
            "hierarchical": max(candidates, key=lambda item: (item[1], item[0]))[0],
            "current_champion_beta": max(candidates, key=lambda item: (item[2], item[0]))[0],
        }

    report = {}
    for model in ("hierarchical", "current_champion_beta"):
        selected = [row for row in holdout
                    if top.get((row["account"], row["role"]), {}).get(model) == row["champion"]]
        chosen_by_accounts = len({row["account"] for row in selected})
        account_rate = statistics.fmean(
            account_counts[account][0] / account_counts[account][1]
            for account in {row["account"] for row in selected}
            if account_counts[account][1]
        ) if chosen_by_accounts else None
        report[model] = {
            "observations": len(selected),
            "unique_matches": len({row["match_id"] for row in selected}),
            "accounts": chosen_by_accounts,
            "holdout_win_rate": statistics.fmean(row["win"] for row in selected) if selected else None,
            "training_account_win_rate": account_rate,
            "coverage": len(selected) / max(len(holdout), 1),
        }
    return report


def replay_fold(observations: list[Observation], start: datetime, end: datetime,
                name: str) -> dict:
    train_end = start - timedelta(hours=EMBARGO_HOURS)
    train_start = train_end - timedelta(days=LOOKBACK_DAYS)
    training = [_row(row) for row in observations if train_start <= row.occurred_at < train_end]
    holdout = [_row(row) for row in observations if start <= row.occurred_at < end]
    training_matches = {row["match_id"] for row in training}
    holdout_matches = {row["match_id"] for row in holdout}
    if training_matches & holdout_matches:
        raise AssertionError("a global match_id crossed the time split")
    if not training or not holdout:
        return {"name": name, "train_start": train_start.isoformat(), "train_end": train_end.isoformat(),
                "holdout_start": start.isoformat(), "holdout_end": end.isoformat(),
                "training_observations": len(training), "holdout_observations": len(holdout),
                "skipped": "training or holdout is empty"}

    fit = _fit(training)
    champion_cells = defaultdict(lambda: [0, 0])
    account_cells = defaultdict(lambda: [0, 0])
    for row in training:
        candidate = champion_cells[(row["account"], row["role"], row["champion"])]
        candidate[0] += row["win"]
        candidate[1] += 1
        account = account_cells[row["account"]]
        account[0] += row["win"]
        account[1] += 1
    predictions = {model: [] for model in MODELS}
    for row in holdout:
        wins, games = champion_cells[(row["account"], row["role"], row["champion"])]
        account_wins, account_games = account_cells[row["account"]]
        predictions["hierarchical"].append(predict_observation(row, fit))
        predictions["current_champion_beta"].append(
            (wins + PRIOR_STRENGTH * 0.5) / (games + PRIOR_STRENGTH)
        )
        predictions["account_rate"].append(
            (account_wins + PRIOR_STRENGTH * 0.5) / (account_games + PRIOR_STRENGTH)
        )
        predictions["constant_0_5"].append(0.5)
    return {
        "name": name,
        "train_start": train_start.isoformat(),
        "train_end": train_end.isoformat(),
        "holdout_start": start.isoformat(),
        "holdout_end": end.isoformat(),
        "training_observations": len(training),
        "training_unique_matches": len(training_matches),
        "holdout_observations": len(holdout),
        "holdout_unique_matches": len(holdout_matches),
        "match_ids_separated": not bool(training_matches & holdout_matches),
        "scores": _scores(holdout, predictions),
        "top_picks": _top_picks(training, holdout, fit),
    }


def validate(observations: list[Observation], *, selection_start: str,
             selection_end: str, final_start: str, final_end: str) -> dict:
    selection_folds = monthly_folds(_date(selection_start), _date(selection_end))
    final_fold = (_date(final_start), _date(final_end))
    folds = [replay_fold(observations, fold.start, fold.end, fold.name) for fold in selection_folds]
    folds.append(replay_fold(observations, final_fold[0], final_fold[1], "final"))
    evaluated = [fold for fold in folds if not fold.get("skipped")]
    gates = {}
    for baseline in ("current_champion_beta", "account_rate", "constant_0_5"):
        gates[baseline] = {
            "every_fold_match_log_loss": bool(evaluated) and all(
                fold["scores"]["hierarchical"]["match_equal"]["log_loss"]
                < fold["scores"][baseline]["match_equal"]["log_loss"] for fold in evaluated
            ),
            "every_fold_account_log_loss": bool(evaluated) and all(
                fold["scores"]["hierarchical"]["account_equal"]["log_loss"]
                < fold["scores"][baseline]["account_equal"]["log_loss"] for fold in evaluated
            ),
            "every_fold_match_brier": bool(evaluated) and all(
                fold["scores"]["hierarchical"]["match_equal"]["brier"]
                < fold["scores"][baseline]["match_equal"]["brier"] for fold in evaluated
            ),
            "every_fold_account_brier": bool(evaluated) and all(
                fold["scores"]["hierarchical"]["account_equal"]["brier"]
                < fold["scores"][baseline]["account_equal"]["brier"] for fold in evaluated
            ),
        }
    gate_passed = bool(evaluated) and all(all(checks.values()) for checks in gates.values())
    return {
        "protocol": {
            "model_version": "hierarchical_logit_laplace_v1",
            "queue": "Ranked Solo/Duo",
            "lookback_days": LOOKBACK_DAYS,
            "embargo_hours": EMBARGO_HOURS,
            "outcome": "unweighted raw binary win/loss",
            "shared_match_split": True,
            "metrics": ["log_loss", "brier", "calibration_bias", "calibration_bins", "top_pick_holdout_win_rate"],
            "promotion_rule": "beat every baseline in every temporal fold on match-equal and account-equal log-loss and Brier",
            "causal_claim": False,
        },
        "folds": folds,
        "promotion_gates": gates,
        "validated": gate_passed,
        "status": "validated" if gate_passed else "exploratory",
        "limits": [
            "Prediction scoring concerns champion-role cells actually observed in each holdout.",
            "Top-pick win rate is conditional on the player actually choosing that historical pick.",
            "No temporal split identifies a causal or counterfactual champion effect.",
        ],
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, required=True)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--selection-start", default="2026-03-01")
    parser.add_argument("--selection-end", default="2026-09-01")
    parser.add_argument("--final-start", default="2026-09-01")
    parser.add_argument("--final-end", default="2026-10-01")
    args = parser.parse_args(argv)
    observations, metadata = load_observations(args.db)
    report = validate(observations, selection_start=args.selection_start,
                      selection_end=args.selection_end, final_start=args.final_start,
                      final_end=args.final_end)
    report["input"] = metadata
    report["created_utc"] = datetime.now(timezone.utc).isoformat()
    rendered = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        output = args.output.resolve()
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(rendered, encoding="utf-8")
        print(json.dumps({"output": str(output), "status": report["status"],
                          "folds": len(report["folds"])}, ensure_ascii=False))
    else:
        print(json.dumps({"status": report["status"], "folds": report["folds"],
                          "promotion_gates": report["promotion_gates"]}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
