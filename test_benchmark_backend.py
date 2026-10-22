import hashlib
import json

import pytest

import app
from benchmark_backend import _fixture, benchmark, main
from storage import SQLiteStorage


def test_synthetic_benchmark_measures_cold_and_warm_work_without_exposing_rows():
    original = (app.STORAGE, app.DB_PATH, app.APP_ROOT)
    report = benchmark(repetitions=2)
    assert (app.STORAGE, app.DB_PATH, app.APP_ROOT) == original
    assert report["status"] == "completed"
    assert report["dataset"] == {"accounts": 2, "observations": 72, "unique_matches": 72}
    for endpoint, timing in report["endpoints"].items():
        assert timing["cold"]["status"] == 200
        assert timing["cold"]["metrics"]["sql_calls"] > 0
        assert timing["cold"]["metrics"]["model_fit_calls"] == 1
        assert timing["cold"]["metrics"]["model_fit_ms"] >= 0
        assert 0 <= timing["warm"]["p50_ms"] <= timing["warm"]["p95_ms"]
        for sample in timing["warm"]["samples"]:
            assert sample["metrics"]["model_cache_hit"] == 1
            assert "model_fit_calls" not in sample["metrics"]
            if endpoint == "/api/training-plan":
                assert sample["metrics"]["plan_cache_hit"] == 1
                assert sample["counts"]["budget_assigned"] == 20
    encoded = json.dumps(report)
    assert "benchmark-0" not in encoded
    assert "Ahri" not in encoded
    assert "match_id" not in encoded


def test_snapshot_copy_preserves_the_source_database_and_restores_globals(tmp_path):
    source = tmp_path / "private-source.db"
    storage = SQLiteStorage(source, app.SCHEMA_PATH)
    storage.initialize()
    _fixture(storage)
    with storage.connect() as connection:
        connection.execute("UPDATE match_quality SET account='private-puuid-account'")
    before = hashlib.sha256(source.read_bytes()).hexdigest()
    original = (app.STORAGE, app.DB_PATH, app.APP_ROOT)
    report = benchmark(source, repetitions=1)
    assert report["status"] == "completed"
    assert hashlib.sha256(source.read_bytes()).hexdigest() == before
    assert (app.STORAGE, app.DB_PATH, app.APP_ROOT) == original
    encoded = json.dumps(report)
    assert report["protocol"]["source"] == "snapshot_copy"
    assert "private-puuid" not in encoded
    assert str(source) not in encoded


def test_failed_query_is_redacted_and_global_state_is_restored(monkeypatch):
    original = (app.STORAGE, app.DB_PATH, app.APP_ROOT)
    def fail(*_args):
        raise RuntimeError("postgresql://user:private-password@host/private-puuid")
    monkeypatch.setattr(app, "query_database", fail)
    report = benchmark(repetitions=1)
    assert report["status"] == "failed"
    assert (app.STORAGE, app.DB_PATH, app.APP_ROOT) == original
    for timing in report["endpoints"].values():
        assert timing["cold"]["status"] == 500
        assert timing["cold"]["error_code"] == "RuntimeError"
    assert "private-" not in json.dumps(report)


def test_cli_outputs_json_and_writes_the_same_report(tmp_path, capsys):
    output = tmp_path / "outputs" / "report.json"
    assert main(["--repetitions", "1", "--output", str(output)]) == 0
    assert json.loads(capsys.readouterr().out) == json.loads(output.read_text(encoding="utf-8"))


def test_cli_report_cannot_overwrite_the_source_database(tmp_path, capsys):
    source = tmp_path / "source.db"
    storage = SQLiteStorage(source, app.SCHEMA_PATH)
    storage.initialize()
    _fixture(storage)
    original = source.read_bytes()
    assert main(["--db", str(source), "--output", str(source), "--repetitions", "1"]) == 1
    assert source.read_bytes() == original
    assert json.loads(capsys.readouterr().out)["output_error_code"] == "ValueError"


@pytest.mark.parametrize("suffix", ("", "-wal", "-shm", "-journal"))
def test_synthetic_cli_cannot_overwrite_the_operational_database_or_sidecars(tmp_path, capsys, monkeypatch, suffix):
    source = tmp_path / "operational.db"
    output = tmp_path / f"operational.db{suffix}"
    source.write_bytes(b"untouched operational database")
    if suffix:
        output.write_bytes(b"untouched SQLite sidecar")
    original = output.read_bytes()
    monkeypatch.setattr(app, "DB_PATH", source)
    assert main(["--output", str(output), "--repetitions", "1"]) == 1
    assert output.read_bytes() == original
    assert source.read_bytes() == b"untouched operational database"
    assert json.loads(capsys.readouterr().out)["output_error_code"] == "ValueError"
