"""New endpoint contracts with isolated SQLite data and real taxonomy."""
from contextlib import closing
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import app
from test_algorithm_scope import ScopeFixture


class PlaystyleApiTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="playstyle-api-")
        self.addCleanup(self.directory.cleanup)
        self.fixture = ScopeFixture(Path(self.directory.name))
        self.fixture.series("selected", "Lux", 30, 22)
        self.fixture.series("selected", "Garen", 30, 8)

    def query(self, endpoint="/api/playstyles", **params):
        arguments = {"account": ["selected"], **{k: [str(v)] for k, v in params.items()}}
        with patch.object(app, "STORAGE", self.fixture.storage):
            return app.query_database(endpoint, arguments)

    def test_omitted_role_aggregates_and_explicit_role_is_preserved(self):
        status, body = self.query()
        self.assertEqual(status, 200)
        self.assertEqual(len(body["categories"]), 14)
        self.assertTrue(all(c["family_size"] == 14 for c in body["categories"]))
        self.assertEqual(body["summary"]["unique_games"], 60)
        self.assertEqual(body["summary"]["metrics_games"], 0)
        self.assertEqual(body["filters"], {"role": "ALL", "queue": "420", "days": "180"})
        self.assertTrue(all(b["raw"]["wins"] is None for b in body["behavior"]))
        status, explicit = self.query(role="MIDDLE")
        self.assertEqual(status, 200)
        self.assertEqual(explicit["filters"], {"role": "MIDDLE", "queue": "420", "days": "180"})
        self.assertEqual(explicit["summary"]["unique_games"], 60)

    def test_loss_attribution_and_annotations_change_only_evidence_notes(self):
        _, before = self.query()
        with closing(self.fixture.storage.connect()) as connection, connection:
            connection.execute("UPDATE match_quality SET loss_attribution_weight=.01,win_evidence_weight=.01")
            connection.execute("INSERT INTO match_annotations(match_id,note,updated_at) VALUES(?,?,?)", ("scope-1", "Nota modificata", "2026-09-08"))
        _, after = self.query()
        self.assertEqual(before, after)
        status, evidence = self.query("/api/playstyle-evidence", category="class:mage", page_size=100)
        self.assertEqual(status, 200)
        self.assertEqual(evidence["total"], 30)
        self.assertIn("Nota modificata", [r["note"] for r in evidence["matches"]])

    def test_never_played_checks_lifetime_not_displayed_period(self):
        self.fixture.series("selected", "Annie", 1, 1)
        with closing(self.fixture.storage.connect()) as connection, connection:
            connection.execute("UPDATE match_quality SET date='2020-01-01' WHERE champion='Annie'")
        status, body = self.query(category="class:mage", days=180)
        self.assertEqual(status, 200)
        self.assertNotIn("Annie", [r["champion"] for r in body["suggestions"]["untried"]])
        self.assertNotIn("Annie", [r["champion"] for r in body["suggestions"]["played"]])

    def test_explicit_empty_scope_unknown_account_and_bad_filters(self):
        for params in ({"role": "SUPPORT", "queue": "700"}, {"account": "missing"}):
            status, body = self.query(**params)
            self.assertEqual(status, 200)
            self.assertEqual(body["summary"]["unique_games"], 0)
            self.assertFalse(any(c["supported"] for c in body["categories"]))
        self.assertEqual(self.query(days="bad")[0], 400)
        self.assertEqual(self.query(category="made-up")[0], 400)
        self.assertEqual(self.query("/api/playstyle-evidence", category="class:mage", page="bad")[0], 400)

    def test_companion_filter_does_not_reset_lifetime_history(self):
        self.fixture.series("selected", "Annie", 1, 1)
        with closing(self.fixture.storage.connect()) as connection, connection:
            connection.execute("INSERT INTO match_participants(match_id,puuid,riot_id,team_id,win,champion) VALUES(?,?,?,?,?,?)",
                               ("scope-61", "friend", "friend", 100, 1, "Garen"))
        status, body = self.query(category="class:mage", companion_account="friend", companion_mode="exclude")
        self.assertEqual(status, 200)
        self.assertEqual(body["summary"]["unique_games"], 60)
        self.assertNotIn("Annie", [r["champion"] for r in body["suggestions"]["untried"]])

    def test_suspended_identity_vetoes_analysis_without_erasing_history(self):
        with closing(self.fixture.storage.connect()) as connection, connection:
            connection.execute("INSERT INTO riot_account_identities VALUES('owner','selected')")
            connection.execute("INSERT INTO riot_identity_policy(puuid,identity_id,state,resume_state,source,note,updated_at,history_json) VALUES('p','owner','exception','assumed','manual','review','now','[]')")
        status, body = self.query(category="class:mage", role="MIDDLE", queue="420")
        self.assertEqual(status, 200)
        self.assertEqual(body["summary"]["accounts"], 1)
        self.assertEqual(body["summary"]["observations"], 0)
        self.assertFalse(any(c["supported"] for c in body["categories"]))
        self.assertNotIn("Lux", [c["champion"] for c in body["suggestions"]["untried"]])
        self.assertTrue(any("Identità sospesa" in note for note in body["notes"]))
        with closing(self.fixture.storage.connect()) as connection, connection:
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM match_quality").fetchone()[0], 60)
            connection.execute("UPDATE riot_identity_policy SET state='assumed'")
        self.assertEqual(self.query()[1]["summary"]["observations"], 60)


if __name__ == "__main__":
    unittest.main()
