"""Resumable local-raw metric backfill. Never downloads matches or runs app startup.

Examples: --copy-from champion_fit.db --db outputs/playstyles-copy.db --verify-preserved
          --db outputs/playstyles-copy.db --max-batches 2
Each completed batch and its checkpoint commit together. A completed job is rescanned
on the next invocation to detect corrected/new historical payloads, skipping unchanged facts.
"""
from __future__ import annotations

import argparse
from contextlib import closing
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import tempfile

from playstyle_metrics import EXTRACTOR_VERSION, ensure_schema, materialize_detail


def _rollback(connection):
    (connection.raw if hasattr(connection, "raw") else connection).rollback()


def backfill(connection, *, batch_size=100, max_batches=None, job_name="local_raw", restart=False,
             before_commit=None) -> dict:
    """Owns batch transactions. before_commit is an optional test/progress hook; raising rolls back that batch."""
    if batch_size < 1 or (max_batches is not None and max_batches < 1):
        raise ValueError("Batch sizes and limits must be positive")
    ensure_schema(connection)
    state = connection.execute("SELECT * FROM playstyle_backfill_checkpoints WHERE job_name=?", (job_name,)).fetchone()
    resume = state and not restart and state["state"] == "running" and state["extractor_version"] == EXTRACTOR_VERSION
    cursor, processed = (state["last_match_id"], state["processed_matches"]) if resume else ("", 0)
    batches = scanned = changed = 0
    statuses = {}
    while True:
        try:
            rows = connection.execute(
                "SELECT match_id,payload_json FROM riot_match_raw WHERE match_id>? ORDER BY match_id LIMIT ?",
                (cursor, batch_size),
            ).fetchall()
            for row in rows:
                try:
                    detail = json.loads(row["payload_json"])
                    result = materialize_detail(connection, row["match_id"], detail)
                except (json.JSONDecodeError, UnicodeDecodeError):
                    fingerprint = hashlib.sha256(str(row["payload_json"]).encode()).hexdigest()
                    result = materialize_detail(connection, row["match_id"], None, fingerprint=fingerprint)
                changed += int(result["changed"])
                statuses[result["status"]] = statuses.get(result["status"], 0) + 1
            scanned += len(rows)
            processed += len(rows)
            cursor = rows[-1]["match_id"] if rows else cursor
            complete = len(rows) < batch_size
            connection.execute(
                """INSERT INTO playstyle_backfill_checkpoints VALUES(?,?,?,?,?,?)
                ON CONFLICT(job_name) DO UPDATE SET extractor_version=excluded.extractor_version,
                last_match_id=excluded.last_match_id,processed_matches=excluded.processed_matches,
                state=excluded.state,updated_at=excluded.updated_at""",
                (job_name, EXTRACTOR_VERSION, cursor, processed, "complete" if complete else "running",
                 datetime.now(timezone.utc).isoformat()),
            )
            if before_commit:
                before_commit(batches + 1, cursor)
            connection.commit()
        except BaseException:
            _rollback(connection)
            raise
        batches += 1
        if complete or (max_batches is not None and batches >= max_batches):
            return {"extractor_version": EXTRACTOR_VERSION, "scanned": scanned, "changed": changed,
                    "processed_matches": processed, "last_match_id": cursor, "complete": complete,
                    "batches": batches, "statuses": statuses}


def backup_sqlite(source: Path, target: Path):
    source, target = source.resolve(strict=True), target.resolve()
    if source == target or target.exists():
        raise ValueError("Backup target must be a new file distinct from the source")
    target.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{target.name}.", suffix=".tmp", dir=target.parent)
    temporary = Path(temporary_name)
    try:
        os.close(descriptor)
        with closing(sqlite3.connect(source.as_uri() + "?mode=ro", uri=True)) as original:
            original.execute("PRAGMA query_only=ON")
            with closing(sqlite3.connect(temporary)) as copy:
                original.backup(copy)
        try:
            os.link(temporary, target)
        except FileExistsError as exc:
            raise ValueError("Backup target must be a new file distinct from the source") from exc
    finally:
        temporary.unlink(missing_ok=True)


def protected_snapshot(connection) -> dict:
    """Reconcile complete raw payloads, observations and annotations, not just row counts."""
    result = {}
    for table, order in (("riot_match_raw", "match_id"), ("match_quality", "account,match_id"),
                         ("match_annotations", "match_id")):
        digest, count = hashlib.sha256(), 0
        for row in connection.execute(f"SELECT * FROM {table} ORDER BY {order}"):
            digest.update(json.dumps(dict(row), sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode())
            digest.update(b"\n")
            count += 1
        result[table] = {"rows": count, "sha256": digest.hexdigest()}
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    targets = parser.add_mutually_exclusive_group(required=True)
    targets.add_argument("--db", type=Path)
    targets.add_argument("--database-url")
    parser.add_argument("--copy-from", type=Path)
    parser.add_argument("--batch-size", type=int, default=100)
    parser.add_argument("--max-batches", type=int)
    parser.add_argument("--restart", action="store_true")
    parser.add_argument("--verify-preserved", action="store_true")
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    if args.copy_from:
        if not args.db:
            parser.error("--copy-from requires a new SQLite --db target")
        backup_sqlite(args.copy_from, args.db)
    from storage import build_storage
    storage = build_storage(args.db or Path("unused.db"), Path(__file__).with_name("schema.sql"), args.database_url)
    connection = storage.connect()
    try:
        before = protected_snapshot(connection) if args.verify_preserved else None
        result = backfill(connection, batch_size=args.batch_size, max_batches=args.max_batches, restart=args.restart)
        if before is not None:
            after = protected_snapshot(connection)
            result.update(protected_before=before, protected_after=after, protected_preserved=before == after)
            if before != after:
                raise RuntimeError("Protected source tables changed during backfill")
        if args.report:
            args.report.parent.mkdir(parents=True, exist_ok=True)
            args.report.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(json.dumps(result, ensure_ascii=True, indent=2))
    finally:
        connection.close()


if __name__ == "__main__":
    main()
