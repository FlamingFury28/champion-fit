import json
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

import app
from app import as_bool, rank_recommendations
from ingest import ingest
from match_scoring import loss_attribution_weight
from riot_sync import checkpoint_stem, reprocess_raw_matches
from storage import SQLiteStorage


class IngestTests(unittest.TestCase):
    def test_boolean_normalization_accepts_win_words(self):
        self.assertEqual(as_bool("win"), 1)
        self.assertEqual(as_bool("won"), 1)
        self.assertEqual(as_bool("loss"), 0)

    def test_boolean_normalization_rejects_false_string(self):
        self.assertEqual(as_bool("false"), 0)
        self.assertEqual(as_bool("0"), 0)

    def test_riot_checkpoint_names_do_not_collide_after_sanitization(self):
        self.assertNotEqual(checkpoint_stem("a-b#EUW"), checkpoint_stem("a_b#EUW"))

    def test_reprocess_raw_matches_uses_each_account_puuid_list(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "test.db"
            storage = SQLiteStorage(database, app.SCHEMA_PATH)
            storage.initialize()
            connection = storage.connect()
            payloads = {
                "M1": {
                    "metadata": {"matchId": "M1"},
                    "info": {"mapId": 11, "queueId": 420, "gameStartTimestamp": 1724198400000,
                             "gameDuration": 1800, "gameVersion": "14.16",
                             "participants": [{"puuid": "P1", "championName": "Vi", "teamPosition": "JUNGLE", "win": True}]},
                },
                "M2": {
                    "metadata": {"matchId": "M2"},
                    "info": {"mapId": 11, "queueId": 420, "gameStartTimestamp": 1724198400000,
                             "gameDuration": 1800, "gameVersion": "14.16",
                             "participants": [{"puuid": "P2", "championName": "LeeSin", "teamPosition": "JUNGLE", "win": False}]},
                },
            }
            connection.executemany(
                "INSERT INTO riot_accounts_raw(puuid,account,game_name,tag_line,fetched_at,payload_json) VALUES(?,?,?,?,?,?)",
                [("P1", "A#EUW", "A", "EUW", "now", "{}"),
                 ("P2", "A#EUW", "A", "EUW", "now", "{}")],
            )
            connection.executemany(
                "INSERT INTO riot_match_list_raw(account,puuid,fetched_at,match_ids_json) VALUES(?,?,?,?)",
                [("A#EUW", "P1", "now", json.dumps(["M1"])),
                 ("A#EUW", "P2", "now", json.dumps(["M2"]))],
            )
            # Explicit owner-provided PUUID history distinguishes this from a
            # Riot ID that two different owners used at different times.
            connection.executemany("INSERT INTO riot_account_aliases VALUES(?,?,?,?,?,?)", [
                ("A#EUW", "a#euw", "A#EUW", puuid, "imported_accounts_json", "now")
                for puuid in ("P1", "P2")
            ])
            connection.executemany(
                "INSERT INTO riot_match_raw(match_id,routing_region,fetched_at,payload_json) VALUES(?,?,?,?)",
                [(match_id, "europe", "now", json.dumps(payload)) for match_id, payload in payloads.items()],
            )
            connection.commit()
            connection.close()

            result = reprocess_raw_matches(database)

            self.assertEqual(result["normalized_rows"], 2)
            connection = sqlite3.connect(database)
            self.assertEqual(
                {row[0] for row in connection.execute("SELECT match_id FROM match_quality")},
                {"M1", "M2"},
            )
            connection.close()

    def test_accounts_api_unions_raw_ids_across_puuids(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "test.db"
            storage = SQLiteStorage(database, app.SCHEMA_PATH)
            storage.initialize()
            connection = storage.connect()
            connection.executemany(
                "INSERT INTO riot_match_list_raw(account,puuid,fetched_at,match_ids_json) VALUES(?,?,?,?)",
                [("A#EUW", "P1", "now", json.dumps(["M1", "M2"])),
                 ("A#EUW", "P2", "now", json.dumps(["M2", "M3"]))],
            )
            connection.commit()
            connection.close()

            with patch.object(app, "STORAGE", storage):
                status, payload = app.query_database("/api/accounts", {})

            self.assertEqual(status, 200)
            self.assertEqual(payload["items"][0]["games"], 3)

    def test_recommendations_keep_other_champions_out_of_personal_posterior(self):
        candidate = {"role": "JUNGLE", "champion": "Candidate", "games": 5,
                     "wins": 3,
                     "positive_evidence": 3, "negative_evidence": 2}
        isolated = rank_recommendations([candidate])[0]
        with_context = next(item for item in rank_recommendations([
            candidate,
            {"role": "JUNGLE", "champion": "Context", "games": 100,
             "wins": 90,
             "positive_evidence": 90, "negative_evidence": 10},
        ]) if item["champion"] == "Candidate")
        for field in ("posterior_fit", "credible_lower_90", "credible_upper_90", "score"):
            self.assertEqual(with_context[field], isolated[field])
        self.assertFalse(with_context["actionable"])

    def test_recommendations_reward_reliable_evidence_over_small_perfect_samples(self):
        candidates = [
            {"role": "JUNGLE", "champion": "Stable", "games": 20, "wins": 16, "positive_evidence": 16, "negative_evidence": 4},
            {"role": "JUNGLE", "champion": "Fluke", "games": 3, "wins": 3, "positive_evidence": 3, "negative_evidence": 0},
        ]
        ranked = rank_recommendations(candidates)

        self.assertEqual(ranked[0]["champion"], "Stable")
        self.assertGreater(ranked[0]["credible_lower_90"], ranked[1]["credible_lower_90"])

    def test_recommendations_do_not_use_blacklist_fields(self):
        candidate = {"role": "TOP", "champion": "FutureChampion", "games": 5,
                     "wins": 4,
                     "positive_evidence": 4, "negative_evidence": 1,
                     "blacklist_strong": 1, "blacklist_provisional": 1}
        ranked = rank_recommendations([candidate])

        self.assertEqual(ranked[0]["champion"], "FutureChampion")
        self.assertNotIn("blacklist", ranked[0])

    def test_loss_weight_uses_calibrated_duration_bands(self):
        self.assertEqual(loss_attribution_weight(9.9), 0.0)
        self.assertEqual(loss_attribution_weight(10.0), 0.04)
        self.assertEqual(loss_attribution_weight(14.9), 0.04)
        self.assertEqual(loss_attribution_weight(15.0), 0.15)
        self.assertEqual(loss_attribution_weight(18.0), 0.15)
        self.assertEqual(loss_attribution_weight(20.0), 0.35)
        self.assertEqual(loss_attribution_weight(23.0), 0.60)
        self.assertEqual(loss_attribution_weight(27.0), 0.88)

    def test_external_signals_reduce_duration_weight(self):
        self.assertEqual(loss_attribution_weight(25, "explicit_afk_teammate"), 0.0)
        self.assertLess(loss_attribution_weight(25, "early_team_collapse"), 0.60)
        self.assertLess(loss_attribution_weight(25, "surrender"), 0.60)

    def test_snapshot_without_explicit_weight_uses_duration_model(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            snapshot = root / "snapshot.json"
            database = root / "test.db"
            snapshot.write_text(json.dumps({
                "matches": [
                    {"account": "TestAccount#EUW", "match_id": "SHORT_001",
                     "date": "2026-08-21T00:00:00Z", "patch": "16.16",
                     "queue": "Ranked Solo/Duo", "champion": "Vi", "role": "JUNGLE",
                     "duration_minutes": 9.9, "win": False},
                    {"account": "TestAccount#EUW", "match_id": "MID_001",
                     "date": "2026-08-21T00:00:00Z", "patch": "16.16",
                     "queue": "Ranked Solo/Duo", "champion": "Vi", "role": "JUNGLE",
                     "duration_minutes": 18, "win": False},
                ]
            }), encoding="utf-8")

            ingest(snapshot, database)
            connection = sqlite3.connect(database)
            weights = dict(connection.execute(
                "SELECT match_id, loss_attribution_weight FROM match_quality"
            ).fetchall())
            connection.close()
            self.assertEqual(weights["SHORT_001"], 0.0)
            self.assertEqual(weights["MID_001"], 0.15)

    def test_urf_is_not_imported(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            snapshot = root / "snapshot.json"
            database = root / "test.db"
            snapshot.write_text(json.dumps({
                "matches": [
                    {"account": "Test#EUW", "match_id": "URF_001", "date": "2026-08-21T00:00:00Z",
                     "patch": "16.16", "queue": "Queue 900", "champion": "Samira", "role": "INVALID",
                     "duration_minutes": 20, "win": True},
                    {"account": "Test#EUW", "match_id": "RANKED_001", "date": "2026-08-21T00:00:00Z",
                     "patch": "16.16", "queue": "Ranked Solo/Duo", "champion": "Vi", "role": "JUNGLE",
                     "duration_minutes": 20, "win": True},
                ]
            }), encoding="utf-8")

            result = ingest(snapshot, database)

            self.assertEqual(result["inserted"], 1)
            self.assertEqual(result["skipped"], 1)
            connection = sqlite3.connect(database)
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM match_quality WHERE queue='Queue 900'").fetchone()[0], 0)
            columns = {row[1] for row in connection.execute("PRAGMA table_info(match_quality)")}
            self.assertNotIn("personal_performance_score", columns)
            connection.close()

    def test_aram_is_not_imported(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            snapshot = root / "snapshot.json"
            database = root / "test.db"
            snapshot.write_text(json.dumps({
                "matches": [{"account": "Test#EUW", "match_id": "ARAM_001", "date": "2026-08-21T00:00:00Z",
                              "patch": "16.16", "queue": "Queue 450", "champion": "Samira", "role": "INVALID",
                              "duration_minutes": 20, "win": True}]
            }), encoding="utf-8")

            result = ingest(snapshot, database)

            self.assertEqual(result["inserted"], 0)
            self.assertEqual(result["skipped"], 1)

    def test_snapshot_import_is_idempotent_and_records_sync_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            snapshot = root / "snapshot.json"
            database = root / "test.db"
            snapshot.write_text(json.dumps({
                "source": "test-exporter",
                "matches": [{
                    "account": "TestAccount#EUW", "match_id": "TEST_001",
                    "date": "2026-08-21T00:00:00Z", "patch": "16.16",
                    "queue": "Ranked Solo/Duo", "champion": "Vi", "role": "JUNGLE",
                    "duration_minutes": 28.4, "win": True,
                }],
            }), encoding="utf-8")

            first = ingest(snapshot, database)
            second = ingest(snapshot, database)

            self.assertEqual(first["inserted"], 1)
            self.assertEqual(first["skipped"], 0)
            self.assertEqual(second["inserted"], 0)
            self.assertEqual(second["skipped"], 1)
            connection = sqlite3.connect(database)
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM match_quality").fetchone()[0], 1)
            metadata = dict(connection.execute("SELECT key,value FROM source_metadata"))
            self.assertEqual(metadata["last_sync_source"], "test-exporter")
            self.assertEqual(metadata["last_sync_inserted"], "0")
            connection.close()

    def test_snapshot_numeric_boolean_flags_preserve_outcomes_and_are_idempotent(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            snapshot = root / "snapshot.json"
            database = root / "test.db"
            rows = [
                {
                    "account": "TestAccount#EUW", "match_id": f"NUMERIC_{index}",
                    "date": "2026-08-21T00:00:00Z", "patch": "16.16",
                    "queue": "Ranked Solo/Duo", "champion": "Vi", "role": "JUNGLE",
                    "duration_minutes": 28.4, "win": value,
                    "explicit_afk": value, "suspected_quasi_afk": value,
                    "early_surrender": value,
                }
                for index, value in enumerate((0, 1, 0.0, 1.0))
            ]
            snapshot.write_text(json.dumps({"matches": rows}), encoding="utf-8")

            self.assertEqual(ingest(snapshot, database)["inserted"], 4)
            with closing(sqlite3.connect(database)) as connection:
                stored = connection.execute(
                    "SELECT win,explicit_afk,suspected_quasi_afk,early_surrender,"
                    "win_evidence_weight,loss_attribution_weight "
                    "FROM match_quality ORDER BY match_id"
                ).fetchall()
                self.assertEqual(stored, [
                    (0, 0, 0, 0, 0.0, 0.88),
                    (1, 1, 1, 1, 0.95, 0.0),
                    (0, 0, 0, 0, 0.0, 0.88),
                    (1, 1, 1, 1, 0.95, 0.0),
                ])
                provenance = [json.loads(row[0]) for row in connection.execute(
                    "SELECT overrides_json FROM match_import_provenance ORDER BY match_id"
                )]
                self.assertEqual(provenance, [
                    {field: row[field] for field in (
                        "explicit_afk", "suspected_quasi_afk", "early_surrender",
                    )}
                    for row in rows
                ])

            repeated = ingest(snapshot, database)
            self.assertEqual(repeated["inserted"], 0)
            self.assertEqual(repeated["updated"], 0)
            self.assertEqual(repeated["skipped"], 4)

    def test_incomplete_or_malformed_snapshot_cannot_overwrite_match_or_provenance(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            snapshot = root / "snapshot.json"
            database = root / "test.db"
            valid = {
                "account": "TestAccount#EUW", "match_id": "TEST_001",
                "date": "2026-08-21T00:00:00Z", "patch": "16.16",
                "queue": "Ranked Solo/Duo", "champion": "Vi", "role": "JUNGLE",
                "duration_minutes": 28.4, "win": False,
                "loss_attribution_weight": 0.4, "reason": "Reviewed export",
            }
            snapshot.write_text(json.dumps({"source": "trusted", "matches": [valid]}), encoding="utf-8")
            self.assertEqual(ingest(snapshot, database)["inserted"], 1)
            connection = sqlite3.connect(database)
            before_match = connection.execute(
                "SELECT * FROM match_quality WHERE account=? AND match_id=?",
                ("TestAccount#EUW", "TEST_001"),
            ).fetchone()
            before_ledger = connection.execute(
                "SELECT * FROM match_import_provenance WHERE account=? AND match_id=?",
                ("TestAccount#EUW", "TEST_001"),
            ).fetchone()
            connection.close()

            incomplete = valid | {"champion": "Ahri", "reason": "must not land"}
            incomplete.pop("patch")
            malformed = valid | {"duration_minutes": "not-a-duration", "reason": "must not land"}
            snapshot.write_text(json.dumps({"source": "broken", "matches": [incomplete, malformed]}), encoding="utf-8")
            result = ingest(snapshot, database)

            self.assertEqual(result["updated"], 0)
            self.assertEqual(result["skipped"], 2)
            connection = sqlite3.connect(database)
            self.assertEqual(connection.execute(
                "SELECT * FROM match_quality WHERE account=? AND match_id=?",
                ("TestAccount#EUW", "TEST_001"),
            ).fetchone(), before_match)
            self.assertEqual(connection.execute(
                "SELECT * FROM match_import_provenance WHERE account=? AND match_id=?",
                ("TestAccount#EUW", "TEST_001"),
            ).fetchone(), before_ledger)
            connection.close()

    def test_null_optional_text_clears_override_without_materializing_none(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            snapshot = root / "snapshot.json"
            database = root / "test.db"
            row = {
                "account": "TestAccount#EUW", "match_id": "TEST_001",
                "date": "2026-08-21T00:00:00Z", "patch": "16.16",
                "queue": "Ranked Solo/Duo", "champion": "Vi", "role": "JUNGLE",
                "duration_minutes": 28.4, "win": False,
                "reason": "Reviewed export", "identity_resolution": "csv",
            }
            snapshot.write_text(json.dumps({"matches": [row]}), encoding="utf-8")
            ingest(snapshot, database)
            row |= {"reason": None, "identity_resolution": None}
            snapshot.write_text(json.dumps({"matches": [row]}), encoding="utf-8")
            ingest(snapshot, database)

            connection = sqlite3.connect(database)
            stored = connection.execute(
                "SELECT reason,identity_resolution FROM match_quality"
            ).fetchone()
            ledger = json.loads(connection.execute(
                "SELECT overrides_json FROM match_import_provenance"
            ).fetchone()[0])
            connection.close()
            self.assertEqual(stored, ("Imported normalized match", "external"))
            self.assertNotIn("reason", ledger)


if __name__ == "__main__":
    unittest.main()
