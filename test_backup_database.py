"""Backups must be coherent, independently usable and never overwrite data."""
import json
from pathlib import Path
import sqlite3

import pytest

import backup_database
from backup_database import BackupError, create_backup, verify_database


def _fixture(path: Path) -> None:
    connection = sqlite3.connect(path)
    try:
        connection.executescript("""
            PRAGMA foreign_keys = ON;
            CREATE TABLE matches(id INTEGER PRIMARY KEY);
            CREATE TABLE annotations(id INTEGER PRIMARY KEY, match_id INTEGER REFERENCES matches(id), note TEXT);
            INSERT INTO matches VALUES(1);
            INSERT INTO annotations VALUES(1,1,'Scelta esplicita: caffè ☕');
        """)
    finally:
        connection.close()


def test_backup_is_independent_and_preserves_annotations(tmp_path):
    source, target = tmp_path / "source.db", tmp_path / "backup.db"
    _fixture(source)
    before = source.read_bytes()
    report = create_backup(source, target)
    assert report["database"] == str(target)
    assert report["size_bytes"] == target.stat().st_size
    assert report["integrity_check"] == report["foreign_key_check"] == "ok"
    assert source.read_bytes() == before
    source.unlink()
    with sqlite3.connect(target) as restored:
        assert restored.execute("SELECT note FROM annotations").fetchone() == ("Scelta esplicita: caffè ☕",)
    assert verify_database(target)["integrity_check"] == "ok"
    assert list(tmp_path.glob(".champion-fit-backup-*")) == []


def test_backup_includes_committed_wal_but_excludes_uncommitted_writes(tmp_path):
    source, target = tmp_path / "source.db", tmp_path / "backup.db"
    _fixture(source)
    writer = sqlite3.connect(source)
    try:
        assert writer.execute("PRAGMA journal_mode = WAL").fetchone() == ("wal",)
        writer.execute("PRAGMA wal_autocheckpoint = 0")
        writer.execute("INSERT INTO matches VALUES(2)")
        writer.commit()
        assert Path(str(source) + "-wal").stat().st_size > 0
        writer.execute("INSERT INTO matches VALUES(3)")
        create_backup(source, target)
        with sqlite3.connect(target) as restored:
            assert restored.execute("SELECT id FROM matches ORDER BY id").fetchall() == [(1,), (2,)]
            assert restored.execute("PRAGMA journal_mode").fetchone() == ("delete",)
        assert not Path(str(target) + "-wal").exists()
        assert not Path(str(target) + "-shm").exists()
    finally:
        writer.close()


def test_existing_destination_and_source_cannot_be_replaced(tmp_path):
    source, target = tmp_path / "source.db", tmp_path / "backup.db"
    _fixture(source)
    target.write_bytes(b"user-owned file")
    before = source.read_bytes()
    with pytest.raises(BackupError):
        create_backup(source, target)
    with pytest.raises(BackupError):
        create_backup(source, source)
    assert target.read_bytes() == b"user-owned file"
    assert source.read_bytes() == before


@pytest.mark.parametrize("suffix", ["-wal", "-shm", "-journal"])
def test_stale_destination_sidecars_are_preserved_and_rejected(tmp_path, suffix):
    source, target = tmp_path / "source.db", tmp_path / "backup.db"
    _fixture(source)
    sidecar = Path(str(target) + suffix)
    sidecar.write_bytes(b"existing sidecar")
    with pytest.raises(BackupError):
        create_backup(source, target)
    assert sidecar.read_bytes() == b"existing sidecar"
    assert not target.exists()


def test_destination_created_during_publish_is_not_overwritten(tmp_path, monkeypatch):
    source, target = tmp_path / "source.db", tmp_path / "backup.db"
    _fixture(source)
    real_link = backup_database.os.link

    def concurrent_link(staging, destination):
        Path(destination).write_bytes(b"concurrent writer")
        return real_link(staging, destination)

    monkeypatch.setattr(backup_database.os, "link", concurrent_link)
    with pytest.raises(BackupError, match="altro processo"):
        create_backup(source, target)
    assert target.read_bytes() == b"concurrent writer"
    assert list(tmp_path.glob(".champion-fit-backup-*")) == []


def test_invalid_foreign_keys_are_not_published_or_silently_repaired(tmp_path):
    source, target = tmp_path / "source.db", tmp_path / "backup.db"
    _fixture(source)
    with sqlite3.connect(source) as connection:
        connection.execute("INSERT INTO annotations VALUES(2,99,'Keep evidence')")
    before = source.read_bytes()
    with pytest.raises(BackupError, match="chiavi esterne"):
        create_backup(source, target)
    with pytest.raises(BackupError, match="chiavi esterne"):
        verify_database(source)
    assert source.read_bytes() == before
    assert not target.exists()
    assert list(tmp_path.glob(".champion-fit-backup-*")) == []


def test_integrity_violations_are_not_published(tmp_path):
    source, target = tmp_path / "source.db", tmp_path / "backup.db"
    _fixture(source)
    with sqlite3.connect(source) as connection:
        connection.executescript("""
            CREATE TABLE scores(value INTEGER);
            INSERT INTO scores VALUES(1);
            CREATE INDEX scores_index ON scores(value);
            PRAGMA writable_schema = ON;
            UPDATE sqlite_master SET sql='CREATE INDEX scores_index ON scores(-value)'
            WHERE name='scores_index';
        """)
    with pytest.raises(BackupError, match="integrità"):
        create_backup(source, target)
    assert not target.exists()
    assert list(tmp_path.glob(".champion-fit-backup-*")) == []


def test_dangling_destination_symlink_is_not_followed(tmp_path):
    source, target, other = tmp_path / "source.db", tmp_path / "backup.db", tmp_path / "other.db"
    _fixture(source)
    try:
        target.symlink_to(other)
    except OSError:
        pytest.skip("Creating symlinks requires additional Windows privileges")
    with pytest.raises(BackupError):
        create_backup(source, target)
    assert target.is_symlink()
    assert not other.exists()


@pytest.mark.parametrize("content", [None, b"", b"not a database"])
def test_missing_empty_and_corrupt_sources_do_not_create_a_backup(tmp_path, content):
    source, target = tmp_path / "source.db", tmp_path / "backup.db"
    if content is not None:
        source.write_bytes(content)
    with pytest.raises(BackupError):
        create_backup(source, target)
    with pytest.raises(BackupError):
        verify_database(source)
    assert not target.exists()
    assert source.exists() is (content is not None)
    assert list(tmp_path.glob(".champion-fit-backup-*")) == []


def test_locked_source_times_out_and_cleans_staging_file(tmp_path):
    source, target = tmp_path / "source.db", tmp_path / "backup.db"
    _fixture(source)
    writer = sqlite3.connect(source)
    try:
        writer.execute("BEGIN EXCLUSIVE")
        with pytest.raises(BackupError, match="Tempo massimo"):
            create_backup(source, target, timeout=0.05)
        assert not target.exists()
        assert list(tmp_path.glob(".champion-fit-backup-*")) == []
    finally:
        writer.close()


def test_publish_failure_does_not_leave_a_partial_backup(tmp_path, monkeypatch):
    source, target = tmp_path / "source.db", tmp_path / "backup.db"
    _fixture(source)

    def unsupported_link(*args):
        raise OSError("hard links unsupported")

    monkeypatch.setattr(backup_database.os, "link", unsupported_link)
    with pytest.raises(BackupError, match="hard link"):
        create_backup(source, target)
    assert not target.exists()
    assert list(tmp_path.glob(".champion-fit-backup-*")) == []


@pytest.mark.parametrize("timeout", [0, -1, float("inf"), float("nan")])
def test_invalid_timeout_is_rejected(tmp_path, timeout):
    with pytest.raises(BackupError, match="timeout"):
        create_backup(tmp_path / "source.db", tmp_path / "backup.db", timeout=timeout)


def test_cli_produces_machine_readable_verification(tmp_path, capsys):
    source, target = tmp_path / "source.db", tmp_path / "backup.db"
    _fixture(source)
    assert backup_database.main(["backup", "--source", str(source), "--output", str(target)]) == 0
    assert json.loads(capsys.readouterr().out)["ok"] is True
    assert backup_database.main(["verify", "--database", str(target)]) == 0
    report = json.loads(capsys.readouterr().out)
    assert report["ok"] is True
    assert report["integrity_check"] == "ok"


def test_postgres_config_does_not_back_up_stale_sqlite_or_disclose_credentials(tmp_path, monkeypatch, capsys):
    secret = "postgresql://someone:private-password@db.example/champion_fit"
    monkeypatch.setenv("CHAMPION_FIT_DATABASE_URL", secret)
    target = tmp_path / "backup.db"
    assert backup_database.main(["backup", "--output", str(target)]) == 1
    error = capsys.readouterr().err
    assert "pg_dump" in error
    assert secret not in error and "private-password" not in error
    assert not target.exists()


def test_empty_explicit_source_never_falls_back_to_the_default(tmp_path, monkeypatch, capsys):
    source, target = tmp_path / "source.db", tmp_path / "backup.db"
    _fixture(source)
    monkeypatch.setattr(backup_database, "DEFAULT_DATABASE", source)
    assert backup_database.main(["backup", "--source", "", "--output", str(target)]) == 1
    assert json.loads(capsys.readouterr().err)["ok"] is False
    assert not target.exists()


@pytest.mark.parametrize("command", ["backup", "verify"])
def test_cli_rejects_connection_strings_without_echoing_them(tmp_path, capsys, command):
    secret = "postgresql://someone:private-password@db.example/champion_fit"
    args = ["backup", "--source", secret, "--output", str(tmp_path / "backup.db")] if command == "backup" else ["verify", "--database", secret]
    assert backup_database.main(args) == 1
    output = capsys.readouterr()
    assert "private-password" not in output.out + output.err
    assert json.loads(output.err)["ok"] is False
