import sqlite3

import app
from storage import SQLiteStorage


def test_initialization_reconciles_legacy_orphans_without_removing_valid_aliases(tmp_path):
    storage = SQLiteStorage(tmp_path / "legacy.db", app.SCHEMA_PATH)
    storage.initialize()
    # Simulate a database written by the old connections with foreign keys off.
    with sqlite3.connect(storage.path) as connection:
        connection.execute("INSERT INTO friend_groups(id,name) VALUES(1,'Existing')")
        connection.executemany(
            "INSERT INTO friend_group_aliases(group_id,alias) VALUES(?,?)",
            [(1, "Valid#EUW"), (99, "Deleted#EUW")],
        )

    storage.initialize()
    storage.initialize()
    connection = storage.connect()
    try:
        assert [tuple(row) for row in connection.execute(
            "SELECT group_id,alias FROM friend_group_aliases"
        )] == [(1, "Valid#EUW")]
        assert connection.execute("PRAGMA foreign_key_check").fetchall() == []
    finally:
        connection.close()
