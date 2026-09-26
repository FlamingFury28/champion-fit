"""Reconcile identifiable legacy Riot loss weights without changing overrides.

The metadata version describes the policy, not whether every imported row has
been migrated. Normalized imports can arrive after that marker was written.
Only the exact legacy provenance and duration/weight signature are eligible.
"""

from __future__ import annotations

from contextlib import suppress
import json
import math
import sqlite3

from match_scoring import LOSS_WEIGHT_MODEL_VERSION, loss_attribution_weight


LEGACY_RIOT_REASON = "Imported from Riot Match-V5"
MIGRATED_RIOT_REASON = "Imported from Riot Match-V5; duration model v2"
_SAVEPOINT = "champion_fit_legacy_loss_weights"
_PROVENANCE_SAVEPOINT = "champion_fit_loss_provenance_probe"


def _legacy_rows(connection) -> tuple[list, bool]:
    """Read an optional ledger on both current and pre-ledger databases.

    The savepoint also recovers PostgreSQL's transaction after an undefined-table
    error. It performs no data writes and never commits pending caller work.
    """
    select = """SELECT m.id, m.account, m.match_id, m.win, m.duration_minutes,
                       m.loss_attribution_weight, m.anomaly_flags, m.explicit_afk,
                       m.suspected_quasi_afk, m.early_surrender"""
    where = "WHERE m.identity_resolution=? AND m.reason=? ORDER BY m.id"
    params = ("riot_api", LEGACY_RIOT_REASON)
    connection.execute(f"SAVEPOINT {_PROVENANCE_SAVEPOINT}")
    try:
        try:
            rows = connection.execute(
                select + ", p.classification provenance_classification, "
                "p.overrides_json provenance_overrides_json "
                "FROM match_quality m LEFT JOIN match_import_provenance p "
                "ON p.account=m.account AND p.match_id=m.match_id " + where,
                params,
            ).fetchall()
            return rows, True
        except Exception as error:
            connection.execute(f"ROLLBACK TO SAVEPOINT {_PROVENANCE_SAVEPOINT}")
            missing_ledger = (
                isinstance(error, sqlite3.OperationalError)
                and "no such table: match_import_provenance" in str(error)
            ) or getattr(error, "sqlstate", None) == "42P01"
            if not missing_ledger:
                raise
            rows = connection.execute(
                select + ", NULL provenance_classification, "
                "NULL provenance_overrides_json FROM match_quality m " + where,
                params,
            ).fetchall()
            return rows, False
    finally:
        connection.execute(f"RELEASE SAVEPOINT {_PROVENANCE_SAVEPOINT}")


def preview_riot_loss_weights(connection) -> list[dict]:
    """Return proposed row changes without writes, commits, or initialization.

    An existing provenance record is authoritative: only known Riot defaults
    consistent with their recorded inputs are eligible. Supplied and unknown
    values remain untouched even when numerically identical to a legacy default.
    With no ledger record, the exact legacy signature remains the fallback for
    databases predating provenance tracking.
    """
    rows, ledger_present = _legacy_rows(connection)
    updates = []
    for row in rows:
        classification = row["provenance_classification"]
        overrides_json = row["provenance_overrides_json"]
        if classification is not None:
            if classification != "known_riot_default":
                continue
            try:
                overrides = json.loads(overrides_json)
            except (TypeError, ValueError):
                continue
            # A contradictory ledger is preserved for reconciliation, not
            # treated as permission to replace an explicitly supplied field.
            if not isinstance(overrides, dict) or any(
                field in overrides for field in ("loss_attribution_weight", "reason")
            ):
                continue
            if any(
                field in overrides and overrides[field] != row[field]
                for field in ("explicit_afk", "suspected_quasi_afk", "early_surrender", "anomaly_flags")
            ):
                continue
        duration = float(row["duration_minutes"])
        old_weight = float(row["loss_attribution_weight"])
        if not math.isfinite(duration) or not math.isfinite(old_weight):
            continue
        legacy_weight = 0.45 if duration < 20.0 else 0.95
        if old_weight != legacy_weight:
            continue
        # Wins never supply negative evidence. Preserve their positive weight;
        # only remove the identifiable legacy value from the loss-weight field.
        new_weight = 0.0 if row["win"] else loss_attribution_weight(
            duration, row["anomaly_flags"], bool(row["explicit_afk"]),
            bool(row["suspected_quasi_afk"]), bool(row["early_surrender"]),
        )
        if new_weight == old_weight:
            continue
        updates.append({
            "id": int(row["id"]),
            "account": row["account"],
            "match_id": row["match_id"],
            "win": int(row["win"]),
            "duration_minutes": duration,
            "old_weight": old_weight,
            "new_weight": new_weight,
            "anomaly_flags": row["anomaly_flags"],
            "explicit_afk": int(row["explicit_afk"]),
            "suspected_quasi_afk": int(row["suspected_quasi_afk"]),
            "early_surrender": int(row["early_surrender"]),
            "provenance_table_present": ledger_present,
            "provenance_classification": classification,
            "provenance_overrides_json": overrides_json,
        })
    return updates


def migrate_riot_loss_weights(connection) -> int:
    """Persist a per-row reconciliation atomically and return changed rows.

    Uses the project's execute/commit connection interface on SQLite/Postgres.
    Like the previous application migration, success commits the connection.
    On failure, only this migration's work is rolled back to its savepoint;
    pending caller changes are left available to the caller.
    """
    connection.execute(f"SAVEPOINT {_SAVEPOINT}")
    try:
        updates = preview_riot_loss_weights(connection)
        for row in updates:
            # A concurrent edit must not be replaced by a stale preview. Both
            # the provenance and every input used to recalculate are guarded.
            update_sql = """UPDATE match_quality
                   SET loss_attribution_weight=?, reason=?
                   WHERE id=? AND identity_resolution=? AND reason=?
                     AND loss_attribution_weight=? AND win=?
                     AND duration_minutes=? AND anomaly_flags=?
                     AND explicit_afk=? AND suspected_quasi_afk=?
                     AND early_surrender=?"""
            params = (
                row["new_weight"], MIGRATED_RIOT_REASON, row["id"],
                "riot_api", LEGACY_RIOT_REASON, row["old_weight"],
                row["win"], row["duration_minutes"], row["anomaly_flags"],
                row["explicit_afk"], row["suspected_quasi_afk"],
                row["early_surrender"],
            )
            if row["provenance_table_present"]:
                if row["provenance_classification"] is None:
                    update_sql += (
                        " AND NOT EXISTS (SELECT 1 FROM match_import_provenance p "
                        "WHERE p.account=match_quality.account AND p.match_id=match_quality.match_id)"
                    )
                else:
                    update_sql += (
                        " AND EXISTS (SELECT 1 FROM match_import_provenance p "
                        "WHERE p.account=match_quality.account AND p.match_id=match_quality.match_id "
                        "AND p.classification=? AND p.overrides_json=?)"
                    )
                    params += (row["provenance_classification"], row["provenance_overrides_json"])
            cursor = connection.execute(update_sql, params)
            if cursor.rowcount != 1:
                raise RuntimeError(
                    f"Legacy weight row {row['id']} changed during migration; "
                    "no migration changes were committed."
                )
        stored = connection.execute(
            "SELECT value FROM source_metadata WHERE key=?",
            ("loss_weight_model_version",),
        ).fetchone()
        if stored is None or stored["value"] != LOSS_WEIGHT_MODEL_VERSION:
            connection.execute(
                "INSERT INTO source_metadata(key,value) VALUES(?,?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                ("loss_weight_model_version", LOSS_WEIGHT_MODEL_VERSION),
            )
        # Commit with the savepoint still active so a commit failure that leaves
        # the transaction open can also be rolled back. COMMIT ends savepoints
        # on both backends, including SQLite's outermost savepoint transaction.
        connection.commit()
    except Exception:
        # Preserve the original error even if a lost connection cannot roll back.
        with suppress(Exception):
            connection.execute(f"ROLLBACK TO SAVEPOINT {_SAVEPOINT}")
            connection.execute(f"RELEASE SAVEPOINT {_SAVEPOINT}")
        raise
    return len(updates)
