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


class Storage(Protocol):
    def connect(self) -> sqlite3.Connection: ...
    def initialize(self) -> None: ...


class SQLiteStorage:
    engine = "sqlite"

    def __init__(self, path: Path, schema_path: Path) -> None:
        self.path = Path(path)
        self.schema_path = Path(schema_path)

    def connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path)
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
        return self.raw.execute(self._sql(query), params)

    def executemany(self, query: str, params):
        cursor = self.raw.cursor()
        try:
            cursor.executemany(self._sql(query), params)
        except Exception:
            cursor.close()
            raise
        return cursor

    def executescript(self, script: str):
        for statement in _split_sql_statements(script):
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
            connection.commit()
        finally:
            connection.close()


def build_storage(path: Path, schema_path: Path, postgres_dsn: str | None = None) -> Storage:
    if postgres_dsn:
        return PostgresStorage(postgres_dsn, schema_path)
    return SQLiteStorage(path, schema_path)
