"""Historical sensitivity audit for the superseded weighted recommendation model.

Run: python validate_algorithm.py --db champion_fit.db
Only generated files under --output are written; application/database startup is
never invoked. Results describe attribution scores, not causal champion effects.
"""

from __future__ import annotations

import argparse
from collections import defaultdict
from datetime import datetime, timedelta, timezone
import hashlib
import json
import math
from pathlib import Path
import statistics

import app
from match_scoring import duration_loss_weight, loss_attribution_weight
from storage import SQLiteStorage


SCENARIOS = (
    "current", "half_current", "quarter_current", "zero_losses",
    "full_losses", "symmetric_quality", "duration_only",
)


class ReadOnlyStorage(SQLiteStorage):
    def connect(self):
        import sqlite3

        connection = sqlite3.connect(self.path.resolve().as_uri() + "?mode=ro", uri=True)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA query_only=ON")
        return connection


def load_rows(path: Path) -> list[dict]:
    connection = ReadOnlyStorage(path, app.SCHEMA_PATH).connect()
    try:
        return [dict(row) for row in connection.execute("""
            SELECT m.account,m.match_id,m.date,m.role,m.champion,m.win,
                   m.duration_minutes,m.queue,m.identity_resolution,m.reason,
                   m.anomaly_flags,m.explicit_afk,m.suspected_quasi_afk,
                   m.early_surrender,m.win_evidence_weight,
                   m.loss_attribution_weight,m.match_quality_score,
                   CASE WHEN COALESCE(a.invincible,0)=1
                          OR COALESCE(a.afk_player,0)=1
                          OR COALESCE(a.griefer,0)=1 THEN 1 ELSE 0 END excluded
            FROM match_quality m
            LEFT JOIN match_annotations a ON a.match_id=m.match_id
            ORDER BY m.account,m.match_id
        """)]
    finally:
        connection.close()


def evidence(row: dict, scenario: str) -> tuple[float, float]:
    if scenario not in SCENARIOS:
        raise ValueError(f"Unknown scenario: {scenario}")
    if row["win"]:
        weight = row["match_quality_score"] if scenario == "symmetric_quality" else row["win_evidence_weight"]
        return float(weight), 0.0
    if row["excluded"]:
        return 0.0, 0.0
    stored = float(row["loss_attribution_weight"])
    weight = {
        "current": stored,
        "half_current": stored * 0.5,
        "quarter_current": stored * 0.25,
        "zero_losses": 0.0,
        "full_losses": 1.0,
        "symmetric_quality": float(row["match_quality_score"]),
        "duration_only": duration_loss_weight(row["duration_minutes"]),
    }[scenario]
    return 0.0, weight


def aggregate(rows: list[dict], scenario: str) -> list[dict]:
    groups = {}
    for row in rows:
        if row["role"] == "INVALID":
            continue
        key = (row["champion"], row["role"])
        item = groups.setdefault(key, {
            "champion": row["champion"], "role": row["role"], "games": 0,
            "wins": 0, "positive_evidence": 0.0, "negative_evidence": 0.0,
        })
        positive, negative = evidence(row, scenario)
        item["games"] += 1
        item["wins"] += row["win"]
        item["positive_evidence"] += positive
        item["negative_evidence"] += negative
    return list(groups.values())


def prior_parameters(candidates: list[dict]) -> dict[tuple, tuple[float, float]]:
    """Effective prior entering each posterior, including its role baseline."""
    priors = app.recommendation_role_priors(candidates)
    totals = defaultdict(lambda: [0.0, 0.0])
    for row in candidates:
        totals[row["role"]][0] += row["positive_evidence"]
        totals[row["role"]][1] += row["negative_evidence"]
    result = {}
    for row in candidates:
        mean, strength = priors.get(row["role"], (0.5, 2.0))
        positive, negative = totals[row["role"]]
        a = mean * strength + max(positive - row["positive_evidence"], 0.0)
        b = (1 - mean) * strength + max(negative - row["negative_evidence"], 0.0)
        result[(row["champion"], row["role"])] = (a / (a + b) * strength, b / (a + b) * strength)
    return result


def rank_fixed_prior(candidates: list[dict], reference: list[dict], limit: int = 3) -> list[dict]:
    parameters = prior_parameters(reference)
    ranked = []
    for row in candidates:
        if row["games"] < 3:
            continue
        a, b = parameters[(row["champion"], row["role"])]
        a += row["positive_evidence"]
        b += row["negative_evidence"]
        mean = a / (a + b)
        sd = math.sqrt(a * b / ((a + b) ** 2 * (a + b + 1)))
        lower, upper = max(0.0, mean - app.MATCHUP_Z_90 * sd), min(1.0, mean + app.MATCHUP_Z_90 * sd)
        ranked.append({
            "champion": row["champion"], "role": row["role"],
            "games": row["games"], "score": round(lower * 100, 1),
            "posterior_fit": round(mean * 100, 1),
            "credible_lower_90": round(lower * 100, 1),
            "credible_upper_90": round(upper * 100, 1),
            "effective_evidence": round(row["positive_evidence"] + row["negative_evidence"], 2),
        })
    ranked.sort(key=lambda r: (-r["score"], -r["posterior_fit"], -r["effective_evidence"], -r["games"], r["champion"], r["role"]))
    chosen, seen = [], set()
    for row in ranked:
        if row["champion"] not in seen:
            chosen.append(row)
            seen.add(row["champion"])
            if len(chosen) == limit:
                break
    return chosen


def key(item: dict) -> tuple[str, str]:
    return item["champion"], item["role"]


def comparison(reference: list[dict], alternative: list[dict]) -> dict:
    first, second = [key(r) for r in reference], [key(r) for r in alternative]
    return {
        "top1_changed": first[:1] != second[:1],
        "top3_set_changed": set(first) != set(second),
        "top3_order_changed": first != second,
        "shared_top3": len(set(first) & set(second)),
        "top3_champions_changed": {r[0] for r in first} != {r[0] for r in second},
    }


def assess_scope(rows: list[dict]) -> dict:
    aggregates = {s: aggregate(rows, s) for s in SCENARIOS}
    rankings = {s: app.rank_recommendations(c) for s, c in aggregates.items()}
    rankings["current_fixed_full_prior"] = rank_fixed_prior(aggregates["current"], aggregates["full_losses"])
    details = {}
    for scenario, candidates in aggregates.items():
        indexed = {key(r): r for r in candidates}
        parameters = prior_parameters(candidates)
        details[scenario] = []
        for ranked in rankings[scenario]:
            row = indexed[key(ranked)]
            a, b = parameters[key(row)]
            details[scenario].append({
                **ranked, "wins": row["wins"], "losses": row["games"] - row["wins"],
                "raw_win_rate": round(row["wins"] / row["games"] * 100, 2),
                "negative_evidence": round(row["negative_evidence"], 3),
                "prior_strength": round(a + b, 3),
                "prior_fraction": round((a + b) / (a + b + row["positive_evidence"] + row["negative_evidence"]), 4),
            })
    # This independent reconstruction is also used for the frozen-prior arm.
    reconstructed = rank_fixed_prior(aggregates["current"], aggregates["current"])
    for actual, rebuilt in zip(rankings["current"], reconstructed, strict=True):
        for field in rebuilt:
            assert actual[field] == rebuilt[field], (field, actual, rebuilt)
    return {
        "observations": len(rows), "unique_matches": len({r["match_id"] for r in rows}),
        "rankings": rankings, "details": details,
        "role_priors": {s: app.recommendation_role_priors(c) for s, c in aggregates.items()},
        "comparisons_vs_current": {s: comparison(rankings["current"], ranking) for s, ranking in rankings.items() if s != "current"},
    }


def main() -> None:
    if hasattr(app, "scoped_champion_evidence"):
        raise SystemExit(
            "This audit targets the superseded weighted model. Preserve its existing "
            "outputs; run validate_algorithm_corrections.py for the current model."
        )
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, default=app.DB_PATH)
    parser.add_argument("--output", type=Path, default=Path("outputs/algorithm_validation"))
    args = parser.parse_args()
    source_names = ["app.py", "match_scoring.py", "validate_algorithm.py"]
    source_bytes = {name: (app.APP_ROOT / name).read_bytes() for name in source_names}
    rows = load_rows(args.db)
    if not rows:
        raise SystemExit("No match data to validate")
    valid = [row for row in rows if row["role"] != "INVALID"]
    by_account = defaultdict(list)
    for row in valid:
        by_account[row["account"]].append(row)
    scopes = {"all_accounts": assess_scope(valid)}
    scopes.update({account: assess_scope(matches) for account, matches in sorted(by_account.items())})
    # Parity with the real profile SQL, using a read-only connection exclusively.
    previous = app.STORAGE
    app.STORAGE = ReadOnlyStorage(args.db, app.SCHEMA_PATH)
    try:
        for name, result in scopes.items():
            params = {} if name == "all_accounts" else {"account": [name]}
            status, payload = app.query_database("/api/profile", params)
            assert int(status) == 200
            # Explanatory UI metadata can contain SQL-only match counts. This
            # audit checks the actual ordering, scores, intervals and confidence.
            numeric_payload = [{k: v for k, v in r.items() if k not in {"explanation", "reason"}} for r in payload["recommendations"]]
            numeric_result = [{k: v for k, v in r.items() if k not in {"explanation", "reason"}} for r in result["rankings"]["current"]]
            assert numeric_payload == numeric_result, name
    finally:
        app.STORAGE = previous
    account_scopes = [scopes[name] for name in sorted(by_account) if scopes[name]["rankings"]["current"]]
    sensitivity = {}
    for scenario in scopes["all_accounts"]["comparisons_vs_current"]:
        comparisons = [r["comparisons_vs_current"][scenario] for r in account_scopes]
        sensitivity[scenario] = {
            "accounts_evaluated": len(comparisons),
            **{field: sum(r[field] for r in comparisons) for field in ("top1_changed", "top3_set_changed", "top3_order_changed", "top3_champions_changed")},
            "mean_shared_top3": statistics.mean(r["shared_top3"] for r in comparisons),
        }
    losses, wins = [r for r in valid if not r["win"]], [r for r in valid if r["win"]]
    positive = sum(evidence(r, "current")[0] for r in valid)
    negative = sum(evidence(r, "current")[1] for r in valid)
    source_groups = defaultdict(list)
    mismatches = []
    bands = defaultdict(list)
    for row in losses:
        recomputed = loss_attribution_weight(row["duration_minutes"], row["anomaly_flags"], bool(row["explicit_afk"]), bool(row["suspected_quasi_afk"]), bool(row["early_surrender"]))
        source_groups[row["identity_resolution"]].append((row, recomputed))
        if abs(row["loss_attribution_weight"] - recomputed) > 0.001:
            mismatches.append(row)
        duration = row["duration_minutes"]
        band = next((label for upper, label in [(10,"<10"),(15,"10-15"),(20,"15-20"),(23,"20-23"),(27,"23-27"),(math.inf,">=27")] if duration < upper))
        bands[band].append(row)
    boundary = max(datetime.fromisoformat(r["date"].replace("Z", "+00:00")) for r in valid) - timedelta(days=90)
    subsets = {
        "ranked_solo_only": [r for r in valid if str(r["queue"]).upper() in {"420", "RANKED SOLO/DUO", "RANKED SOLO"}],
        "last_90_days_of_dataset": [r for r in valid if datetime.fromisoformat(r["date"].replace("Z", "+00:00")) >= boundary],
    }
    for name, subset in subsets.items():
        scopes[name] = assess_scope(subset)
    report = {
        "created_utc": datetime.now(timezone.utc).isoformat(),
        "source_hashes": {name: hashlib.sha256(content).hexdigest() for name, content in source_bytes.items()},
        "logical_data_sha256": hashlib.sha256(json.dumps(rows, sort_keys=True).encode()).hexdigest(),
        "method": {
            "read_only": True, "api_parity_scopes": len(by_account) + 1,
            "unit": "account-match observation; shared match IDs are not independent",
            "scope": "all individual accounts plus pooled diagnostic; no inferred personal account set",
            "manual_exclusions": "preserved in every scenario",
            "win_weights": "stored weights unchanged except symmetric_quality uses match_quality_score on both outcomes",
            "duration_only": "recomputes duration bands; removes automatic anomaly multipliers; keeps manual exclusions",
            "frozen_prior": "current candidate evidence with full_losses effective prior alpha/beta held fixed",
            "interpretation": "sensitivity, not validation of causal attribution or future win probability",
        },
        "data": {
            "rows": len(rows), "valid_role_rows": len(valid), "unique_matches": len({r["match_id"] for r in rows}),
            "accounts": len(by_account), "accounts_with_recommendations": len(account_scopes),
            "first_game": min(r["date"] for r in rows), "last_game": max(r["date"] for r in rows),
            "wins": len(wins), "losses": len(losses),
            "raw_win_rate": len(wins) / len(valid) * 100,
            "positive_evidence": positive, "negative_evidence": negative,
            "weighted_rate": positive / (positive + negative) * 100,
            "average_win_weight": positive / len(wins), "average_loss_weight": negative / len(losses),
            "stored_vs_current_formula_mismatched_losses": len(mismatches),
            "weight_sources": {source: {"losses":len(items), "mismatches":sum(abs(r["loss_attribution_weight"]-v)>0.001 for r,v in items), "average_stored_loss_weight":statistics.mean(r["loss_attribution_weight"] for r,v in items)} for source,items in source_groups.items()},
            "loss_duration_bands": {band:{"losses":len(items),"mean_stored_weight":statistics.mean(r["loss_attribution_weight"] for r in items)} for band,items in bands.items()},
        },
        "sensitivity": sensitivity, "scopes": scopes,
    }
    for name, original in source_bytes.items():
        if (app.APP_ROOT / name).read_bytes() != original:
            raise RuntimeError(f"Source changed during audit: {name}; rerun on a stable version")
    args.output.mkdir(parents=True, exist_ok=True)
    snapshot = args.output / "sensitivity_source"
    snapshot.mkdir(exist_ok=True)
    for name, content in source_bytes.items():
        (snapshot / name).write_bytes(content)
    output = args.output / "sensitivity.json"
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"data": report["data"], "sensitivity": sensitivity, "output": str(output.resolve())}, ensure_ascii=True, indent=2))


if __name__ == "__main__":
    main()
