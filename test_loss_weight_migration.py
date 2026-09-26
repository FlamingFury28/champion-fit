"""Persistence and failure-path tests for the legacy Riot weight migration."""

from contextlib import closing
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

from loss_weight_migration import (
    LEGACY_RIOT_REASON,
    MIGRATED_RIOT_REASON,
    migrate_riot_loss_weights,
    preview_riot_loss_weights,
)


class FailingConnection:
    """Inject failures while retaining the production connection interface."""

    def __init__(self, connection, failure):
        self.connection = connection
        self.failure = failure
        self.updates = 0

    def execute(self, sql, params=()):
        if sql.lstrip().startswith("UPDATE match_quality"):
            self.updates += 1
            if self.failure == "second_update" and self.updates == 2:
                raise RuntimeError("injected second update failure")
            if self.failure == "stale_preview" and self.updates == 2:
                self.connection.execute(
                    "UPDATE match_quality SET loss_attribution_weight=0.2 WHERE id=?",
                    (params[2],),
                )
            if self.failure == "ledger_edit" and self.updates == 2:
                self.connection.execute(
                    "UPDATE match_import_provenance SET classification='supplied_historical' WHERE match_id='M2'"
                )
            if self.failure == "ledger_insert" and self.updates == 2:
                self.connection.execute(
                    "INSERT INTO match_import_provenance VALUES('Account#EUW','M2','manual','supplied_historical','{}','now')"
                )
        if self.failure == "metadata" and sql.startswith("INSERT INTO source_metadata"):
            raise RuntimeError("injected metadata failure")
        return self.connection.execute(sql, params)

    def commit(self):
        if self.failure == "commit":
            raise RuntimeError("injected commit failure")
        return self.connection.commit()


class LossWeightMigrationTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.path = Path(self.directory.name) / "migration.db"
        self.connection = self.connect()
        self.connection.executescript("""
            CREATE TABLE match_quality (
                id INTEGER PRIMARY KEY, account TEXT, match_id TEXT, win INTEGER,
                duration_minutes REAL, loss_attribution_weight REAL,
                anomaly_flags TEXT, explicit_afk INTEGER,
                suspected_quasi_afk INTEGER, early_surrender INTEGER,
                identity_resolution TEXT, reason TEXT, win_evidence_weight REAL
            );
            CREATE TABLE source_metadata (key TEXT PRIMARY KEY, value TEXT);
        """)

    def tearDown(self):
        self.connection.close()
        self.directory.cleanup()

    def connect(self, readonly=False):
        connection = sqlite3.connect(
            self.path.as_uri() + "?mode=ro" if readonly else self.path,
            uri=readonly,
        )
        connection.row_factory = sqlite3.Row
        return connection

    def add(self, identifier, duration=30.0, weight=0.95, win=0,
            identity="riot_api", reason=LEGACY_RIOT_REASON,
            flags="none", explicit_afk=0, suspected=0, early=0):
        self.connection.execute(
            "INSERT INTO match_quality VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (identifier, "Account#EUW", f"M{identifier}", win, duration, weight,
             flags, explicit_afk, suspected, early, identity, reason, 0.95),
        )

    def snapshot(self):
        return (
            [dict(row) for row in self.connection.execute("SELECT * FROM match_quality ORDER BY id")],
            [dict(row) for row in self.connection.execute("SELECT * FROM source_metadata ORDER BY key")],
        )

    def create_ledger(self):
        self.connection.execute("""CREATE TABLE match_import_provenance (
            account TEXT,match_id TEXT,source TEXT,classification TEXT,
            overrides_json TEXT,recorded_at TEXT,PRIMARY KEY(account,match_id))""")

    def add_provenance(self, identifier, classification="known_riot_default", overrides=None):
        self.connection.execute(
            "INSERT INTO match_import_provenance VALUES(?,?,?,?,?,?)",
            ("Account#EUW", f"M{identifier}", "fixture", classification,
             json.dumps(overrides or {}), "now"),
        )

    def test_reconciles_rows_with_marker_already_current_and_preserves_other_sources(self):
        self.connection.execute(
            "INSERT INTO source_metadata VALUES('loss_weight_model_version','duration_bands_v2')"
        )
        self.add(1, duration=18, weight=0.45)
        self.add(2)
        self.add(3, duration=20)
        self.add(4, duration=9, weight=0.45)
        self.add(5, explicit_afk=1)
        self.add(6, win=1)
        self.add(7, weight=0.6)  # Explicit nonlegacy override.
        self.add(8, reason="Reviewed manually")  # Custom provenance.
        self.add(9, identity="strict_csv_signature")
        self.add(10, identity="puuid")
        self.add(11, reason=MIGRATED_RIOT_REASON)
        self.add(12, win=1, weight=0.0)  # No mutation, even to its reason.
        self.add(13, duration=18, weight=0.95)  # Wrong duration for legacy value.
        self.add(14, weight=0.9500001)  # Preserve even a nearby explicit value.
        self.connection.commit()
        untouched = self.snapshot()[0][6:]

        self.assertEqual(migrate_riot_loss_weights(self.connection), 6)
        rows, _ = self.snapshot()
        self.assertEqual([row["loss_attribution_weight"] for row in rows[:6]],
                         [0.15, 0.88, 0.35, 0.0, 0.0, 0.0])
        self.assertTrue(all(row["reason"] == MIGRATED_RIOT_REASON for row in rows[:6]))
        self.assertEqual(rows[6:], untouched)
        self.assertTrue(all(row["win_evidence_weight"] == 0.95 for row in rows))

    def test_preview_works_readonly_and_matches_committed_changes(self):
        self.add(1, duration=18, weight=0.45)
        self.add(2, suspected=1, early=1)
        self.connection.commit()
        original = self.snapshot()
        with closing(self.connect(readonly=True)) as readonly:
            readonly.execute("PRAGMA query_only=ON")
            preview = preview_riot_loss_weights(readonly)
        self.assertEqual([row["new_weight"] for row in preview], [0.15, 0.169])
        self.assertEqual(self.snapshot(), original)
        self.assertEqual(migrate_riot_loss_weights(self.connection), len(preview))
        actual = {row["id"]: row["loss_attribution_weight"] for row in self.snapshot()[0]}
        self.assertEqual(actual, {row["id"]: row["new_weight"] for row in preview})

    def test_reopen_idempotency_and_legacy_import_after_marker(self):
        self.add(1)
        self.connection.commit()
        self.assertEqual(migrate_riot_loss_weights(self.connection), 1)
        self.connection.close()
        self.connection = self.connect()
        settled = self.snapshot()
        self.assertEqual(migrate_riot_loss_weights(self.connection), 0)
        self.assertEqual(self.snapshot(), settled)
        self.add(2, duration=18, weight=0.45)
        self.connection.commit()
        self.connection.close()
        self.connection = self.connect()
        self.assertEqual(migrate_riot_loss_weights(self.connection), 1)
        self.assertEqual(self.snapshot()[0][1]["loss_attribution_weight"], 0.15)
        self.assertEqual(migrate_riot_loss_weights(self.connection), 0)

    def test_failure_rolls_back_weights_reasons_and_metadata_after_reopen(self):
        for failure in ("second_update", "metadata", "commit", "stale_preview"):
            with self.subTest(failure=failure):
                self.connection.execute("DELETE FROM match_quality")
                self.connection.execute("DELETE FROM source_metadata")
                self.add(1)
                self.add(2)
                self.connection.execute("INSERT INTO source_metadata VALUES('other','preserved')")
                self.connection.commit()
                original = self.snapshot()
                with self.assertRaises(RuntimeError):
                    migrate_riot_loss_weights(FailingConnection(self.connection, failure))
                self.assertEqual(self.snapshot(), original)
                self.connection.close()
                self.connection = self.connect()
                self.assertEqual(self.snapshot(), original)

    def test_failure_preserves_pending_caller_work(self):
        self.add(1)
        self.add(2)
        self.connection.commit()
        self.connection.execute("INSERT INTO source_metadata VALUES('pending','caller')")
        with self.assertRaisesRegex(RuntimeError, "second update"):
            migrate_riot_loss_weights(FailingConnection(self.connection, "second_update"))
        self.assertEqual(self.connection.execute(
            "SELECT value FROM source_metadata WHERE key='pending'"
        ).fetchone()["value"], "caller")
        self.assertEqual([row["loss_attribution_weight"] for row in self.snapshot()[0]], [0.95, 0.95])
        self.connection.rollback()
        self.assertIsNone(self.connection.execute(
            "SELECT value FROM source_metadata WHERE key='pending'"
        ).fetchone())

    def test_ledger_preserves_explicit_and_unknown_legacy_shaped_weights(self):
        self.create_ledger()
        for identifier in range(1, 8):
            self.add(identifier)
        self.add_provenance(1)
        self.add_provenance(2, "supplied_historical", {"loss_attribution_weight": 0.95})
        self.add_provenance(3, "unknown", {"loss_attribution_weight": 0.95})
        # Row 4 has no provenance record, even though the table exists.
        self.add_provenance(5, overrides={"loss_attribution_weight": 0.95})
        self.add_provenance(6, overrides={"reason": LEGACY_RIOT_REASON})
        self.add_provenance(7, overrides={"explicit_afk": 1})  # Contradicts the row.
        self.connection.commit()
        original = {row["id"]: row for row in self.snapshot()[0]}
        self.assertEqual([row["id"] for row in preview_riot_loss_weights(self.connection)], [1, 4])
        self.assertEqual(migrate_riot_loss_weights(self.connection), 2)
        rows = {row["id"]: row for row in self.snapshot()[0]}
        for identifier in (2, 3, 5, 6, 7):
            self.assertEqual(rows[identifier], original[identifier])

    def test_stale_ledger_edit_or_new_record_rolls_back_migration(self):
        self.create_ledger()
        for failure in ("ledger_edit", "ledger_insert"):
            with self.subTest(failure=failure):
                self.connection.execute("DELETE FROM match_quality")
                self.connection.execute("DELETE FROM match_import_provenance")
                self.add(1)
                self.add(2)
                self.add_provenance(1)
                if failure == "ledger_edit":
                    self.add_provenance(2)
                self.connection.commit()
                original = self.snapshot()
                ledger = [dict(row) for row in self.connection.execute("SELECT * FROM match_import_provenance ORDER BY match_id")]
                with self.assertRaisesRegex(RuntimeError, "changed during migration"):
                    migrate_riot_loss_weights(FailingConnection(self.connection, failure))
                self.connection.close()
                self.connection = self.connect()
                self.assertEqual(self.snapshot(), original)
                self.assertEqual([dict(row) for row in self.connection.execute("SELECT * FROM match_import_provenance ORDER BY match_id")], ledger)

    def test_derived_replay_and_reopen_do_not_reintroduce_migrated_or_explicit_weights(self):
        from ingest import apply_import_provenance, normalized_match

        self.create_ledger()
        self.add(1, explicit_afk=1)
        self.add(2)
        self.add_provenance(1, overrides={"explicit_afk": 1})
        self.add_provenance(2, "supplied_historical", {
            "loss_attribution_weight": 0.95, "reason": LEGACY_RIOT_REASON,
        })
        self.connection.commit()
        self.assertEqual(migrate_riot_loss_weights(self.connection), 1)
        for identifier in (1, 2):
            # The actual Riot producer leaves win/loss numeric weights absent.
            raw = dict(account="Account#EUW", match_id=f"M{identifier}",
                       duration_minutes=30, win=False, reason=MIGRATED_RIOT_REASON)
            row = normalized_match(apply_import_provenance(self.connection, raw, "riot_api", derived=True))
            self.connection.execute(
                "UPDATE match_quality SET explicit_afk=?,loss_attribution_weight=?,reason=? WHERE id=?",
                (row[10], row[15], row[17], identifier),
            )
        self.connection.commit()
        self.connection.close()
        self.connection = self.connect()
        self.assertEqual(migrate_riot_loss_weights(self.connection), 0)
        rows = self.snapshot()[0]
        self.assertEqual((rows[0]["loss_attribution_weight"], rows[0]["reason"]), (0.0, MIGRATED_RIOT_REASON))
        self.assertEqual((rows[1]["loss_attribution_weight"], rows[1]["reason"]), (0.95, LEGACY_RIOT_REASON))


if __name__ == "__main__":
    unittest.main()
