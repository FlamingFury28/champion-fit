from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
import sqlite3
import tempfile
import unittest

import validate_algorithm_settings as validation


UTC = timezone.utc


def when(value: str) -> datetime:
    return datetime.fromisoformat(value).replace(tzinfo=UTC)


def observation(account, match_id, occurred_at, win, *, role="MIDDLE", champion="Ahri"):
    return validation.Observation(
        account=account,
        identity_group=account,
        match_id=match_id,
        occurred_at=when(occurred_at),
        role=role,
        champion=champion,
        win=win,
    )


class AlgorithmSettingsValidationTests(unittest.TestCase):
    def test_prior_is_contributed_once(self):
        self.assertEqual(validation.posterior_mean(2, 3, 8), 6 / 11)
        self.assertEqual(validation.posterior_mean(0, 0, 8), 0.5)
        with self.assertRaises(ValueError):
            validation.posterior_mean(4, 3, 8)

    def test_replay_has_embargo_and_no_future_leakage(self):
        fold = validation.FoldSpec("april", when("2026-04-01"), when("2026-05-01"))
        rows = [
            observation("a", "train", "2026-03-01", 1),
            # Inside the 24-hour embargo: it must not enter training.
            observation("a", "embargo", "2026-03-31T12:00:00", 0),
            observation("a", "test", "2026-04-02", 0),
            observation("a", "future", "2026-05-02", 1),
        ]
        first = validation.replay_fold(
            rows, fold, lookback_days=180, embargo_hours=24,
            prior_strengths=(8.0,),
        )
        changed = rows[:-1] + [observation("a", "future", "2026-05-02", 0)]
        second = validation.replay_fold(
            changed, fold, lookback_days=180, embargo_hours=24,
            prior_strengths=(8.0,),
        )
        self.assertEqual(first["predictions"][0]["champion_history_games"], 1)
        self.assertEqual(
            first["predictions"][0]["probabilities"],
            second["predictions"][0]["probabilities"],
        )
        self.assertEqual(first["predictions"][0]["probabilities"]["champion_s8"], 5 / 9)

    def test_shared_match_is_one_cluster_but_two_observations(self):
        fold = validation.FoldSpec("one", when("2026-04-01"), when("2026-05-01"))
        rows = [
            observation("a", "shared", "2026-04-02", 1),
            observation("b", "shared", "2026-04-02", 0),
            observation("a", "solo", "2026-04-03", 1),
        ]
        replay = validation.replay_fold(
            rows, fold, lookback_days=180, embargo_hours=24,
            prior_strengths=(8.0,),
        )
        replay["scores"] = validation.score_fold(
            replay, ("null_0_5", "champion_s8"),
        )
        report = validation._fold_report(replay)
        self.assertEqual(report["test_observations"], 3)
        self.assertEqual(report["test_unique_matches"], 2)
        self.assertEqual(report["test_accounts"], 2)
        self.assertEqual(report["scores"]["null_0_5"]["global_match"]["brier"], 0.25)

    def test_duplicate_account_match_is_rejected(self):
        row = observation("a", "m", "2026-04-02", 1)
        with self.assertRaisesRegex(ValueError, "duplicate account/match"):
            validation.validate_observations([row, row])

    def test_fixed_default_is_not_replaced_by_the_least_bad_grid_member(self):
        selection = []
        rows = []
        for month in range(3, 9):
            start = datetime(2026, month, 1, tzinfo=UTC)
            end = validation._next_month(start)
            selection.append(validation.FoldSpec(start.strftime("%Y-%m"), start, end))
            account = f"selection-{month}"
            rows.extend([
                validation.Observation(account, account, f"train-{month}", start.replace(day=1) - validation.timedelta(days=30), "MIDDLE", "Ahri", 1),
                validation.Observation(account, account, f"test-{month}", start.replace(day=2), "MIDDLE", "Ahri", 0),
            ])
        final_start = datetime(2026, 9, 1, tzinfo=UTC)
        rows.extend([
            validation.Observation("final", "final", "final-train", final_start - validation.timedelta(days=30), "MIDDLE", "Ahri", 1),
            validation.Observation("final", "final", "final-test", final_start.replace(day=2), "MIDDLE", "Ahri", 0),
        ])
        report = validation.validate_settings(
            rows,
            selection_folds=selection,
            final_fold=validation.FoldSpec("final", final_start, datetime(2026, 10, 1, tzinfo=UTC)),
            bootstrap_reps=25,
        )
        self.assertEqual(report["selection"]["empirical_grid_best_strength"], 20.0)
        self.assertEqual(report["decision"]["recommended_prior_strength"], 8.0)
        self.assertFalse(report["decision"]["promotion_eligible"])

    def test_loader_canonicalizes_verified_alias_and_excludes_exception_group(self):
        with tempfile.TemporaryDirectory() as directory:
            db = Path(directory) / "fixture.db"
            connection = sqlite3.connect(db)
            connection.executescript("""
                CREATE TABLE match_quality(
                    account TEXT, match_id TEXT, date TEXT, role TEXT,
                    champion TEXT, win INTEGER, queue TEXT,
                    win_evidence_weight REAL, loss_attribution_weight REAL
                );
                CREATE TABLE riot_account_identities(identity_id TEXT, account TEXT);
                CREATE TABLE riot_identity_puuids(puuid TEXT, identity_id TEXT);
                CREATE TABLE riot_account_aliases(
                    account TEXT, normalized_riot_id TEXT, display_riot_id TEXT,
                    puuid TEXT, verification_source TEXT, verified_at TEXT
                );
                CREATE TABLE riot_identity_policy(
                    puuid TEXT, identity_id TEXT, state TEXT
                );
            """)
            connection.executemany(
                "INSERT INTO riot_account_identities VALUES(?,?)",
                [("owner-id", "Owner#EUW"), ("blocked-id", "Blocked#EUW")],
            )
            connection.executemany(
                "INSERT INTO riot_identity_puuids VALUES(?,?)",
                [("p1", "owner-id"), ("p2", "blocked-id")],
            )
            connection.execute(
                "INSERT INTO riot_account_aliases VALUES(?,?,?,?,?,?)",
                ("Owner#EUW", "old#euw", "Old#EUW", "p1", "verified", "now"),
            )
            connection.execute(
                "INSERT INTO riot_identity_policy VALUES(?,?,?)",
                ("p2", "blocked-id", "exception"),
            )
            connection.executemany(
                "INSERT INTO match_quality VALUES(?,?,?,?,?,?,?,?,?)",
                [
                    ("Old#EUW", "m1", "2026-04-01T12:00:00Z", "MIDDLE", "Ahri", 1, "420", 0.0, 999.0),
                    ("Blocked#EUW", "m2", "2026-04-02T12:00:00Z", "MIDDLE", "Ahri", 0, "420", 999.0, 0.0),
                ],
            )
            connection.commit()
            connection.close()
            loaded, metadata = validation.load_observations(db)
        self.assertEqual([(row.account, row.win) for row in loaded], [("Owner#EUW", 1)])
        self.assertEqual(metadata["exception_observations_excluded"], 1)
        self.assertFalse(metadata["raw_json_tables_read"])

    def test_optional_scipy_reference_for_posterior_mean(self):
        try:
            from scipy.stats import beta
        except ImportError:
            self.skipTest("SciPy is optional")
        self.assertAlmostEqual(validation.posterior_mean(7, 10, 8), beta.mean(11, 7), places=14)


if __name__ == "__main__":
    unittest.main()
