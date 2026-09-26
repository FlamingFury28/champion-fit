"""Manual identity assumptions and reversible exceptions on temporary databases."""
import contextlib
import hashlib
import io
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import app
import check_new_matches
import manage_identities
import riot_sync
from account_identity import AccountIdentityConflict, reconcile_account_identity, record_identity_policy
from storage import SQLiteStorage
from test_riot_ingestion import match_detail


class IdentityManagementTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.db = Path(self.temp.name) / "identity.db"
        riot_sync.initialize_ingestion_database(self.db)
        self.storage = SQLiteStorage(self.db, app.SCHEMA_PATH)
        connection = self.storage.connect()
        try:
            connection.execute("INSERT INTO riot_account_identities VALUES('group1','Player#EUW')")
            for puuid in ("p1", "p2"):
                connection.execute("INSERT INTO riot_identity_puuids VALUES(?,'group1')", (puuid,))
                record_identity_policy(connection, puuid, "assumed", "user_assumption", "Temporarily assume shared ownership")
                connection.execute("INSERT INTO riot_match_list_raw VALUES('Player#EUW',?,'now','[\"M1\"]')", (puuid,))
                connection.execute("INSERT INTO riot_accounts_raw VALUES(?,'Player#EUW','Player','EUW','now','{}')", (puuid,))
            connection.execute("INSERT INTO riot_account_aliases VALUES('Player#EUW','oldname#euw','OldName#EUW','p1','riot_account_v1','now')")
            connection.execute("INSERT INTO riot_match_raw VALUES('M1','europe','now',?)", (json.dumps(match_detail(player_puuid="p1")),))
            connection.commit()
        finally:
            connection.close()
        riot_sync.reprocess_raw_matches(self.db)
        connection = self.storage.connect()
        try:
            connection.execute("INSERT INTO match_annotations(match_id,note,updated_at) VALUES('M1','Preserve annotation','now')")
            connection.execute("UPDATE match_quality SET loss_attribution_weight=0.63,reason='External judgment' WHERE match_id='M1'")
            connection.execute("UPDATE match_import_provenance SET classification='supplied_historical',source='csv',overrides_json=?",
                               (json.dumps({"loss_attribution_weight": 0.63, "reason": "External judgment"}),))
            connection.commit()
        finally:
            connection.close()

    def read(self, query, params=()):
        connection = self.storage.connect()
        try:
            return [dict(row) for row in connection.execute(query, params)]
        finally:
            connection.close()

    def data_snapshot(self):
        return {table: self.read(f"SELECT * FROM {table}") for table in (
            "riot_account_identities", "riot_identity_puuids", "riot_accounts_raw", "riot_account_aliases",
            "riot_match_list_raw", "riot_match_raw", "riot_match_materialization", "match_quality",
            "match_participants", "match_annotations", "match_import_provenance", "tracked_account_puuids",
        )}

    def cli(self, *arguments, expected=0):
        result = subprocess.run([sys.executable, str(Path(manage_identities.__file__)), "--db", str(self.db), *arguments],
                                capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
        return json.loads(result.stdout) if expected == 0 else result.stderr

    @staticmethod
    def fake_riot(path, key):
        if path.startswith("/riot/account/"):
            return dict(puuid="p1", gameName="Player", tagLine="EUW")
        if "/ids?" in path:
            return ["M1"]
        return match_detail(player_puuid="p1")

    def test_list_and_show_read_only_report_assumptions_and_saved_alias(self):
        digest = hashlib.sha256(self.db.read_bytes()).hexdigest()
        group = self.cli("list", "--account", "OldName#EUW")["groups"][0]
        self.assertEqual(group["account"], "Player#EUW")
        self.assertEqual(group["state"], "assumed")
        self.assertFalse(group["reconciliation_blocked"])
        self.assertEqual({row["puuid"] for row in group["puuids"]}, {"p1", "p2"})
        self.assertEqual(self.cli("show", "p2")["groups"], [group])
        self.assertEqual(self.cli("list", "--account", "Unrelated#EUW")["groups"], [])
        self.assertEqual(hashlib.sha256(self.db.read_bytes()).hexdigest(), digest)

    def test_suspend_fresh_reopen_blocks_quick_full_and_reprocess_until_restored(self):
        before = self.data_snapshot()
        group = self.cli("exclude", "p2", "--reason", "Possible reused Riot ID")["groups"][0]
        self.assertEqual(group["state"], "exception")
        self.assertTrue(group["reconciliation_blocked"])
        suspended = self.read("SELECT * FROM riot_identity_policy WHERE puuid='p2'")[0]
        self.assertEqual(suspended["resume_state"], "assumed")
        with patch("check_new_matches.riot_get", side_effect=self.fake_riot):
            with self.assertRaisesRegex(AccountIdentityConflict, "Riconciliazione sospesa"):
                check_new_matches.check_account("Player#EUW", "mock", self.db)
        self.assertEqual(self.data_snapshot(), before)
        with patch("riot_sync.riot_get", side_effect=self.fake_riot), patch("riot_sync.configure_api_keys"):
            with self.assertRaisesRegex(AccountIdentityConflict, "Riconciliazione sospesa"):
                riot_sync.sync("mock", self.db, ("Player#EUW",))
        self.assertEqual(self.data_snapshot(), before)
        with self.assertRaisesRegex(AccountIdentityConflict, "Riconciliazione sospesa"):
            riot_sync.reprocess_raw_matches(self.db)
        self.assertEqual(self.data_snapshot(), before)
        self.assertEqual(self.read("SELECT * FROM riot_identity_policy WHERE puuid='p2'"), [suspended])

        group = self.cli("restore", "p2", "--reason", "Exception reviewed and withdrawn")["groups"][0]
        self.assertEqual(group["state"], "assumed")
        self.assertFalse(group["reconciliation_blocked"])
        restored = self.read("SELECT * FROM riot_identity_policy WHERE puuid='p2'")[0]
        self.assertEqual(restored["source"], "user_assumption")
        self.assertEqual([event["to"] for event in json.loads(restored["history_json"])], ["assumed", "exception", "assumed"])
        self.assertEqual(self.data_snapshot(), before)
        with patch("check_new_matches.riot_get", side_effect=self.fake_riot):
            check_new_matches.check_account("Player#EUW", "mock", self.db)
        with patch("riot_sync.riot_get", side_effect=self.fake_riot), patch("riot_sync.configure_api_keys"), contextlib.redirect_stdout(io.StringIO()):
            riot_sync.sync("mock", self.db, ("Player#EUW",))
        self.assertEqual(riot_sync.reprocess_raw_matches(self.db)["accounts"], 1)
        self.assertEqual({row["state"] for row in self.read("SELECT state FROM riot_identity_policy")}, {"assumed"})
        self.assertEqual(self.read("SELECT note FROM match_annotations"), [{"note": "Preserve annotation"}])
        self.assertEqual(self.read("SELECT loss_attribution_weight,reason FROM match_quality"),
                         [{"loss_attribution_weight": 0.63, "reason": "External judgment"}])
        self.assertEqual(self.read("PRAGMA foreign_key_check"), [])

    def test_multiple_exceptions_restore_independently_and_keep_original_state(self):
        connection = self.storage.connect()
        try:
            record_identity_policy(connection, "p1", "verified", "manual_verified", "Explicit ownership confirmed")
            connection.commit()
        finally:
            connection.close()
        self.cli("suspend", "p1", "--reason", "Review first link")
        self.cli("suspend", "p2", "--reason", "Review second link")
        group = self.cli("clear", "p1", "--reason", "First review complete")["groups"][0]
        self.assertTrue(group["reconciliation_blocked"])
        self.assertEqual(self.read("SELECT state FROM riot_identity_policy WHERE puuid='p1'"), [{"state": "verified"}])
        with self.assertRaises(AccountIdentityConflict):
            riot_sync.reprocess_raw_matches(self.db)
        group = self.cli("clear", "p2", "--reason", "Second review complete")["groups"][0]
        self.assertFalse(group["reconciliation_blocked"])
        self.assertEqual(group["state"], "assumed")

    def test_exception_veto_follows_explicit_historical_edge_before_any_write(self):
        connection = self.storage.connect()
        try:
            connection.executemany("INSERT INTO riot_account_aliases VALUES(?,?,?,?,?,?)", [
                ("Bridge#EUW", "bridge#euw", "Bridge#EUW", puuid, "imported_accounts_json", "now")
                for puuid in ("p2", "unmapped-history")
            ])
            connection.commit()
        finally:
            connection.close()
        self.cli("exclude", "p2", "--reason", "Check linked history")
        before = self.data_snapshot()
        connection = self.storage.connect()
        try:
            with self.assertRaisesRegex(AccountIdentityConflict, "Riconciliazione sospesa"):
                reconcile_account_identity(connection, "Bridge#EUW", "unmapped-history")
            self.assertFalse(connection.in_transaction)
        finally:
            connection.close()
        self.assertEqual(self.data_snapshot(), before)

    def test_policy_helper_defers_commit_and_is_idempotent(self):
        old = self.read("SELECT * FROM riot_identity_policy WHERE puuid='p1'")[0]
        connection = self.storage.connect()
        try:
            connection.execute("BEGIN IMMEDIATE")
            recorded = record_identity_policy(connection, "p1", "exception", "user_assumption", "Pending caller commit")
            self.assertEqual(record_identity_policy(connection, "p1", "exception", "user_assumption", "Pending caller commit"), recorded)
            self.assertEqual(self.read("SELECT * FROM riot_identity_policy WHERE puuid='p1'"), [old])
            connection.rollback()
        finally:
            connection.close()
        self.assertEqual(self.read("SELECT * FROM riot_identity_policy WHERE puuid='p1'"), [old])

    def test_cli_rolls_back_if_readback_fails_after_policy_write(self):
        before = self.read("SELECT * FROM riot_identity_policy ORDER BY puuid")
        with patch("manage_identities.identity_groups", side_effect=ValueError("Injected readback failure")), contextlib.redirect_stderr(io.StringIO()):
            code = manage_identities.main(["--db", str(self.db), "exclude", "p2", "--reason", "Rollback test"])
        self.assertEqual(code, 1)
        self.assertEqual(self.read("SELECT * FROM riot_identity_policy ORDER BY puuid"), before)

    def test_unknown_puuid_and_invalid_restore_cannot_invent_or_reassign_ownership(self):
        before = self.data_snapshot()
        policies = self.read("SELECT * FROM riot_identity_policy ORDER BY puuid")
        self.assertIn("non presente", self.cli("exclude", "unknown", "--reason", "Unknown link", expected=1))
        self.assertIn("non ha una sospensione", self.cli("restore", "p1", "--reason", "Not suspended", expected=1))
        self.assertIn("non può essere vuoto", self.cli("exclude", "p1", "--reason", " ", expected=1))
        self.assertEqual(self.data_snapshot(), before)
        self.assertEqual(self.read("SELECT * FROM riot_identity_policy ORDER BY puuid"), policies)
        self.assertEqual(self.read("PRAGMA foreign_key_check"), [])


if __name__ == "__main__":
    unittest.main()
