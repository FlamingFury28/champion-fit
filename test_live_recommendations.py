"""Tests for pure live uncertainty-reduction and taxonomy exploration."""
import unittest

from algorithm_settings import recommended_settings, settings_context
from live_recommendations import exploration, training_plan


def candidate(champion, unique_games=12, accounts=("a", "b"), wins=6, losses=6):
    cells = {
        account: {
            "wins": wins,
            "losses": losses,
            "baseline_wins": 10,
            "baseline_losses": 10,
        }
        for account in accounts
    }
    observations = (wins + losses) * len(accounts)
    return {
        "champion": champion,
        "role": "MIDDLE",
        "games": observations,
        "unique_games": unique_games,
        "wins": wins * len(accounts),
        "losses": losses * len(accounts),
        "positive_evidence": wins * len(accounts),
        "negative_evidence": losses * len(accounts),
        "account_cells": cells,
        "accounts": list(accounts),
    }


class TrainingPlanTests(unittest.TestCase):
    def test_budget_is_total_exact_and_ties_are_stable(self):
        first = training_plan([candidate("Ahri")], ["b", "a"], budget=5)
        second = training_plan([candidate("Ahri")], ["a", "b"], budget=5)
        self.assertEqual(first, second)
        self.assertEqual(first["budget_assigned"], 5)
        self.assertEqual(first["items"][0]["allocation_games"], 5)
        self.assertEqual(
            first["items"][0]["account_allocations"],
            [{"account": "a", "games": 3}, {"account": "b", "games": 2}],
        )

    def test_expected_variance_uses_each_account_posterior(self):
        row = candidate("Ahri", accounts=("a",), wins=2, losses=2)
        result = training_plan([row], ["a"], budget=3)["items"][0]
        variance = 6 * 6 / (12 * 12 * 13)
        self.assertAlmostEqual(result["expected_variance_now"], variance)
        self.assertAlmostEqual(result["expected_variance_after"], variance * 12 / 15)
        self.assertAlmostEqual(result["expected_variance_reduction"], variance * 3 / 15)

    def test_unique_games_drive_display_and_empty_eligible_assigns_nothing(self):
        row = candidate("Ahri", unique_games=2, accounts=("a",), wins=50, losses=0)
        result = training_plan([row], ["a"], budget=7)
        self.assertEqual(result["budget_total"], 7)
        self.assertEqual(result["budget_assigned"], 0)
        self.assertEqual(result["items"], [])

    def test_sparse_account_stays_non_actionable_and_receives_uncertainty_budget(self):
        row = candidate("Ahri", accounts=("a",), wins=12, losses=0)
        row["accounts"] = ["a", "b"]
        row["account_cells"]["b"] = {
            "wins": 0, "losses": 0, "baseline_wins": 10, "baseline_losses": 10,
        }
        result = training_plan([row], ["a", "b"], budget=1)
        item = result["items"][0]
        self.assertFalse(item["actionable"])
        self.assertEqual(item["account_allocations"], [
            {"account": "a", "games": 0}, {"account": "b", "games": 1},
        ])
        self.assertNotIn("vittoria attesa", item["rationale"].casefold())

    def test_settings_change_default_budget_candidate_cap_and_prior(self):
        settings = recommended_settings()
        settings["training"].update(budget=4, max_candidates=1)
        settings["evidence"]["prior_strength"] = 20
        with settings_context(settings):
            result = training_plan([candidate("Ahri"), candidate("Annie")], ["a", "b"])
        self.assertEqual((result["budget_total"], result["budget_default"]), (4, 4))
        self.assertEqual(len(result["items"]), 1)
        self.assertEqual(result["budget_assigned"], 4)
        # Beta(16,16) for each account after six wins and six losses.
        self.assertAlmostEqual(result["items"][0]["expected_variance_now"], 256 / (32 * 32 * 33))

    def test_budget_validation_and_no_accounts(self):
        for invalid in (0, 2001, True, "1.5"):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                training_plan([candidate("Ahri")], ["a"], invalid)
        result = training_plan([candidate("Ahri")], [], 4)
        self.assertEqual((result["budget_assigned"], result["items"]), (0, []))


class ExplorationTests(unittest.TestCase):
    def data(self):
        return {
            "catalog": {"version": "taxonomy-test"},
            "filters": {"role": "MIDDLE"},
            "suggestions": {
                "category_id": "Mage",
                "exploratory": True,
                "played": [{"champion": "Ahri"}],
                "untried": [
                    {"champion": "Orianna", "roles": ["MIDDLE"], "similarity": .5},
                    {"champion": "Annie", "roles": ["MIDDLE"], "similarity": .5},
                    {"champion": "Garen", "roles": ["TOP"], "similarity": .2},
                ],
            },
        }

    def test_exploration_has_no_personal_probability_and_enforces_role(self):
        result = exploration(self.data())
        self.assertEqual(result["taxonomy_version"], "taxonomy-test")
        self.assertEqual([item["champion"] for item in result["items"]], ["Orianna", "Annie"])
        for item in result["items"]:
            self.assertEqual(item["classification"], "exploration")
            self.assertEqual(item["lifetime_games_selected"], 0)
            self.assertEqual(item["role"], "MIDDLE")
            self.assertFalse(any("probab" in key or "win_rate" in key for key in item))
            self.assertIn("non è una probabilità personale", item["rationale"])

    def test_exploration_uses_configured_limit(self):
        settings = recommended_settings()
        settings["playstyle"]["suggestion_limit"] = 1
        with settings_context(settings):
            result = exploration(self.data())
        self.assertEqual(len(result["items"]), 1)


if __name__ == "__main__":
    unittest.main()
