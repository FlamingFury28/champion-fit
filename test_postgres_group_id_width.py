"""Opt-in BIGINT friend-group references on new, legacy and migrated schemas."""
from contextlib import closing
from functools import partial
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
import json
import os
from threading import Thread
from urllib.parse import quote
import uuid

import pytest

import app
from migrate_postgres import migrate
from storage import PostgresStorage, SQLiteStorage


HIGH_GROUP_ID = 2**31 + 17


@pytest.fixture
def postgres_groups():
    base = os.environ.get("CHAMPION_FIT_TEST_POSTGRES_DSN")
    if not base:
        pytest.skip("set CHAMPION_FIT_TEST_POSTGRES_DSN to run PostgreSQL group ID tests")
    psycopg = pytest.importorskip("psycopg")
    from psycopg import sql
    from psycopg.conninfo import make_conninfo

    schemas = []

    def create():
        schema = f"champion_fit_group_width_test_{uuid.uuid4().hex}"
        with psycopg.connect(base, autocommit=True) as admin:
            admin.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(schema)))
        schemas.append(schema)
        return schema, PostgresStorage(make_conninfo(base, options=f"-c search_path={schema}"), app.SCHEMA_PATH)

    try:
        yield create, base
    finally:
        for schema in reversed(schemas):
            with psycopg.connect(base, autocommit=True) as admin:
                admin.execute(sql.SQL("DROP SCHEMA {} CASCADE").format(sql.Identifier(schema)))


def legacy_groups(storage):
    with closing(storage.connect()) as connection:
        connection.executescript("""
            CREATE TABLE friend_groups(id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL UNIQUE);
            CREATE TABLE friend_group_aliases(
                group_id INTEGER NOT NULL,
                alias TEXT NOT NULL UNIQUE,
                PRIMARY KEY(group_id,alias),
                FOREIGN KEY(group_id) REFERENCES friend_groups(id) ON DELETE CASCADE,
                CONSTRAINT legacy_positive_group_id CHECK(group_id>0)
            );
            CREATE UNIQUE INDEX legacy_alias_case_insensitive ON friend_group_aliases(LOWER(alias));
            INSERT INTO friend_groups(name) VALUES('Legacy group');
            INSERT INTO friend_group_aliases(group_id,alias) VALUES(1,'Legacy#EUW');
        """)
        connection.commit()


def alias_structure(storage):
    with closing(storage.connect()) as connection:
        return {
            "column": dict(connection.execute("""
                SELECT c.oid AS table_oid,c.relfilenode,
                       pg_catalog.format_type(a.atttypid,a.atttypmod) AS data_type,a.attnotnull
                FROM pg_catalog.pg_class c JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid
                WHERE c.oid=pg_catalog.to_regclass('friend_group_aliases')
                  AND a.attname='group_id' AND a.attnum>0 AND NOT a.attisdropped
            """).fetchone()),
            "constraints": [dict(row) for row in connection.execute("""
                SELECT conname,contype,convalidated,condeferrable,condeferred,
                       pg_catalog.pg_get_constraintdef(oid) AS definition
                FROM pg_catalog.pg_constraint
                WHERE conrelid=pg_catalog.to_regclass('friend_group_aliases') ORDER BY conname
            """)],
            "indexes": [dict(row) for row in connection.execute("""
                SELECT c.oid,c.relname,c.relfilenode
                FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid=i.indexrelid
                WHERE i.indrelid=pg_catalog.to_regclass('friend_group_aliases') ORDER BY c.relname
            """)],
            "rows": [dict(row) for row in connection.execute(
                "SELECT group_id,alias FROM friend_group_aliases ORDER BY group_id,alias")],
        }


def source_groups(tmp_path, *, orphan=False):
    source = SQLiteStorage(tmp_path / "high-groups.db", app.SCHEMA_PATH)
    source.initialize()
    with closing(source.connect()) as connection:
        connection.execute("INSERT INTO friend_groups(id,name) VALUES(?,?)", (HIGH_GROUP_ID, "High group"))
        connection.execute("INSERT INTO friend_group_aliases(group_id,alias) VALUES(?,?)", (HIGH_GROUP_ID, "High#EUW"))
        connection.commit()
    if orphan:
        import sqlite3
        # Reproduce a source written by older code with foreign keys disabled.
        with sqlite3.connect(source.path) as connection:
            connection.execute("INSERT INTO friend_group_aliases(group_id,alias) VALUES(?,?)", (999, "Orphan#EUW"))
    return source


class QuietGroupHandler(app.DashboardHandler):
    def log_message(self, format, *args):
        pass


def verify_high_id_alias_http(storage, root, monkeypatch, group_id):
    monkeypatch.setattr(app, "STORAGE", storage)
    monkeypatch.setattr(app, "DB_PATH", root / "unused.db")
    monkeypatch.setattr(app, "APP_ROOT", root)
    server = ThreadingHTTPServer(("127.0.0.1", 0), partial(QuietGroupHandler, directory=root))
    worker = Thread(target=server.serve_forever, daemon=True)
    worker.start()

    def send(method, path, payload=None):
        client = HTTPConnection("127.0.0.1", server.server_port, timeout=10)
        try:
            body = json.dumps(payload).encode("utf-8") if payload is not None else None
            client.request(method, path, body=body, headers={"Content-Type": "application/json"} if body else {})
            response = client.getresponse()
            content = response.read()
            assert response.getheader("Content-Type", "").startswith("application/json"), content
            return response.status, json.loads(content)
        finally:
            client.close()

    try:
        status, added = send("POST", f"/api/friend-groups/{group_id}/aliases", {"aliases": ["Added high#EUW"]})
        assert status == 200 and added["id"] == group_id and added["added_aliases"] == ["Added high#EUW"]
        status, deleted = send("DELETE", f"/api/friend-groups/{group_id}/aliases/{quote('Added high#EUW', safe='')}")
        assert status == 200 and deleted["id"] == group_id
        with closing(storage.connect()) as connection:
            assert [row["alias"] for row in connection.execute(
                "SELECT alias FROM friend_group_aliases WHERE group_id=?", (group_id,))] == ["High#EUW"]
            assert connection.execute("SELECT name FROM friend_groups WHERE id=?", (group_id,)).fetchone()["name"] == "High group"
    finally:
        server.shutdown()
        server.server_close()
        worker.join(timeout=5)
        assert not worker.is_alive()


def test_new_schema_uses_bigint_and_repeated_initialize_preserves_table_and_indexes(postgres_groups):
    create, _ = postgres_groups
    _, storage = create()
    storage.initialize()
    with closing(storage.connect()) as connection:
        connection.execute("INSERT INTO friend_groups(id,name) VALUES(?,?)", (HIGH_GROUP_ID, "High group"))
        connection.execute("INSERT INTO friend_group_aliases(group_id,alias) VALUES(?,?)", (HIGH_GROUP_ID, "High#EUW"))
        connection.commit()
    before = alias_structure(storage)
    assert before["column"]["data_type"] == "bigint"
    assert before["column"]["attnotnull"]
    storage.initialize()
    assert alias_structure(storage) == before


def test_legacy_initialize_preserves_rows_constraints_and_cascade(postgres_groups):
    import psycopg

    create, _ = postgres_groups
    _, storage = create()
    legacy_groups(storage)
    before = alias_structure(storage)
    assert before["column"]["data_type"] == "integer"
    storage.initialize()
    after = alias_structure(storage)
    assert after["column"]["data_type"] == "bigint"
    assert after["column"]["attnotnull"]
    assert after["column"]["table_oid"] == before["column"]["table_oid"]
    assert after["constraints"] == before["constraints"]
    assert after["rows"] == before["rows"]
    storage.initialize()
    assert alias_structure(storage) == after

    for statement, params, error in (
        ("INSERT INTO friend_group_aliases(group_id,alias) VALUES(?,?)", (HIGH_GROUP_ID, "Missing#EUW"), psycopg.errors.ForeignKeyViolation),
        ("INSERT INTO friend_group_aliases(group_id,alias) VALUES(?,?)", (1, "Legacy#EUW"), psycopg.errors.UniqueViolation),
        ("INSERT INTO friend_group_aliases(group_id,alias) VALUES(?,?)", (1, "LEGACY#euw"), psycopg.errors.UniqueViolation),
    ):
        with closing(storage.connect()) as connection, pytest.raises(error):
            connection.execute(statement, params)
    with closing(storage.connect()) as connection:
        connection.execute("DELETE FROM friend_groups WHERE id=1")
        assert connection.execute("SELECT COUNT(*) AS count FROM friend_group_aliases").fetchone()["count"] == 0
        connection.rollback()
    assert alias_structure(storage) == after


def test_initialize_only_widens_relation_resolved_by_search_path(postgres_groups):
    from psycopg.conninfo import make_conninfo

    create, base = postgres_groups
    first_schema, first = create()
    second_schema, second = create()
    first.initialize()
    legacy_groups(second)
    before_first = alias_structure(first)
    before_second = alias_structure(second)
    combined = PostgresStorage(make_conninfo(base, options=f"-c search_path={first_schema},{second_schema}"), app.SCHEMA_PATH)
    combined.initialize()
    assert alias_structure(first) == before_first
    assert alias_structure(second) == before_second

    reversed_path = PostgresStorage(make_conninfo(base, options=f"-c search_path={second_schema},{first_schema}"), app.SCHEMA_PATH)
    reversed_path.initialize()
    assert alias_structure(second)["column"]["data_type"] == "bigint"
    assert alias_structure(second)["rows"] == before_second["rows"]
    assert alias_structure(first) == before_first


def test_replace_migration_preserves_sqlite_high_ids_and_alias_http(postgres_groups, tmp_path, monkeypatch):
    create, _ = postgres_groups
    _, storage = create()
    source = source_groups(tmp_path)
    counts = migrate(source.path, storage.dsn, mode="replace")
    assert counts["friend_groups"] == counts["friend_group_aliases"] == 1
    before = alias_structure(storage)
    assert before["column"]["data_type"] == "bigint"
    assert before["rows"] == [{"group_id": HIGH_GROUP_ID, "alias": "High#EUW"}]
    verify_high_id_alias_http(storage, tmp_path, monkeypatch, HIGH_GROUP_ID)
    # A second copy must not rewrite an already compatible relation or its indexes.
    migrate(source.path, storage.dsn)
    assert alias_structure(storage) == before
    with closing(storage.connect()) as connection:
        generated = connection.execute("INSERT INTO friend_groups(name) VALUES('Next group') RETURNING id").fetchone()["id"]
        assert generated > HIGH_GROUP_ID
        connection.rollback()


def test_merge_migration_upgrades_legacy_and_keeps_target_high_ids(postgres_groups, tmp_path, monkeypatch):
    create, _ = postgres_groups
    _, storage = create()
    legacy_groups(storage)
    target_id = HIGH_GROUP_ID + 100
    with closing(storage.connect()) as connection:
        connection.execute("INSERT INTO friend_groups(id,name) VALUES(?,?)", (target_id, "High group"))
        connection.commit()
    source = source_groups(tmp_path)
    migrate(source.path, storage.dsn)
    assert alias_structure(storage)["column"]["data_type"] == "bigint"
    verify_high_id_alias_http(storage, tmp_path, monkeypatch, target_id)
    with closing(storage.connect()) as connection:
        assert [dict(row) for row in connection.execute("SELECT id,name FROM friend_groups ORDER BY id")] == [
            {"id": 1, "name": "Legacy group"}, {"id": target_id, "name": "High group"},
        ]
        assert connection.execute("SELECT alias FROM friend_group_aliases WHERE group_id=1").fetchone()["alias"] == "Legacy#EUW"
    before = alias_structure(storage)
    migrate(source.path, storage.dsn)
    assert alias_structure(storage) == before


def test_failed_migration_rolls_back_legacy_widening_and_all_data(postgres_groups, tmp_path):
    create, _ = postgres_groups
    _, storage = create()
    legacy_groups(storage)
    before = alias_structure(storage)
    source = source_groups(tmp_path, orphan=True)
    with pytest.raises(RuntimeError, match="gruppo sorgente inesistente"):
        migrate(source.path, storage.dsn)
    assert alias_structure(storage) == before
    with closing(storage.connect()) as connection:
        assert [dict(row) for row in connection.execute("SELECT id,name FROM friend_groups")] == [
            {"id": 1, "name": "Legacy group"},
        ]
