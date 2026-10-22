#!/usr/bin/env python3
"""Reproducible local backend timings on synthetic data or a read-only copy.

The source SQLite database is opened in read-only mode and copied with SQLite's
backup API. Schema bootstrap and analytical projections run only on the
temporary copy. No provider API or HTTP server is used.
"""
from __future__ import annotations

import argparse
from contextlib import closing, contextmanager
import json
import math
from pathlib import Path
import sqlite3
from tempfile import TemporaryDirectory
from time import perf_counter

import app
from algorithm_settings import ensure_settings, get_settings_snapshot, migrate_recommendation_settings
from champion_taxonomy import load_catalog
from hierarchical_champion_model import MODEL_VERSION, _CACHE
from live_recommendations import _PLAN_CACHE, _PLAN_VERSION
from runtime_metrics import metrics_scope
from storage import SQLiteStorage


FIXTURE_VERSION = "two_accounts_three_champions_v1"
_ENDPOINTS = ("/api/champions", "/api/training-plan")


def _positive_integer(value):
    try:
        number = int(value)
    except (TypeError, ValueError) as error:
        raise argparse.ArgumentTypeError("Expected a positive integer") from error
    if number < 1:
        raise argparse.ArgumentTypeError("Expected a positive integer")
    return number


def _fixture(storage):
    """Seed fixed binary outcomes without depending on operational data."""
    with closing(storage.connect()) as connection, connection:
        rows = []
        for account_number in range(2):
            account = f"benchmark-{account_number}"
            for champion, wins in (("Ahri", 8), ("Lux", 6), ("Syndra", 4)):
                connection.execute(
                    "INSERT INTO champions(champion,asset_id,icon_url) VALUES(?,?,?) "
                    "ON CONFLICT(champion) DO NOTHING", (champion, champion, ""),
                )
                for index in range(12):
                    win = int((index + account_number) % 12 < wins)
                    rows.append((
                        account, f"benchmark-{account_number}-{champion}-{index}",
                        "2026-01-01T12:00:00Z", "16.1", "420", champion,
                        "MIDDLE", "synthetic_benchmark", 30, win, 0, 0, 0,
                        "none", 0.95, 0 if win else 0.95, 0.95 if win else 0,
                        "Synthetic benchmark",
                    ))
        connection.executemany(
            """INSERT INTO match_quality
            (account,match_id,date,patch,queue,champion,role,identity_resolution,
             duration_minutes,win,explicit_afk,suspected_quasi_afk,early_surrender,
             anomaly_flags,match_quality_score,loss_attribution_weight,
             win_evidence_weight,reason) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""", rows,
        )


def _copy_source(source_path: Path, target_path: Path):
    source_path = Path(source_path).resolve(strict=True)
    if not source_path.is_file():
        raise ValueError("Source must be a SQLite file")
    with closing(sqlite3.connect(f"{source_path.as_uri()}?mode=ro", uri=True)) as source:
        with closing(sqlite3.connect(target_path)) as target:
            source.backup(target)


@contextmanager
def _temporary_app(storage, root):
    previous = (app.STORAGE, app.DB_PATH, app.APP_ROOT)
    app.STORAGE, app.DB_PATH, app.APP_ROOT = storage, storage.path, root
    try:
        yield
    finally:
        app.STORAGE, app.DB_PATH, app.APP_ROOT = previous


def _percentile(values, proportion):
    """Linear interpolation; meaningful even with the default three samples."""
    ordered = sorted(values)
    if not ordered:
        return None
    position = (len(ordered) - 1) * proportion
    lower, upper = math.floor(position), math.ceil(position)
    return round(ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower), 3)


def _sample(endpoint, params):
    started = perf_counter()
    report = {}
    with metrics_scope("backend_benchmark", endpoint=endpoint) as metrics:
        try:
            status, payload = app.query_database(endpoint, params)
            report["status"] = int(status)
            if status != 200:
                # API error text may contain input or database details.
                report["error_code"] = f"http_{int(status)}"
            else:
                counts = {"result_items": len(payload.get("items", []))}
                context = payload.get("context", {})
                for key in ("observations", "unique_games"):
                    if type(context.get(key)) is int:
                        counts[key] = context[key]
                for key in ("budget_total", "budget_assigned", "budget_unassigned"):
                    if type(payload.get(key)) is int:
                        counts[key] = payload[key]
                report["counts"] = counts
        except Exception as error:
            report.update(status=int(app.backend_error_status(error)), error_code=type(error).__name__)
    report["duration_ms"] = round((perf_counter() - started) * 1000, 3)
    report["metrics"] = {key: round(value, 3) for key, value in metrics.items()}
    return report


def benchmark(db: Path | None = None, *, budget: int = 20, repetitions: int = 3) -> dict:
    """Return aggregate timings; never include source paths, accounts or rows."""
    if type(budget) is not int or not 20 <= budget <= 2000:
        raise ValueError("budget must be an integer between 20 and 2000")
    if type(repetitions) is not int or repetitions < 1:
        raise ValueError("repetitions must be a positive integer")
    report = {
        "report_version": 1,
        "status": "completed",
        "protocol": {
            "source": "snapshot_copy" if db is not None else "synthetic",
            "engine": "sqlite", "source_read_only": True, "remote_api_calls": False,
            "reset_caches_before_each_endpoint": True,
            "context": {"role": "MIDDLE", "queue": "420", "days": "all"},
            "budget": budget, "warm_repetitions": repetitions,
        },
        "versions": {"model": MODEL_VERSION, "plan": _PLAN_VERSION,
                     "fixture": FIXTURE_VERSION if db is None else None},
        "endpoints": {},
    }
    try:
        with TemporaryDirectory(prefix="champion-fit-benchmark-") as directory:
            root = Path(directory)
            database = root / "benchmark.db"
            if db is not None:
                _copy_source(db, database)
            storage = SQLiteStorage(database, app.SCHEMA_PATH)
            storage.initialize()
            if db is None:
                _fixture(storage)
            with closing(storage.connect()) as connection, connection:
                app.migrate_legacy_roles(connection)
                ensure_settings(connection)
                migrate_recommendation_settings(connection)
                snapshot = get_settings_snapshot(connection)
                accounts = [str(row[0]) for row in connection.execute(
                    "SELECT DISTINCT account FROM match_quality ORDER BY account"
                ) if row[0]]
                report["dataset"] = {
                    "accounts": len(accounts),
                    "observations": connection.execute("SELECT COUNT(*) FROM match_quality").fetchone()[0],
                    "unique_matches": connection.execute("SELECT COUNT(DISTINCT match_id) FROM match_quality").fetchone()[0],
                }
            report["versions"].update(
                catalog=load_catalog()["source_version"],
                algorithm_revision=snapshot["revision"],
                algorithm_fingerprint=snapshot["fingerprint"],
            )
            params = {"account": accounts, "role": ["MIDDLE"], "queue": ["420"], "days": ["all"]}
            with _temporary_app(storage, root):
                for endpoint in _ENDPOINTS:
                    _CACHE.clear()
                    _PLAN_CACHE.clear()
                    endpoint_params = params | ({"budget": [str(budget)]} if endpoint == "/api/training-plan" else {})
                    cold = _sample(endpoint, endpoint_params)
                    warm = [_sample(endpoint, endpoint_params) for _ in range(repetitions)]
                    durations = [item["duration_ms"] for item in warm]
                    report["endpoints"][endpoint] = {
                        "cold": cold,
                        "warm": {"samples": warm, "p50_ms": _percentile(durations, 0.5),
                                 "p95_ms": _percentile(durations, 0.95)},
                    }
                    if any(item["status"] != 200 for item in [cold, *warm]):
                        report["status"] = "failed"
    except Exception as error:
        report.update(status="failed", error_code=type(error).__name__)
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, help="SQLite source; benchmark only a temporary backup copy")
    parser.add_argument("--budget", type=_positive_integer, default=20)
    parser.add_argument("--repetitions", type=_positive_integer, default=3)
    parser.add_argument("--output", type=Path, help="Optional JSON report file")
    args = parser.parse_args(argv)
    try:
        report = benchmark(args.db, budget=args.budget, repetitions=args.repetitions)
    except Exception as error:
        report = {"report_version": 1, "status": "failed", "error_code": type(error).__name__}
    if args.output:
        try:
            source, output = (args.db or app.DB_PATH).resolve(), args.output.resolve()
            same_file = source == output or (
                source.exists() and output.exists() and source.samefile(output)
            )
            source_sidecars = {Path(str(source) + suffix) for suffix in ("-wal", "-shm", "-journal")}
            if same_file or output in source_sidecars:
                raise ValueError("Report output must not replace the source database")
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        except (OSError, ValueError) as error:
            report.update(status="failed", output_error_code=type(error).__name__)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return int(report["status"] != "completed")


if __name__ == "__main__":
    raise SystemExit(main())
