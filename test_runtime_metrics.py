import json
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

import pytest

import app
from runtime_metrics import log_failure, measure, metrics_scope, record_metric
from storage import PostgresConnection, SQLiteStorage


def test_metric_scopes_are_isolated_across_workers_and_do_not_log_labels_or_sql(tmp_path, caplog):
    storage = SQLiteStorage(tmp_path / "metrics.db", app.SCHEMA_PATH)
    storage.initialize()
    barrier = Barrier(2)

    def worker(count):
        connection = storage.connect()
        try:
            with metrics_scope("test", request_id=str(count), account="private-account") as metrics:
                barrier.wait(timeout=5)
                for _ in range(count):
                    connection.execute("SELECT ?", ("private-bind",)).fetchone()
                record_metric("observations", count)
                return dict(metrics)
        finally:
            connection.close()

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(worker, (1, 3)))
    assert [item["sql_calls"] for item in results] == [1, 3]
    assert [item["observations"] for item in results] == [1, 3]
    assert all(item["sql_ms"] >= 0 for item in results)
    assert "private-account" not in caplog.text
    assert "private-bind" not in caplog.text
    assert "SELECT" not in caplog.text


def test_failed_stages_are_timed_and_scope_is_restored(caplog):
    with pytest.raises(RuntimeError):
        with metrics_scope("test", request_id="failed"):
            with measure("model_fit"):
                raise RuntimeError("private-error-secret")
    records = [json.loads(record.message) for record in caplog.records]
    assert records[-1]["outcome"] == "failed"
    assert records[-1]["metrics"]["model_fit_calls"] == 1
    assert records[-1]["metrics"]["model_fit_ms"] >= 0
    record_metric("outside", 1)
    with metrics_scope("next") as metrics:
        assert metrics == {}
    assert "private-error-secret" not in caplog.text


def test_error_diagnostics_redact_driver_messages_and_unknown_labels(caplog):
    try:
        raise RuntimeError("postgresql://user:password@host private-puuid")
    except RuntimeError as error:
        log_failure(error, endpoint="/api/champions", account="private-account")
    payload = json.loads(caplog.records[-1].message)
    assert payload["exception_type"] == "RuntimeError"
    assert payload["stack"][-1]["function"] == "test_error_diagnostics_redact_driver_messages_and_unknown_labels"
    assert "password" not in caplog.text
    assert "private-" not in caplog.text


def test_postgres_sql_timings_preserve_bindings_and_cursor_api():
    class Cursor:
        def executemany(self, query, params):
            self.bindings = (query, params)
        def close(self):
            pass

    class Raw:
        def execute(self, query, params=()):
            return (query, params)
        def cursor(self):
            return Cursor()

    connection = PostgresConnection(Raw())
    with metrics_scope("postgres") as metrics:
        assert connection.execute("SELECT ?", (1,)) == ("SELECT %s", (1,))
        cursor = connection.executemany("SELECT ?", [(2,), (3,)])
        assert cursor.bindings == ("SELECT %s", [(2,), (3,)])
        assert metrics["sql_calls"] == 2
