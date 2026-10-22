"""Synchronization diagnostics use isolated databases and fake Riot responses."""
import json
import sys
from urllib.parse import unquote

import pytest

import app
import check_new_matches
import riot_sync
from sync_runs import SyncRun, recent_runs
from storage import SQLiteStorage
from test_ingestion_recovery import complete_detail


@pytest.fixture
def sync_storage(tmp_path):
    db = tmp_path / "sync.db"
    riot_sync.initialize_ingestion_database(db)
    return SQLiteStorage(db, app.SCHEMA_PATH)


def read(storage, sql, params=()):
    connection = storage.connect()
    try:
        return [dict(row) for row in connection.execute(sql, params)]
    finally:
        connection.close()


def fake_provider(path, _key):
    if path.startswith("/riot/account/"):
        name = unquote(path.split("/by-riot-id/")[1].split("/")[0])
        if name == "Missing":
            raise riot_sync.RiotAPIError("private player missing", path, 404)
        return {"puuid": "p1", "gameName": name, "tagLine": "EUW"}
    if "/ids?" in path:
        return ["M1"]
    return complete_detail()


def invoke_incremental(monkeypatch, storage, accounts):
    arguments = ["check_new_matches.py", "--db", str(storage.path), "--api-keys", "secret-key"]
    for account in accounts:
        arguments.extend(["--account", account])
    monkeypatch.setattr(sys, "argv", arguments)
    check_new_matches.main()


@pytest.mark.parametrize("operation", ["incremental", "historical"])
def test_success_commits_account_outcome_with_facts(sync_storage, monkeypatch, operation):
    target = "check_new_matches._riot_get_limited" if operation == "incremental" else "riot_sync.riot_get"
    monkeypatch.setattr(target, fake_provider)
    if operation == "incremental":
        result = check_new_matches.check_account("Player#EUW", "secret-key", sync_storage.path)
    else:
        result = riot_sync.sync("secret-key", sync_storage.path, ("Player#EUW",))
    run = read(sync_storage, "SELECT * FROM riot_sync_runs")[0]
    account = read(sync_storage, "SELECT * FROM riot_sync_run_accounts")[0]
    assert run["operation"] == operation
    assert run["status"] == account["status"] == "completed"
    assert run["requested_accounts"] == run["completed_accounts"] == 1
    assert run["finished_at"] and account["started_at"] and account["finished_at"]
    assert json.loads(run["counts_json"])["inserted"] == result["inserted"] == 1
    assert account["resolved_account"] == "Player#EUW"
    assert len(read(sync_storage, "SELECT * FROM match_quality")) == 1
    assert read(sync_storage, "SELECT value FROM source_metadata WHERE key='last_sync_at'")
    assert not list(sync_storage.path.parent.glob("*.active.json"))


@pytest.mark.parametrize("operation", ["incremental", "historical"])
def test_unresolved_account_is_persisted_as_partial_run(sync_storage, monkeypatch, operation):
    target = "check_new_matches._riot_get_limited" if operation == "incremental" else "riot_sync.riot_get"
    monkeypatch.setattr(target, fake_provider)
    accounts = ("Player#EUW", "Missing#EUW")
    if operation == "incremental":
        invoke_incremental(monkeypatch, sync_storage, accounts)
    else:
        riot_sync.sync("secret-key", sync_storage.path, accounts)
    run = read(sync_storage, "SELECT * FROM riot_sync_runs")[0]
    outcomes = read(sync_storage, "SELECT * FROM riot_sync_run_accounts ORDER BY requested_account")
    assert run["status"] == "partial"
    assert (run["requested_accounts"], run["completed_accounts"], run["failed_accounts"]) == (2, 1, 1)
    assert [(item["requested_account"], item["status"], item["error_code"]) for item in outcomes] == [
        ("Missing#EUW", "failed", "riot_http_404"), ("Player#EUW", "completed", ""),
    ]
    assert json.loads(run["counts_json"])["inserted"] == 1
    assert len(read(sync_storage, "SELECT * FROM match_quality")) == 1


@pytest.mark.parametrize("operation", ["incremental", "historical"])
def test_rollback_does_not_leave_a_successful_account_outcome(sync_storage, monkeypatch, operation):
    target = "check_new_matches._riot_get_limited" if operation == "incremental" else "riot_sync.riot_get"
    monkeypatch.setattr(target, fake_provider)
    record_result = SyncRun.record_result

    def failure_after_result(self, connection, account, result, **kwargs):
        record_result(self, connection, account, result, **kwargs)
        raise RuntimeError("injected failure after outcome write, private secret-key")

    monkeypatch.setattr(SyncRun, "record_result", failure_after_result)
    with pytest.raises(RuntimeError, match="injected failure"):
        if operation == "incremental":
            check_new_matches.check_account("Player#EUW", "secret-key", sync_storage.path)
        else:
            riot_sync.sync("secret-key", sync_storage.path, ("Player#EUW",))
    run = read(sync_storage, "SELECT * FROM riot_sync_runs")[0]
    account = read(sync_storage, "SELECT * FROM riot_sync_run_accounts")[0]
    assert run["status"] == account["status"] == "failed"
    assert run["completed_accounts"] == 0 and run["failed_accounts"] == 1
    assert json.loads(run["counts_json"]) == json.loads(account["counts_json"]) == {}
    for table in ("match_quality", "riot_match_raw", "riot_match_list_raw", "match_participants"):
        assert read(sync_storage, f"SELECT * FROM {table}") == []
    assert not list(sync_storage.path.parent.glob("*.active.json"))


@pytest.mark.parametrize("operation", ["incremental", "historical"])
def test_keyboard_interrupt_is_durable_without_fabricated_completion(sync_storage, monkeypatch, operation):
    def interrupted(*_args):
        raise KeyboardInterrupt()
    target = "check_new_matches._riot_get_limited" if operation == "incremental" else "riot_sync.riot_get"
    monkeypatch.setattr(target, interrupted)
    with pytest.raises(KeyboardInterrupt):
        if operation == "incremental":
            check_new_matches.check_account("Player#EUW", "secret-key", sync_storage.path)
        else:
            riot_sync.sync("secret-key", sync_storage.path, ("Player#EUW",))
    run = read(sync_storage, "SELECT * FROM riot_sync_runs")[0]
    account = read(sync_storage, "SELECT * FROM riot_sync_run_accounts")[0]
    assert run["status"] == account["status"] == "interrupted"
    assert run["error_code"] == account["error_code"] == "interrupted"
    assert run["interrupted_accounts"] == 1 and run["completed_accounts"] == 0
    assert not list(sync_storage.path.parent.glob("*.active.json"))


def test_incremental_duplicate_arguments_are_checked_once(sync_storage, monkeypatch):
    monkeypatch.setattr("check_new_matches._riot_get_limited", fake_provider)
    invoke_incremental(monkeypatch, sync_storage, ("Player#EUW", "  PLAYER#euw  ", "Player#EUW"))
    assert read(sync_storage, "SELECT requested_accounts,completed_accounts FROM riot_sync_runs") == [
        {"requested_accounts": 1, "completed_accounts": 1},
    ]


def seed_raw(storage, *, invalid=False):
    connection = storage.connect()
    try:
        detail = complete_detail()
        if invalid:
            detail["info"]["participants"].pop()
        connection.execute("INSERT INTO riot_match_list_raw VALUES(?,?,?,?)", ("Player#EUW", "p1", "now", '["M1"]'))
        connection.execute("INSERT INTO riot_match_raw VALUES(?,?,?,?)", ("M1", "europe", "now", json.dumps(detail)))
        connection.commit()
    finally:
        connection.close()


def test_reprocess_registers_incomplete_payload_without_losing_raw(sync_storage):
    seed_raw(sync_storage, invalid=True)
    result = riot_sync.reprocess_raw_matches(sync_storage.path)
    assert result["inserted"] == 0
    run = read(sync_storage, "SELECT * FROM riot_sync_runs")[0]
    assert run["operation"] == "reprocess" and run["status"] == "partial"
    assert run["partial_accounts"] == 1
    assert json.loads(run["counts_json"])["invalid_payload"] == 1
    assert len(read(sync_storage, "SELECT * FROM riot_match_raw")) == 1


def test_reprocess_journal_success_rolls_back_with_the_atomic_rebuild(sync_storage, monkeypatch):
    seed_raw(sync_storage)
    record_result = SyncRun.record_result

    def failure_after_result(self, connection, account, result, **kwargs):
        record_result(self, connection, account, result, **kwargs)
        raise RuntimeError("failed after ledger update")
    monkeypatch.setattr(SyncRun, "record_result", failure_after_result)
    with pytest.raises(RuntimeError):
        riot_sync.reprocess_raw_matches(sync_storage.path)
    run = read(sync_storage, "SELECT * FROM riot_sync_runs")[0]
    assert run["status"] == "failed" and run["completed_accounts"] == 0
    assert read(sync_storage, "SELECT status FROM riot_sync_run_accounts") == [{"status": "failed"}]
    assert read(sync_storage, "SELECT * FROM match_quality") == []
    assert len(read(sync_storage, "SELECT * FROM riot_match_raw")) == 1


def test_pending_and_running_ledger_survive_restart_without_claiming_success(sync_storage):
    # Simulate process loss by deliberately omitting the context-manager exit.
    run = SyncRun(sync_storage, "incremental", ["Private#EUW", "Another#EUW"]).__enter__()
    run.begin_account("Private#EUW")
    connection = sync_storage.connect()
    try:
        run.record_result(connection, "Private#EUW", {"inserted": 3, "account": "Private#EUW"})
        connection.commit()
    finally:
        connection.close()
    sync_storage.initialize()  # idempotent startup never erases or completes an old run
    connection = sync_storage.connect()
    try:
        diagnostics = recent_runs(connection)
    finally:
        connection.close()
    assert diagnostics[0]["status"] == "running" and diagnostics[0]["finished_at"] is None
    assert diagnostics[0]["counts"] == {"inserted": 3}
    assert diagnostics[0]["completed_accounts"] == 1
    assert "Private#EUW" not in json.dumps(diagnostics) and "Another#EUW" not in json.dumps(diagnostics)
    assert read(sync_storage, "SELECT status FROM riot_sync_run_accounts ORDER BY requested_account") == [
        {"status": "pending"}, {"status": "completed"},
    ]


def test_sync_metrics_are_correlated_and_never_expose_accounts_or_keys(sync_storage, monkeypatch, caplog):
    monkeypatch.setattr("check_new_matches._riot_get_limited", fake_provider)
    invoke_incremental(monkeypatch, sync_storage, ["Player#EUW"])
    run_id = read(sync_storage, "SELECT run_id FROM riot_sync_runs")[0]["run_id"]
    metrics = [json.loads(record.message) for record in caplog.records if record.name == "champion_fit.backend"]
    assert {item["operation"] for item in metrics} >= {"sync.incremental", "sync.incremental.account"}
    assert all(item["run_id"] == run_id for item in metrics)
    assert "Player#EUW" not in caplog.text and "secret-key" not in caplog.text
