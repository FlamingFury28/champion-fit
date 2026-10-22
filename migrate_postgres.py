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
from storage import upgrade_postgres_friend_group_alias_ids

TABLES = (
    "algorithm_settings_revisions", "algorithm_settings_state",
    "recommendation_preferences", "recommendation_feedback_state", "recommendation_feedback_events",
    "training_plan_runs",
    "source_metadata", "riot_sync_runs", "riot_sync_run_accounts",
    "riot_accounts_raw", "riot_match_raw", "riot_match_list_raw",
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
    "riot_sync_runs", "riot_sync_run_accounts",
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

VERSIONED_STORES = (
    ("settings", ("algorithm_settings_state", "algorithm_settings_revisions")),
    ("feedback", ("recommendation_feedback_state", "recommendation_preferences", "recommendation_feedback_events")),
)

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


def _selected_versioned_stores(selected_tables: tuple[str, ...]) -> list:
    stores = []
    for label, tables in VERSIONED_STORES:
        selected = set(tables).intersection(selected_tables)
        if selected and selected != set(tables):
            raise ValueError(f"Il ledger {label} deve essere importato come unità completa: {', '.join(tables)}")
        if selected:
            stores.append((label, tables))
    return stores


def _lock_versioned_stores(cursor, stores, *, allow_partial: bool = False) -> bool:
    """Cover missing singleton rows without waiting on inverse initializer locks."""
    missing = False
    for label, tables in stores:
        existing = [table for table in tables if cursor.execute(
            "SELECT 1 FROM pg_catalog.pg_class WHERE oid=pg_catalog.to_regclass(%s)", (table,),
        ).fetchone()]
        missing = missing or len(existing) != len(tables)
        if existing and len(existing) != len(tables) and not allow_partial:
            raise RuntimeError(f"Schema del ledger {label} incompleto; nessun dato modificato")
        if existing:
            try:
                cursor.execute(f"LOCK TABLE {','.join(existing)} IN SHARE ROW EXCLUSIVE MODE NOWAIT")
            except Exception as error:
                if getattr(error, "sqlstate", None) != "55P03":
                    raise
                raise RuntimeError(
                    f"Scrittura concorrente sul ledger {label}: riprova al termine; nessun dato modificato"
                ) from error
    return missing


def _versioned_store_empty(label: str, rows: dict) -> bool:
    if label == "settings":
        return not any(rows.values())
    return (not rows["recommendation_preferences"] and not rows["recommendation_feedback_events"]
            and [dict(row) for row in rows["recommendation_feedback_state"]] == [{"singleton_id": 1, "revision": 0}])


def _source_versioned_store_empty(label: str, rows: dict) -> bool:
    if _versioned_store_empty(label, rows):
        return True
    if label == "settings":
        state = [dict(row) for row in rows["algorithm_settings_state"]]
        revisions = {dict(row)["revision"] for row in rows["algorithm_settings_revisions"]}
        valid = len(state) == 1 and state[0]["singleton_id"] == 1 and state[0]["current_revision"] in revisions
    else:
        state = [dict(row) for row in rows["recommendation_feedback_state"]]
        events = {dict(row)["revision"] for row in rows["recommendation_feedback_events"]}
        valid = len(state) == 1 and state[0]["singleton_id"] == 1
        revision = state[0]["revision"] if valid else -1
        valid = valid and type(revision) is int and revision > 0 and len(events) == revision and min(events, default=0) == 1 and max(events, default=0) == revision
    if not valid:
        raise RuntimeError(f"Ledger {label} sorgente incompleto o incoerente; nessun dato modificato")
    return False


def _validate_versioned_store_merges(source, cursor, stores, source_metadata, *, full_scope: bool) -> set[str]:
    """Import only an empty target or an exactly identical immutable ledger."""
    unchanged = set()
    for label, tables in stores:
        source_rows = {}
        target_rows = {}
        for table in tables:
            columns = sorted(source_metadata[table][0])
            query = f"SELECT {','.join(_identifier(column) for column in columns)} FROM {_identifier(table)}"
            source_rows[table] = {tuple(zip(columns, row)) for row in source.execute(query).fetchall()}
            target_rows[table] = {tuple(zip(columns, row)) for row in cursor.execute(query).fetchall()}
        source_empty = _source_versioned_store_empty(label, source_rows)
        if source_empty or target_rows == source_rows:
            unchanged.update(tables)
            continue
        if _versioned_store_empty(label, target_rows):
            continue
        guidance = (
            " Per aggiornare solo i dati Riot usa --scope riot; --replace-target sostituisce "
            "l'intera destinazione e richiede prima un backup verificato."
            if full_scope else " Importa il ledger in una destinazione vuota o esegui una sostituzione completa esplicita dopo backup."
        )
        raise RuntimeError(f"Conflitto revisioni nel ledger {label}: snapshot divergenti; nessun dato modificato." + guidance)
    return unchanged


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


def _target_friend_keys(cursor, table: str, key_column: str, columns: str) -> dict:
    """Reject ambiguous legacy owners before matching Python casefold keys."""
    result = {}
    for row in cursor.execute(f"SELECT {columns} FROM {_identifier(table)} ORDER BY 1,2").fetchall():
        value = str(row[1])
        key = value.casefold()
        if key in result:
            raise RuntimeError(
                f"La destinazione PostgreSQL contiene {table}.{key_column} ambigui "
                f"senza distinzione tra maiuscole e minuscole: {result[key][1]!r}, {value!r}"
            )
        result[key] = (row[0], value)
    return result


def _merge_friend_group_aliases(source: sqlite3.Connection, cursor, groups: dict, aliases: dict) -> int:
    """Resolve group names and existing aliases with the same casefold as HTTP."""
    group_names = {
        row[0]: str(row[1])
        for row in source.execute("SELECT id,name FROM friend_groups")
    }
    rows = []
    updates = []
    count = 0
    for group_id, alias in source.execute("SELECT group_id,alias FROM friend_group_aliases"):
        if group_id not in group_names:
            raise RuntimeError(
                f"Alias {alias!r} riferito a un gruppo sorgente inesistente: {group_id!r}"
            )
        target_group = groups.get(group_names[group_id].casefold())
        if target_group is None:
            raise RuntimeError(f"Gruppo sorgente non presente nella destinazione: {group_names[group_id]!r}")
        target_id = target_group[0]
        existing = aliases.get(alias.casefold())
        if existing is None:
            rows.append((target_id, alias))
            aliases[alias.casefold()] = (target_id, alias)
        elif existing[0] != target_id:
            # The existing merge reassigns an imported alias to its source
            # group. Retain that policy and the target's display spelling.
            updates.append((target_id, existing[1]))
            aliases[alias.casefold()] = (target_id, existing[1])
        count += 1
    if updates:
        cursor.executemany("UPDATE friend_group_aliases SET group_id=%s WHERE alias=%s", updates)
    if rows:
        cursor.executemany(
            "INSERT INTO friend_group_aliases (group_id,alias) VALUES (%s,%s)",
            rows,
        )
    return count


def _validate_source_case_insensitive_keys(
    source: sqlite3.Connection, selected_tables: tuple[str, ...],
) -> None:
    """Reject SQLite snapshots that are ambiguous under application semantics."""
    for table, column in (
        ("friend_groups", "name"),
        ("friend_group_aliases", "alias"),
    ):
        if table not in selected_tables and not (table == "friend_groups" and "friend_group_aliases" in selected_tables):
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
    stores = _selected_versioned_stores(selected_tables)

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
            # HTTP mutations acquire this same lock before reading names or
            # aliases. Acquire it before any DDL/table locks to keep the order
            # consistent and protect casefold maps until transaction commit.
            cursor.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", ("champion_fit.friend_group_aliases",))
            missing_stores = _lock_versioned_stores(cursor, stores, allow_partial=mode == "replace")
            previous_lock_timeout = None
            if missing_stores:
                previous_lock_timeout = cursor.execute("SELECT current_setting('lock_timeout')").fetchone()[0]
                cursor.execute("SELECT set_config('lock_timeout',%s,true)", ("250ms",))
            if mode == "replace":
                # PostgreSQL DDL is transactional. A failed copy rolls this
                # rebuild back with the data it replaced still intact.
                for table in reversed(TABLES):
                    cursor.execute(f"DROP TABLE IF EXISTS {_identifier(table)} CASCADE")
            cursor.execute(postgres_schema())
            upgrade_postgres_friend_group_alias_ids(cursor)

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

            if missing_stores:
                # A concurrent initializer may have won creation after our
                # initial lookup. Lock the now-present store before any reads.
                _lock_versioned_stores(cursor, stores)
                cursor.execute("SELECT set_config('lock_timeout',%s,true)", (previous_lock_timeout,))

            unchanged_ledgers = (_validate_versioned_store_merges(
                source, cursor, stores, source_metadata, full_scope=selected_tables == TABLES,
            ) if mode == "merge" else set())

            groups = {}
            aliases = {}
            if mode == "merge" and {"friend_groups", "friend_group_aliases"}.intersection(selected_tables):
                groups = _target_friend_keys(cursor, "friend_groups", "name", "id,name")
                if "friend_group_aliases" in selected_tables:
                    aliases = _target_friend_keys(cursor, "friend_group_aliases", "alias", "group_id,alias")

            if mode == "replace":
                # schema.sql contains an idempotent singleton seed. Clear it
                # together with every other managed row before copying.
                for table in reversed(TABLES):
                    cursor.execute(f"DELETE FROM {_identifier(table)}")

            for table in selected_tables:
                columns, primary_key, autoincrement = source_metadata[table]
                if table in unchanged_ledgers:
                    counts[table] = source.execute(f"SELECT COUNT(*) FROM {_identifier(table)}").fetchone()[0]
                    continue

                if mode == "merge" and table == "friend_groups":
                    rows = source.execute("SELECT name FROM friend_groups").fetchall()
                    missing = [row for row in rows if str(row[0]).casefold() not in groups]
                    if missing:
                        cursor.executemany(
                            "INSERT INTO friend_groups (name) VALUES (%s)", missing,
                        )
                        groups = _target_friend_keys(cursor, "friend_groups", "name", "id,name")
                    counts[table] = len(rows)
                    continue
                if mode == "merge" and table == "friend_group_aliases":
                    counts[table] = _merge_friend_group_aliases(source, cursor, groups, aliases)
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
    except Exception as error:
        if getattr(error, "sqlstate", None) == "55P03":
            raise RuntimeError("Scrittura concorrente nello schema dei ledger: riprova al termine; nessun dato modificato") from error
        raise
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
