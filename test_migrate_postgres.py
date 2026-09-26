import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import types
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

from ingest import ingest
from app import SCHEMA_PATH
from migrate_postgres import RIOT_SYNC_TABLES, TABLES, migrate


class FakeCursor:
    def __init__(self, execute_error_marker=None):
        self.schema = ""
        self.batches = []
        self.statements = []
        self.execute_error_marker = execute_error_marker

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def execute(self, query, params=None):
        self.statements.append((query, params))
        if self.execute_error_marker and self.execute_error_marker in query:
            raise RuntimeError("simulated conflicting target rows")
        if params is None:
            self.schema = query
        return self

    def executemany(self, query, rows):
        self.batches.append((query, list(rows)))


class FakeConnection:
    def __init__(self, execute_error_marker=None):
        self.cursor_instance = FakeCursor(execute_error_marker)
        self.committed = False

    def cursor(self):
        return self.cursor_instance

    def commit(self):
        self.committed = True

    def close(self):
        pass


class FakePsycopg:
    def __init__(self, execute_error_marker=None):
        self.connection = FakeConnection(execute_error_marker)

    def connect(self, dsn):
        return self.connection


class MigrationTests(unittest.TestCase):
    @staticmethod
    def _source_database(root: Path) -> Path:
        snapshot = root / "snapshot.json"
        database = root / "source.db"
        snapshot.write_text(json.dumps({"source": "test", "matches": [{
            "account": "A#EUW", "match_id": "M1", "date": "2026-08-21T00:00:00Z",
            "patch": "16.16", "queue": "Ranked Solo/Duo", "champion": "Vi", "role": "JUNGLE",
            "duration_minutes": 28, "win": True,
        }]}), encoding="utf-8")
        ingest(snapshot, database)
        return database

    def test_migration_includes_every_application_table_in_dependency_order(self):
        connection = sqlite3.connect(":memory:")
        try:
            connection.executescript(SCHEMA_PATH.read_text(encoding="utf-8"))
            tables = {row[0] for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
            )}
            self.assertEqual(set(TABLES), tables)
            for table in tables:
                for reference in connection.execute(f"PRAGMA foreign_key_list({table})"):
                    parent = reference[2]
                    if parent != table:
                        self.assertLess(TABLES.index(parent), TABLES.index(table))
        finally:
            connection.close()

    def test_migration_requires_an_existing_sqlite_source(self):
        with tempfile.TemporaryDirectory() as directory:
            missing = Path(directory) / "missing.db"

            with self.assertRaises(FileNotFoundError):
                migrate(missing, "postgresql://test")

    def test_migration_builds_postgres_schema_and_transfers_all_tables(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            database = self._source_database(root)
            fake = FakePsycopg()
            fake_module = types.SimpleNamespace(connect=fake.connect)
            with (
                patch.dict(sys.modules, {"psycopg": fake_module}),
                patch("migrate_postgres.sqlite3.connect", wraps=sqlite3.connect) as sqlite_connect,
            ):
                counts = migrate(database, "postgresql://test")
            source_uri = sqlite_connect.call_args_list[0].args[0]
            self.assertTrue(source_uri.endswith("?mode=ro"))
            self.assertTrue(sqlite_connect.call_args_list[0].kwargs["uri"])
            self.assertEqual(sqlite_connect.call_args_list[1].args[0], ":memory:")
            self.assertTrue(fake.connection.committed)
            self.assertNotIn("PRAGMA", fake.connection.cursor_instance.schema)
            self.assertNotIn("AUTOINCREMENT", fake.connection.cursor_instance.schema)
            self.assertEqual(set(counts), set(TABLES))
            self.assertEqual(counts["match_quality"], 1)
            non_empty_tables = sum(1 for table in TABLES if counts[table])
            self.assertEqual(len(fake.connection.cursor_instance.batches), non_empty_tables)
            self.assertTrue(all(
                "ON CONFLICT" in query
                for query, _ in fake.connection.cursor_instance.batches
            ))
            statements = [query for query, _ in fake.connection.cursor_instance.statements]
            deletes = [query for query in statements if query.startswith("DELETE FROM")]
            self.assertEqual(len(deletes), 1)
            self.assertIn(
                "DELETE FROM match_quality AS duplicate USING match_quality AS keeper",
                deletes[0],
            )
            self.assertIn(
                "(TO_JSONB(duplicate) - 'id')=(TO_JSONB(keeper) - 'id')",
                deletes[0],
            )
            self.assertFalse(any(query.startswith("DROP TABLE") for query in statements))
            self.assertTrue(any(
                "ADD COLUMN IF NOT EXISTS participant_id" in query for query in statements
            ))
            self.assertTrue(any(
                "CREATE UNIQUE INDEX IF NOT EXISTS uq_match_quality_account_match" in query
                for query in statements
            ))

    def test_riot_scope_preserves_application_owned_tables(self):
        with tempfile.TemporaryDirectory() as directory:
            database = self._source_database(Path(directory))
            fake = FakePsycopg()
            with patch.dict(sys.modules, {"psycopg": types.SimpleNamespace(connect=fake.connect)}):
                counts = migrate(database, "postgresql://test", tables=RIOT_SYNC_TABLES)
            self.assertEqual(set(counts), set(RIOT_SYNC_TABLES))
            batch_sql = [query for query, _ in fake.connection.cursor_instance.batches]
            self.assertFalse(any("algorithm_settings" in query for query in batch_sql))
            self.assertFalse(any("recommendation_" in query for query in batch_sql))
            self.assertFalse(any("match_annotations" in query for query in batch_sql))

    def test_merge_uses_logical_keys_and_remaps_surrogate_foreign_keys(self):
        with tempfile.TemporaryDirectory() as directory:
            database = self._source_database(Path(directory))
            source = sqlite3.connect(database)
            try:
                group_id = source.execute(
                    "INSERT INTO friend_groups(name) VALUES('Premade') RETURNING id"
                ).fetchone()[0]
                source.execute(
                    "INSERT INTO friend_group_aliases(group_id,alias) VALUES(?,?)",
                    (group_id, "Duo#EUW"),
                )
                source.commit()
            finally:
                source.close()
            fake = FakePsycopg()
            with patch.dict(sys.modules, {"psycopg": types.SimpleNamespace(connect=fake.connect)}):
                migrate(database, "postgresql://test")

            batches = fake.connection.cursor_instance.batches
            match_sql, match_rows = next(
                batch for batch in batches
                if batch[0].startswith("INSERT INTO match_quality ")
            )
            self.assertIn("INSERT INTO match_quality (account,match_id,", match_sql)
            self.assertNotIn("match_quality (id,", match_sql)
            self.assertIn("ON CONFLICT (account,match_id) DO UPDATE", match_sql)
            self.assertEqual(match_rows[0][0:2], ("A#EUW", "M1"))

            group_sql, group_rows = next(
                batch for batch in batches
                if batch[0].startswith("INSERT INTO friend_groups ")
            )
            self.assertEqual(
                group_sql,
                "INSERT INTO friend_groups (name) VALUES (%s) "
                "ON CONFLICT (LOWER(name)) DO NOTHING",
            )
            self.assertEqual(group_rows, [("Premade",)])
            alias_sql, alias_rows = next(
                batch for batch in batches
                if batch[0].startswith("INSERT INTO friend_group_aliases ")
            )
            self.assertIn(
                "SELECT id,%s FROM friend_groups WHERE LOWER(name)=LOWER(%s)", alias_sql,
            )
            self.assertIn("ON CONFLICT (LOWER(alias))", alias_sql)
            self.assertEqual(alias_rows, [("Duo#EUW", "Premade")])

    def test_merge_rejects_case_insensitive_source_group_duplicates(self):
        with tempfile.TemporaryDirectory() as directory:
            database = self._source_database(Path(directory))
            source = sqlite3.connect(database)
            try:
                source.executemany(
                    "INSERT INTO friend_groups(name) VALUES(?)",
                    [("Premade",), ("premade",)],
                )
                source.commit()
            finally:
                source.close()
            fake = FakePsycopg()
            with (
                patch.dict(sys.modules, {"psycopg": types.SimpleNamespace(connect=fake.connect)}),
                self.assertRaisesRegex(RuntimeError, "friend_groups.name ambigui"),
            ):
                migrate(database, "postgresql://test")
            self.assertFalse(fake.connection.committed)

    def test_conflicting_target_duplicates_abort_before_cleanup_in_every_scope(self):
        with tempfile.TemporaryDirectory() as directory:
            database = self._source_database(Path(directory))
            for selected_tables in (TABLES, RIOT_SYNC_TABLES):
                with self.subTest(selected_tables=selected_tables):
                    fake = FakePsycopg(
                        execute_error_marker="match_quality contains conflicting duplicates",
                    )
                    with (
                        patch.dict(
                            sys.modules,
                            {"psycopg": types.SimpleNamespace(connect=fake.connect)},
                        ),
                        self.assertRaisesRegex(
                            RuntimeError, "simulated conflicting target rows",
                        ),
                    ):
                        migrate(
                            database, "postgresql://test", tables=selected_tables,
                        )
                    statements = [
                        query for query, _ in fake.connection.cursor_instance.statements
                    ]
                    preflight = next(
                        query for query in statements
                        if "match_quality contains conflicting duplicates" in query
                    )
                    self.assertIn(
                        "COUNT(DISTINCT (TO_JSONB(candidate) - 'id'))>1", preflight,
                    )
                    self.assertIn("conflicts.account || '/' || conflicts.match_id", preflight)
                    self.assertFalse(any(
                        query.startswith("DELETE FROM match_quality")
                        for query in statements
                    ))
                    self.assertEqual(fake.connection.cursor_instance.batches, [])
                    self.assertFalse(fake.connection.committed)

    def test_riot_scope_applies_only_explicit_stale_tombstones(self):
        with tempfile.TemporaryDirectory() as directory:
            database = self._source_database(Path(directory))
            source = sqlite3.connect(database)
            try:
                source.execute(
                    "INSERT INTO riot_match_list_raw(account,puuid,fetched_at,match_ids_json) "
                    "VALUES(?,?,?,?)",
                    ("A#EUW", "p1", "now", '["M1","M_STALE"]'),
                )
                source.executemany(
                    "INSERT INTO riot_match_materialization "
                    "(account,match_id,status,reason,identity_resolution,participant_puuid,attempts,last_attempt_at) "
                    "VALUES(?,?,?,?,?,?,?,?)",
                    [
                        ("A#EUW", "M_STALE", "unsupported_queue", "queue", "", "p1", 1, "now"),
                        ("B#EUW", "B_STALE", "unsupported_queue", "queue", "", "p2", 1, "now"),
                    ],
                )
                source.commit()
            finally:
                source.close()
            fake = FakePsycopg()
            with patch.dict(sys.modules, {"psycopg": types.SimpleNamespace(connect=fake.connect)}):
                migrate(database, "postgresql://test", tables=RIOT_SYNC_TABLES)

            statements = [query for query, _ in fake.connection.cursor_instance.statements]
            delete_sql = next(
                query for query in statements
                if query.startswith("DELETE FROM match_quality AS target")
            )
            self.assertIn(
                "USING champion_fit_riot_stale_match_keys AS stale", delete_sql,
            )
            self.assertIn("target.account=stale.account", delete_sql)
            self.assertIn("target.match_id=stale.match_id", delete_sql)
            stale_batch = next(
                rows for query, rows in fake.connection.cursor_instance.batches
                if query.startswith("INSERT INTO champion_fit_riot_stale_match_keys")
            )
            self.assertEqual(stale_batch, [("A#EUW", "M_STALE")])

    def test_replace_mode_is_explicit_and_rebuilds_in_one_transaction(self):
        with tempfile.TemporaryDirectory() as directory:
            database = self._source_database(Path(directory))
            fake = FakePsycopg()
            with patch.dict(sys.modules, {"psycopg": types.SimpleNamespace(connect=fake.connect)}):
                migrate(database, "postgresql://test", mode="replace")
            statements = [query for query, _ in fake.connection.cursor_instance.statements]
            self.assertTrue(any(query.startswith("DROP TABLE") for query in statements))
            self.assertTrue(any(query.startswith("DELETE FROM") for query in statements))
            self.assertTrue(fake.connection.committed)

    def test_replace_mode_rejects_partial_scope(self):
        with tempfile.TemporaryDirectory() as directory:
            database = self._source_database(Path(directory))
            with self.assertRaisesRegex(ValueError, "complete managed table set"):
                migrate(database, "postgresql://test", mode="replace", tables=RIOT_SYNC_TABLES)

    def test_production_compose_keeps_full_migration_out_of_normal_startup(self):
        compose = Path(__file__).with_name("docker-compose.production.yml").read_text(
            encoding="utf-8"
        )

        def service_block(name: str) -> str:
            lines = compose.splitlines()
            start = lines.index(f"  {name}:") + 1
            end = len(lines)
            for index in range(start, len(lines)):
                line = lines[index]
                next_service = (
                    line.startswith("  ")
                    and not line.startswith("    ")
                    and line.endswith(":")
                )
                next_top_level = bool(line) and not line.startswith(" ")
                if next_service or next_top_level:
                    end = index
                    break
            return "\n".join(lines[start:end])

        migrate_service = service_block("migrate")
        web_service = service_block("web")
        self.assertIn('profiles: ["bootstrap"]', migrate_service)
        self.assertIn("python migrate_postgres.py", migrate_service)
        self.assertNotIn("--scope riot", migrate_service)
        self.assertIn("PGPASSWORD:", migrate_service)
        self.assertIn("postgresql://champion_fit@postgres", migrate_service)
        self.assertNotIn("champion_fit:$${POSTGRES_PASSWORD}", migrate_service)
        self.assertIn(
            "source: ${CHAMPION_FIT_SQLITE_PATH:-./champion_fit.db}", migrate_service,
        )
        self.assertIn("postgres:", web_service)
        self.assertIn("condition: service_healthy", web_service)
        self.assertNotIn("migrate:", web_service)
        self.assertIn("PGPASSWORD:", web_service)
        self.assertIn(
            "CHAMPION_FIT_DATABASE_URL: postgresql://champion_fit@postgres", web_service,
        )
        self.assertNotIn("champion_fit:${POSTGRES_PASSWORD}", web_service)

    @unittest.skipUnless(shutil.which("docker"), "Docker Compose CLI is unavailable")
    def test_production_compose_config_does_not_require_sqlite_path(self):
        compose = Path(__file__).with_name("docker-compose.production.yml")
        environment = os.environ.copy()
        environment.pop("CHAMPION_FIT_SQLITE_PATH", None)
        environment["POSTGRES_PASSWORD"] = "placeholder:@/#? password"
        result = subprocess.run(
            ["docker", "compose", "-f", str(compose), "config"],
            cwd=compose.parent,
            env=environment,
            capture_output=True,
            text=True,
            timeout=30,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        profiled = subprocess.run(
            [
                "docker", "compose", "-f", str(compose),
                "--profile", "bootstrap", "config",
            ],
            cwd=compose.parent,
            env=environment,
            capture_output=True,
            text=True,
            timeout=30,
        )
        self.assertEqual(profiled.returncode, 0, profiled.stdout + profiled.stderr)
        self.assertIn("champion_fit.db", profiled.stdout)


@unittest.skipUnless(
    os.environ.get("CHAMPION_FIT_TEST_POSTGRES_DSN"),
    "set CHAMPION_FIT_TEST_POSTGRES_DSN to run the isolated PostgreSQL integration test",
)
class PostgreSQLMigrationIntegrationTests(unittest.TestCase):
    def test_preexisting_legacy_schema_is_upgraded_and_migration_is_idempotent(self):
        import psycopg
        from psycopg import sql
        from psycopg.conninfo import make_conninfo

        base_dsn = os.environ["CHAMPION_FIT_TEST_POSTGRES_DSN"]
        schema_name = f"champion_fit_test_{uuid.uuid4().hex}"
        with psycopg.connect(base_dsn, autocommit=True) as admin:
            admin.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(schema_name)))
        scoped_dsn = make_conninfo(base_dsn, options=f"-c search_path={schema_name}")
        try:
            with psycopg.connect(scoped_dsn) as target:
                target.execute(
                    """CREATE TABLE match_participants (
                        match_id TEXT NOT NULL, puuid TEXT NOT NULL,
                        riot_id TEXT NOT NULL, team_id INTEGER NOT NULL DEFAULT 0,
                        win INTEGER NOT NULL DEFAULT 0,
                        PRIMARY KEY (match_id, puuid)
                    )"""
                )
                target.execute(
                    """CREATE TABLE match_quality (
                        id BIGSERIAL PRIMARY KEY,
                        account TEXT NOT NULL, match_id TEXT NOT NULL,
                        date TEXT NOT NULL, patch TEXT NOT NULL, queue TEXT NOT NULL,
                        champion TEXT NOT NULL, role TEXT NOT NULL,
                        identity_resolution TEXT NOT NULL,
                        duration_minutes DOUBLE PRECISION NOT NULL, win INTEGER NOT NULL,
                        explicit_afk INTEGER NOT NULL, suspected_quasi_afk INTEGER NOT NULL,
                        early_surrender INTEGER NOT NULL, anomaly_flags TEXT NOT NULL,
                        match_quality_score DOUBLE PRECISION NOT NULL,
                        loss_attribution_weight DOUBLE PRECISION NOT NULL,
                        win_evidence_weight DOUBLE PRECISION NOT NULL, reason TEXT NOT NULL
                    )"""
                )
                target.execute(
                    """INSERT INTO match_quality
                       (account,match_id,date,patch,queue,champion,role,identity_resolution,
                        duration_minutes,win,explicit_afk,suspected_quasi_afk,early_surrender,
                        anomaly_flags,match_quality_score,loss_attribution_weight,
                        win_evidence_weight,reason)
                       VALUES
                       ('Legacy#EUW','LEGACY','2025','15.1','420','Vi','JUNGLE','legacy',
                        30,1,0,0,0,'none',0.95,0,0.95,'legacy'),
                       ('Legacy#EUW','LEGACY','2025','15.1','420','Vi','JUNGLE','legacy',
                        30,1,0,0,0,'none',0.95,0,0.95,'duplicate')"""
                )
                target.execute(
                    """CREATE TABLE friend_groups (
                        id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL UNIQUE
                    )"""
                )
                target.execute(
                    """CREATE TABLE friend_group_aliases (
                        group_id BIGINT NOT NULL REFERENCES friend_groups(id) ON DELETE CASCADE,
                        alias TEXT NOT NULL UNIQUE, PRIMARY KEY(group_id,alias)
                    )"""
                )
                group_id = target.execute(
                    "INSERT INTO friend_groups(name) VALUES('Premade') RETURNING id"
                ).fetchone()[0]
                target.execute(
                    "INSERT INTO friend_group_aliases(group_id,alias) VALUES(%s,'Duo#EUW')",
                    (group_id,),
                )
            with tempfile.TemporaryDirectory() as directory:
                database = MigrationTests._source_database(Path(directory))
                source = sqlite3.connect(database)
                try:
                    group_id = source.execute(
                        "INSERT INTO friend_groups(name) VALUES('premade') RETURNING id"
                    ).fetchone()[0]
                    source.execute(
                        "INSERT INTO friend_group_aliases(group_id,alias) VALUES(?,?)",
                        (group_id, "duo#euw"),
                    )
                    source.commit()
                finally:
                    source.close()
                with self.assertRaisesRegex(psycopg.Error, "Legacy#EUW/LEGACY"):
                    migrate(database, scoped_dsn)
                with psycopg.connect(scoped_dsn) as target:
                    self.assertEqual(
                        target.execute(
                            "SELECT reason FROM match_quality "
                            "WHERE account='Legacy#EUW' AND match_id='LEGACY' "
                            "ORDER BY id"
                        ).fetchall(),
                        [("legacy",), ("duplicate",)],
                    )
                    target.execute(
                        "UPDATE match_quality SET reason='legacy' "
                        "WHERE account='Legacy#EUW' AND match_id='LEGACY'"
                    )
                first = migrate(database, scoped_dsn)
                second = migrate(database, scoped_dsn)
            self.assertEqual(first, second)
            with psycopg.connect(scoped_dsn) as target:
                columns = {
                    row[0] for row in target.execute(
                        "SELECT column_name FROM information_schema.columns "
                        "WHERE table_schema=current_schema() AND table_name='match_participants'"
                    )
                }
                self.assertTrue({"champion", "participant_id", "normalized_riot_id"} <= columns)
                self.assertEqual(
                    target.execute("SELECT COUNT(*) FROM match_quality").fetchone()[0], 2
                )
                self.assertEqual(
                    target.execute(
                        "SELECT COUNT(*) FROM match_quality "
                        "WHERE account='Legacy#EUW' AND match_id='LEGACY'"
                    ).fetchone()[0],
                    1,
                )
                self.assertEqual(
                    target.execute(
                        "SELECT reason FROM match_quality "
                        "WHERE account='Legacy#EUW' AND match_id='LEGACY'"
                    ).fetchone()[0],
                    "legacy",
                )
                self.assertIsNotNone(target.execute(
                    "SELECT 1 FROM pg_indexes WHERE schemaname=current_schema() "
                    "AND indexname='uq_match_quality_account_match'"
                ).fetchone())
                self.assertEqual(
                    target.execute("SELECT name FROM friend_groups").fetchall(),
                    [("Premade",)],
                )
                self.assertEqual(
                    target.execute("SELECT alias FROM friend_group_aliases").fetchall(),
                    [("Duo#EUW",)],
                )
            from algorithm_settings import ensure_settings, get_settings_snapshot, save_settings
            from storage import PostgresStorage

            settings_connection = PostgresStorage(scoped_dsn, SCHEMA_PATH).connect()
            try:
                ensure_settings(settings_connection)
                snapshot = get_settings_snapshot(settings_connection)
                saved = save_settings(
                    settings_connection, snapshot["revision"], snapshot["settings"]
                )
                self.assertEqual(saved["revision"], snapshot["revision"] + 1)
            finally:
                settings_connection.close()
        finally:
            with psycopg.connect(base_dsn, autocommit=True) as admin:
                admin.execute(
                    sql.SQL("DROP SCHEMA {} CASCADE").format(sql.Identifier(schema_name))
                )


if __name__ == "__main__":
    unittest.main()
