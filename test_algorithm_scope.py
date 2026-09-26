"""Algorithm scope audit: isolated SQLite fixtures; no operational DB access.

The Simpson and matrix tests protect corrections to the audited limitations.
Run directly for current audit JSON, or with pytest/unittest for the checks.
"""

from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

import app
from storage import SQLiteStorage


class ScopeFixture:
    def __init__(self, directory: Path):
        self.storage = SQLiteStorage(directory / "scope.db", app.SCHEMA_PATH)
        self.storage.initialize()
        self.next_id = 0

    def series(self, account, champion, games, wins, loss_weight=1.0):
        with closing(self.storage.connect()) as connection, connection:
            connection.execute(
                "INSERT OR IGNORE INTO champions VALUES(?,?,?)",
                (champion, champion, f"/{champion}.png"),
            )
            rows = []
            for i in range(games):
                self.next_id += 1
                win = int(i < wins)
                rows.append((
                    account, f"scope-{self.next_id}", "2026-08-01T12:00:00Z",
                    "16.16", "420", champion, "MIDDLE", "test", 30, win,
                    0, 0, 0, "none", 1, loss_weight if not win else 0,
                    1 if win else 0, "isolated scope audit",
                ))
            connection.executemany(
                """INSERT INTO match_quality
                (account,match_id,date,patch,queue,champion,role,identity_resolution,
                 duration_minutes,win,explicit_afk,suspected_quasi_afk,early_surrender,
                 anomaly_flags,match_quality_score,loss_attribution_weight,
                 win_evidence_weight,reason) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                rows,
            )

    def query(self, endpoint, accounts=None):
        params = {} if accounts is None else {"account": accounts}
        with patch.object(app, "STORAGE", self.storage):
            status, payload = app.query_database(endpoint, params)
        if status != 200:
            raise AssertionError((status, payload))
        return payload

    def recommendations(self, accounts=None):
        items = self.query("/api/profile", accounts)["recommendations"]
        # Selection labels may preserve input order; inference uses a set.
        for item in items:
            if "accounts" in item:
                item["accounts"] = sorted(item["accounts"])
        return items


def simpson_case(fixture):
    # A wins more often within each account. Exposure mix alone reverses pooling.
    fixture.series("low", "A", 900, 270)
    fixture.series("low", "B", 100, 20)
    fixture.series("high", "A", 100, 90)
    fixture.series("high", "B", 900, 720)
    return {
        "low": fixture.recommendations(["low"]),
        "high": fixture.recommendations(["high"]),
        "pooled": fixture.recommendations(["low", "high"]),
        "design": {
            "low": {"A": {"wins": 270, "games": 900}, "B": {"wins": 20, "games": 100}},
            "high": {"A": {"wins": 90, "games": 100}, "B": {"wins": 720, "games": 900}},
        },
    }


def matrix_case(fixture):
    fixture.series("selected", "A", 40, 20)
    fixture.series("selected", "B", 40, 28)
    before = {
        "recommendations": fixture.recommendations(["selected"]),
        "matrix": fixture.query("/api/champions", ["selected"])["items"],
    }
    with closing(fixture.storage.connect()) as connection, connection:
        connection.execute(
            "UPDATE match_quality SET loss_attribution_weight=0.1 WHERE champion='A' AND win=0"
        )
    after = {
        "recommendations": fixture.recommendations(["selected"]),
        "matrix": fixture.query("/api/champions", ["selected"])["items"],
    }
    return {"before": before, "after": after}


class AlgorithmScopeTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="champion-scope-audit-")
        self.addCleanup(self.directory.cleanup)
        self.fixture = ScopeFixture(Path(self.directory.name))

    def test_unselected_accounts_do_not_change_selected_profile_or_ranking(self):
        self.fixture.series("selected", "A", 20, 12)
        self.fixture.series("selected", "B", 20, 10)
        before = self.fixture.query("/api/profile", ["selected"])
        self.fixture.series("unselected", "A", 600, 0, 0.1)
        self.fixture.series("unselected", "Foreign", 300, 300)
        after = self.fixture.query("/api/profile", ["selected"])
        self.assertEqual(before, after)
        self.assertNotEqual(after["recommendations"], self.fixture.recommendations())

    def test_account_order_duplicates_and_csv_encoding_preserve_ranking(self):
        self.fixture.series("one", "A", 20, 12)
        self.fixture.series("two", "B", 20, 10)
        expected = self.fixture.recommendations(["one", "two"])
        self.assertEqual(expected, self.fixture.recommendations(["two", "one", "one"]))
        self.assertEqual(expected, self.fixture.recommendations([" two, one "]))

    def test_unknown_explicit_account_does_not_fall_back_to_all(self):
        self.fixture.series("selected", "A", 20, 12)
        payload = self.fixture.query("/api/profile", ["unknown"])
        self.assertEqual(0, payload["summary"]["games"])
        self.assertEqual([], payload["recommendations"])

    def test_omitting_account_means_all_accounts(self):
        self.fixture.series("one", "A", 20, 12)
        self.fixture.series("two", "B", 20, 10)
        self.assertEqual(self.fixture.recommendations(["one", "two"]), self.fixture.recommendations())

    def test_account_standardization_prevents_demonstrated_simpson_reversal(self):
        result = simpson_case(self.fixture)
        self.assertEqual("A", result["low"][0]["champion"])
        self.assertEqual("A", result["high"][0]["champion"])
        self.assertEqual("A", result["pooled"][0]["champion"])
        # Equal account standardization recovers A: 60% versus 50%.
        rates = {
            champion: sum(account[champion]["wins"] / account[champion]["games"]
                          for account in result["design"].values()) / 2
            for champion in ("A", "B")
        }
        self.assertGreater(rates["A"], rates["B"])

    def test_attribution_weights_do_not_change_outcome_ranking(self):
        result = matrix_case(self.fixture)
        before, after = result["before"], result["after"]
        self.assertEqual("B", before["recommendations"][0]["champion"])
        self.assertEqual("B", after["recommendations"][0]["champion"])
        self.assertEqual(["B", "A"], [row["champion"] for row in after["matrix"]])
        self.assertEqual(
            [row["posterior_win_rate"] for row in before["matrix"]],
            [row["posterior_win_rate"] for row in after["matrix"]],
        )
        adjusted = next(row for row in after["matrix"] if row["champion"] == "A")
        recommendation = next(row for row in after["recommendations"] if row["champion"] == "A")
        self.assertEqual(40, adjusted["effective_sample_size"])
        self.assertEqual(22, recommendation["effective_evidence"])


def audit_payload():
    with tempfile.TemporaryDirectory(prefix="champion-scope-audit-report-") as directory:
        directory = Path(directory)
        (directory / "simpson").mkdir()
        (directory / "matrix").mkdir()
        return {
            "source_sha256": {
                name: hashlib.sha256((app.APP_ROOT / name).read_bytes()).hexdigest()
                for name in ("app.py", "schema.sql", "frontend/src/pages/FitPage.tsx")
            },
            "simpson": simpson_case(ScopeFixture(directory / "simpson")),
            "weight_vs_matrix": matrix_case(ScopeFixture(directory / "matrix")),
        }


if __name__ == "__main__":
    import sys

    if len(sys.argv) == 3 and sys.argv[1] == "--report":
        output = Path(sys.argv[2])
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(audit_payload(), indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print(output)
    else:
        unittest.main()
