"""Batch writes use psycopg3's Cursor API, not a nonexistent Connection method."""
from unittest.mock import Mock
import pytest
from storage import PostgresConnection


def test_batch_uses_cursor_and_preserves_transaction_boundary():
    raw = Mock(spec=["cursor", "commit"])
    adapter = PostgresConnection(raw)
    params = [("match", 1, None), ("match", 2, 0)]
    cursor = adapter.executemany("INSERT INTO metric VALUES(?,?,?)", params)
    raw.cursor.assert_called_once_with()
    cursor.executemany.assert_called_once_with("INSERT INTO metric VALUES(%s,%s,%s)", params)
    raw.commit.assert_not_called()


def test_failed_batch_closes_cursor_and_propagates_error():
    raw = Mock(spec=["cursor"])
    raw.cursor.return_value.executemany.side_effect = ValueError("failed batch")
    with pytest.raises(ValueError, match="failed batch"):
        PostgresConnection(raw).executemany("INSERT INTO metric VALUES(?)", [(1,)])
    raw.cursor.return_value.close.assert_called_once_with()
