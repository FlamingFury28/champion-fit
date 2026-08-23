import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from app import as_bool, rank_recommendations
from ingest import ingest
from match_scoring import loss_attribution_weight
from riot_sync import checkpoint_stem


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

    def test_recommendations_include_other_champions_evidence_in_posterior(self):
        candidate = {"role": "JUNGLE", "champion": "Candidate", "games": 5,
                     "positive_evidence": 3, "negative_evidence": 2}
        isolated = rank_recommendations([candidate])[0]
        with_context = rank_recommendations([
            candidate,
            {"role": "JUNGLE", "champion": "Context", "games": 100,
             "positive_evidence": 90, "negative_evidence": 10},
        ])[0]
        self.assertGreater(with_context["posterior_fit"], isolated["posterior_fit"])

    def test_recommendations_reward_reliable_evidence_over_small_perfect_samples(self):
        candidates = [
            {"role": "JUNGLE", "champion": "Stable", "games": 20, "positive_evidence": 16, "negative_evidence": 4},
            {"role": "JUNGLE", "champion": "Fluke", "games": 3, "positive_evidence": 3, "negative_evidence": 0},
        ]
        ranked = rank_recommendations(candidates)

        self.assertEqual(ranked[0]["champion"], "Stable")
        self.assertGreater(ranked[0]["credible_lower_90"], ranked[1]["credible_lower_90"])

    def test_recommendations_do_not_use_blacklist_fields(self):
        candidate = {"role": "TOP", "champion": "FutureChampion", "games": 5,
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


if __name__ == "__main__":
    unittest.main()
