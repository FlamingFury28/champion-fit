"""Persistence boundary for Champion Fit.

The application currently runs on SQLite. Keeping this small contract in one
module makes the eventual PostgreSQL implementation replaceable without
changing HTTP handlers, profile logic, or ingestion code.
"""

from __future__ import annotations

import re
import sqlite3
from pathlib import Path
from typing import Protocol


SQL_INTEGER_MAX = 2**63 - 1

_DOLLAR_QUOTE = re.compile(r"\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$")


def _split_sql_statements(script: str) -> list[str]:
    """Split a SQL script on semicolons outside quoted text and comments."""
    statements: list[str] = []
    current: list[str] = []
    index = 0
    block_depth = 0
    quote: str | None = None
    dollar_quote: str | None = None
    line_comment = False

    while index < len(script):
        char = script[index]
        pair = script[index:index + 2]

        if line_comment:
            current.append(char)
            index += 1
            if char in "\r\n":
                line_comment = False
            continue

        if block_depth:
            if pair == "/*":
                current.append(pair)
                block_depth += 1
                index += 2
            elif pair == "*/":
                current.append(pair)
                block_depth -= 1
                index += 2
            else:
                current.append(char)
                index += 1
            continue

        if dollar_quote is not None:
            if script.startswith(dollar_quote, index):
                current.append(dollar_quote)
                index += len(dollar_quote)
                dollar_quote = None
            else:
                current.append(char)
                index += 1
            continue

        if quote is not None:
            current.append(char)
            index += 1
            if quote == "'" and char == "\\" and index < len(script):
                # Also support PostgreSQL E-strings and installations with
                # standard_conforming_strings disabled.
                current.append(script[index])
                index += 1
            elif char == quote:
                if index < len(script) and script[index] == quote:
                    current.append(script[index])
                    index += 1
                else:
                    quote = None
            continue

        if pair == "--":
            current.append(pair)
            index += 2
            line_comment = True
        elif pair == "/*":
            current.append(pair)
            index += 2
            block_depth = 1
        elif char in "'\"":
            current.append(char)
            index += 1
            quote = char
        elif char == "$":
            match = _DOLLAR_QUOTE.match(script, index)
            if match:
                dollar_quote = match.group(0)
                current.append(dollar_quote)
                index += len(dollar_quote)
            else:
                current.append(char)
                index += 1
        elif char == ";":
            statement = "".join(current).strip()
            if statement:
                statements.append(statement)
            current.clear()
            index += 1
        else:
            current.append(char)
            index += 1

    statement = "".join(current).strip()
    if statement:
        statements.append(statement)
    return statements


def postgres_table_exists(connection, table: str) -> bool:
    """Inspect the queryable relation resolved by PostgreSQL's current search path."""
    return bool(connection.execute(
        "SELECT 1 FROM pg_catalog.pg_class c "
        "WHERE c.oid=pg_catalog.to_regclass(?) AND c.relkind IN ('r','p','v','m','f')",
        (table,),
    ).fetchone())


def postgres_table_columns(connection, table: str) -> set[str]:
    """Read columns from the same qualified, unqualified, or temporary relation as SQL."""
    return {
        str(row["column_name"])
        for row in connection.execute(
            "SELECT a.attname AS column_name "
            "FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid "
            "WHERE c.oid=pg_catalog.to_regclass(?) AND c.relkind IN ('r','p','v','m','f') "
            "AND a.attnum>0 AND NOT a.attisdropped",
            (table,),
        )
    }


def upgrade_postgres_friend_group_alias_ids(connection) -> None:
    """Widen the resolved legacy reference without rewriting compatible tables."""
    connection.execute("""
        DO $$
        BEGIN
          IF EXISTS (
            SELECT 1 FROM pg_catalog.pg_attribute a
            WHERE a.attrelid=pg_catalog.to_regclass('friend_group_aliases')
              AND a.attname='group_id' AND a.attnum>0 AND NOT a.attisdropped
              AND a.atttypid='pg_catalog.int4'::pg_catalog.regtype
          ) THEN
            ALTER TABLE friend_group_aliases ALTER COLUMN group_id TYPE BIGINT;
          END IF;
        END $$
    """)


class Storage(Protocol):
    def connect(self) -> sqlite3.Connection: ...
    def initialize(self) -> None: ...


class MeasuredSQLiteConnection(sqlite3.Connection):
    """Preserve the native connection API while timing SQL inside metric scopes."""

    def execute(self, *args, **kwargs):
        from runtime_metrics import measure
        with measure("sql"):
            return super().execute(*args, **kwargs)

    def executemany(self, *args, **kwargs):
        from runtime_metrics import measure
        with measure("sql"):
            return super().executemany(*args, **kwargs)

    def executescript(self, *args, **kwargs):
        from runtime_metrics import measure
        with measure("sql"):
            return super().executescript(*args, **kwargs)


class SQLiteStorage:
    engine = "sqlite"

    def __init__(self, path: Path, schema_path: Path) -> None:
        self.path = Path(path)
        self.schema_path = Path(schema_path)

    def connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, factory=MeasuredSQLiteConnection)
        connection.row_factory = sqlite3.Row
        # SQLite applies this setting per connection, including HTTP requests.
        connection.execute("PRAGMA foreign_keys = ON")
        return connection

    def initialize(self) -> None:
        connection = self.connect()
        try:
            connection.executescript(self.schema_path.read_text(encoding="utf-8"))
            # Older connections did not enforce ON DELETE CASCADE. These aliases
            # belong to groups already deleted by the user and cannot be reused.
            connection.execute(
                "DELETE FROM friend_group_aliases WHERE NOT EXISTS "
                "(SELECT 1 FROM friend_groups WHERE id=friend_group_aliases.group_id)"
            )
            connection.commit()
        finally:
            connection.close()


class PostgresConnection:
    def __init__(self, connection) -> None:
        self.raw = connection

    @staticmethod
    def _sql(query: str) -> str:
        return query.replace("?", "%s")

    def execute(self, query: str, params=()):
        from runtime_metrics import measure
        with measure("sql"):
            return self.raw.execute(self._sql(query), params)

    def executemany(self, query: str, params):
        from runtime_metrics import measure
        cursor = self.raw.cursor()
        try:
            with measure("sql"):
                cursor.executemany(self._sql(query), params)
        except Exception:
            cursor.close()
            raise
        return cursor

    def executescript(self, script: str):
        from runtime_metrics import measure
        for statement in _split_sql_statements(script):
            with measure("sql"):
                self.raw.execute(statement)

    def commit(self):
        self.raw.commit()

    def rollback(self):
        self.raw.rollback()

    def close(self):
        self.raw.close()


class PostgresStorage:
    engine = "postgres"

    def __init__(self, dsn: str, schema_path: Path) -> None:
        self.dsn = dsn
        self.schema_path = Path(schema_path)

    def connect(self) -> PostgresConnection:
        try:
            import psycopg
            from psycopg.rows import dict_row
        except ImportError as error:
            raise RuntimeError("Installa psycopg per usare PostgreSQL: pip install psycopg[binary]") from error
        return PostgresConnection(psycopg.connect(self.dsn, row_factory=dict_row))

    def initialize(self) -> None:
        connection = self.connect()
        try:
            connection.raw.execute("""CREATE OR REPLACE FUNCTION round(double precision, integer)
                RETURNS numeric LANGUAGE SQL IMMUTABLE STRICT AS $$
                SELECT round($1::numeric, $2)
                $$""")
            schema = self.schema_path.read_text(encoding="utf-8").replace("PRAGMA foreign_keys = ON;", "")
            schema = schema.replace("INTEGER PRIMARY KEY AUTOINCREMENT", "BIGSERIAL PRIMARY KEY")
            connection.executescript(schema)
            upgrade_postgres_friend_group_alias_ids(connection)
            connection.commit()
        finally:
            connection.close()


def build_storage(path: Path, schema_path: Path, postgres_dsn: str | None = None) -> Storage:
    if postgres_dsn:
        return PostgresStorage(postgres_dsn, schema_path)
    return SQLiteStorage(path, schema_path)
