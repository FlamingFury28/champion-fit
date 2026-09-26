"""Persistent regressions for audit F01/F02/F04/F05/F06/F07/F08."""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import app
import check_new_matches
import riot_sync
from ingest import legacy_import_provenance
from effective_evidence import load_effective_evidence
from match_scoring import loss_attribution_weight
from account_identity import AccountIdentityConflict, canonical_account_name, reconcile_account_identity
from test_riot_ingestion import match_detail
from storage import SQLiteStorage


def complete_detail(match_id="M1", puuid="p1", name="Player"):
    return match_detail(match_id, puuid, name)


def normalized_row(account="Player#EUW", match_id="M1"):
    return dict(account=account, match_id=match_id, date="2020-01-01", patch="10.1", queue="420",
                champion="Lux", role="MIDDLE", win=False, duration_minutes=10)


class IngestionRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.db = Path(self.temp.name) / "test.db"
        riot_sync.initialize_ingestion_database(self.db)
        self.storage = SQLiteStorage(self.db, app.SCHEMA_PATH)

    def read(self, sql, params=()):
        connection = self.storage.connect()
        try:
            return [dict(row) for row in connection.execute(sql, params)]
        finally:
            connection.close()

    def seed(self, details, account="Player#EUW", puuid="p1"):
        connection = self.storage.connect()
        connection.execute("INSERT INTO riot_match_list_raw VALUES(?,?,?,?)", (account, puuid, "now", json.dumps(list(details))))
        for match_id, detail in details.items():
            connection.execute("INSERT INTO riot_match_raw VALUES(?,?,?,?) ON CONFLICT(match_id) DO UPDATE SET payload_json=excluded.payload_json",
                               (match_id, "europe", "now", json.dumps(detail)))
        connection.commit()
        connection.close()

    def fake_riot(self, details=None, name="Player", puuid="p1"):
        details = details or {"M1": complete_detail(puuid=puuid, name=name)}

        def get(path, _key):
            if path.startswith("/riot/account/"):
                return dict(puuid=puuid, gameName=name, tagLine="EUW")
            if "/ids?" in path:
                return list(details)
            match_id = path.rsplit("/", 1)[-1]
            return details[match_id]
        return get

    def assert_complete(self, count=1):
        self.assertEqual(len(self.read("SELECT * FROM match_quality")), count)
        self.assertEqual(len(self.read("SELECT * FROM riot_match_raw")), count)
        self.assertEqual(len(self.read("SELECT * FROM match_participants")), count * 10)
        self.assertEqual(len(self.read("SELECT * FROM riot_match_materialization WHERE status='materialized'")), count)

    def test_reprocess_updates_derived_fields_and_preserves_annotation_and_row_id(self):
        self.seed({"M1": complete_detail()})
        riot_sync.ingest_normalized_rows([normalized_row()], self.db, "fixture")
        before_id = self.read("SELECT id FROM match_quality")[0]["id"]
        connection = self.storage.connect()
        connection.execute("INSERT INTO match_annotations(match_id,note,updated_at) VALUES('M1','keep this annotation','now')")
        connection.commit(); connection.close()

        first = riot_sync.reprocess_raw_matches(self.db)
        second = riot_sync.reprocess_raw_matches(self.db)

        self.assertEqual(first["updated"], 1)
        self.assertEqual(first["inserted"], 0)
        self.assertEqual(second["updated"], 0)
        self.assertEqual(second["skipped"], 1)
        stored = self.read("SELECT id,champion,role,win,duration_minutes,loss_attribution_weight FROM match_quality")[0]
        self.assertEqual(stored, dict(id=before_id, champion="Vi", role="JUNGLE", win=1, duration_minutes=30.0, loss_attribution_weight=0.0))
        self.assertEqual(self.read("SELECT note FROM match_annotations")[0]["note"], "keep this annotation")
        self.assert_complete()

    def test_truncated_roster_cannot_delete_an_existing_match(self):
        detail = complete_detail()
        detail["metadata"]["participants"] = detail["metadata"]["participants"][1:]
        detail["info"]["participants"] = detail["info"]["participants"][1:]
        self.seed({"M1": detail})
        riot_sync.ingest_normalized_rows([normalized_row()], self.db, "fixture")
        result = riot_sync.reprocess_raw_matches(self.db)
        self.assertEqual(result["removed_stale"], 0)
        self.assertEqual(len(self.read("SELECT * FROM match_quality")), 1)
        self.assertEqual(self.read("SELECT status,reason FROM riot_match_materialization"), [dict(status="invalid_payload", reason="incomplete_identity_roster")])

    def test_truncated_info_cannot_shift_owner_puuid_onto_an_ally(self):
        self.seed({"M1": complete_detail()})
        riot_sync.reprocess_raw_matches(self.db)
        before_match = self.read("SELECT * FROM match_quality")
        before_roster = self.read("SELECT * FROM match_participants ORDER BY participant_id")
        detail = complete_detail()
        detail["info"]["participants"] = detail["info"]["participants"][1:]
        connection = self.storage.connect()
        connection.execute("UPDATE riot_match_raw SET payload_json=? WHERE match_id='M1'", (json.dumps(detail),))
        connection.commit(); connection.close()
        result = riot_sync.reprocess_raw_matches(self.db)
        self.assertEqual(result["updated"], 0)
        self.assertEqual(result["removed_stale"], 0)
        self.assertEqual(self.read("SELECT * FROM match_quality"), before_match)
        self.assertEqual(self.read("SELECT * FROM match_participants ORDER BY participant_id"), before_roster)
        self.assertEqual(self.read("SELECT status,reason FROM riot_match_materialization"), [dict(status="invalid_payload", reason="incomplete_identity_roster")])
        self.assertEqual(riot_sync.participant_rows_from_detail(detail), [])

    def test_incomplete_or_incoherent_roster_is_invalid_even_when_owner_is_present(self):
        evidence = riot_sync.AccountIdentityEvidence("Player#EUW", frozenset({"p1"}), frozenset({"player#euw"}))
        for kind in ("both_truncated", "metadata_truncated", "duplicate_slot", "identity_in_wrong_slot", "duplicate_metadata"):
            with self.subTest(kind=kind):
                detail = complete_detail()
                if kind == "both_truncated":
                    detail["info"]["participants"].pop()
                    detail["metadata"]["participants"].pop()
                elif kind == "metadata_truncated":
                    detail["metadata"]["participants"].pop()
                elif kind == "duplicate_slot":
                    detail["info"]["participants"][-1]["participantId"] = 9
                elif kind == "identity_in_wrong_slot":
                    detail["info"]["participants"][1]["puuid"] = "p1"
                else:
                    detail["metadata"]["participants"][-1] = "p1"
                result = riot_sync.normalize_match_detail("Player#EUW", evidence, detail)
                self.assertEqual(result.status, "invalid_payload")
                self.assertIsNone(result.row)
                self.assertEqual(riot_sync.participant_rows_from_detail(detail), [])

    def test_reordered_info_uses_verified_slot_ids_instead_of_array_position(self):
        detail = complete_detail()
        detail["info"]["participants"].reverse()
        evidence = riot_sync.AccountIdentityEvidence("Player#EUW", frozenset({"p1"}), frozenset())
        result = riot_sync.normalize_match_detail("Player#EUW", evidence, detail)
        self.assertEqual(result.status, "eligible")
        self.assertEqual(result.observed_puuid, "p1")
        self.assertEqual(result.row["champion"], "Vi")
        self.assertEqual(result.row["role"], "JUNGLE")
        self.assertEqual(result.participants[0]["participant_id"], 1)

    def test_mismatched_raw_id_is_recorded_under_requested_id_without_roster_crash(self):
        detail = complete_detail("ACTUAL")
        self.seed({"REQUESTED": detail})
        riot_sync.ingest_normalized_rows([normalized_row(match_id="REQUESTED")], self.db, "fixture")
        self.assertEqual(riot_sync.participant_rows_from_detail(detail, "REQUESTED"), [])
        result = riot_sync.reprocess_raw_matches(self.db)
        self.assertEqual(result["inserted"], 0)
        self.assertEqual(self.read("SELECT match_id FROM match_quality"), [dict(match_id="REQUESTED")])
        self.assertEqual(self.read("SELECT match_id,status,reason FROM riot_match_materialization"), [dict(match_id="REQUESTED", status="invalid_payload", reason="match_id_mismatch")])

    def test_quick_failure_rolls_back_every_projection_and_retry_recovers(self):
        with patch("check_new_matches.riot_get", side_effect=self.fake_riot()), patch(
            "check_new_matches.upsert_match_participants", side_effect=RuntimeError("injected failure"),
        ):
            with self.assertRaisesRegex(RuntimeError, "injected failure"):
                check_new_matches.check_account("Player#EUW", "fake", self.db)
        for table in ("match_quality", "riot_match_raw", "riot_match_list_raw", "match_participants",
                      "riot_match_materialization", "riot_account_identities", "riot_identity_puuids"):
            self.assertEqual(self.read(f"SELECT * FROM {table}"), [], table)
        with patch("check_new_matches.riot_get", side_effect=self.fake_riot()):
            result = check_new_matches.check_account("Player#EUW", "fake", self.db)
        self.assertEqual(result["inserted"], 1)
        self.assert_complete()

    def test_quick_repairs_a_preexisting_interrupted_import(self):
        riot_sync.ingest_normalized_rows([normalized_row()], self.db, "interrupted_legacy_import")
        with patch("check_new_matches.riot_get", side_effect=self.fake_riot()):
            result = check_new_matches.check_account("Player#EUW", "fake", self.db)
        self.assertEqual(result["updated"], 1)
        self.assert_complete()

    def test_quick_does_not_claim_an_unknown_puuid_from_a_reused_historical_alias(self):
        details = {"BRIDGE": complete_detail("BRIDGE", "p1", "Old Name"),
                   "OLD": complete_detail("OLD", "p2", "Old Name")}
        self.seed(details)
        riot_sync.ingest_normalized_rows([normalized_row(match_id="BRIDGE")], self.db, "legacy")
        with patch("check_new_matches.riot_get", side_effect=self.fake_riot({"BRIDGE": details["BRIDGE"]})):
            result = check_new_matches.check_account("Player#EUW", "fake", self.db)
        self.assertEqual(result["identity_unresolved"], 1)
        self.assertEqual(result["updated"], 1)
        self.assertEqual(result["inserted"], 0)
        self.assertEqual(self.read("SELECT match_id FROM match_quality"), [dict(match_id="BRIDGE")])
        old_state = self.read(
            "SELECT status,reason FROM riot_match_materialization WHERE match_id='OLD'"
        )
        self.assertEqual(
            old_state,
            [dict(status="identity_unresolved", reason="unverified_alias_puuid")],
        )
        self.assertEqual(self.read(
            "SELECT identity_id FROM riot_identity_puuids WHERE puuid='p2'"
        ), [])
        self.assertEqual(self.read(
            "SELECT match_id FROM match_participants WHERE match_id='OLD'"
        ), [])

        repeated = riot_sync.reprocess_raw_matches(self.db)
        self.assertEqual(repeated["inserted"], 0)
        self.assertEqual(repeated["identity_unresolved"], 1)
        self.assertEqual(self.read("SELECT match_id FROM match_quality"), [dict(match_id="BRIDGE")])

    def test_full_sync_failure_preserves_checkpoint_and_retry_commits_complete_history(self):
        self.seed({"OLD": complete_detail("OLD")})
        fake = self.fake_riot({"NEW": complete_detail("NEW")})
        with patch("riot_sync.riot_get", side_effect=fake), patch(
            "riot_sync.upsert_match_participants", side_effect=RuntimeError("injected failure"),
        ):
            with self.assertRaisesRegex(RuntimeError, "injected failure"):
                riot_sync.sync("fake", self.db, ("Player#EUW",))
        self.assertEqual(self.read("SELECT * FROM match_quality"), [])
        self.assertEqual(self.read("SELECT match_id FROM riot_match_raw"), [dict(match_id="OLD")])
        self.assertTrue(list(self.db.parent.glob("*.checkpoint.json")))
        with patch("riot_sync.riot_get", side_effect=fake):
            result = riot_sync.sync("fake", self.db, ("Player#EUW",))
        self.assertEqual(result["inserted"], 2)
        self.assert_complete(2)
        self.assertFalse(list(self.db.parent.glob("*.checkpoint.json")))
        self.assertEqual(set(json.loads(self.read("SELECT match_ids_json FROM riot_match_list_raw")[0]["match_ids_json"])), {"OLD", "NEW"})

    def test_full_sync_exposes_live_cross_process_marker_and_cleans_it(self):
        observed = []

        def get(path, key):
            markers = list(self.db.parent.glob(f".{self.db.stem}.riot-sync-*.active.json"))
            self.assertEqual(len(markers), 1)
            observed.append(json.loads(markers[0].read_text(encoding="utf-8")))
            return self.fake_riot()(path, key)

        with patch("riot_sync.riot_get", side_effect=get):
            riot_sync.sync("fake", self.db, ("Player#EUW",))

        self.assertTrue(observed)
        marker = observed[0]
        self.assertEqual(marker["version"], 1)
        self.assertEqual(marker["database"], self.db.name)
        self.assertEqual(marker["account_count"], 1)
        self.assertEqual(marker["pid"], os.getpid())
        self.assertIn("started_at", marker)
        self.assertIn("heartbeat_at", marker)
        self.assertEqual(list(self.db.parent.glob(f".{self.db.stem}.riot-sync-*.active.json")), [])

    def test_corrupted_checkpoint_does_not_block_full_sync_recovery(self):
        checkpoint = self.db.with_name(f".{self.db.stem}.riot-{riot_sync.checkpoint_stem('Player#EUW')}.checkpoint.json")
        checkpoint.write_text('{"account":"Player#EUW","ids":["M1"],"raw_matches":', encoding="utf-8")
        with patch("riot_sync.riot_get", side_effect=self.fake_riot()):
            result = riot_sync.sync("fake", self.db, ("Player#EUW",))
        self.assertEqual(result["inserted"], 1)
        self.assertFalse(checkpoint.exists())
        self.assert_complete()

    def test_non_object_detail_does_not_advance_checkpoint_and_is_retried(self):
        checkpoint = self.db.parent / "pending.checkpoint.json"

        def non_object(path, _key):
            return ["M1"] if "/ids?" in path else []

        with patch("riot_sync.riot_get", side_effect=non_object):
            rows, participants, raw, ids = riot_sync.match_rows(
                "Player#EUW", "p1", "fake", checkpoint,
            )
        self.assertEqual((rows, participants, raw, ids), ([], [], {}, ["M1"]))
        state = json.loads(checkpoint.read_text(encoding="utf-8"))
        self.assertEqual(state["completed"], 0)
        self.assertEqual(state["pending_match_ids"], ["M1"])

        with patch("riot_sync.riot_get", side_effect=self.fake_riot()):
            rows, participants, raw, ids = riot_sync.match_rows(
                "Player#EUW", "p1", "fake", checkpoint,
            )
        self.assertEqual([row["match_id"] for row in rows], ["M1"])
        self.assertEqual(len(participants), 10)
        self.assertEqual(set(raw), {"M1"})
        self.assertEqual(json.loads(checkpoint.read_text(encoding="utf-8"))["pending_match_ids"], [])

    def test_non_404_detail_failure_aborts_historical_sync(self):
        checkpoint = self.db.parent / "failed.checkpoint.json"

        def unavailable(path, _key):
            if "/ids?" in path:
                return ["M1"]
            raise riot_sync.RiotAPIError("Riot API HTTP 503", path, 503)

        with patch("riot_sync.riot_get", side_effect=unavailable):
            with self.assertRaisesRegex(riot_sync.RiotAPIError, "503"):
                riot_sync.match_rows("Player#EUW", "p1", "fake", checkpoint)
        self.assertFalse(checkpoint.exists())

    def test_quick_retry_queue_recovers_historical_missing_and_invalid_details(self):
        invalid = complete_detail("INVALID")
        invalid["info"]["participants"].pop()
        invalid["metadata"]["participants"].pop()
        self.seed({"RECENT": complete_detail("RECENT"), "INVALID": invalid})
        connection = self.storage.connect()
        connection.execute(
            "UPDATE riot_match_list_raw SET match_ids_json=?",
            (json.dumps(["RECENT", "MISSING", "INVALID"]),),
        )
        connection.commit()
        connection.close()
        riot_sync.reprocess_raw_matches(self.db)

        details = {
            "RECENT": complete_detail("RECENT"),
            "MISSING": complete_detail("MISSING"),
            "INVALID": complete_detail("INVALID"),
        }

        def get(path, _key):
            if path.startswith("/riot/account/"):
                return dict(puuid="p1", gameName="Player", tagLine="EUW")
            if "/ids?" in path:
                return ["RECENT"]
            return details[path.rsplit("/", 1)[-1]]

        with patch("check_new_matches.riot_get", side_effect=get):
            result = check_new_matches.check_account("Player#EUW", "fake", self.db)
        self.assertEqual(result["retried_raw"], 2)
        self.assertEqual(result["pending_details"], 0)
        self.assert_complete(3)

    def test_quick_detail_404_is_pending_not_an_unresolved_account(self):
        missing_path = "/lol/match/v5/matches/MISSING"

        def unavailable(path, _key):
            if path.startswith("/riot/account/"):
                return dict(puuid="p1", gameName="Player", tagLine="EUW")
            if "/ids?" in path:
                return ["MISSING"]
            raise riot_sync.RiotAPIError("Riot API HTTP 404", missing_path, 404)

        with patch("check_new_matches.riot_get", side_effect=unavailable):
            result = check_new_matches.check_account("Player#EUW", "fake", self.db)
        self.assertEqual(result["pending_details"], 1)
        self.assertEqual(result["inserted"], 0)
        self.assertEqual(self.read("SELECT match_ids_json FROM riot_match_list_raw")[0]["match_ids_json"], '["MISSING"]')
        self.assertEqual(self.read("SELECT * FROM riot_match_raw"), [])

        def recovered(path, _key):
            if path.startswith("/riot/account/"):
                return dict(puuid="p1", gameName="Player", tagLine="EUW")
            if "/ids?" in path:
                return []
            return complete_detail("MISSING")

        with patch("check_new_matches.riot_get", side_effect=recovered):
            result = check_new_matches.check_account("Player#EUW", "fake", self.db)
        self.assertEqual(result["retried_raw"], 1)
        self.assertEqual(result["inserted"], 1)
        self.assert_complete()

    def test_checkpoint_replacement_failure_preserves_previous_valid_json(self):
        checkpoint = self.db.parent / "resume.checkpoint.json"
        saved = dict(account="Player#EUW", puuid="p1", ids=["M1"], completed=0, raw_matches={})
        checkpoint.write_text(json.dumps(saved), encoding="utf-8")
        original = checkpoint.read_bytes()
        with patch("riot_sync.riot_get", side_effect=self.fake_riot()), patch(
            "riot_sync.os.replace", side_effect=OSError("injected replacement failure"),
        ):
            with self.assertRaisesRegex(OSError, "injected replacement failure"):
                riot_sync.match_rows("Player#EUW", "p1", "fake", checkpoint)
        self.assertEqual(checkpoint.read_bytes(), original)
        self.assertEqual(list(self.db.parent.glob("resume.checkpoint.json.*.tmp")), [])
        with patch("riot_sync.riot_get", side_effect=self.fake_riot()):
            rows, participants, _raw, ids = riot_sync.match_rows("Player#EUW", "p1", "fake", checkpoint)
        self.assertEqual(ids, ["M1"])
        self.assertEqual(rows[0]["champion"], "Vi")
        self.assertEqual(len(participants), 10)
        self.assertEqual(json.loads(checkpoint.read_text(encoding="utf-8"))["completed"], 1)

    def test_process_death_during_checkpoint_write_preserves_previous_cache_and_recovers(self):
        checkpoint = self.db.parent / "resume.checkpoint.json"
        saved = dict(account="Player#EUW", puuid="p1", ids=["M1"], completed=0, raw_matches={})
        checkpoint.write_text(json.dumps(saved), encoding="utf-8")
        original = checkpoint.read_bytes()
        child = r'''
import os,sys
from pathlib import Path
from unittest.mock import patch
import riot_sync
from test_ingestion_recovery import complete_detail
def riot(path,key):
    if '/ids?' in path: return ['M1']
    return complete_detail()
def crash_json(value,handle,**kwargs):
    handle.write('{"partial":')
    handle.flush()
    os._exit(24)
with patch('riot_sync.riot_get',side_effect=riot):
    if sys.argv[2]=='crash':
        with patch('riot_sync.json.dump',side_effect=crash_json):
            riot_sync.match_rows('Player#EUW','p1','fake',Path(sys.argv[1]))
    else:
        riot_sync.match_rows('Player#EUW','p1','fake',Path(sys.argv[1]))
'''
        crashed = subprocess.run([sys.executable, "-c", child, str(checkpoint), "crash"], capture_output=True, text=True, timeout=30)
        self.assertEqual(crashed.returncode, 24, crashed.stderr)
        self.assertEqual(checkpoint.read_bytes(), original)
        recovered = subprocess.run([sys.executable, "-c", child, str(checkpoint), "recover"], capture_output=True, text=True, timeout=30)
        self.assertEqual(recovered.returncode, 0, recovered.stderr)
        self.assertEqual(json.loads(checkpoint.read_text(encoding="utf-8"))["completed"], 1)

    def test_reprocess_failure_rolls_back_prior_accounts_and_can_retry(self):
        self.seed({"M1": complete_detail()})
        self.seed({"M2": complete_detail("M2", "p2", "Second")}, "Second#EUW", "p2")
        writer = riot_sync.upsert_match_participants
        calls = []

        def fail_second(connection, participants):
            calls.append(1)
            if len(calls) == 2:
                raise RuntimeError("second account failed")
            return writer(connection, participants)

        with patch("riot_sync.upsert_match_participants", side_effect=fail_second):
            with self.assertRaisesRegex(RuntimeError, "second account failed"):
                riot_sync.reprocess_raw_matches(self.db)
        for table in ("match_quality", "match_participants", "riot_match_materialization", "riot_account_identities"):
            self.assertEqual(self.read(f"SELECT * FROM {table}"), [], table)
        self.assertEqual(riot_sync.reprocess_raw_matches(self.db)["inserted"], 2)
        self.assert_complete(2)

    def test_same_puuid_rename_keeps_one_identity_and_resolves_saved_filters(self):
        with patch("check_new_matches.riot_get", side_effect=self.fake_riot(name="Old Name")):
            check_new_matches.check_account("Old Name#EUW", "fake", self.db)
        original_identity = self.read("SELECT identity_id FROM riot_account_identities")[0]["identity_id"]
        with patch("check_new_matches.riot_get", side_effect=self.fake_riot(name="New Name")):
            result = check_new_matches.check_account("New Name#EUW", "fake", self.db)
        self.assertEqual(result["inserted"], 0)
        self.assertEqual(self.read("SELECT identity_id,account FROM riot_account_identities"), [dict(identity_id=original_identity, account="New Name#EUW")])
        self.assertEqual(self.read("SELECT account FROM match_quality"), [dict(account="New Name#EUW")])
        connection = self.storage.connect()
        self.assertEqual(canonical_account_name(connection, "Old Name#EUW"), "New Name#EUW")
        connection.close()
        self.assert_complete()

    def test_saved_old_riot_id_recovers_canonical_puuid_after_rename(self):
        with patch("check_new_matches.riot_get", side_effect=self.fake_riot(name="Old Name")):
            check_new_matches.check_account("Old Name#EUW", "fake", self.db)
        with patch("check_new_matches.riot_get", side_effect=self.fake_riot(name="New Name")):
            check_new_matches.check_account("New Name#EUW", "fake", self.db)

        requested_paths = []

        def renamed(path, _key):
            requested_paths.append(path)
            if path == "/riot/account/v1/accounts/by-riot-id/Old%20Name/EUW":
                raise riot_sync.RiotAPIError("Riot API HTTP 404", path, 404)
            if path == "/riot/account/v1/accounts/by-puuid/p1":
                return dict(puuid="p1", gameName="New Name", tagLine="EUW")
            if "/ids?" in path:
                return ["M1"]
            raise AssertionError(path)

        with patch("check_new_matches.riot_get", side_effect=renamed):
            result = check_new_matches.check_account("Old Name#EUW", "fake", self.db)

        self.assertEqual(result["account"], "New Name#EUW")
        self.assertIn("/riot/account/v1/accounts/by-puuid/p1", requested_paths)
        self.assertEqual(self.read("SELECT DISTINCT account FROM riot_match_list_raw"), [dict(account="New Name#EUW")])

    def test_reused_historical_riot_id_gets_a_distinct_owner(self):
        with patch("check_new_matches.riot_get", side_effect=self.fake_riot(name="Old Name", puuid="p1")):
            check_new_matches.check_account("Old Name#EUW", "fake", self.db)
        with patch("check_new_matches.riot_get", side_effect=self.fake_riot(name="New Name", puuid="p1")):
            check_new_matches.check_account("New Name#EUW", "fake", self.db)
        second = {"M2": complete_detail("M2", "p2", "Old Name")}
        with patch("check_new_matches.riot_get", side_effect=self.fake_riot(second, "Old Name", "p2")):
            result = check_new_matches.check_account("Old Name#EUW", "fake", self.db)

        self.assertEqual(result["account"], "Old Name#EUW")
        riot_sync.reprocess_raw_matches(self.db)
        self.assertEqual(
            self.read("SELECT puuid,identity_id FROM riot_identity_puuids ORDER BY puuid"),
            [dict(puuid="p1", identity_id="p1"), dict(puuid="p2", identity_id="p2")],
        )
        self.assertEqual(check_new_matches._stored_puuids(self.db, "Old Name#EUW"), ("p2",))
        connection = self.storage.connect()
        try:
            self.assertEqual(canonical_account_name(connection, "Old Name#EUW"), "Old Name#EUW")
        finally:
            connection.close()

    def test_legacy_duplicate_aliases_merge_by_verified_puuid_preserving_annotations(self):
        self.seed({"M1": complete_detail(name="Old Name"), "OLD": complete_detail("OLD", name="Old Name")}, "Old Name#EUW")
        self.seed({"M1": complete_detail(name="Old Name")}, "New Name#EUW")
        riot_sync.ingest_normalized_rows([normalized_row("Old Name#EUW"), normalized_row("New Name#EUW")], self.db, "legacy")
        connection = self.storage.connect()
        connection.execute("INSERT INTO riot_accounts_raw VALUES(?,?,?,?,?,?)", ("p1", "New Name#EUW", "New Name", "EUW", "now", "{}"))
        connection.execute("INSERT INTO match_annotations(match_id,note,updated_at) VALUES('M1','saved note','now')")
        connection.commit(); connection.close()
        result = riot_sync.reprocess_raw_matches(self.db)
        self.assertEqual(result["accounts"], 1)
        self.assertEqual({row["account"] for row in self.read("SELECT account FROM match_quality")}, {"New Name#EUW"})
        self.assertEqual(self.read("SELECT note FROM match_annotations"), [dict(note="saved note")])
        self.assert_complete(2)

    def test_different_owned_puuids_in_the_same_match_remain_distinct_accounts(self):
        details = complete_detail()
        details["info"]["participants"][1]["riotIdGameName"] = "Ally"
        self.seed({"M1": details})
        self.seed({"M1": details}, "Ally#EUW", "ally-puuid")
        result = riot_sync.reprocess_raw_matches(self.db)
        self.assertEqual(result["inserted"], 2)
        self.assertEqual(len(self.read("SELECT * FROM riot_account_identities")), 2)
        self.assertEqual({row["account"] for row in self.read("SELECT account FROM match_quality")}, {"Player#EUW", "Ally#EUW"})

    def test_reused_name_does_not_merge_two_established_puuid_owners(self):
        with patch("check_new_matches.riot_get", side_effect=self.fake_riot(name="First", puuid="p1")):
            check_new_matches.check_account("First#EUW", "fake", self.db)
        with patch("check_new_matches.riot_get", side_effect=self.fake_riot({"M2": complete_detail("M2", "p2", "Second")}, "Second", "p2")):
            check_new_matches.check_account("Second#EUW", "fake", self.db)
        before = {table: self.read(f"SELECT * FROM {table}") for table in (
            "match_quality", "riot_account_identities", "riot_identity_puuids", "riot_account_aliases", "riot_match_list_raw",
        )}
        with patch("check_new_matches.riot_get", side_effect=self.fake_riot(name="Second", puuid="p1")):
            with self.assertRaises(AccountIdentityConflict):
                check_new_matches.check_account("Second#EUW", "fake", self.db)
        for table, expected in before.items():
            self.assertEqual(self.read(f"SELECT * FROM {table}"), expected, table)

    def test_new_puuid_cannot_claim_an_existing_owner_by_name_alone(self):
        with patch("check_new_matches.riot_get", side_effect=self.fake_riot()):
            check_new_matches.check_account("Player#EUW", "fake", self.db)
        with patch("check_new_matches.riot_get", side_effect=self.fake_riot(puuid="different-owner")):
            with self.assertRaises(AccountIdentityConflict):
                check_new_matches.check_account("Player#EUW", "fake", self.db)
        self.assertEqual(self.read("SELECT puuid FROM riot_identity_puuids"), [dict(puuid="p1")])
        self.assert_complete()

    def seed_cold_name_collision(self, first_account="Reused#EUW", second_account="Reused#EUW"):
        self.seed({"M1": complete_detail("M1", "first-owner", first_account.split("#")[0])}, first_account, "first-owner")
        self.seed({"M2": complete_detail("M2", "second-owner", second_account.split("#")[0])}, second_account, "second-owner")
        connection = self.storage.connect()
        connection.executemany("INSERT INTO riot_accounts_raw VALUES(?,?,?,?,?,?)", [
            (puuid, account, account.split("#")[0], account.split("#")[1], timestamp, "{}")
            for puuid, account, timestamp in (("first-owner", first_account, "2025-01-01"),
                                               ("second-owner", second_account, "2026-01-01"))
        ])
        connection.commit(); connection.close()

    def test_cold_legacy_same_name_does_not_prove_two_puuids_share_an_owner(self):
        self.seed_cold_name_collision()
        before = {table: self.read(f"SELECT * FROM {table}") for table in ("riot_accounts_raw", "riot_match_list_raw", "riot_match_raw")}
        with self.assertRaisesRegex(AccountIdentityConflict, "senza una storia di proprietà verificata"):
            riot_sync.reprocess_raw_matches(self.db)
        for table, expected in before.items():
            self.assertEqual(self.read(f"SELECT * FROM {table}"), expected, table)
        self.assertEqual(self.read("SELECT * FROM riot_account_identities"), [])
        self.assertEqual(self.read("SELECT * FROM riot_identity_puuids"), [])
        self.assertEqual(self.read("SELECT * FROM match_quality"), [])

    def test_cold_legacy_case_variants_cannot_hide_a_name_collision(self):
        self.seed_cold_name_collision("Owner#EUW", "owner#euw")
        with self.assertRaises(AccountIdentityConflict):
            riot_sync.reprocess_raw_matches(self.db)
        self.assertEqual(self.read("SELECT * FROM riot_account_identities"), [])
        self.assertEqual(len(self.read("SELECT * FROM riot_accounts_raw")), 2)

    def test_a_single_explicit_history_entry_cannot_claim_an_unlisted_namesake(self):
        self.seed_cold_name_collision()
        connection = self.storage.connect()
        connection.executemany("INSERT INTO riot_account_aliases VALUES(?,?,?,?,?,?)", [
            ("Reused#EUW", "reused#euw", "Reused#EUW", "first-owner", "imported_accounts_json", "2025"),
            ("Reused#EUW", "reused#euw", "Reused#EUW", "second-owner", "riot_account_v1", "2026"),
        ])
        connection.commit(); connection.close()
        with self.assertRaises(AccountIdentityConflict):
            riot_sync.reprocess_raw_matches(self.db)
        self.assertEqual(self.read("SELECT * FROM riot_account_identities"), [])
        self.assertEqual(len(self.read("SELECT * FROM riot_account_aliases")), 2)

    def test_stable_case_variant_name_collision_is_rejected(self):
        with patch("check_new_matches.riot_get", side_effect=self.fake_riot(name="Owner", puuid="first-owner")):
            check_new_matches.check_account("Owner#EUW", "fake", self.db)
        with patch("check_new_matches.riot_get", side_effect=self.fake_riot(name="owner", puuid="second-owner")):
            with self.assertRaises(AccountIdentityConflict):
                check_new_matches.check_account("owner#euw", "fake", self.db)
        self.assertEqual(self.read("SELECT identity_id FROM riot_account_identities"), [dict(identity_id="first-owner")])

    def test_process_death_rolls_back_and_a_fresh_process_recovers(self):
        child = r'''
import os,sys
from pathlib import Path
from unittest.mock import patch
import check_new_matches
from test_ingestion_recovery import complete_detail
def riot(path,key):
    if path.startswith('/riot/'): return dict(puuid='p1',gameName='Player',tagLine='EUW')
    if '/ids?' in path: return ['M1']
    return complete_detail()
def crash(connection,participants): os._exit(23)
with patch('check_new_matches.riot_get',side_effect=riot):
    if sys.argv[2]=='crash':
        with patch('check_new_matches.upsert_match_participants',side_effect=crash):
            check_new_matches.check_account('Player#EUW','fake',Path(sys.argv[1]))
    else:
        check_new_matches.check_account('Player#EUW','fake',Path(sys.argv[1]))
'''
        crashed = subprocess.run([sys.executable, "-c", child, str(self.db), "crash"], capture_output=True, text=True, timeout=30)
        self.assertEqual(crashed.returncode, 23, crashed.stderr)
        self.assertEqual(self.read("SELECT * FROM match_quality"), [])
        self.assertEqual(self.read("SELECT * FROM riot_match_raw"), [])
        recovered = subprocess.run([sys.executable, "-c", child, str(self.db), "recover"], capture_output=True, text=True, timeout=30)
        self.assertEqual(recovered.returncode, 0, recovered.stderr)
        self.assert_complete()

    def test_explicit_csv_loss_override_survives_raw_correction_without_negative_win_evidence(self):
        self.seed({"M1": complete_detail()})
        supplied = normalized_row() | {"loss_attribution_weight": 0.63, "reason": "Manual loss judgment"}
        riot_sync.ingest_normalized_rows([supplied], self.db, "csv_export")
        riot_sync.reprocess_raw_matches(self.db)
        stored = self.read("SELECT champion,win,loss_attribution_weight,win_evidence_weight,reason FROM match_quality")[0]
        self.assertEqual(stored, dict(champion="Vi", win=1, loss_attribution_weight=0.63,
                                      win_evidence_weight=0.95, reason="Manual loss judgment"))
        ledger = self.read("SELECT * FROM match_import_provenance")[0]
        self.assertEqual(ledger["source"], "csv_export")
        self.assertEqual(ledger["classification"], "known_riot_default")
        self.assertEqual(json.loads(ledger["overrides_json"])["loss_attribution_weight"], 0.63)
        positive, negative, _total = app.recommendation_evidence_expressions()
        evidence = self.read(f"SELECT {positive} positive,{negative} negative FROM match_quality m LEFT JOIN match_annotations a ON a.match_id=m.match_id")[0]
        self.assertEqual(evidence, dict(positive=0.95, negative=0))

    def test_legacy_scoring_provenance_preserves_supplied_and_unknown_inputs(self):
        detail = complete_detail()
        detail["info"]["participants"][0]["win"] = False
        self.seed({"M1": detail})
        supplied = normalized_row() | {
            "identity_resolution": "strict_csv_signature", "match_quality_score": 0.72,
            "loss_attribution_weight": 0.63, "win_evidence_weight": 0.12,
            "explicit_afk": True, "suspected_quasi_afk": True, "early_surrender": True,
            "anomaly_flags": "external_judgment", "reason": "Loss only partially attributed to this player",
        }
        riot_sync.ingest_normalized_rows([supplied], self.db, "legacy_export")
        connection = self.storage.connect()
        connection.execute("DELETE FROM match_import_provenance")
        connection.commit(); connection.close()
        riot_sync.reprocess_raw_matches(self.db)
        row = self.read("SELECT * FROM match_quality")[0]
        for field in ("match_quality_score", "loss_attribution_weight", "win_evidence_weight", "explicit_afk",
                      "suspected_quasi_afk", "early_surrender", "anomaly_flags", "reason"):
            self.assertEqual(row[field], supplied[field], field)
        ledger = self.read("SELECT * FROM match_import_provenance")[0]
        self.assertEqual(ledger["classification"], "known_riot_default")
        self.assertEqual(ledger["source"], "legacy:strict_csv_signature")
        unknown = dict(row, identity_resolution="external", reason="Unidentified exporter")
        classification, overrides = legacy_import_provenance(unknown)
        self.assertEqual(classification, "unknown")
        self.assertEqual(overrides["loss_attribution_weight"], 0.63)
        # Numerical agreement with today's formula does not prove provenance.
        unknown["loss_attribution_weight"] = loss_attribution_weight(30)
        self.assertEqual(legacy_import_provenance(unknown)[0], "unknown")

    def test_set_clear_and_reprocess_restores_effective_riot_weight_model(self):
        detail = complete_detail()
        detail["info"]["participants"][0]["win"] = False
        self.seed({"M1": detail})
        supplied = normalized_row() | {"loss_attribution_weight": 0.63}
        riot_sync.ingest_normalized_rows([supplied], self.db, "manual_override")
        riot_sync.ingest_normalized_rows(
            [normalized_row() | {"loss_attribution_weight": None}],
            self.db,
            "manual_clear",
        )
        riot_sync.reprocess_raw_matches(self.db)

        ledger = self.read("SELECT source,classification,overrides_json FROM match_import_provenance")[0]
        self.assertEqual(ledger["source"], "riot_api_raw_reprocess")
        self.assertEqual(ledger["classification"], "known_riot_default")
        self.assertNotIn("loss_attribution_weight", json.loads(ledger["overrides_json"]))
        connection = self.storage.connect()
        try:
            evidence = load_effective_evidence(connection)[("Player#EUW", "M1")]
        finally:
            connection.close()
        self.assertEqual(evidence["attribution_source"], "configured_model")

    def test_identifiable_legacy_riot_default_is_recomputed_from_corrected_duration(self):
        detail = complete_detail()
        detail["info"]["participants"][0]["win"] = False
        self.seed({"M1": detail})
        legacy = normalized_row() | {
            "identity_resolution": "riot_api", "reason": "Imported from Riot Match-V5",
            "loss_attribution_weight": 0.45,
        }
        riot_sync.ingest_normalized_rows([legacy], self.db, "legacy_export")
        connection = self.storage.connect()
        connection.execute("DELETE FROM match_import_provenance")
        connection.commit(); connection.close()
        result = riot_sync.reprocess_raw_matches(self.db)
        self.assertEqual(result["updated"], 1)
        row = self.read("SELECT * FROM match_quality")[0]
        self.assertEqual(row["duration_minutes"], 30)
        self.assertEqual(row["loss_attribution_weight"], loss_attribution_weight(30))
        self.assertEqual(row["match_quality_score"], 0.95)
        self.assertEqual(self.read("SELECT classification FROM match_import_provenance"), [dict(classification="known_riot_default")])

    def test_conflicting_legacy_override_values_are_not_discarded_during_rename(self):
        self.seed({"M1": complete_detail()}, "Player#EUW")
        self.seed({"M1": complete_detail()}, "Renamed#EUW")
        riot_sync.ingest_normalized_rows([normalized_row() | {"loss_attribution_weight": 0.6},
                                         normalized_row("Renamed#EUW") | {"loss_attribution_weight": 0.8}], self.db, "csv")
        with self.assertRaisesRegex(AccountIdentityConflict, "Override storici discordanti"):
            riot_sync.reprocess_raw_matches(self.db)
        self.assertEqual({row["loss_attribution_weight"] for row in self.read("SELECT loss_attribution_weight FROM match_quality")}, {0.6, 0.8})
        self.assertEqual(self.read("SELECT * FROM riot_account_identities"), [])

    def test_identity_merge_rolls_back_feedback_migration_on_later_conflict(self):
        self.seed({"M1": complete_detail()}, "Player#EUW")
        self.seed({"M1": complete_detail()}, "Renamed#EUW")
        riot_sync.ingest_normalized_rows(
            [normalized_row() | {"loss_attribution_weight": 0.6},
             normalized_row("Renamed#EUW") | {"loss_attribution_weight": 0.8}],
            self.db,
            "csv",
        )
        connection = self.storage.connect()
        try:
            connection.execute(
                "INSERT INTO recommendation_preferences VALUES(?,?,?,?,?,?)",
                ("Player#EUW", "Player#EUW", "Ahri", "MIDDLE", "like", "now"),
            )
            connection.commit()
            before = [dict(row) for row in connection.execute(
                "SELECT * FROM recommendation_preferences"
            )]
            with self.assertRaisesRegex(AccountIdentityConflict, "Override storici discordanti"):
                reconcile_account_identity(connection, "Player#EUW", "p1", "Renamed#EUW")
            self.assertEqual(
                [dict(row) for row in connection.execute("SELECT * FROM recommendation_preferences")],
                before,
            )
            self.assertEqual(
                [dict(row) for row in connection.execute("SELECT * FROM riot_account_identities")],
                [],
            )
        finally:
            connection.close()


if __name__ == "__main__":
    unittest.main()
