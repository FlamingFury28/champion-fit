#!/usr/bin/env python3
"""Optional SQLite -> PostgreSQL migration.

Requires ``psycopg`` only when this command is used. The webapp remains
dependency-free and continues to use SQLite by default.
"""

from __future__ import annotations

import argparse
import sqlite3
from pathlib import Path

from app import DB_PATH, SCHEMA_PATH

TABLES = (
    "source_metadata", "riot_accounts_raw", "riot_match_raw", "riot_match_list_raw",
    "champions", "champion_fit", "test_plan",
    "blacklist", "screening_candidates", "match_quality", "match_annotations",
    "match_participants", "tracked_account_puuids", "friend_groups", "friend_group_aliases",
)


def postgres_schema() -> str:
    schema = SCHEMA_PATH.read_text(encoding="utf-8")
    schema = schema.replace("PRAGMA foreign_keys = ON;", "")
    schema = schema.replace("INTEGER PRIMARY KEY AUTOINCREMENT", "BIGSERIAL PRIMARY KEY")
    return schema


def migrate(sqlite_path: Path, dsn: str) -> dict[str, int]:
    try:
        import psycopg
    except ImportError as error:
        raise RuntimeError("Installa psycopg solo per la migrazione: pip install psycopg[binary]") from error

    source = sqlite3.connect(sqlite_path)
    target = psycopg.connect(dsn)
    counts: dict[str, int] = {}
    try:
        with target.cursor() as cursor:
            cursor.execute(postgres_schema())
            for table in TABLES:
                columns = [row[1] for row in source.execute(f"PRAGMA table_info({table})")]
                rows = source.execute(f"SELECT {','.join(columns)} FROM {table}").fetchall()
                if not rows:
                    counts[table] = 0
                    continue
                names = ",".join(columns)
                placeholders = ",".join(["%s"] * len(columns))
                cursor.executemany(
                    f"INSERT INTO {table} ({names}) VALUES ({placeholders}) ON CONFLICT DO NOTHING",
                    rows,
                )
                counts[table] = len(rows)
        target.commit()
        return counts
    finally:
        source.close()
        target.close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Migrate Champion Fit SQLite data to PostgreSQL")
    parser.add_argument("dsn", help="PostgreSQL DSN, for example postgresql://user:pass@host/db")
    parser.add_argument("--sqlite", type=Path, default=DB_PATH)
    args = parser.parse_args()
    print(migrate(args.sqlite, args.dsn))


if __name__ == "__main__":
    main()
