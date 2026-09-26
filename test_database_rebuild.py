"""The rebuild lifecycle must discard provenance and ownership of the old data."""
import csv
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import app
from account_identity import canonical_account_name
from ingest import ingest_rows
from storage import SQLiteStorage


class DatabaseRebuildTests(unittest.TestCase):
    def test_invalid_json_does_not_replace_the_existing_database(self):
        for invalid_file in ("champion_fit.json", "accounts.json"):
            with self.subTest(invalid_file=invalid_file), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                database = root / "rebuild.db"
                source = root / "source"
                source.mkdir()
                storage = SQLiteStorage(database, app.SCHEMA_PATH)
                storage.initialize()
                connection = storage.connect()
                try:
                    connection.execute(
                        "INSERT INTO champions(champion,asset_id,icon_url) VALUES('Lux','Lux','')"
                    )
                    connection.execute(
                        """INSERT INTO match_quality
                           (account,match_id,date,patch,queue,champion,role,identity_resolution,
                            duration_minutes,win,explicit_afk,suspected_quasi_afk,early_surrender,
                            anomaly_flags,match_quality_score,loss_attribution_weight,win_evidence_weight,reason)
                           VALUES('Existing#EUW','old-match','2026-01-01','test','420','Lux','MIDDLE',
                                  'test',30,1,0,0,0,'none',1,0,1,'preserve me')"""
                    )
                    connection.commit()
                finally:
                    connection.close()

                for filename in (
                    "champion_fit.csv", "next_400_games.csv", "blacklist.csv",
                    "new_champions_to_screen.csv", "match_quality.csv",
                ):
                    (source / filename).write_text("champion\n", encoding="utf-8")
                (source / "champion_fit.json").write_text("{}", encoding="utf-8")
                (source / "accounts.json").write_text("{}", encoding="utf-8")
                (source / invalid_file).write_text("{not valid json", encoding="utf-8")

                with patch.object(app, "DB_PATH", database), patch.object(app, "STORAGE", storage):
                    with self.assertRaises(json.JSONDecodeError):
                        app.database(source, rebuild=True)

                fresh = storage.connect()
                try:
                    row = fresh.execute(
                        "SELECT match_id,reason FROM match_quality"
                    ).fetchone()
                    self.assertEqual(dict(row), {"match_id": "old-match", "reason": "preserve me"})
                finally:
                    fresh.close()

    def test_rebuild_replaces_legacy_provenance_and_identity_on_fresh_reopen(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            database = root / "rebuild.db"
            source = root / "source"
            source.mkdir()
            storage = SQLiteStorage(database, app.SCHEMA_PATH)
            storage.initialize()
            account, match_id = "Existing#EUW", "REUSED_MATCH_KEY"
            connection = storage.connect()
            try:
                ingest_rows(connection, [{
                    "account": account, "match_id": match_id, "date": "2025-01-01",
                    "patch": "15.1", "queue": "420", "champion": "Lux", "role": "MIDDLE", "win": False,
                    "duration_minutes": 10, "loss_attribution_weight": 0.2,
                    "reason": "Override belonging to the old dataset",
                }], "old_export")
                connection.execute("INSERT INTO riot_account_identities VALUES('old-owner',?)", (account,))
                connection.execute("INSERT INTO riot_identity_puuids VALUES('old-owner','old-owner')")
                connection.execute("INSERT INTO riot_identity_puuids VALUES('old-history','old-owner')")
                connection.execute("INSERT INTO riot_identity_policy VALUES(?,?,?,?,?,?,?,?)",
                                   ('old-history', 'old-owner', 'assumed', '', 'manual_assumption', 'Old dataset', '2025', '[]'))
                connection.execute("INSERT INTO riot_accounts_raw VALUES(?,?,?,?,?,?)",
                                   ("old-owner", account, "Existing", "EUW", "2025", "{}"))
                connection.execute("INSERT INTO riot_match_list_raw VALUES(?,?,?,?)",
                                   (account, "old-owner", "2025", json.dumps([match_id])))
                connection.execute("INSERT INTO riot_match_raw VALUES(?,?,?,?)", (match_id, "europe", "2025", "{}"))
                connection.execute("INSERT INTO riot_account_aliases VALUES(?,?,?,?,?,?)",
                                   (account, "old alias#euw", "Old Alias#EUW", "old-owner", "riot_account_v1", "2025"))
                connection.execute("INSERT INTO tracked_account_puuids VALUES('old-history',?)", (account,))
                connection.commit()
                for table in ("match_import_provenance", "riot_identity_policy", "riot_identity_puuids", "riot_account_identities"):
                    self.assertGreater(connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0], 0)
            finally:
                connection.close()

            # Reuse the logical account/match key with a replacement dataset:
            # old scoring inputs must not attach themselves to the new facts.
            replacement = {
                "account": account, "match_id": match_id, "date": "2026-09-08T10:00:00Z",
                "patch": "16.17", "queue": "420", "champion": "Vi", "role": "JUNGLE",
                "identity_resolution": "strict_csv_signature", "duration_minutes": 30,
                "win": 0, "explicit_afk": 0, "suspected_quasi_afk": 0, "early_surrender": 0,
                "anomaly_flags": "none", "match_quality_score": 0.95,
                "loss_attribution_weight": 0.8, "win_evidence_weight": 0,
                "reason": "Independent replacement dataset",
            }
            with (source / "match_quality.csv").open("w", encoding="utf-8", newline="") as handle:
                writer = csv.DictWriter(handle, fieldnames=list(replacement))
                writer.writeheader()
                writer.writerow(replacement)
            for filename in ("champion_fit.csv", "next_400_games.csv", "blacklist.csv", "new_champions_to_screen.csv"):
                (source / filename).write_text("champion\n", encoding="utf-8")
            (source / "champion_fit.json").write_text(json.dumps({"scope": "replacement"}), encoding="utf-8")
            (source / "accounts.json").write_text(json.dumps({account: {"puuid": "new-owner"}}), encoding="utf-8")

            with patch.object(app, "DB_PATH", database), patch.object(app, "STORAGE", storage):
                app.database(source, rebuild=True)

            # A separate connection verifies both committed persistence and FK
            # ordering, rather than observing pending changes in the rebuild.
            fresh = SQLiteStorage(database, app.SCHEMA_PATH).connect()
            try:
                self.assertEqual(fresh.execute("PRAGMA foreign_keys").fetchone()[0], 1)
                self.assertEqual(fresh.execute("PRAGMA foreign_key_check").fetchall(), [])
                for table in ("match_import_provenance", "riot_identity_policy", "riot_identity_puuids", "riot_account_identities",
                              "riot_accounts_raw", "riot_match_list_raw", "riot_match_raw"):
                    self.assertEqual(fresh.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0], 0, table)
                row = fresh.execute("SELECT account,match_id,champion,role,loss_attribution_weight,reason FROM match_quality").fetchone()
                self.assertEqual(dict(row), {
                    "account": account, "match_id": match_id, "champion": "Vi", "role": "JUNGLE",
                    "loss_attribution_weight": 0.8, "reason": "Independent replacement dataset",
                })
                self.assertEqual(fresh.execute("SELECT COUNT(*) FROM match_quality").fetchone()[0], 1)
                self.assertEqual(dict(fresh.execute("SELECT puuid,account FROM tracked_account_puuids")), {"new-owner": account})
                self.assertEqual({row[0] for row in fresh.execute("SELECT puuid FROM riot_account_aliases")}, {"new-owner"})
                self.assertEqual(canonical_account_name(fresh, "Old Alias#EUW"), "Old Alias#EUW")
            finally:
                fresh.close()


if __name__ == "__main__":
    unittest.main()
