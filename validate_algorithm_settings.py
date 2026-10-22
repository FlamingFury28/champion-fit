"""Read-only temporal validation for Champion Fit evidence settings.

The validator measures historical association, not a causal champion effect.
It keeps the competitive context fixed to Ranked Solo, uses raw binary outcomes,
and treats stored attribution weights as archive/audit fields only.

Examples::

    python validate_algorithm_settings.py --db champion_fit.db
    python validate_algorithm_settings.py --db snapshot.db --output report.json

The default run selects a sensitivity candidate on March-August 2026 and opens
September only after that candidate has been fixed.  SQLite is always opened in
``mode=ro`` with ``PRAGMA query_only=ON``.
"""

from __future__ import annotations

import argparse
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import hashlib
import json
import math
from pathlib import Path
import random
import sqlite3
import statistics
import unicodedata


RANKED_SOLO_QUEUES = frozenset({"420", "RANKED SOLO", "RANKED SOLO/DUO"})
DEFAULT_PRIOR_STRENGTHS = (8.0, 12.0, 20.0)
DEFAULT_PRIOR_STRENGTH = 8.0
DEFAULT_PRIOR_MEAN = 0.5
DEFAULT_LOOKBACK_DAYS = 180
DEFAULT_EMBARGO_HOURS = 24
DEFAULT_BOOTSTRAP_REPS = 1000
DEFAULT_BOOTSTRAP_SEED = 20260924
ESTIMANDS = ("global_match", "equal_account", "observation")
BOOTSTRAP_ESTIMANDS = ("global_match", "equal_account")
SCORES = ("log_loss", "brier", "calibration_bias")


@dataclass(frozen=True)
class Observation:
    account: str
    identity_group: str
    match_id: str
    occurred_at: datetime
    role: str
    champion: str
    win: int
    patch: str = ""


@dataclass(frozen=True)
class FoldSpec:
    name: str
    start: datetime
    end: datetime


def _identity_key(value: object) -> str:
    return unicodedata.normalize("NFKC", str(value or "")).strip().casefold()


def _utc(value: object) -> datetime:
    parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _utc_sort_value(value: object) -> str | None:
    """Return an exactly sortable UTC instant; malformed source text stays invalid."""
    try:
        return _utc(value).isoformat(timespec="microseconds")
    except (TypeError, ValueError, OverflowError):
        return None


def _date(value: str) -> datetime:
    parsed = datetime.strptime(value, "%Y-%m-%d")
    return parsed.replace(tzinfo=timezone.utc)


def _next_month(value: datetime) -> datetime:
    return datetime(
        value.year + (value.month == 12),
        1 if value.month == 12 else value.month + 1,
        1,
        tzinfo=timezone.utc,
    )


def monthly_folds(start: datetime, end: datetime) -> list[FoldSpec]:
    """Return complete half-open calendar-month folds in ``[start, end)``."""
    if start.day != 1 or end.day != 1 or end <= start:
        raise ValueError("selection dates must be increasing first days of a month")
    result = []
    current = start
    while current < end:
        following = _next_month(current)
        if following > end:
            raise ValueError("selection end must close a complete month")
        result.append(FoldSpec(current.strftime("%Y-%m"), current, following))
        current = following
    return result


def posterior_mean(wins: int, games: int, prior_strength: float,
                   prior_mean: float = DEFAULT_PRIOR_MEAN) -> float:
    """Return the Beta-binomial posterior mean with one prior contribution."""
    wins, games = int(wins), int(games)
    prior_strength, prior_mean = float(prior_strength), float(prior_mean)
    if games < 0 or wins < 0 or wins > games:
        raise ValueError("wins and games must describe binary outcomes")
    if not math.isfinite(prior_strength) or prior_strength <= 0:
        raise ValueError("prior_strength must be finite and positive")
    if not math.isfinite(prior_mean) or not 0 < prior_mean < 1:
        raise ValueError("prior_mean must be strictly between zero and one")
    return (wins + prior_mean * prior_strength) / (games + prior_strength)


def _table_exists(connection: sqlite3.Connection, name: str) -> bool:
    return connection.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,),
    ).fetchone() is not None


def load_observations(db_path: Path) -> tuple[list[Observation], dict]:
    """Load the bounded normalized input without reading retained raw JSON."""
    path = Path(db_path).resolve()
    connection = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    try:
        connection.execute("PRAGMA query_only=ON")
        connection.execute("BEGIN")
        connection.create_function("validation_utc", 1, _utc_sort_value, deterministic=True)
        identity_account: dict[str, str] = {}
        direct_identity: dict[str, str] = {}
        puuid_identity: dict[str, str] = {}
        if _table_exists(connection, "riot_account_identities"):
            for row in connection.execute(
                "SELECT identity_id,account FROM riot_account_identities"
            ):
                identity_account[str(row["identity_id"])] = str(row["account"])
                direct_identity[str(row["account"])] = str(row["identity_id"])
        if _table_exists(connection, "riot_identity_puuids"):
            puuid_identity = {
                str(row["puuid"]): str(row["identity_id"])
                for row in connection.execute(
                    "SELECT puuid,identity_id FROM riot_identity_puuids"
                )
            }
        alias_candidates: dict[str, set[str]] = defaultdict(set)
        if _table_exists(connection, "riot_account_aliases"):
            for row in connection.execute(
                "SELECT account,display_riot_id,normalized_riot_id,puuid "
                "FROM riot_account_aliases"
            ):
                identity = puuid_identity.get(str(row["puuid"]))
                if not identity:
                    continue
                for label in (row["account"], row["display_riot_id"], row["normalized_riot_id"]):
                    key = _identity_key(label)
                    if key:
                        alias_candidates[key].add(identity)
        unique_aliases = {
            key: next(iter(values)) for key, values in alias_candidates.items()
            if len(values) == 1
        }
        exceptions: set[str] = set()
        if _table_exists(connection, "riot_identity_policy"):
            exceptions = {
                str(row["identity_id"])
                for row in connection.execute(
                    "SELECT DISTINCT identity_id FROM riot_identity_policy "
                    "WHERE state='exception'"
                )
            }

        match_quality_columns = {
            str(row[1]) for row in connection.execute("PRAGMA table_info(match_quality)")
        }
        patch_expression = "m.patch" if "patch" in match_quality_columns else "''"
        rows = connection.execute(
            f"""WITH global_match_time AS (
                   SELECT match_id,MIN(validation_utc(date)) occurred_at,
                          COUNT(*)!=COUNT(validation_utc(date)) invalid_dates
                   FROM match_quality GROUP BY match_id
               )
               SELECT m.account,m.match_id,t.occurred_at,t.invalid_dates,
                      m.role,m.champion,m.win,m.queue,{patch_expression} patch
               FROM match_quality m
               JOIN global_match_time t ON t.match_id=m.match_id
               WHERE m.role!='INVALID'
               ORDER BY t.occurred_at,m.match_id,m.account"""
        )
        observations = []
        excluded_exceptions = 0
        registered = 0
        digest = hashlib.sha256()
        for row in rows:
            queue = str(row["queue"] or "").strip().upper()
            if queue not in RANKED_SOLO_QUEUES:
                continue
            saved_account = str(row["account"])
            identity = direct_identity.get(saved_account)
            if identity is None:
                identity = unique_aliases.get(_identity_key(saved_account))
            if identity in exceptions:
                excluded_exceptions += 1
                continue
            if identity is None:
                canonical = saved_account
                identity_group = "unregistered:" + hashlib.sha256(
                    _identity_key(saved_account).encode("utf-8")
                ).hexdigest()
            else:
                registered += 1
                canonical = identity_account.get(identity, saved_account)
                identity_group = identity
            # Never replace malformed source dates with a valid peer's time.
            if row["invalid_dates"]:
                raise ValueError(f"invalid timestamp for global match: {row['match_id']}")
            item = Observation(
                account=canonical,
                identity_group=identity_group,
                match_id=str(row["match_id"]),
                occurred_at=_utc(str(row["occurred_at"])),
                role=str(row["role"]),
                champion=str(row["champion"]),
                win=int(row["win"]),
                patch=str(row["patch"] or ""),
            )
            digest.update(repr((
                item.account, item.match_id, item.occurred_at.isoformat(),
                item.role, item.champion, item.win,
                item.patch,
            )).encode("utf-8"))
            observations.append(item)
        validate_observations(observations)
        metadata = {
            "database": str(path),
            "logical_input_sha256": digest.hexdigest(),
            "ranked_observations": len(observations),
            "unique_matches": len({row.match_id for row in observations}),
            "canonical_accounts": len({row.account for row in observations}),
            "registered_observations": registered,
            "unregistered_observations": len(observations) - registered,
            "exception_observations_excluded": excluded_exceptions,
            "raw_json_tables_read": False,
        }
        return observations, metadata
    finally:
        connection.close()


def validate_observations(observations: list[Observation]) -> None:
    """Reject duplicate account-match rows and inconsistent match timestamps."""
    seen = set()
    match_times: dict[str, datetime] = {}
    for row in observations:
        if row.win not in (0, 1):
            raise ValueError("win must be binary")
        key = (row.account, row.match_id)
        if key in seen:
            raise ValueError(f"duplicate account/match observation: {key!r}")
        seen.add(key)
        prior = match_times.setdefault(row.match_id, row.occurred_at)
        if prior != row.occurred_at:
            raise ValueError(f"global match timestamp is inconsistent: {row.match_id}")


def _losses(probability: float, outcome: int) -> dict[str, float]:
    return {
        "log_loss": -(outcome * math.log(probability)
                      + (1 - outcome) * math.log1p(-probability)),
        "brier": (probability - outcome) ** 2,
        "calibration_bias": probability - outcome,
    }


def replay_fold(observations: list[Observation], fold: FoldSpec, *,
                lookback_days: int, embargo_hours: int,
                prior_strengths: tuple[float, ...]) -> dict:
    """Fit before the embargo and predict a later, globally grouped fold."""
    train_end = fold.start - timedelta(hours=embargo_hours)
    train_start = train_end - timedelta(days=lookback_days)
    training = [row for row in observations if train_start <= row.occurred_at < train_end]
    holdout = [row for row in observations if fold.start <= row.occurred_at < fold.end]
    champion_counts: dict[tuple[str, str, str], list[int]] = defaultdict(lambda: [0, 0])
    role_counts: dict[tuple[str, str], list[int]] = defaultdict(lambda: [0, 0])
    for row in training:
        for counter in (
            champion_counts[(row.account, row.role, row.champion)],
            role_counts[(row.account, row.role)],
        ):
            counter[0] += row.win
            counter[1] += 1
    predictions = []
    for row in holdout:
        champion_wins, champion_games = champion_counts[
            (row.account, row.role, row.champion)
        ]
        role_wins, role_games = role_counts[(row.account, row.role)]
        probabilities = {"null_0_5": 0.5}
        for strength in prior_strengths:
            label = _strength_label(strength)
            probabilities[f"champion_{label}"] = posterior_mean(
                champion_wins, champion_games, strength,
            )
            probabilities[f"account_role_{label}"] = posterior_mean(
                role_wins, role_games, strength,
            )
        predictions.append({
            "account": row.account,
            "match_id": row.match_id,
            "win": row.win,
            "champion_history_games": champion_games,
            "role_history_games": role_games,
            "probabilities": probabilities,
            "losses": {
                model: _losses(probability, row.win)
                for model, probability in probabilities.items()
            },
        })
    return {
        "spec": fold,
        "train_start": train_start,
        "train_end": train_end,
        "training": training,
        "holdout": holdout,
        "predictions": predictions,
        "training_champion_cells": len(champion_counts),
        "training_role_cells": len(role_counts),
    }


def _strength_label(strength: float) -> str:
    return f"s{strength:g}".replace(".", "_")


def _aggregate(values: list[dict], model: str, score: str, estimand: str) -> float:
    if not values:
        raise ValueError("cannot score an empty holdout")
    if estimand == "observation":
        return statistics.fmean(row["losses"][model][score] for row in values)
    field = "match_id" if estimand == "global_match" else "account"
    groups: dict[str, list[float]] = defaultdict(list)
    for row in values:
        groups[row[field]].append(row["losses"][model][score])
    return statistics.fmean(statistics.fmean(group) for group in groups.values())


def score_fold(fold: dict, models: tuple[str, ...]) -> dict:
    return {
        model: {
            estimand: {
                score: _aggregate(fold["predictions"], model, score, estimand)
                for score in SCORES
            }
            for estimand in ESTIMANDS
        }
        for model in models
    }


def _mean_fold_scores(folds: list[dict], models: tuple[str, ...]) -> dict:
    return {
        model: {
            estimand: {
                score: statistics.fmean(
                    fold["scores"][model][estimand][score] for fold in folds
                )
                for score in SCORES
            }
            for estimand in ESTIMANDS
        }
        for model in models
    }


def _seed(base: int, label: str) -> int:
    digest = hashlib.sha256(f"{base}:{label}".encode("utf-8")).digest()
    return int.from_bytes(digest[:8], "big")


def paired_cluster_bootstrap(folds: list[dict], model: str, baseline: str,
                             score: str, estimand: str, *, reps: int,
                             seed: int) -> dict:
    """Pair model losses and resample global matches within every time fold."""
    if reps < 1:
        raise ValueError("bootstrap reps must be positive")
    clustered = []
    for fold in folds:
        matches: dict[str, list[dict]] = defaultdict(list)
        for row in fold["predictions"]:
            matches[row["match_id"]].append(row)
        clustered.append(matches)
    observed = statistics.fmean(
        fold["scores"][model][estimand][score]
        - fold["scores"][baseline][estimand][score]
        for fold in folds
    )
    randomizer = random.Random(_seed(seed, f"{model}:{baseline}:{score}:{estimand}"))
    samples = []
    for _ in range(reps):
        fold_values = []
        for matches in clustered:
            match_ids = list(matches)
            sampled = [randomizer.choice(match_ids) for _ in match_ids]
            if estimand == "global_match":
                fold_values.append(statistics.fmean(
                    statistics.fmean(
                        row["losses"][model][score]
                        - row["losses"][baseline][score]
                        for row in matches[match_id]
                    )
                    for match_id in sampled
                ))
            elif estimand == "observation":
                deltas = [
                    row["losses"][model][score]
                    - row["losses"][baseline][score]
                    for match_id in sampled for row in matches[match_id]
                ]
                fold_values.append(statistics.fmean(deltas))
            else:
                accounts: dict[str, list[float]] = defaultdict(list)
                for match_id in sampled:
                    for row in matches[match_id]:
                        accounts[row["account"]].append(
                            row["losses"][model][score]
                            - row["losses"][baseline][score]
                        )
                fold_values.append(statistics.fmean(
                    statistics.fmean(values) for values in accounts.values()
                ))
        samples.append(statistics.fmean(fold_values))
    ordered = sorted(samples)
    return {
        "delta": observed,
        "ci95": [_percentile(ordered, 0.025), _percentile(ordered, 0.975)],
        "cluster": "global_match_id",
        "fold_weighting": "equal",
        "bootstrap_reps": reps,
        "seed": seed,
    }


def _percentile(ordered: list[float], quantile: float) -> float:
    position = (len(ordered) - 1) * quantile
    lower, upper = math.floor(position), math.ceil(position)
    if lower == upper:
        return ordered[lower]
    return (ordered[lower] * (upper - position)
            + ordered[upper] * (position - lower))


def _fold_report(fold: dict) -> dict:
    holdout = fold["holdout"]
    predictions = fold["predictions"]
    return {
        "name": fold["spec"].name,
        "train_start": fold["train_start"].isoformat(),
        "train_end_exclusive": fold["train_end"].isoformat(),
        "test_start": fold["spec"].start.isoformat(),
        "test_end_exclusive": fold["spec"].end.isoformat(),
        "training_observations": len(fold["training"]),
        "training_unique_matches": len({row.match_id for row in fold["training"]}),
        "training_accounts": len({row.account for row in fold["training"]}),
        "training_champion_cells": fold["training_champion_cells"],
        "test_observations": len(holdout),
        "test_unique_matches": len({row.match_id for row in holdout}),
        "test_accounts": len({row.account for row in holdout}),
        "test_champion_cells": len({
            (row.account, row.role, row.champion) for row in holdout
        }),
        "test_observations_with_champion_history": sum(
            row["champion_history_games"] > 0 for row in predictions
        ),
        "scores": fold["scores"],
    }


def _score_replays(replays: list[dict], models: tuple[str, ...]) -> list[dict]:
    for fold in replays:
        if not fold["predictions"]:
            raise ValueError(f"empty holdout fold: {fold['spec'].name}")
        fold["scores"] = score_fold(fold, models)
    return replays


def validate_settings(observations: list[Observation], *,
                      selection_folds: list[FoldSpec], final_fold: FoldSpec,
                      lookback_days: int = DEFAULT_LOOKBACK_DAYS,
                      embargo_hours: int = DEFAULT_EMBARGO_HOURS,
                      prior_strengths: tuple[float, ...] = DEFAULT_PRIOR_STRENGTHS,
                      bootstrap_reps: int = DEFAULT_BOOTSTRAP_REPS,
                      bootstrap_seed: int = DEFAULT_BOOTSTRAP_SEED) -> dict:
    """Run the frozen selection/final protocol and return a JSON-ready report."""
    if DEFAULT_PRIOR_STRENGTH not in prior_strengths:
        raise ValueError("the configured strength 8 must be in the grid")
    if len(set(prior_strengths)) != len(prior_strengths):
        raise ValueError("prior strengths must be unique")
    if not 1 <= bootstrap_reps <= 10000:
        raise ValueError("bootstrap reps must be between 1 and 10000")
    validate_observations(observations)
    models = ("null_0_5",) + tuple(
        model
        for strength in prior_strengths
        for model in (
            f"champion_{_strength_label(strength)}",
            f"account_role_{_strength_label(strength)}",
        )
    )
    selection = _score_replays([
        replay_fold(
            observations, fold, lookback_days=lookback_days,
            embargo_hours=embargo_hours, prior_strengths=prior_strengths,
        )
        for fold in selection_folds
    ], models)
    selection_means = _mean_fold_scores(selection, models)
    candidate_models = {
        strength: f"champion_{_strength_label(strength)}"
        for strength in prior_strengths
    }
    empirical_strength = min(
        prior_strengths,
        key=lambda strength: (
            selection_means[candidate_models[strength]]["global_match"]["log_loss"],
            selection_means[candidate_models[strength]]["global_match"]["brier"],
            strength,
        ),
    )
    empirical_model = candidate_models[empirical_strength]
    default_model = candidate_models[DEFAULT_PRIOR_STRENGTH]
    final = _score_replays([
        replay_fold(
            observations, final_fold, lookback_days=lookback_days,
            embargo_hours=embargo_hours, prior_strengths=prior_strengths,
        )
    ], models)
    final_means = _mean_fold_scores(final, models)

    comparisons = {}
    for strength, model in candidate_models.items():
        if strength == DEFAULT_PRIOR_STRENGTH:
            continue
        comparisons[str(strength)] = {
            estimand: {
                score: paired_cluster_bootstrap(
                    selection, model, default_model, score, estimand,
                    reps=bootstrap_reps, seed=bootstrap_seed,
                )
                for score in ("log_loss", "brier")
            }
            for estimand in BOOTSTRAP_ESTIMANDS
        }
    empirical_vs_null = {
        estimand: {
            score: paired_cluster_bootstrap(
                selection, empirical_model, "null_0_5", score, estimand,
                reps=bootstrap_reps, seed=bootstrap_seed,
            )
            for score in ("log_loss", "brier")
        }
        for estimand in BOOTSTRAP_ESTIMANDS
    }
    final_vs_default = {
        estimand: {
            score: paired_cluster_bootstrap(
                final, empirical_model, default_model, score, estimand,
                reps=bootstrap_reps, seed=bootstrap_seed,
            )
            for score in ("log_loss", "brier")
        }
        for estimand in BOOTSTRAP_ESTIMANDS
    }
    final_vs_null = {
        estimand: {
            score: paired_cluster_bootstrap(
                final, empirical_model, "null_0_5", score, estimand,
                reps=bootstrap_reps, seed=bootstrap_seed,
            )
            for score in ("log_loss", "brier")
        }
        for estimand in BOOTSTRAP_ESTIMANDS
    }
    best_comparison = comparisons.get(str(empirical_strength))
    promotion_checks = {
        "selection_match_beats_strength_8": empirical_strength == DEFAULT_PRIOR_STRENGTH or (
            best_comparison["global_match"]["log_loss"]["ci95"][1] < 0
        ),
        "selection_equal_account_beats_strength_8": empirical_strength == DEFAULT_PRIOR_STRENGTH or (
            best_comparison["equal_account"]["log_loss"]["ci95"][1] < 0
        ),
        "selection_match_beats_null": empirical_vs_null["global_match"]["log_loss"]["ci95"][1] < 0,
        "final_match_beats_null": final_vs_null["global_match"]["log_loss"]["ci95"][1] < 0,
    }
    promotion_eligible = all(promotion_checks.values())
    reasons = []
    if empirical_strength != DEFAULT_PRIOR_STRENGTH:
        reasons.append(
            "The grid winner is a sensitivity result, not an automatic settings change."
        )
    if not promotion_checks["selection_equal_account_beats_strength_8"]:
        reasons.append(
            "The equal-account estimand does not validate the match-level improvement over strength 8."
        )
    if not promotion_checks["selection_match_beats_null"]:
        reasons.append(
            "The champion posterior does not beat the constant 0.5 benchmark in selection folds."
        )
    if not promotion_checks["final_match_beats_null"]:
        reasons.append(
            "The frozen candidate does not beat the constant 0.5 benchmark in the final fold."
        )
    reasons.append(
        "Strength 20 is the prudent upper edge of this bounded grid, not a global optimum."
    )
    return {
        "protocol": {
            "estimand": "equal-account historical association",
            "common_context": {"queue": "420", "days": lookback_days},
            "prior_mean": DEFAULT_PRIOR_MEAN,
            "prior_strength_grid": list(prior_strengths),
            "configured_default_prior_strength": DEFAULT_PRIOR_STRENGTH,
            "embargo_hours": embargo_hours,
            "bootstrap": {
                "reps": bootstrap_reps,
                "seed": bootstrap_seed,
                "cluster": "global_match_id",
                "time_fold_weighting": "equal",
            },
            "outcome": "raw binary win/loss",
            "attribution_weights_used": False,
            "negative_veto_used": False,
            "causal_claim": False,
        },
        "selection": {
            "folds": [_fold_report(fold) for fold in selection],
            "equal_fold_mean_scores": selection_means,
            "empirical_grid_best_strength": empirical_strength,
            "comparisons_vs_strength_8": comparisons,
            "empirical_best_vs_null": empirical_vs_null,
        },
        "final": {
            "fold": _fold_report(final[0]),
            "scores": final_means,
            "empirical_best_vs_strength_8": final_vs_default,
            "empirical_best_vs_null": final_vs_null,
        },
        "decision": {
            "recommended_prior_mean": DEFAULT_PRIOR_MEAN,
            "recommended_prior_strength": DEFAULT_PRIOR_STRENGTH,
            "promotion_eligible": promotion_eligible,
            "promotion_checks": promotion_checks,
            "reasons": reasons,
            "probability_interpretation": (
                "Historical raw-outcome estimate; predictive usefulness and causal benefit are not validated."
            ),
            "ranking_interpretation": (
                "Proper scores cover champions actually played and do not validate counterfactual top-N rankings."
            ),
        },
        "limits": [
            "Observational champion selection can confound every historical association.",
            "Sessions, patches, MMR, teammates and repeated accounts create dependence beyond match clusters.",
            "Canonical identity links may include explicit assumptions; unlinked smurfs cannot be inferred.",
            "A temporal replay does not guarantee future calibration.",
            "Unique matches and account-match observations are reported separately.",
        ],
    }


def _round_floats(value):
    if isinstance(value, float):
        return round(value, 10)
    if isinstance(value, dict):
        return {str(key): _round_floats(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_round_floats(item) for item in value]
    return value


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, required=True)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--selection-start", default="2026-03-01")
    parser.add_argument("--selection-end", default="2026-09-01")
    parser.add_argument("--final-start", default="2026-09-01")
    parser.add_argument("--final-end", default="2026-10-01")
    parser.add_argument("--lookback-days", type=int, default=DEFAULT_LOOKBACK_DAYS)
    parser.add_argument("--embargo-hours", type=int, default=DEFAULT_EMBARGO_HOURS)
    parser.add_argument("--bootstrap-reps", type=int, default=DEFAULT_BOOTSTRAP_REPS)
    parser.add_argument("--bootstrap-seed", type=int, default=DEFAULT_BOOTSTRAP_SEED)
    args = parser.parse_args(argv)
    if args.lookback_days <= 0 or args.embargo_hours < 0:
        parser.error("lookback-days must be positive and embargo-hours nonnegative")
    selection_start, selection_end = _date(args.selection_start), _date(args.selection_end)
    final_start, final_end = _date(args.final_start), _date(args.final_end)
    if final_end <= final_start or final_start < selection_end:
        parser.error("final dates must follow the complete selection period")
    observations, input_metadata = load_observations(args.db)
    report = validate_settings(
        observations,
        selection_folds=monthly_folds(selection_start, selection_end),
        final_fold=FoldSpec("final", final_start, final_end),
        lookback_days=args.lookback_days,
        embargo_hours=args.embargo_hours,
        bootstrap_reps=args.bootstrap_reps,
        bootstrap_seed=args.bootstrap_seed,
    )
    report["input"] = input_metadata
    report["created_utc"] = datetime.now(timezone.utc).isoformat()
    report = _round_floats(report)
    rendered = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        output = args.output.resolve()
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(rendered, encoding="utf-8")
        print(json.dumps({
            "output": str(output),
            "recommended_prior_strength": report["decision"]["recommended_prior_strength"],
            "empirical_grid_best_strength": report["selection"]["empirical_grid_best_strength"],
            "promotion_eligible": report["decision"]["promotion_eligible"],
        }, ensure_ascii=False))
    else:
        print(rendered, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
