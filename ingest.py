#!/usr/bin/env python3
"""Import normalized match snapshots into Champion Fit.

The producer can be a Riot API client, an exporter, or a scheduled job. This
module deliberately contains no provider credentials and never calls a remote
API: it only defines the stable hand-off into the local SQLite database.
"""

from __future__ import annotations

import argparse
import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from app import DB_PATH, SCHEMA_PATH, champion_asset_id, icon_url, migrate_legacy_roles, normalize_role
from match_scoring import loss_attribution_weight
from storage import SQLiteStorage
from queue_rules import is_supported_queue


def as_bool(value: object) -> int:
    return int(str(value).strip().lower() in {"1", "true", "yes", "win", "won"})


def as_float(value: object, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def clean_anomaly_flags(value: object) -> str:
    retired = {"strong_personal_loss", "weak_personal_performance"}
    flags = [flag for flag in str(value or "none").split(";") if flag and flag not in retired]
    return ";".join(flags) or "none"


def normalized_match(row: dict) -> tuple:
    champion = str(row.get("champion", "Unknown")).strip() or "Unknown"
    win = as_bool(row.get("win", False))
    duration = as_float(row.get("duration_minutes"), 0.0)
    quality = as_float(row.get("match_quality_score"), 0.95 if duration >= 20 else 0.45)
    explicit_afk = as_bool(row.get("explicit_afk", False))
    suspected_quasi_afk = as_bool(row.get("suspected_quasi_afk", False))
    early_surrender = as_bool(row.get("early_surrender", False))
    anomaly_flags = clean_anomaly_flags(row.get("anomaly_flags", "none"))
    default_loss_weight = 0.0 if win else loss_attribution_weight(
        duration, anomaly_flags, explicit_afk, suspected_quasi_afk, early_surrender,
    )
    return (
        str(row.get("account", "")).strip(), str(row.get("match_id", "")).strip(),
        str(row.get("date", "")).strip(), str(row.get("patch", "")).strip(),
        str(row.get("queue", "Unknown")).strip(), champion,
        normalize_role(row.get("role", "INVALID")) or "INVALID",
        str(row.get("identity_resolution", "external")), duration, win,
        explicit_afk, suspected_quasi_afk, early_surrender, anomaly_flags,
        quality, as_float(row.get("loss_attribution_weight"), default_loss_weight),
        as_float(row.get("win_evidence_weight"), quality if win else 0.0),
        str(row.get("reason", "Imported normalized match")),
    )


def ingest(input_path: Path, db_path: Path = DB_PATH) -> dict[str, int | str]:
    payload = json.loads(input_path.read_text(encoding="utf-8"))
    matches = payload.get("matches", payload) if isinstance(payload, dict) else payload
    if not isinstance(matches, list):
        raise ValueError("Input must contain a 'matches' list or be a list")
    storage = SQLiteStorage(db_path, SCHEMA_PATH)
    connection = storage.connect()
    try:
        storage.initialize()
        # Keep standalone imports consistent with the dashboard startup migration.
        migrate_legacy_roles(connection)
        inserted = skipped = 0
        for raw in matches:
            if not isinstance(raw, dict):
                skipped += 1
                continue
            if not is_supported_queue(raw.get("queue")):
                skipped += 1
                continue
            row = normalized_match(raw)
            account, match_id = row[0], row[1]
            if not account or not match_id or not row[2] or not row[5]:
                skipped += 1
                continue
            connection.execute(
                "INSERT OR IGNORE INTO champions(champion,asset_id,icon_url) VALUES(?,?,?)",
                (row[5], champion_asset_id(row[5]), icon_url(row[5])),
            )
            exists = connection.execute(
                "SELECT 1 FROM match_quality WHERE account=? AND match_id=? LIMIT 1", (account, match_id)
            ).fetchone()
            if exists:
                skipped += 1
                continue
            connection.execute(
                """INSERT INTO match_quality
                (account,match_id,date,patch,queue,champion,role,identity_resolution,duration_minutes,win,
                 explicit_afk,suspected_quasi_afk,early_surrender,anomaly_flags,match_quality_score,
                 loss_attribution_weight,win_evidence_weight,reason)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""", row,
            )
            inserted += 1
        now = datetime.now(timezone.utc).isoformat()
        source = str(payload.get("source", "normalized_snapshot")) if isinstance(payload, dict) else "normalized_snapshot"
        connection.executemany(
            "INSERT INTO source_metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            [("last_sync_at", now), ("last_sync_source", source), ("last_sync_inserted", str(inserted))],
        )
        connection.commit()
        return {"inserted": inserted, "skipped": skipped, "source": source, "synced_at": now}
    finally:
        connection.close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Import a normalized Champion Fit match snapshot")
    parser.add_argument("input", type=Path, help="JSON file containing matches")
    parser.add_argument("--db", type=Path, default=DB_PATH, help="SQLite database path")
    args = parser.parse_args()
    print(json.dumps(ingest(args.input, args.db), ensure_ascii=False))


if __name__ == "__main__":
    main()
