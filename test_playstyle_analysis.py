"""Isolated invariants for overlapping archetypes and observed behavior."""
from datetime import datetime, timezone
import unittest
from unittest.mock import patch

from algorithm_settings import recommended_settings, settings_context
import playstyle_analysis as ps


def series(champion, wins, losses, account="one", prefix=None, **extra):
    return [{"account": account, "match_id": f"{prefix or champion + account}-{i}", "champion": champion,
             "win": int(i < wins), "role": "MIDDLE", "queue": "420", "date": "2026-08-01T00:00:00Z",
             "duration_minutes": 25, **extra} for i in range(wins + losses)]


class PlaystyleAnalysisTests(unittest.TestCase):
    def setUp(self):
        champions = [dict(id=c, name=c, classes=[], tags=tags, roles=["MIDDLE"])
                     for c, tags in (("A", ["x", "y"]), ("B", ["z"]), ("C", ["x"]),
                                     ("D", ["x", "y"]), ("E", ["x", "z"]))]
        catalog = {"version": "test", "source_version": "test", "sources": [], "champions": champions,
                   "categories": [dict(id=c, label=c, kind="style", criteria="test", roles=["MIDDLE"], sources=[])
                                  for c in ("x", "y", "z")]}
        entries = {entry["id"]: entry for entry in champions}
        self.patchers = [patch.object(ps, "load_catalog", return_value=catalog),
                         patch.object(ps, "canonical_champion", side_effect=lambda c: c),
                         patch.object(ps, "champion_entry", side_effect=entries.get),
                         patch.object(ps, "champion_categories", side_effect=lambda c: entries.get(c, {}).get("tags", []))]
        for patcher in self.patchers:
            patcher.start()
            self.addCleanup(patcher.stop)

    def rank(self, rows, accounts=None):
        return {r["id"]: r for r in ps.rank_categories(ps.deduplicate(rows), accounts or ["one"])}

    def test_overlaps_duplicate_once_and_global_baseline_exclusion(self):
        rows = series("A", 1, 0, prefix="shared") + series("B", 1, 0, "two", prefix="shared")
        rows += series("B", 0, 1, prefix="other") + series("C", 0, 1, "two", prefix="third")
        result = self.rank(rows + rows, ["one", "two"])
        self.assertEqual(result["x"]["observations"], 2)
        self.assertEqual(result["y"]["observations"], 1)
        self.assertEqual(result["x"]["baseline_games"], 1)
        self.assertEqual(result["x"]["support_per_account"]["two"]["baseline_games"], 0)
        self.assertFalse(result["x"]["supported"])

    def test_composition_uses_the_reason_for_each_category_only(self):
        ps.champion_entry("A")["tag_reasons"] = {"x": "Controlla lo spazio con terreno.",
                                                  "y": "Ripete danno con attacchi potenziati."}
        ranked = self.rank(series("A", 3, 2) + series("B", 2, 3))
        self.assertEqual(ranked["x"]["composition"][0]["reason"], "Controlla lo spazio con terreno.")
        self.assertEqual(ranked["y"]["composition"][0]["reason"], "Ripete danno con attacchi potenziati.")
        self.assertNotIn("reason", ranked["z"]["composition"][0])
        self.assertNotIn("reason", ps.composition(series("A", 3, 2))[0])
        self.assertEqual(ranked["x"]["composition"][0]["wins"], 3)

    def test_absent_accounts_or_complement_block_conclusions(self):
        rows = series("A", 100, 0) + series("B", 0, 100)
        self.assertTrue(self.rank(rows)["x"]["supported"])
        result = self.rank(rows, ["one", "absent"])["x"]
        self.assertFalse(result["supported"])
        self.assertIn("absent", result["missing_accounts"])
        no_base = self.rank(series("A", 100, 0))["x"]
        self.assertFalse(no_base["supported"])
        self.assertEqual(no_base["missing_baseline_accounts"], ["one"])
        self.assertIsNone(no_base["baseline_mean"])
        self.assertIsNone(no_base["baseline_lower_90"])
        self.assertIsNone(no_base["baseline_upper_90"])

    def test_support_uses_unique_matches_without_a_twenty_game_gate(self):
        rows = []
        for account in ("one", "two", "three"):
            rows += series("A", 19, 0, account, prefix="shared") + series("B", 0, 100, account)
        result = self.rank(rows, ["one", "two", "three"])["x"]
        self.assertEqual((result["games"], result["observations"]), (19, 57))
        self.assertTrue(result["supported"])

    def test_weights_do_not_affect_any_estimate_or_order(self):
        rows = series("A", 27, 13) + series("B", 10, 30)
        before = self.rank(rows)
        after = self.rank([{**r, "loss_attribution_weight": .01, "win_evidence_weight": 999,
                            "carryable_loss": 1, "invincible": 1} for r in rows])
        self.assertEqual(before, after)

    def test_conflicting_duplicate_is_rejected_before_inference(self):
        row = series("A", 1, 0)[0]
        with self.assertRaisesRegex(ValueError, "Duplicato account/partita in conflitto"):
            self.rank([row, {**row, "win": 0}])
        with self.assertRaisesRegex(ValueError, "champion"):
            ps.deduplicate([row, {**row, "champion": "B"}])

    def test_fixed_equal_account_weighting(self):
        rows = series("A", 90, 10) + series("B", 50, 50)
        rows += series("A", 0, 10, "two") + series("B", 5, 5, "two")
        result = self.rank(rows, ["one", "two"])["x"]
        expected = 100 * ((90 / 100) + (0 / 10)) / 2
        self.assertAlmostEqual(result["mean"], expected)

    def test_single_observed_game_is_raw_and_never_filled_from_a_prior(self):
        result = self.rank(series("A", 1, 0) + series("B", 0, 1))["x"]
        self.assertEqual(result["mean"], 100)
        self.assertEqual(result["baseline_mean"], 0)
        self.assertEqual(result["prior_share"], 0)
        self.assertIsNone(result["probability"])
        self.assertEqual(result["method"], "exact_binomial")
        self.assertFalse(result["supported"])

    def test_configured_intervals_reach_categories_sensitivity_and_played(self):
        rows = series("A", 27, 13) + series("C", 10, 10) + series("B", 10, 30)
        legacy = self.rank(rows)["x"]
        settings = recommended_settings()
        settings["evidence"]["credible_mass"] = .8
        settings["recommendations"]["confidence"] = .99
        with settings_context(settings):
            category = self.rank(rows)["x"]
            played = ps.suggestions(rows, rows, ["one"], "MIDDLE", category)["played"]
            empty = ps.contrast([], [], [], 3)
        self.assertEqual(category["credible_mass"], .8)
        self.assertEqual(category["lower_90"], legacy["lower_90"])
        self.assertEqual(category["upper_90"], legacy["upper_90"])
        self.assertEqual(category["mean"], legacy["mean"])
        self.assertEqual(category["supported"], legacy["supported"])
        for result in (category, category["sensitivity"], *played):
            self.assertEqual(result["credible_mass"], .8)
            self.assertGreater(result["lower"], result["lower_90"])
            self.assertLess(result["upper"], result["upper_90"])
        self.assertGreater(category["baseline_lower"], category["baseline_lower_90"])
        self.assertLess(category["baseline_upper"], category["baseline_upper_90"])
        self.assertIsNone(empty["lower"])
        self.assertEqual(empty["credible_mass"], .8)

    def test_dominant_champion_sensitivity_retains_family(self):
        result = self.rank(series("A", 100, 0) + series("C", 20, 20) + series("B", 50, 50))["x"]
        self.assertTrue(result["supported"])
        self.assertEqual(result["sensitivity"]["champion"], "A")
        self.assertTrue(result["sensitivity"]["depends_on_champion"])
        self.assertFalse(result["sensitivity"]["supported"])
        self.assertEqual(result["family_size"], 3)
        self.assertAlmostEqual(result["threshold"], 100 * (1 - .05 / (2 * 3)))

    def test_unknown_membership_is_not_a_complement(self):
        result = self.rank(series("A", 100, 0) + series("UNKNOWN", 0, 100))["x"]
        self.assertEqual(result["baseline_games"], 0)
        self.assertFalse(result["supported"])

    def test_shared_match_unknown_coverage_is_a_disjoint_partition(self):
        rows = series("A", 1, 0, prefix="shared") + series("UNKNOWN", 1, 0, "two", prefix="shared")
        result = ps.analyze(rows, rows, ["one", "two"], {"days": ["all"]})
        self.assertEqual(result["summary"]["unique_games"], 1)
        self.assertEqual(result["summary"]["classified_games"], 0)
        self.assertEqual(result["summary"]["unclassified_games"], 1)

    def test_lifetime_untried_and_jaccard_deterministic(self):
        rows = series("A", 30, 10) + series("B", 10, 30)
        category = self.rank(rows)["x"]
        result = ps.suggestions(rows, rows + series("D", 1, 0, date="2020-01-01"), ["one"], "MIDDLE", category)
        self.assertEqual([x["champion"] for x in result["untried"]], ["C", "E"])
        self.assertEqual(result["untried"][0]["similarity"], .5)
        self.assertEqual(result["untried"][0]["matched_tags"], ["x"])
        self.assertNotIn("mean", result["untried"][0])

    def test_filters_default_to_all_roles_and_keep_explicit_role(self):
        rows = ps.deduplicate(series("A", 30, 10, queue="Ranked Solo/Duo") + series("B", 10, 0, role="TOP", queue="Queue 400"))
        now = datetime(2026, 9, 8, tzinfo=timezone.utc)
        filters, _, scoped = ps.resolve_filters(rows, {}, now)
        self.assertEqual(filters, {"role": "ALL", "queue": "420", "days": "180"})
        self.assertEqual(len(scoped), 40)
        blank_filters, _, blank_scoped = ps.resolve_filters(rows, {"role": [" "]}, now)
        self.assertEqual(blank_filters, {"role": "ALL", "queue": "420", "days": "180"})
        self.assertEqual(len(blank_scoped), 40)
        filters, _, scoped = ps.resolve_filters(rows, {"role": ["TOP"], "queue": ["400"]}, now)
        self.assertEqual(filters["role"], "TOP")
        self.assertEqual(len(scoped), 10)
        with self.assertRaises(ValueError):
            ps.resolve_filters(rows, {"days": ["yesterday"]})
        empty_filters, _, empty_rows = ps.resolve_filters([], {})
        self.assertEqual(empty_filters, {"role": "ALL", "queue": "420", "days": "180"})
        self.assertFalse(empty_rows)

    def test_configured_context_keeps_all_roles_by_default(self):
        settings = recommended_settings()
        settings["context"] = {"queue": "400", "days": 365}
        rows = ps.deduplicate(
            series("A", 8, 0, role="TOP", queue="400")
            + series("B", 12, 0, role="MIDDLE", queue="420")
            + series("C", 3, 0, role="MIDDLE", queue="400")
        )
        with settings_context(settings):
            filters, _, scoped = ps.resolve_filters(rows, {}, datetime(2026, 9, 8, tzinfo=timezone.utc))
            explicit, _, empty = ps.resolve_filters(
                rows, {"role": ["SUPPORT"], "queue": ["420"], "days": ["90"]},
                datetime(2026, 9, 8, tzinfo=timezone.utc),
            )
        self.assertEqual(filters, {"role": "ALL", "queue": "400", "days": "365"})
        self.assertEqual(len(scoped), 11)
        self.assertEqual(explicit, {"role": "SUPPORT", "queue": "420", "days": "90"})
        self.assertFalse(empty)

    def test_configured_threshold_bins_cells_and_suggestion_limit(self):
        settings = recommended_settings()
        settings["evidence"]["min_games"] = 30
        settings["playstyle"].update(
            percentile_min_games=11, duration_bounds=[15, 25, 35], suggestion_limit=1,
        )
        rows = series("A", 25, 0) + series("B", 0, 40)
        with settings_context(settings):
            category = self.rank(rows)["x"]
            percentiles = ps.contextual_percentiles(series("A", 5, 5, farm=1), "farm")
            bands = [ps.duration_band(value) for value in (14.9, 15, 25, 35)]
            suggestions = ps.suggestions(rows, rows, ["one"], "MIDDLE", category)
        self.assertTrue(category["supported"])
        self.assertEqual(category["min_games"], 0)
        self.assertFalse(any("Meno di" in reason for reason in category["reasons"]))
        self.assertFalse(percentiles)
        self.assertEqual(bands, [0, 1, 2, 3])
        self.assertLessEqual(len(suggestions["played"]), 1)
        self.assertLessEqual(len(suggestions["untried"]), 1)

    def test_percentiles_use_both_outcomes_midranks_and_exact_cells(self):
        rows = series("A", 5, 5, farm=0)
        sparse = series("B", 4, 5, farm=9)
        percentiles = ps.contextual_percentiles(rows + sparse, "farm")
        self.assertEqual(set(percentiles.values()), {50})
        self.assertEqual(len(percentiles), 10)
        flipped = [{**r, "win": 1 - r["win"]} for r in rows + sparse]
        self.assertEqual(percentiles, ps.contextual_percentiles(flipped, "farm"))
        self.assertEqual([ps.duration_band(v) for v in (19.9, 20, 30, 40, None, 0)], [0, 1, 2, 3, None, None])
        mixed_bands = [{**r, "duration_minutes": 40 if i == 0 else 25} for i, r in enumerate(rows)]
        self.assertFalse(ps.contextual_percentiles(mixed_bands, "farm"))

    def test_behavior_equal_weights_same_accounts_missing_and_zero(self):
        rows = series("A", 10, 1, farm=0) + series("A", 1, 10, "two", farm=100)
        rows += series("A", 10, 0, "excluded", farm=999)
        result = ps.behavior_comparison(rows, ["one", "two", "excluded"], "farm")
        self.assertEqual(result["accounts"], 2)
        self.assertEqual(result["excluded_accounts"], ["excluded"])
        self.assertEqual(result["wins"], result["losses"])
        self.assertEqual(result["wins"]["q1"], 0)
        self.assertEqual(result["wins"]["q3"], 100)
        self.assertEqual(result["wins"]["median"], 50)
        self.assertIsNone(ps.behavior_comparison(rows, ["one"], "vision")["wins"])

    def test_single_account_median_averages_middle_pair(self):
        result = ps.weighted_distribution([(1, 1), (2, 1), (3, 1), (4, 1)])
        self.assertEqual(result, {"median": 2.5, "q1": 1.5, "q3": 3.5, "n": 4})

    def test_search_and_sort_never_change_family_and_evidence_pages(self):
        rows = series("A", 30, 10) + series("B", 10, 30)
        before = ps.analyze(rows, rows, ["one"], {"days": ["all"]})
        after = ps.analyze(rows, rows, ["one"], {"days": ["all"], "q": ["nothing"], "sort": ["games"]})
        self.assertEqual(before, after)
        page1 = ps.evidence(rows, {"days": ["all"], "category": ["x"], "page_size": ["5"]})
        page2 = ps.evidence(rows, {"days": ["all"], "category": ["x"], "page_size": ["5"], "page": ["2"]})
        self.assertEqual(page1["total"], 40)
        self.assertFalse({r["match_id"] for r in page1["matches"]} & {r["match_id"] for r in page2["matches"]})


if __name__ == "__main__":
    unittest.main()
