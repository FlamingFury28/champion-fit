import json
import sqlite3
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

from ingest import ingest
from migrate_postgres import TABLES, migrate


class FakeCursor:
    def __init__(self):
        self.schema = ""
        self.batches = []

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def execute(self, query, params=None):
        if params is None:
            self.schema = query

    def executemany(self, query, rows):
        self.batches.append((query, list(rows)))


class FakeConnection:
    def __init__(self):
        self.cursor_instance = FakeCursor()
        self.committed = False

    def cursor(self):
        return self.cursor_instance

    def commit(self):
        self.committed = True

    def close(self):
        pass


class FakePsycopg:
    def __init__(self):
        self.connection = FakeConnection()

    def connect(self, dsn):
        return self.connection


class MigrationTests(unittest.TestCase):
    def test_migration_builds_postgres_schema_and_transfers_all_tables(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            snapshot = root / "snapshot.json"
            database = root / "source.db"
            snapshot.write_text(json.dumps({"source": "test", "matches": [{
                "account": "A#EUW", "match_id": "M1", "date": "2026-08-21T00:00:00Z",
                "patch": "16.16", "queue": "Ranked Solo/Duo", "champion": "Vi", "role": "JUNGLE",
                "duration_minutes": 28, "win": True,
            }]}), encoding="utf-8")
            ingest(snapshot, database)
            fake = FakePsycopg()
            fake_module = types.SimpleNamespace(connect=fake.connect)
            with patch.dict(sys.modules, {"psycopg": fake_module}):
                counts = migrate(database, "postgresql://test")
            self.assertTrue(fake.connection.committed)
            self.assertNotIn("PRAGMA", fake.connection.cursor_instance.schema)
            self.assertNotIn("AUTOINCREMENT", fake.connection.cursor_instance.schema)
            self.assertEqual(set(counts), set(TABLES))
            self.assertEqual(counts["match_quality"], 1)
            non_empty_tables = sum(1 for table in TABLES if counts[table])
            self.assertEqual(len(fake.connection.cursor_instance.batches), non_empty_tables)


if __name__ == "__main__":
    unittest.main()
