"""Queue policy regressions use only an isolated in-memory database."""

from contextlib import closing
import sqlite3

import pytest

import app
from queue_rules import is_supported_queue


@pytest.mark.parametrize(
    "queue",
    [
        "Swiftplay", " swiftplay ", "Clash", " cLaSh ",
        480, "480", "Queue 480", 700, "700", "Queue 700",
        "Quickplay", "Draft Pick", "Blind Pick", "Ranked Solo/Duo", "Ranked Flex",
    ],
)
def test_supported_queue_names_and_ids(queue):
    assert is_supported_queue(queue)


@pytest.mark.parametrize(
    "queue",
    [
        None, "", "unknown", "ARAM", "ARAM Clash", 720, "Queue 720",
        "URF", 900, "Queue 900", "Co-op vs AI", 830, "Queue 830",
        "Clash ARAM", "Swiftplay Bots",
    ],
)
def test_unsupported_modes_remain_excluded(queue):
    assert not is_supported_queue(queue)


def test_startup_purge_preserves_named_supported_matches_and_related_data():
    matches = [
        ("swiftplay", "Swiftplay"),
        ("clash", "Clash"),
        ("ranked", "420"),
        ("aram-clash", "ARAM Clash"),
        ("urf", "900"),
        ("bots", "830"),
    ]
    with closing(sqlite3.connect(":memory:")) as connection:
        connection.row_factory = sqlite3.Row
        connection.executescript(app.SCHEMA_PATH.read_text(encoding="utf-8"))
        connection.execute("INSERT INTO champions VALUES('Ahri', 'Ahri', '/Ahri.png')")
        connection.executemany(
            """INSERT INTO match_quality
            (account, match_id, date, patch, queue, champion, role, identity_resolution,
             duration_minutes, win, explicit_afk, suspected_quasi_afk, early_surrender,
             anomaly_flags, match_quality_score, loss_attribution_weight,
             win_evidence_weight, reason)
            VALUES ('test', ?, '2026-10-15', '16.20', ?, 'Ahri', 'MIDDLE', 'test',
                    30, 1, 0, 0, 0, 'none', 1, 0, 1, 'isolated queue fixture')""",
            matches,
        )
        connection.executemany(
            "INSERT INTO match_annotations(match_id, note, updated_at) VALUES(?, 'keep', '2026-10-15')",
            [(match_id,) for match_id, _ in matches],
        )
        connection.executemany(
            "INSERT INTO match_participants(match_id, puuid, riot_id) VALUES(?, 'test-puuid', 'Test#EUW')",
            [(match_id,) for match_id, _ in matches],
        )
        connection.commit()

        assert app.purge_urf_matches(connection) == 3
        for table in ("match_quality", "match_annotations", "match_participants"):
            remaining = {row[0] for row in connection.execute(f"SELECT match_id FROM {table}")}
            assert remaining == {"swiftplay", "clash", "ranked"}
        assert app.purge_urf_matches(connection) == 0
