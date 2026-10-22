"""Durable synchronization journal; committed account results share fact transactions.

Live process markers remain the liveness authority. A killed process can leave
a running journal entry, which deliberately never claims successful completion.
Only numeric counters and stable error codes are exposed by ``recent_runs``;
account labels stay in the local account ledger, never in diagnostic logs.
"""
from __future__ import annotations

from collections import Counter
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import datetime, timezone
from heapq import nlargest
import json
import os
from uuid import uuid4

from analysis_runtime import parse_time
from runtime_metrics import log_failure, record_metric


_CURRENT_RUN: ContextVar[SyncRun | None] = ContextVar("riot_sync_run", default=None)
_COUNTERS = frozenset({
    "inserted", "updated", "skipped", "removed_stale", "identity_edges_persisted",
    "fetched_matches", "new_ids", "recent_ids", "retried_raw", "pending_details",
    "raw_known", "raw_available", "raw_missing", "attempted", "eligible",
    "identity_unresolved", "invalid_payload", "normalized_rows", "playstyle_metrics_changed",
})
_INCOMPLETE_COUNTERS = {"pending_details", "raw_missing", "identity_unresolved", "invalid_payload"}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _counters(values) -> dict[str, int]:
    return {key: int(value) for key, value in values.items()
            if key in _COUNTERS and type(value) is int and value >= 0}


def error_code(error: BaseException) -> str:
    if isinstance(error, (KeyboardInterrupt, SystemExit)):
        return "interrupted"
    status = getattr(error, "status_code", None)
    if type(status) is int and 100 <= status <= 599:
        return f"riot_http_{status}"
    if type(error).__name__ == "AccountIdentityConflict":
        return "identity_conflict"
    # Messages can contain account names, URLs or credentials. Never retain them.
    return type(error).__name__


def current_run() -> SyncRun | None:
    return _CURRENT_RUN.get()


class SyncRun:
    def __init__(self, storage, operation: str, accounts, *, run_id: str | None = None):
        if operation not in {"historical", "incremental", "reprocess"}:
            raise ValueError("Unsupported synchronization operation")
        self.storage = storage
        self.operation = operation
        self.accounts = tuple(dict.fromkeys(str(account).strip() for account in accounts if str(account).strip()))
        self.run_id = run_id or uuid4().hex

    def __enter__(self):
        connection = self.storage.connect()
        try:
            connection.execute(
                "INSERT INTO riot_sync_runs(run_id,operation,status,started_at,pid,requested_accounts) "
                "VALUES(?,?,'running',?,?,?)",
                (self.run_id, self.operation, _now(), os.getpid(), len(self.accounts)),
            )
            connection.executemany(
                "INSERT INTO riot_sync_run_accounts(run_id,requested_account,status) VALUES(?,?,'pending')",
                [(self.run_id, account) for account in self.accounts],
            )
            connection.commit()
        finally:
            connection.close()
        return self

    def __exit__(self, _error_type, error, _traceback):
        try:
            self.finish(error)
        except Exception as journal_error:
            if error is None:
                raise
            # Preserve the original failure if the database itself is unavailable.
            log_failure(journal_error, mode=self.operation)
        return False

    def begin_account(self, account: str):
        connection = self.storage.connect()
        try:
            connection.execute(
                "UPDATE riot_sync_run_accounts SET status='running',started_at=? "
                "WHERE run_id=? AND requested_account=? AND status='pending'",
                (_now(), self.run_id, account),
            )
            connection.commit()
        finally:
            connection.close()

    @contextmanager
    def account_attempt(self, account: str):
        self.begin_account(account)
        token = _CURRENT_RUN.set(self)
        try:
            yield
        except BaseException as error:
            try:
                self.fail_account(account, error)
            except Exception as journal_error:
                log_failure(journal_error, mode=self.operation)
            raise
        finally:
            _CURRENT_RUN.reset(token)

    def record_result(self, connection, account: str, result, *, resolved_account: str = ""):
        """Write through the caller's transaction; never commit facts independently."""
        counters = _counters(result)
        status = "partial" if any(counters.get(key, 0) for key in _INCOMPLETE_COUNTERS) else "completed"
        changed = connection.execute(
            "UPDATE riot_sync_run_accounts SET resolved_account=?,status=?,started_at=COALESCE(started_at,?),"
            "finished_at=?,counts_json=?,error_code='' "
            "WHERE run_id=? AND requested_account=? AND status IN ('pending','running')",
            (resolved_account or account, status, _now(), _now(), json.dumps(counters, sort_keys=True), self.run_id, account),
        )
        if changed.rowcount:
            self._update_totals(connection)

    def replace_pending_accounts(self, connection, accounts):
        """Bind an atomic local rebuild to names reconciled in that same transaction."""
        accounts = tuple(dict.fromkeys(accounts))
        connection.execute("DELETE FROM riot_sync_run_accounts WHERE run_id=? AND status='pending'", (self.run_id,))
        connection.executemany(
            "INSERT INTO riot_sync_run_accounts(run_id,requested_account,status,started_at) VALUES(?,?,'running',?)",
            [(self.run_id, account, _now()) for account in accounts],
        )
        connection.execute("UPDATE riot_sync_runs SET requested_accounts=? WHERE run_id=?", (len(accounts), self.run_id))

    def complete_account(self, account: str, result, *, resolved_account: str = ""):
        """Fallback for producers without a fact transaction (and command adapters)."""
        connection = self.storage.connect()
        try:
            self.record_result(connection, account, result, resolved_account=resolved_account)
            connection.commit()
        finally:
            connection.close()

    def fail_account(self, account: str, error: BaseException):
        connection = self.storage.connect()
        try:
            connection.execute(
                "UPDATE riot_sync_run_accounts SET status=?,finished_at=?,error_code=? "
                "WHERE run_id=? AND requested_account=? AND status IN ('pending','running')",
                ("interrupted" if isinstance(error, (KeyboardInterrupt, SystemExit)) else "failed",
                 _now(), error_code(error), self.run_id, account),
            )
            self._update_totals(connection)
            connection.commit()
        finally:
            connection.close()

    def finish(self, error: BaseException | None = None):
        connection = self.storage.connect()
        try:
            interrupted = isinstance(error, (KeyboardInterrupt, SystemExit))
            connection.execute(
                "UPDATE riot_sync_run_accounts SET status=?,finished_at=?,error_code=? "
                "WHERE run_id=? AND status IN ('pending','running')",
                ("interrupted" if interrupted else "failed", _now(),
                 error_code(error) if error else "not_completed", self.run_id),
            )
            states, counts = self._update_totals(connection)
            committed = states["completed"] + states["partial"]
            incomplete = states["partial"] + states["failed"] + states["interrupted"]
            status = (
                "interrupted" if interrupted else
                "partial" if committed and (error is not None or incomplete) else
                "failed" if error is not None or incomplete else "completed"
            )
            connection.execute(
                "UPDATE riot_sync_runs SET status=?,finished_at=?,completed_accounts=?,partial_accounts=?,"
                "failed_accounts=?,interrupted_accounts=?,counts_json=?,error_code=? WHERE run_id=? AND status='running'",
                (status, _now(), states["completed"], states["partial"], states["failed"], states["interrupted"],
                 json.dumps(dict(counts), sort_keys=True), error_code(error) if error else "", self.run_id),
            )
            connection.commit()
            record_metric(f"sync.runs.{status}")
            for key in ("completed", "partial", "failed", "interrupted"):
                record_metric(f"sync.accounts.{key}", states[key])
        finally:
            connection.close()

    def _update_totals(self, connection):
        accounts = list(connection.execute(
            "SELECT status,counts_json FROM riot_sync_run_accounts WHERE run_id=?", (self.run_id,),
        ))
        states = Counter(row["status"] for row in accounts)
        counts = Counter()
        for row in accounts:
            counts.update(_counters(json.loads(row["counts_json"])))
        connection.execute(
            "UPDATE riot_sync_runs SET completed_accounts=?,partial_accounts=?,failed_accounts=?,"
            "interrupted_accounts=?,counts_json=? WHERE run_id=? AND status='running'",
            (states["completed"], states["partial"], states["failed"], states["interrupted"],
             json.dumps(dict(counts), sort_keys=True), self.run_id),
        )
        return states, counts


def recent_runs(connection, limit: int = 5) -> list[dict]:
    """Return bounded aggregate diagnostics without account labels or exception text."""
    maximum = max(1, min(int(limit), 50))
    rows = connection.execute("SELECT run_id,started_at FROM riot_sync_runs")
    minimum_time = datetime.min.replace(tzinfo=timezone.utc)

    def time_key(row):
        instant = parse_time(row["started_at"])
        # Preserve malformed legacy diagnostics, after every valid timestamp.
        return instant is not None, instant or minimum_time, row["run_id"]

    # PostgreSQL buffers each result set. Scan only the small ordering keys;
    # counters and diagnostic text are fetched for the chosen records alone.
    selected = [row["run_id"] for row in nlargest(maximum, rows, key=time_key)]
    if not selected:
        return []
    details = connection.execute(
        "SELECT run_id,operation,status,started_at,finished_at,requested_accounts,completed_accounts,"
        "partial_accounts,failed_accounts,interrupted_accounts,counts_json,error_code "
        f"FROM riot_sync_runs WHERE run_id IN ({','.join('?' for _ in selected)})", selected,
    )
    by_id = {row["run_id"]: dict(row) for row in details}
    results = []
    for run_id in selected:
        # A concurrent journal cleanup can remove a selected run between reads.
        if run_id not in by_id:
            continue
        result = by_id[run_id]
        result["counts"] = _counters(json.loads(result.pop("counts_json")))
        results.append(result)
    return results
