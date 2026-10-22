"""Opt-in API contracts on real PostgreSQL, isolated from operational data.

Set CHAMPION_FIT_TEST_POSTGRES_DSN to a disposable test database. Every run
migrates a synthetic SQLite fixture into a unique schema and drops that schema
even if an API assertion fails.
"""
from __future__ import annotations

import json
import os
import uuid
from contextlib import closing

import pytest

import app
from algorithm_settings import ensure_settings, get_settings_snapshot
from frontend.e2e.seed_and_serve import seed
from migrate_postgres import migrate
from storage import PostgresStorage


AS_OF = "2026-09-24T12:00:00Z"
ACCOUNT = "Alpha#EUW"


@pytest.fixture(scope="module")
def postgres_api_fixture(tmp_path_factory):
    base_dsn = os.environ.get("CHAMPION_FIT_TEST_POSTGRES_DSN")
    if not base_dsn:
        pytest.skip("set CHAMPION_FIT_TEST_POSTGRES_DSN to run real PostgreSQL API tests")
    psycopg = pytest.importorskip("psycopg")
    from psycopg import sql
    from psycopg.conninfo import make_conninfo

    root = tmp_path_factory.mktemp("postgres-api")
    source = seed(root / "fixture.db")
    with closing(source.connect()) as connection:
        ensure_settings(connection)
        settings = get_settings_snapshot(connection)
    schema = f"champion_fit_api_test_{uuid.uuid4().hex}"
    with psycopg.connect(base_dsn, autocommit=True) as admin:
        assert admin.info.server_version >= 160000, "API tests require PostgreSQL 16 or later"
        admin.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(schema)))
    try:
        scoped_dsn = make_conninfo(base_dsn, options=f"-c search_path={schema}")
        storage = PostgresStorage(scoped_dsn, app.SCHEMA_PATH)
        storage.initialize()
        counts = migrate(root / "fixture.db", scoped_dsn)
        assert counts["match_quality"] == 6
        assert counts["match_participants"] == 19
        yield root, storage, settings
    finally:
        with psycopg.connect(base_dsn, autocommit=True) as admin:
            admin.execute(sql.SQL("DROP SCHEMA {} CASCADE").format(sql.Identifier(schema)))


@pytest.fixture
def query_postgres(postgres_api_fixture, monkeypatch):
    root, storage, settings = postgres_api_fixture
    monkeypatch.setattr(app, "STORAGE", storage)
    monkeypatch.setattr(app, "DB_PATH", root / "fixture.db")
    monkeypatch.setattr(app, "APP_ROOT", root)

    def query(path, **params):
        arguments = {"account": ACCOUNT, "queue": "all", "role": "ALL", "days": "all", "as_of": AS_OF}
        arguments.update(params)
        arguments = {key: value if isinstance(value, list) else [str(value)] for key, value in arguments.items()}
        status, payload = app.query_database(path, arguments)
        assert status == 200, payload
        # Use the handler's numeric serialization for PostgreSQL aggregates.
        json.dumps(payload, default=float, allow_nan=False)
        if path in app.ANALYTICAL_ENDPOINTS:
            assert payload["algorithm_revision"] == settings["revision"]
            assert payload["algorithm_fingerprint"] == settings["fingerprint"]
        return payload

    return query


def test_real_postgres_profile_preserves_scoped_totals_and_annotations(query_postgres):
    profile = query_postgres("/api/profile")
    assert profile["accounts"] == [ACCOUNT]
    assert profile["summary"]["games"] == 4
    assert profile["summary"]["wins"] == 3
    assert profile["summary"]["losses"] == 1
    assert profile["summary"]["win_rate"] == 75.0
    assert profile["summary"]["afk_games"] == 1
    assert {row["champion"]: row["games"] for row in profile["champions"]} == {"Ahri": 3, "Lux": 1}
    assert sum(row["games"] for row in profile["weekdays"]) == 4
    assert len(profile["recent"]) == 4


def test_real_postgres_champion_matrix_and_training_plan_share_model_and_scope(query_postgres):
    matrix = query_postgres("/api/champions", role="MIDDLE")
    plan = query_postgres("/api/training-plan", role="MIDDLE", budget=20)
    assert [(item["champion"], item["unique_games"]) for item in matrix["items"]] == [("Ahri", 3)]
    assert matrix["model"]["model_version"] == plan["model"]["model_version"]
    assert matrix["context"] == plan["context"]
    assert plan["budget_total"] == plan["budget_assigned"] == 20
    assert sum(item["allocation_games"] for item in plan["items"]) == 20


@pytest.mark.parametrize("endpoint", ["/api/matchups", "/api/synergy"])
def test_real_postgres_encounters_keep_scope_and_source_coverage(query_postgres, endpoint):
    encounters = query_postgres(endpoint)
    assert encounters["context"]["accounts"] == [ACCOUNT]
    assert encounters["context"]["observations"] == 4
    assert encounters["family_size"] > 0
    assert encounters["games"] == 4
    if endpoint == "/api/matchups":
        assert encounters["games_with_opponents"] == 4
        assert {row["champion"] for row in encounters["beats"] + encounters["loses_to"]} == {"Annie", "Zed"}
    else:
        assert encounters["coverage"]["analyzed_games"] == 4
        # The Lux support match has no distinct allied champion: its synthetic
        # teammate also played Lux and is excluded from champion comparisons.
        assert encounters["games_with_teammates"] == 3
        assert {row["champion"] for row in encounters["exploratory"]} == {"Lux", "Garen"}


def test_real_postgres_friends_returns_other_profile_without_own_account(query_postgres):
    friends = query_postgres("/api/friends", min_shared_games=1)
    assert friends["items"]
    assert ACCOUNT not in {row["friend"] for row in friends["items"]}
    assert any(row["friend"] == "Beta#EUW" and row["shared_games"] == 1 for row in friends["items"])


def test_real_postgres_playstyles_and_preferences_use_observed_history(query_postgres):
    styles = query_postgres("/api/playstyles")
    recommendations = query_postgres("/api/recommendations", role="MIDDLE")
    assert styles["summary"]["unique_games"] == 4
    assert styles["summary"]["metrics_games"] == 0
    assert len(styles["categories"]) == 14
    assert [(row["champion"], row["games"]) for row in recommendations["known"]] == [("Ahri", 3)]
    assert recommendations["discover"]
    assert "Ahri" not in {row["champion"] for row in recommendations["discover"]}


def test_real_postgres_revision_contract_rejects_stale_analysis(query_postgres):
    snapshot = query_postgres("/api/algorithm-settings")
    status, payload = app.query_database("/api/profile", {"algorithm_revision": [str(snapshot["revision"] + 1)]})
    assert status == 409
    assert payload["algorithm_revision"] == snapshot["revision"]
    assert payload["error"]


def test_real_postgres_explicit_empty_queue_scope_is_not_broadened(query_postgres):
    matrix = query_postgres("/api/champions", role="MIDDLE", queue="440")
    plan = query_postgres("/api/training-plan", role="MIDDLE", queue="440", budget=20)
    assert matrix["items"] == plan["items"] == []
    assert matrix["context"]["observations"] == plan["context"]["observations"] == 0
    assert matrix["context"]["queue"] == plan["context"]["queue"] == "440"
    assert plan["budget_assigned"] == 0
    assert plan["budget_unassigned"] == 20


def test_real_postgres_unknown_account_cannot_inherit_existing_profile(query_postgres):
    profile = query_postgres("/api/profile", account="Missing#EUW")
    assert profile["accounts"] == ["Missing#EUW"]
    assert profile["summary"]["games"] == 0
    assert profile["summary"]["wins"] == 0
    assert profile["recent"] == profile["champions"] == []


def test_real_postgres_api_requests_leave_migrated_facts_unchanged(query_postgres, postgres_api_fixture):
    _, storage, _ = postgres_api_fixture
    def facts():
        with closing(storage.connect()) as connection:
            return {
                table: [dict(row) for row in connection.execute(f"SELECT * FROM {table} ORDER BY 1,2")]
                for table in ("match_quality", "match_annotations", "match_participants", "source_metadata")
            }
    before = facts()
    for endpoint in ("/api/profile", "/api/champions", "/api/playstyles", "/api/recommendations"):
        query_postgres(endpoint)
    assert facts() == before
