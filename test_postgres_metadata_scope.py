"""Opt-in PostgreSQL introspection resolves the same relation as ordinary SQL."""
from contextlib import closing
import os
import uuid

import pytest

import account_identity
import app
import playstyle_metrics
import riot_sync
from storage import PostgresStorage, postgres_table_columns, postgres_table_exists


@pytest.fixture(scope="module")
def metadata_schemas():
    base = os.environ.get("CHAMPION_FIT_TEST_POSTGRES_DSN")
    if not base:
        pytest.skip("set CHAMPION_FIT_TEST_POSTGRES_DSN to run isolated PostgreSQL metadata tests")
    psycopg = pytest.importorskip("psycopg")
    from psycopg import sql
    from psycopg.conninfo import make_conninfo

    prefix = f"champion_fit_metadata_test_{uuid.uuid4().hex}"
    schemas = (f"{prefix}_a", f"{prefix}_b")
    created = []
    try:
        stores = []
        for schema in schemas:
            with psycopg.connect(base, autocommit=True) as admin:
                assert admin.info.server_version >= 160000
                admin.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(schema)))
                created.append(schema)
            storage = PostgresStorage(make_conninfo(base, options=f"-c search_path={schema}"), app.SCHEMA_PATH)
            storage.initialize()
            stores.append(storage)
        yield schemas, stores
    finally:
        for schema in reversed(created):
            with psycopg.connect(base, autocommit=True) as admin:
                admin.execute(sql.SQL("DROP SCHEMA {} CASCADE").format(sql.Identifier(schema)))


@pytest.fixture
def metadata_connection(metadata_schemas):
    _, stores = metadata_schemas
    connection = stores[0].connect()
    try:
        yield connection
    finally:
        connection.rollback()
        connection.close()


def set_search_path(connection, schemas):
    connection.raw.execute("SELECT set_config('search_path',%s,true)", (",".join(schemas),))


def create_probe_tables(connection, schemas):
    for index, schema in enumerate(schemas):
        connection.execute(f'CREATE TABLE "{schema}".lookup_probe(column_{index} INTEGER, dropped_column TEXT)')
        connection.execute(f'ALTER TABLE "{schema}".lookup_probe DROP COLUMN dropped_column')


@pytest.mark.parametrize("first", [0, 1])
def test_columns_follow_both_search_path_orders_and_qualified_names(metadata_schemas, metadata_connection, first):
    schemas, _ = metadata_schemas
    connection = metadata_connection
    create_probe_tables(connection, schemas)
    set_search_path(connection, (schemas[first], schemas[1 - first]))
    actual = {item[0] for item in connection.execute("SELECT * FROM lookup_probe WHERE FALSE").description}
    assert actual == {f"column_{first}"}
    for columns in (postgres_table_columns, riot_sync._table_columns):
        # SQL folds unquoted uppercase identifiers, and includes neither dropped
        # attributes nor system columns in SELECT *.
        assert columns(connection, "lookup_probe") == actual
        assert columns(connection, "LOOKUP_PROBE") == actual
        for index, schema in enumerate(schemas):
            assert columns(connection, f"{schema}.lookup_probe") == {f"column_{index}"}
        assert columns(connection, "missing_lookup_probe") == set()
        assert connection.execute("SELECT 1 AS usable").fetchone()["usable"] == 1


@pytest.mark.parametrize("exists", [
    postgres_table_exists, riot_sync._table_exists, account_identity._exists, playstyle_metrics._exists,
], ids=["storage", "riot", "identity", "metrics"])
def test_exists_excludes_names_outside_search_path_and_uses_qualified_names(metadata_schemas, metadata_connection, exists):
    schemas, _ = metadata_schemas
    connection = metadata_connection
    connection.execute(f'CREATE TABLE "{schemas[1]}".only_secondary(value INTEGER)')
    connection.execute(f'CREATE TABLE "{schemas[0]}"."MixedCaseProbe"(value INTEGER)')
    for order in ((schemas[0], schemas[1]), (schemas[1], schemas[0])):
        set_search_path(connection, order)
        assert exists(connection, "only_secondary")
        assert exists(connection, f"{schemas[1]}.only_secondary")
        assert exists(connection, f'{schemas[0]}."MixedCaseProbe"')
        assert not exists(connection, "MISSING_LOOKUP_PROBE")
    set_search_path(connection, (schemas[0],))
    assert not exists(connection, "only_secondary")
    assert exists(connection, f"{schemas[1]}.only_secondary")
    assert not exists(connection, "MixedCaseProbe")  # Unquoted name folds to lowercase.
    assert exists(connection, '"MixedCaseProbe"')
    assert connection.execute("SELECT 1 AS usable").fetchone()["usable"] == 1


def test_temporary_shadowing_and_explicit_schema_resolve_independently(metadata_schemas, metadata_connection):
    schemas, _ = metadata_schemas
    connection = metadata_connection
    create_probe_tables(connection, schemas)
    set_search_path(connection, schemas)
    connection.execute("CREATE TEMP TABLE lookup_probe(temporary_column INTEGER)")
    assert {item[0] for item in connection.execute("SELECT * FROM lookup_probe WHERE FALSE").description} == {"temporary_column"}
    assert postgres_table_columns(connection, "lookup_probe") == {"temporary_column"}
    assert riot_sync._table_columns(connection, "lookup_probe") == {"temporary_column"}
    assert postgres_table_columns(connection, "pg_temp.lookup_probe") == {"temporary_column"}
    assert postgres_table_columns(connection, f"{schemas[0]}.lookup_probe") == {"column_0"}
    assert postgres_table_exists(connection, "lookup_probe")


def test_queryable_kinds_include_views_and_partitions_but_exclude_indexes_and_sequences(metadata_schemas, metadata_connection):
    schemas, _ = metadata_schemas
    connection = metadata_connection
    schema = schemas[0]
    connection.execute(f'CREATE TABLE "{schema}".ordinary_probe(value INTEGER)')
    connection.execute(f'CREATE TABLE "{schema}".partition_probe(value INTEGER) PARTITION BY RANGE(value)')
    connection.execute(f'CREATE VIEW "{schema}".view_probe AS SELECT 1 AS value')
    connection.execute(f'CREATE MATERIALIZED VIEW "{schema}".materialized_probe AS SELECT 1 AS value')
    connection.execute(f'CREATE INDEX probe_index ON "{schema}".ordinary_probe(value)')
    connection.execute(f'CREATE SEQUENCE "{schema}".probe_sequence')
    for name in ("ordinary_probe", "partition_probe", "view_probe", "materialized_probe"):
        assert postgres_table_exists(connection, f"{schema}.{name}")
        assert postgres_table_columns(connection, f"{schema}.{name}") == {"value"}
    for name in ("probe_index", "probe_sequence"):
        assert not postgres_table_exists(connection, f"{schema}.{name}")
        assert postgres_table_columns(connection, f"{schema}.{name}") == set()


def test_app_roster_migration_ignores_other_schemas_columns(metadata_schemas, metadata_connection, monkeypatch):
    _, stores = metadata_schemas
    connection = metadata_connection
    connection.execute("ALTER TABLE match_participants DROP COLUMN champion")
    monkeypatch.setattr(app, "STORAGE", stores[0])
    assert app.migrate_match_participant_champions(connection, commit=False) == 0
    assert "champion" in postgres_table_columns(connection, "match_participants")


def test_real_startup_upgrades_only_resolved_legacy_schema(metadata_schemas, tmp_path, monkeypatch):
    _, stores = metadata_schemas
    target, unrelated = stores
    with closing(target.connect()) as connection:
        connection.execute("INSERT INTO match_participants(match_id,puuid,riot_id,team_id,win) VALUES('legacy','legacy-puuid','Legacy#EUW',100,1)")
        for column in ("champion", "participant_id", "normalized_riot_id"):
            connection.execute(f"ALTER TABLE match_participants DROP COLUMN {column}")
        connection.commit()
    with closing(unrelated.connect()) as connection:
        connection.execute("INSERT INTO source_metadata(key,value) VALUES('metadata_sentinel','unchanged')")
        connection.commit()
        unrelated_before = [dict(row) for row in connection.execute("SELECT * FROM source_metadata ORDER BY key")]
    monkeypatch.setattr(app, "STORAGE", target)
    monkeypatch.setattr(app, "DB_PATH", tmp_path / "unused.db")
    monkeypatch.setattr(app, "APP_ROOT", tmp_path)

    app.database(tmp_path, False)

    with closing(target.connect()) as connection:
        assert {"champion", "participant_id", "normalized_riot_id"} <= postgres_table_columns(connection, "match_participants")
        legacy = connection.execute("SELECT * FROM match_participants WHERE puuid='legacy-puuid'").fetchone()
        assert legacy["riot_id"] == "Legacy#EUW"
        assert legacy["normalized_riot_id"] == "legacy#euw"
        assert legacy["champion"] == "" and legacy["participant_id"] == 0
    with closing(unrelated.connect()) as connection:
        assert [dict(row) for row in connection.execute("SELECT * FROM source_metadata ORDER BY key")] == unrelated_before
        assert connection.execute("SELECT COUNT(*) count FROM match_participants").fetchone()["count"] == 0
