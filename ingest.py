#!/usr/bin/env python3
"""Import normalized match snapshots into Champion Fit.

The producer can be a Riot API client, an exporter, or a scheduled job. This
module deliberately contains no provider credentials and never calls a remote
API: it only defines the stable hand-off into the local SQLite database.
"""

from __future__ import annotations

import argparse
import json
import math
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from app import DB_PATH, SCHEMA_PATH, champion_asset_id, icon_url, migrate_legacy_roles, normalize_role
from match_scoring import loss_attribution_weight
from storage import SQLiteStorage
from queue_rules import is_supported_queue
from account_identity import canonical_account_name
from analysis_runtime import parse_time


def as_bool(value: object) -> int:
    if isinstance(value, (int, float)):
        return int(value == 1)
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


MATCH_COLUMNS = (
    "account", "match_id", "date", "patch", "queue", "champion", "role",
    "identity_resolution", "duration_minutes", "win", "explicit_afk",
    "suspected_quasi_afk", "early_surrender", "anomaly_flags", "match_quality_score",
    "loss_attribution_weight", "win_evidence_weight", "reason",
)

OVERRIDE_FIELDS = (
    "match_quality_score", "loss_attribution_weight", "win_evidence_weight",
    "explicit_afk", "suspected_quasi_afk", "early_surrender", "anomaly_flags", "reason",
)

REQUIRED_MATCH_FIELDS = (
    "account", "match_id", "date", "patch", "queue", "champion", "role",
    "duration_minutes", "win",
)
_BOOLEAN_FIELDS = ("win", "explicit_afk", "suspected_quasi_afk", "early_surrender")
_WEIGHT_FIELDS = ("match_quality_score", "loss_attribution_weight", "win_evidence_weight")


def _valid_import_text(value: str) -> bool:
    """Reject NUL and text that cannot be encoded as UTF-8."""
    if "\x00" in value:
        return False
    try:
        value.encode("utf-8")
    except UnicodeEncodeError:
        return False
    return True


def _validate_import_source(source: str) -> None:
    if not _valid_import_text(source):
        raise ValueError("La sorgente dell'importazione contiene un carattere non valido")


def valid_normalized_match(row: object) -> bool:
    """Reject incomplete or malformed hand-offs before touching their ledger.

    Optional fields may be ``null`` to clear a prior override. Required facts
    must always be present because defaults would otherwise overwrite a valid
    archived match when a producer emits a partial snapshot.
    """
    if not isinstance(row, dict) or any(field not in row for field in REQUIRED_MATCH_FIELDS):
        return False
    for field in ("account", "match_id", "date", "patch", "queue", "champion", "role"):
        if not isinstance(row[field], str) or not row[field].strip() or not _valid_import_text(row[field]):
            return False
    if parse_time(row["date"].strip()) is None:
        return False
    if normalize_role(row["role"]) not in {"TOP", "JUNGLE", "MIDDLE", "BOTTOM", "SUPPORT"}:
        return False
    duration = row["duration_minutes"]
    if isinstance(duration, bool):
        return False
    try:
        duration = float(duration)
    except (TypeError, ValueError, OverflowError):
        return False
    if not math.isfinite(duration) or duration < 0:
        return False
    accepted_booleans = {"0", "1", "false", "true", "no", "yes", "loss", "win", "lost", "won"}
    for field in _BOOLEAN_FIELDS:
        if field not in row or row[field] is None:
            if field == "win":
                return False
            continue
        value = row[field]
        if isinstance(value, bool):
            continue
        if isinstance(value, (int, float)) and value in {0.0, 1.0}:
            continue
        if not isinstance(value, str) or value.strip().lower() not in accepted_booleans:
            return False
    for field in _WEIGHT_FIELDS:
        if field not in row or row[field] is None:
            continue
        value = row[field]
        if isinstance(value, bool):
            return False
        try:
            value = float(value)
        except (TypeError, ValueError, OverflowError):
            return False
        if not math.isfinite(value) or not 0 <= value <= 1:
            return False
    for field in ("anomaly_flags", "reason", "identity_resolution"):
        if field in row and row[field] is not None and (
            not isinstance(row[field], str) or not _valid_import_text(row[field])
        ):
            return False
    return True


def legacy_import_provenance(row) -> tuple[str, dict]:
    """Conservatively distinguish identifiable Riot defaults from supplied data.

    Unknown provenance is preserved, including values numerically equal to a
    default. This intentionally matches the legacy loss migration's exact
    signature; an override identical to that signature is indistinguishable.
    """
    reason = str(row["reason"])
    resolution = str(row["identity_resolution"])
    duration = float(row["duration_minutes"])
    old_loss = float(row["loss_attribution_weight"])
    quality = 0.95 if duration >= 20 else 0.45
    default_loss = 0.0 if row["win"] else loss_attribution_weight(
        duration, row["anomaly_flags"], row["explicit_afk"], row["suspected_quasi_afk"], row["early_surrender"],
    )
    legacy_default = (
        resolution == "riot_api" and reason == "Imported from Riot Match-V5"
        and old_loss == quality
    )
    current_default = (
        resolution in {"riot_api", "puuid_exact", "verified_riot_id_exact"}
        and reason == "Imported from Riot Match-V5; duration model v2"
        and old_loss == default_loss
    )
    if not (legacy_default or current_default):
        classification = "supplied_historical" if resolution in {"strict_csv_signature", "puuid"} else "unknown"
        return classification, {field: row[field] for field in OVERRIDE_FIELDS}
    overrides = {field: row[field] for field in ("explicit_afk", "suspected_quasi_afk", "early_surrender", "anomaly_flags")}
    if row["match_quality_score"] != quality:
        overrides["match_quality_score"] = row["match_quality_score"]
    if row["win_evidence_weight"] != (row["match_quality_score"] if row["win"] else 0.0):
        overrides["win_evidence_weight"] = row["win_evidence_weight"]
    return "known_riot_default", overrides


def backfill_import_provenance(connection) -> int:
    """Archive unclassified legacy scoring inputs before any alias deduplication."""
    rows = connection.execute(
        "SELECT m.* FROM match_quality m LEFT JOIN match_import_provenance p "
        "ON p.account=m.account AND p.match_id=m.match_id WHERE p.account IS NULL",
    ).fetchall()
    now = datetime.now(timezone.utc).isoformat()
    for row in rows:
        classification, overrides = legacy_import_provenance(row)
        connection.execute(
            "INSERT INTO match_import_provenance VALUES(?,?,?,?,?,?) ON CONFLICT(account,match_id) DO NOTHING",
            (row["account"], row["match_id"], f"legacy:{row['identity_resolution']}", classification, json.dumps(overrides), now),
        )
    return len(rows)


def apply_import_provenance(connection, raw: dict, source: str, derived: bool) -> dict:
    account, match_id = str(raw["account"]), str(raw["match_id"])
    saved = connection.execute(
        "SELECT * FROM match_import_provenance WHERE account=? AND match_id=?", (account, match_id),
    ).fetchone()
    overrides = json.loads(saved["overrides_json"]) if saved else {}
    if not derived:
        # Presence is explicit; omission keeps an existing override and null
        # deliberately clears that field so a later raw calculation can own it.
        for field in OVERRIDE_FIELDS:
            if field in raw:
                if raw[field] is None:
                    overrides.pop(field, None)
                else:
                    overrides[field] = raw[field]
    # Classification describes the facts currently materialized in the match
    # row. The independent override map survives either fact producer; while
    # nonempty, source retains the audit origin of those active overrides.
    # A later Riot reprocess must therefore restore known-default provenance
    # after a supplied snapshot clears its last explicit weight.
    classification = "known_riot_default" if derived else "supplied_historical"
    provenance_source = (
        str(saved["source"])
        if derived and saved is not None and overrides
        else source
    )
    connection.execute(
        "INSERT INTO match_import_provenance VALUES(?,?,?,?,?,?) "
        "ON CONFLICT(account,match_id) DO UPDATE SET source=excluded.source,classification=excluded.classification,"
        "overrides_json=excluded.overrides_json,recorded_at=excluded.recorded_at",
        (account, match_id, provenance_source, classification, json.dumps(overrides, ensure_ascii=False), datetime.now(timezone.utc).isoformat()),
    )
    cleared = {*OVERRIDE_FIELDS, "identity_resolution"}
    materialized = {
        field: value for field, value in raw.items()
        if value is not None or field not in cleared
    }
    return materialized | overrides


def ingest_rows(connection, matches, source: str, *, derived: bool = False) -> dict[str, int | str]:
    """Upsert derived match fields in the caller's transaction.

    Manual annotations live in their own table and are deliberately untouched.
    This helper never initializes a database or commits the caller's work.
    """
    _validate_import_source(source)
    inserted = updated = skipped = 0
    backfill_import_provenance(connection)
    account_names = {}
    for raw in matches:
        if not valid_normalized_match(raw):
            skipped += 1
            continue
        if not is_supported_queue(raw.get("queue")):
            skipped += 1
            continue
        raw = dict(raw)
        account = str(raw.get("account", "")).strip()
        if account not in account_names:
            account_names[account] = canonical_account_name(connection, account)
        raw["account"] = account_names[account]
        # Validate the hand-off before recording provenance for its key.
        row = normalized_match(raw)
        account, match_id = row[0], row[1]
        if not account or not match_id or not row[2] or not row[5]:
            skipped += 1
            continue
        raw["match_id"] = match_id
        row = normalized_match(apply_import_provenance(connection, raw, source, derived))
        connection.execute(
            "INSERT OR IGNORE INTO champions(champion,asset_id,icon_url) VALUES(?,?,?)",
            (row[5], champion_asset_id(row[5]), icon_url(row[5])),
        )
        existing = connection.execute(
            f"SELECT {','.join(MATCH_COLUMNS)} FROM match_quality WHERE account=? AND match_id=? LIMIT 1", (account, match_id)
        ).fetchone()
        if existing and tuple(existing[column] for column in MATCH_COLUMNS) == row:
            skipped += 1
            continue
        if existing:
            connection.execute(
                f"UPDATE match_quality SET {','.join(column + '=?' for column in MATCH_COLUMNS[2:])} "
                "WHERE account=? AND match_id=?", (*row[2:], account, match_id),
            )
            updated += 1
        else:
            connection.execute(
                f"INSERT INTO match_quality ({','.join(MATCH_COLUMNS)}) VALUES ({','.join('?' for _ in MATCH_COLUMNS)})", row,
            )
            inserted += 1
    now = datetime.now(timezone.utc).isoformat()
    connection.executemany(
            "INSERT INTO source_metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            [("last_sync_at", now), ("last_sync_source", source), ("last_sync_inserted", str(inserted)),
             ("last_sync_updated", str(updated))],
    )
    return {"inserted": inserted, "updated": updated, "skipped": skipped, "source": source, "synced_at": now}


def ingest(input_path: Path, db_path: Path = DB_PATH) -> dict[str, int | str]:
    payload = json.loads(input_path.read_text(encoding="utf-8"))
    matches = payload.get("matches", payload) if isinstance(payload, dict) else payload
    if not isinstance(matches, list):
        raise ValueError("Input must contain a 'matches' list or be a list")
    source = str(payload.get("source", "normalized_snapshot")) if isinstance(payload, dict) else "normalized_snapshot"
    _validate_import_source(source)
    storage = SQLiteStorage(db_path, SCHEMA_PATH)
    storage.initialize()
    connection = storage.connect()
    try:
        # This legacy migration commits; keep it outside the import transaction.
        migrate_legacy_roles(connection)
        result = ingest_rows(connection, matches, source)
        connection.commit()
        return result
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
