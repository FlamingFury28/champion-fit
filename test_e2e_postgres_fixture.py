"""Disposable E2E schema ownership survives force-stopped web servers."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import uuid
from pathlib import Path
from unittest.mock import Mock, patch

import pytest

from frontend.e2e import seed_and_serve as fixture


@pytest.fixture
def manifest(tmp_path, monkeypatch):
    path = tmp_path / "fixture-schema.json"
    monkeypatch.setenv(fixture.POSTGRES_MANIFEST_ENV, str(path))
    return path


@pytest.fixture
def postgres_dsn(monkeypatch):
    dsn = os.environ.get("CHAMPION_FIT_TEST_POSTGRES_DSN")
    if not dsn:
        pytest.skip("set CHAMPION_FIT_TEST_POSTGRES_DSN for isolated E2E PostgreSQL lifecycle tests")
    pytest.importorskip("psycopg")
    monkeypatch.setenv("CHAMPION_FIT_E2E_POSTGRES_DSN", dsn)
    return dsn


def _schema_exists(dsn, schema):
    import psycopg

    with psycopg.connect(dsn) as connection:
        return connection.execute(
            "SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname=%s)", (schema,),
        ).fetchone()[0]


def test_cleanup_without_manifest_does_not_require_database(manifest, monkeypatch):
    monkeypatch.delenv("CHAMPION_FIT_E2E_POSTGRES_DSN", raising=False)
    drop = Mock()
    monkeypatch.setattr(fixture, "_drop_fixture_schema", drop)
    assert fixture.cleanup_postgres_fixture() is False
    drop.assert_not_called()


@pytest.mark.parametrize("payload", [
    {"schema": "public"},
    {"schema": "champion_fit_e2e_" + "a" * 31},
    {"schema": "champion_fit_e2e_" + "a" * 32 + "; DROP SCHEMA public CASCADE"},
    {"schema": "champion_fit_e2e_" + "A" * 32},
    {"schema": ["champion_fit_e2e_" + "a" * 32]},
    {"schema": "champion_fit_e2e_" + "a" * 32, "dsn": "unexpected"},
    ["champion_fit_e2e_" + "a" * 32],
])
def test_cleanup_rejects_unowned_or_malformed_schema_before_database_access(manifest, payload, monkeypatch):
    manifest.write_text(json.dumps(payload), encoding="utf-8")
    drop = Mock()
    monkeypatch.setattr(fixture, "_drop_fixture_schema", drop)
    with pytest.raises(ValueError, match="manifest"):
        fixture.cleanup_postgres_fixture()
    drop.assert_not_called()
    assert manifest.exists()


def test_failed_cleanup_retains_manifest_for_retry(manifest, monkeypatch):
    manifest.write_text(json.dumps({"schema": "champion_fit_e2e_" + "a" * 32}), encoding="utf-8")
    monkeypatch.setenv("CHAMPION_FIT_E2E_POSTGRES_DSN", "test-dsn")
    monkeypatch.setattr(fixture, "_drop_fixture_schema", Mock(side_effect=RuntimeError("database unavailable")))
    with pytest.raises(RuntimeError, match="database unavailable"):
        fixture.cleanup_postgres_fixture()
    assert manifest.exists()


def test_sqlite_fixture_does_not_create_postgres_manifest(tmp_path, manifest, monkeypatch):
    monkeypatch.delenv("CHAMPION_FIT_E2E_POSTGRES_DSN", raising=False)
    with fixture.fixture_storage(tmp_path / "fixture.db") as storage:
        assert storage.engine == "sqlite"
    assert not manifest.exists()


def test_real_postgres_graceful_fixture_cleanup_removes_schema_and_manifest(tmp_path, manifest, postgres_dsn):
    with fixture.fixture_storage(tmp_path / "fixture.db") as storage:
        payload = json.loads(manifest.read_text(encoding="utf-8"))
        assert set(payload) == {"schema"}
        schema = payload["schema"]
        assert fixture.POSTGRES_SCHEMA_PATTERN.fullmatch(schema)
        assert _schema_exists(postgres_dsn, schema)
        connection = storage.connect()
        try:
            assert connection.execute("SELECT COUNT(*) AS n FROM match_quality").fetchone()["n"] == 6
        finally:
            connection.close()
    assert not _schema_exists(postgres_dsn, schema)
    assert not manifest.exists()
    assert fixture.cleanup_postgres_fixture() is False


def test_real_postgres_existing_schema_is_never_claimed_or_dropped(tmp_path, manifest, postgres_dsn):
    import psycopg
    from psycopg import sql

    identifier = uuid.uuid4()
    schema = f"champion_fit_e2e_{identifier.hex}"
    with psycopg.connect(postgres_dsn, autocommit=True) as admin:
        admin.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(schema)))
        admin.execute(sql.SQL("CREATE TABLE {}.sentinel(value TEXT)").format(sql.Identifier(schema)))
        admin.execute(sql.SQL("INSERT INTO {}.sentinel VALUES('preserve me')").format(sql.Identifier(schema)))
    try:
        with patch.object(fixture.uuid, "uuid4", return_value=identifier):
            with pytest.raises(psycopg.errors.DuplicateSchema):
                with fixture.fixture_storage(tmp_path / "fixture.db"):
                    pytest.fail("pre-existing schema must not become an E2E fixture")
        assert not manifest.exists()
        with psycopg.connect(postgres_dsn) as admin:
            assert admin.execute(sql.SQL("SELECT value FROM {}.sentinel").format(
                sql.Identifier(schema),
            )).fetchone()[0] == "preserve me"
    finally:
        with psycopg.connect(postgres_dsn, autocommit=True) as admin:
            admin.execute(sql.SQL("DROP SCHEMA {} CASCADE").format(sql.Identifier(schema)))


def test_real_postgres_existing_manifest_is_not_overwritten(tmp_path, manifest, postgres_dsn):
    original = {"schema": f"champion_fit_e2e_{uuid.uuid4().hex}"}
    manifest.write_text(json.dumps(original), encoding="utf-8")
    identifier = uuid.uuid4()
    with patch.object(fixture.uuid, "uuid4", return_value=identifier):
        with pytest.raises(FileExistsError):
            with fixture.fixture_storage(tmp_path / "fixture.db"):
                pytest.fail("an existing manifest must not be overwritten")
    assert json.loads(manifest.read_text(encoding="utf-8")) == original
    assert not _schema_exists(postgres_dsn, f"champion_fit_e2e_{identifier.hex}")


def test_real_postgres_force_stopped_server_is_cleaned_by_cli(tmp_path, manifest, postgres_dsn):
    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "index.html").write_text("<!doctype html><title>E2E lifecycle</title>", encoding="utf-8")
    environment = dict(os.environ, CHAMPION_FIT_E2E_DIST=str(dist), CHAMPION_FIT_E2E_PORT="0")
    script = Path(fixture.__file__).resolve()
    process = subprocess.Popen(
        [sys.executable, str(script)], env=environment, stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT, text=True,
    )
    ready = threading.Event()
    output = []

    def collect_output():
        for line in process.stdout:
            output.append(line)
            if line.startswith("Champion Fit E2E (postgres):"):
                ready.set()

    reader = threading.Thread(target=collect_output, daemon=True)
    reader.start()
    try:
        assert ready.wait(30), "".join(output)
        schema = json.loads(manifest.read_text(encoding="utf-8"))["schema"]
        process.kill()
        process.wait(timeout=15)
        assert manifest.exists()
        assert _schema_exists(postgres_dsn, schema)
        # Cleanup must work independently of the build and server startup.
        environment["CHAMPION_FIT_E2E_DIST"] = str(tmp_path / "missing-dist")
        cleanup = subprocess.run(
            [sys.executable, str(script), "--cleanup-postgres-fixture"],
            env=environment, capture_output=True, text=True, timeout=30,
        )
        assert cleanup.returncode == 0, cleanup.stdout + cleanup.stderr
        assert not manifest.exists()
        assert not _schema_exists(postgres_dsn, schema)
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=15)
        reader.join(timeout=5)
        process.stdout.close()
        if manifest.exists():
            fixture.cleanup_postgres_fixture()
