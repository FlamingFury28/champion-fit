"""Casefold-compatible friend merges preserve target identities and ownership."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
import sys
from time import monotonic, sleep
import types
import uuid

import pytest

import app
from migrate_postgres import RIOT_SYNC_TABLES, migrate
from storage import SQLiteStorage
from test_migrate_postgres import FakePsycopg
from test_postgres_group_id_width import alias_structure, legacy_groups, postgres_groups  # noqa: F401


def source_groups(tmp_path, groups):
    source = SQLiteStorage(tmp_path / "casefold-groups.db", app.SCHEMA_PATH)
    source.initialize()
    with closing(source.connect()) as connection:
        for name, aliases in groups:
            group_id = connection.execute("INSERT INTO friend_groups(name) VALUES(?) RETURNING id", (name,)).fetchone()[0]
            connection.executemany("INSERT INTO friend_group_aliases(group_id,alias) VALUES(?,?)",
                                   [(group_id, alias) for alias in aliases])
        connection.commit()
    return source


def rows(storage):
    with closing(storage.connect()) as connection:
        return {
            "groups": [dict(row) for row in connection.execute("SELECT id,name FROM friend_groups ORDER BY id")],
            "aliases": [dict(row) for row in connection.execute("SELECT group_id,alias FROM friend_group_aliases ORDER BY group_id,alias")],
            "relations": [dict(row) for row in connection.execute("""
                SELECT oid,relname,relkind FROM pg_catalog.pg_class
                WHERE relnamespace=pg_catalog.current_schema()::pg_catalog.regnamespace ORDER BY relname
            """)],
        }


@pytest.mark.parametrize("mode,tables", [("merge", None), ("replace", None), ("merge", RIOT_SYNC_TABLES)],
                         ids=["merge", "replace", "riot-only"])
def test_global_lock_precedes_every_target_schema_or_table_statement(tmp_path, monkeypatch, mode, tables):
    source = source_groups(tmp_path, [])
    fake = FakePsycopg()
    monkeypatch.setitem(sys.modules, "psycopg", types.SimpleNamespace(connect=fake.connect))
    options = {"mode": mode}
    if tables is not None:
        options["tables"] = tables
    migrate(source.path, "postgresql://synthetic-fake", **options)
    assert fake.connection.cursor_instance.statements[0] == (
        "SELECT pg_advisory_xact_lock(hashtext(%s))", ("champion_fit.friend_group_aliases",),
    )


@pytest.mark.parametrize("source_name,target_name", [("Straße", "STRASSE"), ("équipe", "Équipe")])
def test_merge_reuses_casefold_target_ids_and_display_for_names_and_aliases(postgres_groups, tmp_path, source_name, target_name):
    create, _ = postgres_groups
    _, target = create()
    target.initialize()
    target_id = 2**31 + 17
    source = source_groups(tmp_path, [(source_name, [source_name + "#EUW", "New#EUW"])])
    with closing(target.connect()) as connection:
        connection.execute("INSERT INTO friend_groups(id,name) VALUES(?,?)", (target_id, target_name))
        connection.execute("INSERT INTO friend_group_aliases(group_id,alias) VALUES(?,?)", (target_id, target_name + "#EUW"))
        connection.execute("INSERT INTO friend_groups(name) VALUES('Target only')")
        connection.execute("INSERT INTO friend_group_aliases(group_id,alias) VALUES(1,'TargetOnly#EUW')")
        connection.commit()
    counts = migrate(source.path, target.dsn)
    after = rows(target)
    assert counts["friend_groups"] == 1 and counts["friend_group_aliases"] == 2
    assert after["groups"] == [{"id": 1, "name": "Target only"}, {"id": target_id, "name": target_name}]
    assert sorted(after["aliases"], key=lambda row: (row["group_id"], row["alias"])) == sorted([
        {"group_id": 1, "alias": "TargetOnly#EUW"},
        {"group_id": target_id, "alias": target_name + "#EUW"},
        {"group_id": target_id, "alias": "New#EUW"},
    ], key=lambda row: (row["group_id"], row["alias"]))
    migrate(source.path, target.dsn)
    assert rows(target) == after


def test_casefold_alias_reassignment_keeps_existing_display_and_other_groups(postgres_groups, tmp_path):
    create, _ = postgres_groups
    _, target = create()
    target.initialize()
    source = source_groups(tmp_path, [("Source group", ["Straße#EUW"])])
    with closing(target.connect()) as connection:
        connection.execute("INSERT INTO friend_groups(name) VALUES('Target group')")
        connection.executemany("INSERT INTO friend_group_aliases(group_id,alias) VALUES(1,?)",
                               [("STRASSE#EUW",), ("TargetOnly#EUW",)])
        connection.commit()
    migrate(source.path, target.dsn)
    after = rows(target)
    assert after["groups"] == [{"id": 1, "name": "Target group"}, {"id": 2, "name": "Source group"}]
    assert after["aliases"] == [{"group_id": 1, "alias": "TargetOnly#EUW"}, {"group_id": 2, "alias": "STRASSE#EUW"}]
    migrate(source.path, target.dsn)
    assert rows(target) == after


@pytest.mark.parametrize("ambiguous", ["names", "aliases"])
def test_ambiguous_target_legacy_aborts_without_merging_or_schema_changes(postgres_groups, tmp_path, ambiguous):
    create, _ = postgres_groups
    _, target = create()
    legacy_groups(target)
    with closing(target.connect()) as connection:
        if ambiguous == "names":
            connection.executemany("INSERT INTO friend_groups(name) VALUES(?)", [("Straße",), ("STRASSE",)])
        else:
            connection.executemany("INSERT INTO friend_group_aliases(group_id,alias) VALUES(1,?)", [("Straße#EUW",), ("STRASSE#EUW",)])
        connection.commit()
    source = source_groups(tmp_path, [("Source group", ["Source#EUW"])])
    before_rows, before_structure = rows(target), alias_structure(target)
    with pytest.raises(RuntimeError, match="destinazione PostgreSQL.*ambigui"):
        migrate(source.path, target.dsn)
    assert rows(target) == before_rows
    assert alias_structure(target) == before_structure
    assert alias_structure(target)["column"]["data_type"] == "integer"


@pytest.mark.parametrize("ambiguous", ["names", "aliases"])
@pytest.mark.parametrize("tables", [None, ("friend_group_aliases",)], ids=["all", "aliases-only"])
def test_ambiguous_source_remains_rejected_before_target_connection(tmp_path, monkeypatch, ambiguous, tables):
    groups = [("Straße", ["First#EUW"]), ("STRASSE", ["Second#EUW"])] if ambiguous == "names" else [
        ("Source group", ["Straße#EUW", "STRASSE#EUW"]),
    ]
    source = source_groups(tmp_path, groups)
    def reject_connect(*args, **kwargs):
        pytest.fail("ambiguous source reached PostgreSQL")
    monkeypatch.setitem(sys.modules, "psycopg", types.SimpleNamespace(connect=reject_connect))
    with pytest.raises(RuntimeError, match="snapshot SQLite.*ambigui"):
        migrate(source.path, "postgresql://synthetic-fake", **({"tables": tables} if tables is not None else {}))


def test_explicit_replace_keeps_exact_source_ids_and_display_despite_legacy_target(postgres_groups, tmp_path):
    create, _ = postgres_groups
    _, target = create()
    legacy_groups(target)
    with closing(target.connect()) as connection:
        connection.executemany("INSERT INTO friend_groups(name) VALUES(?)", [("Straße",), ("STRASSE",)])
        connection.commit()
    source = source_groups(tmp_path, [("Source Straße", ["Source Straße#EUW"])])
    migrate(source.path, target.dsn, mode="replace")
    after = rows(target)
    assert after["groups"] == [{"id": 1, "name": "Source Straße"}]
    assert after["aliases"] == [{"group_id": 1, "alias": "Source Straße#EUW"}]


def test_riot_only_keeps_unicode_legacy_ambiguities_outside_import_scope(postgres_groups, tmp_path):
    create, _ = postgres_groups
    _, target = create()
    target.initialize()
    with closing(target.connect()) as connection:
        connection.executemany("INSERT INTO friend_groups(name) VALUES(?)", [("Straße",), ("STRASSE",)])
        connection.executemany("INSERT INTO friend_group_aliases(group_id,alias) VALUES(1,?)", [("Straße#EUW",), ("STRASSE#EUW",)])
        connection.commit()
    source = source_groups(tmp_path, [("Source Straße", []), ("Source STRASSE", [])])
    before = rows(target)
    counts = migrate(source.path, target.dsn, tables=RIOT_SYNC_TABLES)
    after = rows(target)
    assert set(counts) == set(RIOT_SYNC_TABLES)
    assert after["groups"] == before["groups"] and after["aliases"] == before["aliases"]


def test_migration_waits_for_web_lock_before_ddl_and_sees_new_committed_name(postgres_groups, tmp_path):
    import psycopg
    from psycopg.conninfo import make_conninfo

    create, base = postgres_groups
    schema, target = create()
    target.initialize()
    source = source_groups(tmp_path, [("Straße", ["Imported#EUW"])])
    application = "casefold_migration_" + uuid.uuid4().hex
    migration_dsn = make_conninfo(target.dsn, application_name=application)
    with psycopg.connect(target.dsn) as web_writer, psycopg.connect(base, autocommit=True) as observer:
        web_writer.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", ("champion_fit.friend_group_aliases",))
        with ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(migrate, source.path, migration_dsn)
            try:
                deadline = monotonic() + 5
                waiting = None
                while monotonic() < deadline:
                    waiting = observer.execute("SELECT pid,wait_event,query FROM pg_stat_activity WHERE application_name=%s AND state='active'", (application,)).fetchone()
                    if waiting and waiting[1] == "advisory":
                        break
                    sleep(.01)
                assert waiting and waiting[1] == "advisory" and "pg_advisory_xact_lock" in waiting[2]
                assert not future.done()
                # No relation locks can precede the global lock acquisition.
                group_oid = web_writer.execute("SELECT 'friend_groups'::regclass::oid").fetchone()[0]
                assert observer.execute("SELECT 1 FROM pg_locks WHERE pid=%s AND relation=%s", (waiting[0], group_oid)).fetchone() is None
                group_id = web_writer.execute("INSERT INTO friend_groups(name) VALUES('STRASSE') RETURNING id").fetchone()[0]
                web_writer.execute("INSERT INTO friend_group_aliases(group_id,alias) VALUES(%s,'Existing#EUW')", (group_id,))
                web_writer.commit()
                assert future.result(timeout=10)["friend_groups"] == 1
            finally:
                web_writer.rollback()
                # Release the blocking transaction even if the assertions fail.
                if not future.done():
                    web_writer.commit()
                    future.result(timeout=10)
    result = rows(target)
    assert result["groups"] == [{"id": group_id, "name": "STRASSE"}]
    assert result["aliases"] == [{"group_id": group_id, "alias": "Existing#EUW"}, {"group_id": group_id, "alias": "Imported#EUW"}]
