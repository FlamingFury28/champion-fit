"""Contract and coverage checks for the pinned, offline champion catalog."""

import hashlib
import unittest
from unittest.mock import patch
from urllib.parse import urlsplit

from champion_taxonomy import (
    canonical_champion,
    champion_categories,
    champion_entry,
    load_catalog,
)


class ChampionTaxonomyTests(unittest.TestCase):
    def test_catalog_covers_exact_official_pinned_ids_and_category_contract(self):
        catalog = load_catalog()
        self.assertEqual(catalog["source_version"], "16.13.1")
        self.assertEqual(catalog["champion_count"], 173)
        identifiers = sorted(entry["id"] for entry in catalog["champions"])
        # Independently recorded from Riot's downloaded 16.13.1 champion.json.
        self.assertEqual(hashlib.sha256("\n".join(identifiers).encode()).hexdigest(),
                         "5f5ef592bf6cbd49e9170c81c15443f8d639fcbf03ef421a9ba7d713141b1e84")
        self.assertEqual(len(set(identifiers)), 173)
        categories = {category["id"]: category for category in catalog["categories"]}
        self.assertEqual(set(categories), {
            "class:tank", "class:fighter", "class:assassin", "class:mage",
            "class:marksman", "class:support", "style:engage", "style:peel",
            "style:poke", "style:burst", "style:sustained", "style:zone",
            "style:duel", "style:sidelane",
        })
        roles = {"TOP", "JUNGLE", "MIDDLE", "BOTTOM", "SUPPORT"}
        for category in categories.values():
            self.assertTrue(category["label"])
            self.assertTrue(category["criteria"])
            self.assertTrue(category["sources"])
            self.assertTrue(set(category["roles"]) <= roles)
            self.assertEqual(category["kind"], category["id"].split(":")[0])
        for entry in catalog["champions"]:
            self.assertTrue(entry["classes"])
            self.assertTrue(entry["tags"])
            self.assertTrue(entry["roles"])
            self.assertEqual(len(entry["roles"]), len(set(entry["roles"])))
            self.assertTrue(set(entry["roles"]) <= roles)
            for identifier in entry["classes"] + entry["tags"]:
                self.assertIn(identifier, categories)
                self.assertTrue(set(entry["roles"]) <= set(categories[identifier]["roles"]))
            self.assertTrue(all(identifier.startswith("class:") for identifier in entry["classes"]))
            self.assertTrue(all(identifier.startswith("style:") for identifier in entry["tags"]))

    def test_official_names_aliases_numeric_keys_and_assets_resolve(self):
        aliases = {
            "LeBlanc": "Leblanc", "  le blanc  ": "Leblanc",
            "Tahm Kench": "TahmKench", "tahm_kench": "TahmKench",
            "Wukong": "MonkeyKing", "62": "MonkeyKing",
            "Nunu & Willump": "Nunu", "Nunu e Willump": "Nunu",
            "Renata Glasc": "Renata", "K’Sante": "KSante",
            "Kai'Sa": "Kaisa", "Cho'Gath": "Chogath",
            "Dr. Mundo": "DrMundo", "FiddleSticks": "Fiddlesticks",
            "https://ddragon.leagueoflegends.com/cdn/16.13.1/img/champion/LeBlanc.png": "Leblanc",
            "https://ddragon.leagueoflegends.com/cdn/img/champion/splash/MonkeyKing_0.jpg?x=1": "MonkeyKing",
            "assets\\TahmKench.png": "TahmKench",
        }
        for alias, expected in aliases.items():
            with self.subTest(alias=alias):
                self.assertEqual(canonical_champion(alias), expected)
                self.assertEqual(champion_categories(alias), champion_categories(expected))
        for entry in load_catalog()["champions"]:
            self.assertEqual(canonical_champion(entry["id"]), entry["id"])
            self.assertEqual(canonical_champion(entry["name"]), entry["id"])
            self.assertEqual(canonical_champion(entry["key"]), entry["id"])

    def test_unknowns_do_not_receive_fallback_tags_or_fuzzy_matches(self):
        for value, expected in ((None, ""), ("", ""), ("  Future   Hero!  ", "Future Hero!"),
                                ("AhriNew", "AhriNew"), ("Tank", "Tank"),
                                ("UnknownChampion.png", "UnknownChampion.png")):
            self.assertEqual(canonical_champion(value), expected)
            self.assertIsNone(champion_entry(value))
            self.assertEqual(champion_categories(value), [])

    def test_results_are_offline_and_consumer_statistics_cannot_mutate_taxonomy(self):
        expected = champion_categories("LeBlanc")
        with patch("sqlite3.connect", side_effect=AssertionError("No match database may be read")), \
             patch("urllib.request.urlopen", side_effect=AssertionError("No network lookup may run")):
            entry = champion_entry("LeBlanc")
            entry.update(wins=0, losses=1000)
            entry["classes"].clear()
            entry["tags"].append("style:unknown")
            catalog = load_catalog()
            catalog["champions"].clear()
            self.assertEqual(champion_categories("Leblanc"), expected)
            self.assertEqual(len(load_catalog()["champions"]), 173)
            self.assertNotIn("wins", champion_entry("Leblanc"))

    def test_new_champions_and_class_role_distinction_are_explicit(self):
        self.assertEqual(champion_entry("Locke")["roles"], ["MIDDLE"])
        self.assertEqual(champion_entry("Zaahen")["roles"], ["TOP", "JUNGLE"])
        self.assertEqual(champion_entry("Yunara")["classes"], ["class:marksman"])
        self.assertEqual(champion_entry("Ivern")["roles"], ["JUNGLE"])
        self.assertIn("class:support", champion_entry("Ivern")["classes"])
        self.assertIn("style:sidelane", champion_categories("Fiora"))
        self.assertIn("style:peel", champion_categories("Janna"))
        self.assertNotIn("style:engage", champion_categories("Janna"))

    def test_sources_remain_consultable_primary_riot_urls(self):
        catalog = load_catalog()
        domains = {"ddragon.leagueoflegends.com", "developer.riotgames.com", "www.leagueoflegends.com"}
        urls = [source["url"] for source in catalog["sources"]]
        urls += [url for category in catalog["categories"] for url in category["sources"]]
        urls += [url for entry in catalog["champions"] for url in entry["sources"]]
        for url in urls:
            self.assertEqual(urlsplit(url).scheme, "https")
            self.assertIn(urlsplit(url).netloc, domains)


if __name__ == "__main__":
    unittest.main()
