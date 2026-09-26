#!/usr/bin/env python3
"""Optional SQLite -> PostgreSQL migration.

The default merge is deliberately non-destructive: source rows are inserted or
updated, while rows that exist only in PostgreSQL are retained.  ``replace`` is
an explicit disaster-recovery/bootstrap operation that rebuilds every managed
table from the SQLite snapshot.
"""

from __future__ import annotations

import argparse
import re
import sqlite3
from pathlib import Path
from typing import Iterable

from app import DB_PATH, SCHEMA_PATH

TABLES = (
    "algorithm_settings_revisions", "algorithm_settings_state",
    "recommendation_preferences", "recommendation_feedback_state", "recommendation_feedback_events",
    "source_metadata", "riot_accounts_raw", "riot_match_raw", "riot_match_list_raw",
    "riot_account_identities", "riot_identity_puuids", "riot_identity_policy",
    "riot_account_aliases", "riot_match_materialization",
    "champions", "champion_fit", "test_plan",
    "blacklist", "screening_candidates", "match_quality", "match_import_provenance", "match_annotations",
    "match_participants", "tracked_account_puuids", "friend_groups", "friend_group_aliases",
    "playstyle_metric_sources", "playstyle_match_metrics", "playstyle_backfill_checkpoints",
)

# Tables written by the Riot synchronization commands.  This scope is useful
# after PostgreSQL has become the serving database: application-owned settings,
# feedback, annotations, and friend groups remain authoritative in PostgreSQL.
RIOT_SYNC_TABLES = (
    "riot_accounts_raw", "riot_match_raw", "riot_match_list_raw",
    "riot_account_identities", "riot_identity_puuids", "riot_identity_policy",
    "riot_account_aliases", "riot_match_materialization",
    "champions", "match_quality", "match_import_provenance",
    "match_participants", "tracked_account_puuids",
    "playstyle_metric_sources", "playstyle_match_metrics",
)

# SQLite IDs are local implementation details for these tables.  In merge
# mode PostgreSQL keeps its own surrogate IDs and rows reconcile on the stable
# application key instead.
LOGICAL_KEYS = {
    "match_quality": ("account", "match_id"),
}

_IDENTIFIER = re.compile(r"^[a-z_][a-z0-9_]*$")


def postgres_schema() -> str:
    schema = SCHEMA_PATH.read_text(encoding="utf-8")
    schema = schema.replace("PRAGMA foreign_keys = ON;", "")
    schema = schema.replace("INTEGER PRIMARY KEY AUTOINCREMENT", "BIGSERIAL PRIMARY KEY")
    return schema


def _identifier(value: str) -> str:
    if not _IDENTIFIER.fullmatch(value):
        raise ValueError(f"Invalid SQL identifier: {value!r}")
    return value


def _sqlite_snapshot(sqlite_path: Path) -> sqlite3.Connection:
    """Return a transactionally consistent in-memory copy of a live database."""
    live = sqlite3.connect(f"{sqlite_path.as_uri()}?mode=ro", uri=True)
    snapshot = sqlite3.connect(":memory:")
    try:
        # sqlite3_backup takes a coherent snapshot even when the source uses
        # WAL and writers continue committing while this command is running.
        live.backup(snapshot)
    except Exception:
        snapshot.close()
        raise
    finally:
        live.close()
    snapshot.execute("PRAGMA foreign_keys = ON")
    return snapshot


def _source_metadata(
    source: sqlite3.Connection, tables: Iterable[str]
) -> dict[str, tuple[list[str], list[str], bool]]:
    metadata: dict[str, tuple[list[str], list[str], bool]] = {}
    for raw_table in tables:
        table = _identifier(raw_table)
        table_info = source.execute(f"PRAGMA table_info({table})").fetchall()
        if not table_info:
            raise RuntimeError(
                f"La snapshot SQLite non contiene la tabella richiesta {table}; "
                "avvia prima l'app sul database SQLite per applicare lo schema corrente"
            )
        columns = [str(row[1]) for row in table_info]
        primary_key = [str(row[1]) for row in sorted(
            (row for row in table_info if row[5]), key=lambda row: row[5]
        )]
        if not primary_key:
            raise RuntimeError(f"La tabella SQLite {table} non ha una chiave primaria")
        create_sql_row = source.execute(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name=?", (table,)
        ).fetchone()
        autoincrement = bool(
            create_sql_row and "AUTOINCREMENT" in (create_sql_row[0] or "").upper()
        )
        if autoincrement and len(primary_key) != 1:
            raise RuntimeError(f"La tabella SQLite {table} ha AUTOINCREMENT ma una chiave composta")
        metadata[table] = (columns, primary_key, autoincrement)
    return metadata


def _upsert_sql(table: str, columns: list[str], conflict_key: Iterable[str]) -> str:
    conflict_key = tuple(conflict_key)
    insert_columns = ",".join(_identifier(column) for column in columns)
    placeholders = ",".join(["%s"] * len(columns))
    conflict_columns = ",".join(_identifier(column) for column in conflict_key)
    updates = [column for column in columns if column not in conflict_key]
    if updates:
        conflict_action = "DO UPDATE SET " + ",".join(
            f"{_identifier(column)}=EXCLUDED.{_identifier(column)}" for column in updates
        )
    else:
        conflict_action = "DO NOTHING"
    return (
        f"INSERT INTO {_identifier(table)} ({insert_columns}) VALUES ({placeholders}) "
        f"ON CONFLICT ({conflict_columns}) {conflict_action}"
    )


def _merge_columns(
    table: str,
    columns: list[str],
    primary_key: list[str],
    autoincrement: bool,
) -> tuple[list[str], tuple[str, ...]]:
    """Return target columns and conflict key without importing local IDs."""
    logical_key = LOGICAL_KEYS.get(table)
    if not autoincrement or logical_key is None:
        return columns, tuple(primary_key)
    missing = set(logical_key) - set(columns)
    if missing:
        raise RuntimeError(
            f"La tabella {table} non contiene la chiave logica attesa: {sorted(missing)}"
        )
    return [column for column in columns if column not in primary_key], logical_key


def _merge_friend_group_aliases(source: sqlite3.Connection, cursor) -> int:
    """Resolve source group IDs through the stable group name in PostgreSQL."""
    group_names = {
        row[0]: str(row[1])
        for row in source.execute("SELECT id,name FROM friend_groups")
    }
    rows = []
    for group_id, alias in source.execute("SELECT group_id,alias FROM friend_group_aliases"):
        if group_id not in group_names:
            raise RuntimeError(
                f"Alias {alias!r} riferito a un gruppo sorgente inesistente: {group_id!r}"
            )
        rows.append((alias, group_names[group_id]))
    if rows:
        cursor.executemany(
            "INSERT INTO friend_group_aliases (group_id,alias) "
            "SELECT id,%s FROM friend_groups WHERE LOWER(name)=LOWER(%s) "
            "ON CONFLICT (LOWER(alias)) DO UPDATE SET group_id=EXCLUDED.group_id",
            rows,
        )
    return len(rows)


def _validate_source_case_insensitive_keys(
    source: sqlite3.Connection, selected_tables: tuple[str, ...],
) -> None:
    """Reject SQLite snapshots that are ambiguous under application semantics."""
    for table, column in (
        ("friend_groups", "name"),
        ("friend_group_aliases", "alias"),
    ):
        if table not in selected_tables:
            continue
        seen: dict[str, str] = {}
        for row in source.execute(f"SELECT {_identifier(column)} FROM {_identifier(table)}"):
            value = str(row[0])
            key = value.casefold()
            previous = seen.get(key)
            if previous is not None and previous != value:
                raise RuntimeError(
                    f"La snapshot SQLite contiene {table}.{column} ambigui "
                    f"senza distinzione tra maiuscole e minuscole: {previous!r}, {value!r}"
                )
            seen[key] = value


def _upgrade_postgres_constraints(cursor) -> None:
    """Install idempotent logical uniqueness required by merge statements."""
    cursor.execute(
        """DO $$
        DECLARE conflicting_keys TEXT;
        BEGIN
          SELECT STRING_AGG(
            conflicts.account || '/' || conflicts.match_id,
            ', ' ORDER BY conflicts.account,conflicts.match_id
          ) INTO conflicting_keys
          FROM (
            SELECT candidate.account,candidate.match_id
            FROM match_quality AS candidate
            GROUP BY candidate.account,candidate.match_id
            HAVING COUNT(DISTINCT (TO_JSONB(candidate) - 'id'))>1
          ) AS conflicts;
          IF conflicting_keys IS NOT NULL THEN
            RAISE EXCEPTION
              'match_quality contains conflicting duplicates: %', conflicting_keys;
          END IF;
        END $$"""
    )
    cursor.execute(
        "DELETE FROM match_quality AS duplicate USING match_quality AS keeper "
        "WHERE duplicate.account=keeper.account "
        "AND duplicate.match_id=keeper.match_id AND duplicate.id>keeper.id "
        "AND (TO_JSONB(duplicate) - 'id')=(TO_JSONB(keeper) - 'id')"
    )
    cursor.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_match_quality_account_match "
        "ON match_quality(account,match_id)"
    )
    cursor.execute(
        """DO $$
        BEGIN
          IF EXISTS (
            SELECT LOWER(name) FROM friend_groups
            GROUP BY LOWER(name) HAVING COUNT(*)>1
          ) THEN
            RAISE EXCEPTION 'friend_groups contains case-insensitive duplicate names';
          END IF;
          IF EXISTS (
            SELECT LOWER(alias) FROM friend_group_aliases
            GROUP BY LOWER(alias) HAVING COUNT(*)>1
          ) THEN
            RAISE EXCEPTION 'friend_group_aliases contains case-insensitive duplicate aliases';
          END IF;
        END $$"""
    )
    cursor.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_friend_groups_name_ci "
        "ON friend_groups(LOWER(name))"
    )
    cursor.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_friend_group_aliases_alias_ci "
        "ON friend_group_aliases(LOWER(alias))"
    )


def _sync_riot_match_quality_deletions(source: sqlite3.Connection, cursor) -> None:
    """Apply explicit stale tombstones without deleting target-only matches."""
    keys = list(source.execute(
        "SELECT DISTINCT state.account,state.match_id "
        "FROM riot_match_materialization state "
        "WHERE state.status IN ('identity_unresolved','unsupported_map','unsupported_queue') "
        "AND EXISTS ("
        "SELECT 1 FROM riot_match_list_raw raw WHERE raw.account=state.account"
        ") AND NOT EXISTS ("
        "SELECT 1 FROM match_quality current "
        "WHERE current.account=state.account AND current.match_id=state.match_id"
        ") ORDER BY state.account,state.match_id"
    ))
    if not keys:
        return
    cursor.execute(
        "CREATE TEMP TABLE champion_fit_riot_stale_match_keys ("
        "account TEXT NOT NULL,match_id TEXT NOT NULL,"
        "PRIMARY KEY(account,match_id)) ON COMMIT DROP"
    )
    cursor.executemany(
        "INSERT INTO champion_fit_riot_stale_match_keys (account,match_id) VALUES (%s,%s) "
        "ON CONFLICT (account,match_id) DO NOTHING",
        keys,
    )
    cursor.execute(
        "DELETE FROM match_quality AS target "
        "USING champion_fit_riot_stale_match_keys AS stale "
        "WHERE target.account=stale.account AND target.match_id=stale.match_id"
    )


def migrate(
    sqlite_path: Path,
    dsn: str,
    *,
    mode: str = "merge",
    tables: Iterable[str] = TABLES,
) -> dict[str, int]:
    sqlite_path = Path(sqlite_path).resolve(strict=True)
    if not sqlite_path.is_file():
        raise FileNotFoundError(f"SQLite source is not a file: {sqlite_path}")
    selected_tables = tuple(tables)
    if not selected_tables:
        raise ValueError("At least one table must be selected")
    if mode not in {"merge", "replace"}:
        raise ValueError("mode must be 'merge' or 'replace'")
    if mode == "replace" and selected_tables != TABLES:
        raise ValueError("replace mode requires the complete managed table set")

    try:
        import psycopg
    except ImportError as error:
        raise RuntimeError("Installa psycopg solo per la migrazione: pip install psycopg[binary]") from error

    source = _sqlite_snapshot(sqlite_path)
    target = None
    counts: dict[str, int] = {}
    serial_columns: list[tuple[str, str]] = []
    try:
        source_metadata = _source_metadata(source, selected_tables)
        _validate_source_case_insensitive_keys(source, selected_tables)
        target = psycopg.connect(dsn)
        with target.cursor() as cursor:
            if mode == "replace":
                # PostgreSQL DDL is transactional. A failed copy rolls this
                # rebuild back with the data it replaced still intact.
                for table in reversed(TABLES):
                    cursor.execute(f"DROP TABLE IF EXISTS {_identifier(table)} CASCADE")
            cursor.execute(postgres_schema())

            # CREATE TABLE IF NOT EXISTS cannot add columns to a legacy volume.
            # These are the only in-place column additions in the repository;
            # keeping them here lets an old PostgreSQL volume accept a current
            # SQLite source before the web process performs the same idempotent
            # startup migration.
            cursor.execute(
                "ALTER TABLE match_participants ADD COLUMN IF NOT EXISTS "
                "champion TEXT NOT NULL DEFAULT ''"
            )
            cursor.execute(
                "ALTER TABLE match_participants ADD COLUMN IF NOT EXISTS "
                "participant_id INTEGER NOT NULL DEFAULT 0"
            )
            cursor.execute(
                "ALTER TABLE match_participants ADD COLUMN IF NOT EXISTS "
                "normalized_riot_id TEXT NOT NULL DEFAULT ''"
            )
            _upgrade_postgres_constraints(cursor)

            if mode == "replace":
                # schema.sql contains an idempotent singleton seed. Clear it
                # together with every other managed row before copying.
                for table in reversed(TABLES):
                    cursor.execute(f"DELETE FROM {_identifier(table)}")

            for table in selected_tables:
                columns, primary_key, autoincrement = source_metadata[table]

                if mode == "merge" and table == "friend_groups":
                    rows = source.execute("SELECT name FROM friend_groups").fetchall()
                    if rows:
                        cursor.executemany(
                            "INSERT INTO friend_groups (name) VALUES (%s) "
                            "ON CONFLICT (LOWER(name)) DO NOTHING",
                            rows,
                        )
                    counts[table] = len(rows)
                    continue
                if mode == "merge" and table == "friend_group_aliases":
                    counts[table] = _merge_friend_group_aliases(source, cursor)
                    continue

                transfer_columns = columns
                conflict_key: Iterable[str] = primary_key
                if mode == "merge":
                    transfer_columns, conflict_key = _merge_columns(
                        table, columns, primary_key, autoincrement,
                    )
                rows = source.execute(
                    f"SELECT {','.join(transfer_columns)} FROM {table}"
                ).fetchall()
                if autoincrement and mode == "replace":
                    serial_columns.append((table, primary_key[0]))

                if rows:
                    cursor.executemany(
                        _upsert_sql(table, transfer_columns, conflict_key), rows,
                    )
                # The count describes source rows submitted. PostgreSQL-only
                # rows are retained in merge mode and are not included here.
                counts[table] = len(rows)

            if mode == "merge" and selected_tables == RIOT_SYNC_TABLES:
                _sync_riot_match_quality_deletions(source, cursor)

            # Explicit SQLite IDs bypass PostgreSQL's BIGSERIAL sequence.
            # Advance each owned sequence so later application inserts keep working.
            for table, column in serial_columns:
                cursor.execute(
                    f"WITH sequence_state AS ("
                    f"SELECT pg_get_serial_sequence(%s, %s)::regclass AS sequence_name, "
                    f"GREATEST(COALESCE(MAX({column}), 1), 1) AS last_value, "
                    f"COUNT(*) > 0 AS is_called FROM {table}"
                    f") SELECT setval(sequence_name, last_value, is_called) "
                    f"FROM sequence_state WHERE sequence_name IS NOT NULL",
                    (table, column),
                )
        target.commit()
        return counts
    finally:
        source.close()
        if target is not None:
            target.close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Migrate Champion Fit SQLite data to PostgreSQL")
    parser.add_argument("dsn", help="PostgreSQL DSN, for example postgresql://user:pass@host/db")
    parser.add_argument("--sqlite", type=Path, default=DB_PATH)
    parser.add_argument(
        "--scope", choices=("all", "riot"), default="all",
        help="all tables for initial migration; riot for later Riot synchronization",
    )
    parser.add_argument(
        "--replace-target", action="store_true",
        help="rebuild every managed PostgreSQL table; requires a verified backup",
    )
    args = parser.parse_args()
    if args.replace_target and args.scope != "all":
        parser.error("--replace-target cannot be combined with --scope riot")
    print(migrate(
        args.sqlite,
        args.dsn,
        mode="replace" if args.replace_target else "merge",
        tables=TABLES if args.scope == "all" else RIOT_SYNC_TABLES,
    ))


if __name__ == "__main__":
    main()
