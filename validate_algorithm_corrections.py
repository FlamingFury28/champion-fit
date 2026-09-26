"""Read-only validation of loss-weight invariance in the production outcome model.

The operational SQLite database is opened query-only. Only the small scoring
tables are copied into memory, where hypothetical weight changes are applied.
Run: python validate_algorithm_corrections.py --db champion_fit.db
"""

from __future__ import annotations

import argparse
from contextlib import closing
from datetime import datetime, timezone
import hashlib
import importlib
import json
from pathlib import Path
import sqlite3
import sys


INFERENCE_FIELDS = (
    "champion", "role", "games", "raw_win_rate", "score", "posterior_fit",
    "credible_lower_90", "credible_upper_90", "confidence", "actionable",
    "baseline_win_rate", "posterior_lift_pp", "decision_threshold",
    "probability_meaningful_advantage", "probability_meaningful_disadvantage",
    "probability_method", "missing_accounts",
    "advantage_probability", "disadvantage_probability", "signal_probability",
    "probability_worse_than_baseline", "direction_probability", "direction_confidence",
    "baseline_credible_lower_90", "baseline_credible_upper_90", "family_size",
    "account_count", "observed_account_count", "account_weighting",
)
SCENARIOS = {"half_losses": .5, "quarter_losses": .25, "zero_losses": 0, "full_losses": None}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", type=Path, default=Path(__file__).resolve().parent)
    parser.add_argument("--db", type=Path)
    parser.add_argument("--output", type=Path, default=Path("outputs/algorithm_fixes/current_sensitivity.json"))
    args = parser.parse_args()
    source_root = args.source_root.resolve()
    source_files = {name: source_root / name for name in (
        "app.py", "decision_models.py", "statistical_evidence.py", "stratified_evidence.py",
        "schema.sql", "match_scoring.py",
    )}
    source_files["validation_script"] = Path(__file__).resolve()
    source_hashes = {name: hashlib.sha256(path.read_bytes()).hexdigest() for name, path in source_files.items()}
    sys.path.insert(0, str(source_root))
    app = importlib.import_module("app")
    db_path = (args.db or app.DB_PATH).resolve()
    if not hasattr(app, "scoped_champion_evidence"):
        raise SystemExit("The corrected production model has not been integrated.")

    with closing(sqlite3.connect(":memory:")) as memory:
        memory.row_factory = sqlite3.Row
        memory.executescript((source_root / "schema.sql").read_text(encoding="utf-8"))
        fingerprint = hashlib.sha256()
        copied = {}
        with closing(sqlite3.connect(db_path.as_uri() + "?mode=ro", uri=True)) as source:
            source.row_factory = sqlite3.Row
            source.execute("PRAGMA query_only=ON")
            source.execute("BEGIN")  # One consistent snapshot across copied tables.
            for table, order in (("champions", "champion"), ("match_quality", "account,match_id"), ("match_annotations", "match_id")):
                columns = [row[1] for row in memory.execute(f"PRAGMA table_info({table})")]
                source_columns = {row[1] for row in source.execute(f"PRAGMA table_info({table})")}
                columns = [column for column in columns if column in source_columns]
                rows = source.execute(f"SELECT {','.join(columns)} FROM {table} ORDER BY {order}").fetchall()
                fingerprint.update(json.dumps([table, columns, [list(row) for row in rows]], ensure_ascii=False).encode())
                memory.executemany(
                    f"INSERT INTO {table}({','.join(columns)}) VALUES({','.join('?' for _ in columns)})", rows,
                )
                copied[table] = len(rows)
        memory.execute("CREATE TEMP TABLE original_weights AS SELECT account,match_id,loss_attribution_weight FROM match_quality")
        scopes = {"all_accounts": {}}
        scopes.update({row[0]: {"account": [row[0]]} for row in memory.execute(
            "SELECT DISTINCT account FROM match_quality ORDER BY account"
        )})

        def evaluate():
            result = {}
            for name, params in scopes.items():
                candidates = app.scoped_champion_evidence(memory, params)
                ranked = app.rank_recommendations(candidates)
                result[name] = {
                    "ranking": [{key: item.get(key) for key in INFERENCE_FIELDS} for item in ranked],
                    "negative_evidence": round(sum(item["negative_evidence"] for item in candidates), 6),
                    "candidate_count": len(candidates),
                }
            return result

        baseline = evaluate()
        scenarios = {}
        for name, multiplier in SCENARIOS.items():
            if multiplier is None:
                memory.execute("UPDATE match_quality SET loss_attribution_weight=1 WHERE win=0")
            else:
                memory.execute("""UPDATE match_quality SET loss_attribution_weight=?*(
                    SELECT loss_attribution_weight FROM original_weights o
                    WHERE o.account=match_quality.account AND o.match_id=match_quality.match_id)
                    WHERE win=0""", (multiplier,))
            result = evaluate()
            changed = [scope for scope in scopes if baseline[scope]["ranking"] != result[scope]["ranking"]]
            scenarios[name] = {"changed_scopes": changed, "scope_count": len(scopes), "scopes": result}
        report = {
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "database": str(db_path), "source_root": str(source_root),
            "input_fingerprint_sha256": fingerprint.hexdigest(), "copied_rows": copied,
            "source_sha256": source_hashes,
            "source_sha256_after": {name: hashlib.sha256(path.read_bytes()).hexdigest() for name, path in source_files.items()},
            "scope_count": len(scopes),
            "scopes_with_recommendations": sum(bool(value["ranking"]) for value in baseline.values()),
            "actionable_recommendations": sum(item["actionable"] for scope in baseline.values() for item in scope["ranking"]),
            "inference_fields_checked": INFERENCE_FIELDS,
            "baseline": baseline, "scenarios": scenarios,
            "passed": not any(value["changed_scopes"] for value in scenarios.values()),
            "limits": [
                "Checks invariance to attribution weights, not predictive calibration or a causal benefit.",
                "Posterior guarantees depend on the stated Bernoulli/Beta model assumptions.",
                "Uses production scoring queries; no application startup, ingestion or database migration.",
            ],
        }
        report["source_stable"] = report["source_sha256"] == report["source_sha256_after"]
        report["passed"] = report["passed"] and report["source_stable"]
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(json.dumps({"output": str(args.output.resolve()), "passed": report["passed"],
                          "scopes": report["scope_count"], "input_rows": copied,
                          "changed_scopes": {name: value["changed_scopes"] for name, value in scenarios.items()}}, ensure_ascii=False))
        if not report["passed"]:
            raise SystemExit(1)


if __name__ == "__main__":
    main()
