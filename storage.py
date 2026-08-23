"""Persistence boundary for Champion Fit.

The application currently runs on SQLite. Keeping this small contract in one
module makes the eventual PostgreSQL implementation replaceable without
changing HTTP handlers, profile logic, or ingestion code.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Protocol


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
        return connection

    def initialize(self) -> None:
        connection = self.connect()
        try:
            connection.executescript(self.schema_path.read_text(encoding="utf-8"))
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
        return self.raw.executemany(self._sql(query), params)

    def executescript(self, script: str):
        for statement in script.split(";"):
            statement = statement.strip()
            if statement:
                self.raw.execute(statement)

    def commit(self):
        self.raw.commit()

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
