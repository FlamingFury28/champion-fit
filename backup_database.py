#!/usr/bin/env python3
"""Create and verify local SQLite backups without initializing the application.

The source is read-only; SQLite's backup API includes committed WAL data. A
verified, standalone copy is published with an atomic no-clobber hard link.
No network requests, schema migrations, restores, or source writes occur here.
"""

from __future__ import annotations

import argparse
import json
import math
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import time


DEFAULT_DATABASE = Path(__file__).resolve().with_name("champion_fit.db")
DEFAULT_TIMEOUT = 120.0


class BackupError(RuntimeError):
    """A backup or validation could not complete safely."""


def _local_path(value: str | Path) -> Path:
    # Reject connection strings before resolving or including paths in output.
    text = os.fspath(value)
    if not text:
        raise BackupError("Indica un percorso SQLite non vuoto.")
    if "://" in text or text.lower().startswith(("file:", "postgres:", "postgresql:")):
        raise BackupError("Sono supportati solo percorsi di file SQLite locali, non URL o DSN.")
    # Keep the final component intact so a dangling destination symlink is
    # still recognized as an existing user-owned path.
    return Path(os.path.abspath(Path(text).expanduser()))


def _deadline(timeout: float) -> float:
    if not math.isfinite(timeout) or timeout <= 0:
        raise BackupError("Il timeout deve essere un numero positivo e finito.")
    return time.monotonic() + timeout


def _check_deadline(deadline: float) -> None:
    if time.monotonic() >= deadline:
        raise BackupError("Tempo massimo superato; nessun backup incompleto è stato pubblicato.")


def _open_readonly(path: Path, deadline: float) -> sqlite3.Connection:
    if not path.is_file() or path.stat().st_size == 0:
        raise BackupError("Il database sorgente deve essere un file SQLite esistente e non vuoto.")
    _check_deadline(deadline)
    connection = sqlite3.connect(
        path.as_uri() + "?mode=ro", uri=True,
        timeout=max(0.001, deadline - time.monotonic()),
    )
    try:
        connection.set_progress_handler(lambda: int(time.monotonic() >= deadline), 10_000)
        connection.execute("PRAGMA query_only = ON")
    except Exception:
        connection.close()
        raise
    return connection


def _verify(path: Path, deadline: float) -> dict:
    connection = _open_readonly(path, deadline)
    try:
        # One read transaction keeps both checks on the same committed state.
        connection.execute("BEGIN")
        integrity = connection.execute("PRAGMA integrity_check").fetchall()
        if integrity != [("ok",)]:
            raise BackupError("Verifica integrità SQLite fallita; il file non è un backup verificato.")
        if connection.execute("PRAGMA foreign_key_check").fetchone() is not None:
            raise BackupError("Verifica riferimenti SQLite fallita; sono presenti chiavi esterne non valide.")
        _check_deadline(deadline)
        return {"database": str(path), "integrity_check": "ok", "foreign_key_check": "ok"}
    finally:
        connection.close()


def verify_database(database: str | Path, *, timeout: float = DEFAULT_TIMEOUT) -> dict:
    """Validate an existing SQLite database in a read-only, consistent snapshot."""
    path = _local_path(database)
    try:
        return _verify(path, _deadline(timeout))
    except sqlite3.Error as error:
        raise BackupError("Impossibile verificare il database SQLite (file non valido, bloccato o timeout).") from error
    except OSError as error:
        raise BackupError("Impossibile leggere il database SQLite; controlla percorso e permessi.") from error


def _destination_available(destination: Path) -> None:
    # An old sidecar can change the meaning of an otherwise valid main file.
    for candidate in (destination, *(Path(str(destination) + suffix) for suffix in ("-wal", "-shm", "-journal"))):
        if candidate.exists() or candidate.is_symlink():
            raise BackupError("La destinazione o un suo file ausiliario esiste già; scegli un nuovo percorso.")


def create_backup(
    source: str | Path, destination: str | Path, *, timeout: float = DEFAULT_TIMEOUT,
) -> dict:
    """Publish a checked backup, never replacing an existing destination file."""
    source_path = _local_path(source)
    destination_path = _local_path(destination)
    deadline = _deadline(timeout)
    if source_path == destination_path:
        raise BackupError("Sorgente e destinazione devono essere file diversi.")
    temporary: Path | None = None
    try:
        _destination_available(destination_path)
        if not destination_path.parent.is_dir():
            raise BackupError("La cartella di destinazione deve esistere prima del backup.")
        live = _open_readonly(source_path, deadline)
        try:
            descriptor, filename = tempfile.mkstemp(
                # .db stays excluded from Git/Docker even if a terminated
                # process leaves its private staging file behind.
                prefix=".champion-fit-backup-", suffix=".db", dir=destination_path.parent,
            )
            os.close(descriptor)
            temporary = Path(filename)
            snapshot = sqlite3.connect(temporary)
            try:
                live.backup(
                    snapshot, pages=128, sleep=0.05,
                    progress=lambda status, remaining, total: _check_deadline(deadline),
                )
                # A published backup must be portable as a single file, even
                # when its source currently has committed data in a WAL.
                if snapshot.execute("PRAGMA journal_mode = DELETE").fetchone()[0] != "delete":
                    raise BackupError("Impossibile rendere il backup un file SQLite autonomo.")
            finally:
                snapshot.close()
        finally:
            live.close()

        report = _verify(temporary, deadline)
        # Windows requires a writable descriptor for fsync; only our new
        # temporary copy is opened this way, never the source.
        with temporary.open("r+b") as handle:
            os.fsync(handle.fileno())
        size_bytes = temporary.stat().st_size
        _check_deadline(deadline)
        _destination_available(destination_path)
        # Unlike replace/rename on Unix, link fails if a competing writer has
        # claimed this exact destination since the preceding existence check.
        os.link(temporary, destination_path)
        return {**report, "database": str(destination_path), "source": str(source_path),
                "size_bytes": size_bytes}
    except FileExistsError as error:
        raise BackupError("La destinazione è stata creata da un altro processo; nessun file sovrascritto.") from error
    except sqlite3.Error as error:
        raise BackupError("Backup SQLite fallito (file non valido, bloccato o timeout); nessun backup pubblicato.") from error
    except OSError as error:
        raise BackupError("Backup non pubblicato: controlla spazio, permessi e supporto agli hard link della destinazione.") from error
    finally:
        if temporary is not None:
            for candidate in (temporary, *(Path(str(temporary) + suffix) for suffix in ("-wal", "-shm", "-journal"))):
                candidate.unlink(missing_ok=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Backup SQLite locale coerente e verificato, senza sovrascritture.")
    commands = parser.add_subparsers(dest="command", required=True)
    backup = commands.add_parser("backup", help="Crea una nuova copia verificata.")
    backup.add_argument("--source", help="File SQLite sorgente; default: champion_fit.db accanto allo script.")
    backup.add_argument("--output", required=True, help="Nuovo file di backup in una cartella esistente.")
    backup.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT, help="Tempo massimo in secondi (default: 120).")
    verify = commands.add_parser("verify", help="Verifica un file SQLite senza modificarne i dati.")
    verify.add_argument("--database", required=True, help="File SQLite da verificare.")
    verify.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT, help="Tempo massimo in secondi (default: 120).")
    args = parser.parse_args(argv)
    try:
        if args.command == "backup":
            if args.source is None and os.environ.get("CHAMPION_FIT_DATABASE_URL"):
                raise BackupError(
                    "L'app usa un database esterno: per PostgreSQL usa pg_dump. "
                    "Per una copia dello staging SQLite indica --source esplicitamente."
                )
            source = DEFAULT_DATABASE if args.source is None else args.source
            report = create_backup(source, args.output, timeout=args.timeout)
        else:
            report = verify_database(args.database, timeout=args.timeout)
    except BackupError as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        return 1
    print(json.dumps({"ok": True, **report}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
