"""Contracts for descriptive, outcome-independent preference recommendations."""

import builtins
import sys
from types import ModuleType
from unittest.mock import patch

import pytest

from preference_recommendations import build_recommendations


CATALOG = {
    "version": "fixture", "source_version": "fixture", "categories": [
        {"id": "class:mage", "label": "Maghi"}, {"id": "style:poke", "label": "Poke"},
        {"id": "class:tank", "label": "Tank"},
    ],
    "champions": [
        {"id": "A", "name": "Alpha", "aliases": ["Alias Alpha"], "classes": ["class:mage"], "tags": ["style:poke"], "roles": ["MIDDLE"]},
        {"id": "B", "name": "Beta", "classes": ["class:mage"], "tags": ["style:poke"], "roles": ["MIDDLE"]},
        {"id": "C", "name": "Gamma", "classes": ["class:mage"], "tags": [], "roles": ["MIDDLE"]},
        {"id": "D", "name": "Delta", "classes": ["class:tank"], "tags": [], "roles": ["TOP", "MIDDLE"]},
        {"id": "E", "name": "Epsilon", "classes": ["class:tank"], "tags": [], "roles": ["TOP"]},
    ],
}


def row(account, match_id, champion, *, date="2026-09-01T10:00:00Z", win=1, role="MIDDLE", **more):
    return {
        "account": account, "match_id": match_id, "champion": champion, "date": date,
        "win": win, "role": role, "queue": "420", **more,
    }


def build(rows, lifetime=None, accounts=("one",), **kwargs):
    return build_recommendations(
        rows, rows if lifetime is None else lifetime, accounts, "MIDDLE",
        catalog=CATALOG, include_performance=False, **kwargs,
    )


def test_frequency_order_is_invariant_to_wins_and_attribution_weights():
    rows = [row("one", "1", "A", win=1), row("one", "2", "A", win=0), row("one", "3", "A", win=1), row("one", "4", "B", win=0)]
    flipped = [{**item, "win": 1 - item["win"], "loss_attribution_weight": 0, "win_evidence_weight": 999} for item in rows]

    before = build(rows)
    after = build(flipped)

    assert [item["champion"] for item in before["known"]] == ["A", "B"]
    assert [item["champion"] for item in after["known"]] == ["A", "B"]
    assert [item["preference_score"] for item in before["known"]] == [.75, .25]
    assert before["profile"] == after["profile"]


def test_missing_selected_account_is_reported_but_not_used_as_a_prior():
    rows = [row("one", "1", "A"), row("one", "2", "A"), row("one", "3", "B")]

    alone = build(rows, accounts=("one",))
    with_missing = build(rows, accounts=("one", "missing"))

    assert alone["known"][0]["preference_score"] == with_missing["known"][0]["preference_score"]
    assert with_missing["coverage"]["active_accounts"] == ["one"]
    assert with_missing["coverage"]["missing_accounts"] == ["missing"]
    assert "non riducono" in with_missing["notes"][0]


def test_single_observation_produces_a_familiar_choice_and_positive_similarity_discovery():
    result = build([row("one", "1", "A")], trial_budget=3)

    assert [item["champion"] for item in result["known"]] == ["A"]
    assert result["known"][0]["preference_score"] == 1
    assert [item["champion"] for item in result["discover"]] == ["B", "C"]
    assert all(item["similarity"] > 0 for item in result["discover"])
    assert result["trial_plan"]["budget"] == 3
    assert [item["champion"] for item in result["trial_plan"]["items"]] == ["A", "B", "C"]


def test_lifetime_history_and_any_selected_dislike_exclude_candidates_while_like_anchors_without_games():
    rows = [row("one", "1", "A")]
    lifetime = [*rows, row("two", "old", "B", role="TOP")]
    feedback = [
        {"account": "one", "champion": "C", "role": "MIDDLE", "preference": "like"},
        {"account": "two", "champion": "D", "role": "MIDDLE", "preference": "dislike"},
        {"account": "one", "champion": "D", "role": "MIDDLE", "preference": "like"},
    ]

    result = build(rows, lifetime, accounts=("one", "two"), feedback=feedback)

    assert [item["champion"] for item in result["known"]][:2] == ["C", "A"]
    anchor = result["known"][0]
    assert anchor["games"] == anchor["account_count"] == 0
    assert anchor["feedback"] == "like"
    assert anchor["source_champions"][0]["source_kind"] == "explicit_feedback"
    assert "B" not in [item["champion"] for item in result["discover"]]
    assert "D" not in [item["champion"] for item in result["discover"]]
    assert result["coverage"]["excluded_count"] == 1


def test_aliases_small_samples_deduplicate_and_conflicts_are_explicit():
    duplicate = [row("ONE", "same", "Alias Alpha"), row("one", "same", "A")]
    result = build(duplicate, accounts=("one",))
    assert result["coverage"]["games"] == result["coverage"]["observations"] == 1
    assert result["known"][0]["champion"] == "A"

    with pytest.raises(ValueError, match="conflicting account/match"):
        build([row("one", "same", "A"), row("one", "same", "B")])


def test_rows_outside_selected_identity_or_role_do_not_leak_into_preference_profile():
    rows = [
        row("one", "1", "A"), row("outside", "2", "B"), row("one", "3", "D", role="TOP"),
    ]
    result = build(rows, accounts=("one",))

    assert result["coverage"]["games"] == 1
    assert [item["champion"] for item in result["known"]] == ["A"]


def test_off_meta_observed_pick_is_kept_as_familiar_but_not_invented_as_a_tag_profile():
    result = build([row("one", "1", "Future Champion")])

    assert [item["champion"] for item in result["known"]] == ["Future Champion"]
    assert result["coverage"]["unclassified_games"] == 1
    assert result["profile"] == result["discover"] == []


def test_recent_preference_window_does_not_truncate_raw_performance_rows():
    rows = [
        row("one", "old-a", "A", date="2026-09-01T10:00:00Z"),
        row("one", "new-a", "A", date="2026-09-02T10:00:00Z"),
        row("one", "new-b", "B", date="2026-09-03T10:00:00Z"),
    ]
    calls = []
    module = ModuleType("observed_performance")
    module.observed_performance = lambda source, candidate, *args, **kwargs: calls.append((source, candidate)) or {}
    with patch.dict(sys.modules, {"observed_performance": module}):
        result = build_recommendations(rows, rows, ["one"], "MIDDLE", catalog=CATALOG, recent_games=1)

    assert result["coverage"]["games"] == 3
    assert result["coverage"]["observations"] == 3
    assert result["coverage"]["preference_observations"] == 1
    assert result["known"][0]["champion"] == "B"
    assert sorted(len(candidate) for _, candidate in calls) == [1, 2]


def test_observed_performance_is_called_separately_and_never_used_for_ordering():
    calls = []
    module = ModuleType("observed_performance")

    def observed_performance(
        rows, candidate_rows, accounts, confidence, family_size,
        meaningful_delta, family_alpha,
    ):
        calls.append((
            rows, candidate_rows, accounts, confidence, family_size,
            meaningful_delta, family_alpha,
        ))
        return {"observed": len(candidate_rows)}

    module.observed_performance = observed_performance
    rows = [row("one", "1", "A"), row("one", "2", "B")]
    with patch.dict(sys.modules, {"observed_performance": module}):
        result = build_recommendations(
            rows, rows, ["one"], "MIDDLE", catalog=CATALOG,
            confidence=.8, meaningful_delta=.07, family_alpha=.02,
        )

    assert [item["champion"] for item in result["known"]] == ["A", "B"]
    assert all(item["performance"] == {"observed": 1} for item in result["known"])
    assert len(calls) == 2
    assert all(call[2:] == (["one"], .8, 2, .07, .02) for call in calls)


def test_missing_performance_module_is_not_silently_replaced_with_a_numeric_fallback():
    importer = builtins.__import__

    def unavailable(name, *args, **kwargs):
        if name == "observed_performance":
            raise ImportError("performance module unavailable")
        return importer(name, *args, **kwargs)

    with patch("builtins.__import__", side_effect=unavailable), pytest.raises(ImportError, match="unavailable"):
        build_recommendations([row("one", "1", "A")], [row("one", "1", "A")], ["one"], "MIDDLE", catalog=CATALOG)


def test_performance_family_is_complete_before_feedback_or_display_limit():
    calls = []
    module = ModuleType("observed_performance")
    module.observed_performance = lambda *args, **kwargs: calls.append(kwargs["family_size"]) or {}
    rows = [row("one", "1", "A"), row("one", "2", "B"), row("one", "3", "C")]
    with patch.dict(sys.modules, {"observed_performance": module}):
        result = build_recommendations(
            rows, rows, ["one"], "MIDDLE", catalog=CATALOG, limit=1,
            feedback=[{"account": "one", "champion": "B", "role": "MIDDLE", "preference": "dislike"}],
    )

    assert len(result["known"]) == 1
    assert calls and set(calls) == {3}


def test_empty_observation_without_feedback_is_an_honest_empty_seed():
    result = build([], [], accounts=("one", "missing"))

    assert result["profile"] == result["known"] == result["discover"] == []
    assert result["trial_plan"] == {"budget": 0, "items": []}
    assert "Nessuna osservazione" in result["notes"][0]


def test_neutral_feedback_clears_a_previous_explicit_state_for_that_account():
    result = build(
        [row("one", "1", "A")], feedback=[
            {"account": "one", "champion": "C", "role": "MIDDLE", "preference": "like"},
            {"account": "one", "champion": "C", "role": "MIDDLE", "preference": "neutral"},
        ],
    )

    assert "C" not in [item["champion"] for item in result["known"]]
    assert result["coverage"]["excluded_count"] == 0


def test_no_history_like_has_no_observed_frequency_score_and_recent_counts_are_labeled():
    rows = [row("one", "old", "A", date="2026-01-01T00:00:00Z")]
    anchor = build([], [], feedback=[
        {"account": "one", "champion": "C", "role": "MIDDLE", "preference": "like"},
    ])["known"][0]
    historical = build(rows, recent_games=0)["known"][0]

    assert anchor["preference_score"] is None
    assert anchor["feedback"] == "like"
    assert historical["preference_score"] == 0
    assert any("0 partite recenti" in reason for reason in historical["reasons"])
    assert any("1 partite nel perimetro" in reason for reason in historical["reasons"])


def test_dislike_removes_only_its_implicit_source_and_preserves_raw_coverage():
    rows = [row("one", "shared", "A"), row("two", "other", "D")]
    result = build(
        rows, accounts=("one", "two"), feedback=[
            {"account": "one", "champion": "A", "role": "MIDDLE", "preference": "dislike"},
        ],
    )

    assert result["coverage"]["observations"] == 2
    assert result["coverage"]["preference_observations"] == 2
    assert result["profile"]
    assert all(source["champion"] != "A" for item in result["discover"] for source in item["source_champions"])
    assert "A" not in [item["champion"] for item in result["known"]]


def test_all_role_profile_applies_feedback_only_to_the_matching_role():
    rows = [
        row("one", "middle", "D", role="MIDDLE"),
        row("one", "top", "D", role="TOP"),
    ]
    result = build_recommendations(
        rows, rows, ["one"], "ALL", catalog=CATALOG, include_performance=False,
        feedback=[{"account": "one", "champion": "D", "role": "TOP", "preference": "dislike"}],
    )

    tank = next(item for item in result["profile"] if item["tag"] == "class:tank")
    assert tank["games"] == 1
    assert tank["share"] == 1
    assert result["coverage"]["excluded_count"] == 1


def test_performance_family_size_can_cover_a_cross_role_request_family():
    calls = []
    module = ModuleType("observed_performance")
    module.observed_performance = lambda *args, **kwargs: calls.append(kwargs["family_size"]) or {}
    rows = [row("one", "1", "A"), row("one", "2", "B")]

    with patch.dict(sys.modules, {"observed_performance": module}):
        build_recommendations(
            rows, rows, ["one"], "MIDDLE", catalog=CATALOG,
            performance_family_size=7,
        )

    assert calls == [7, 7]


def test_like_without_matches_seeds_discovery_as_an_explicit_non_game_source():
    result = build([], [], feedback=[
        {"account": "one", "champion": "A", "role": "MIDDLE", "preference": "like"},
    ])

    assert result["coverage"]["games"] == result["coverage"]["observations"] == 0
    assert result["known"][0]["champion"] == "A"
    assert result["discover"]
    source = result["discover"][0]["source_champions"][0]
    assert source == {
        "champion": "A", "name": "Alpha", "games": 0, "similarity": source["similarity"],
        "matched_tags": source["matched_tags"], "source_kind": "explicit_feedback",
    }
    assert any("sostituisce" in note for note in result["notes"])


def test_coverage_counts_global_games_separately_from_account_match_observations():
    rows = [row("one", "shared", "A"), row("two", "shared", "A")]
    result = build(rows, accounts=("one", "two"))

    assert result["coverage"]["games"] == 1
    assert result["coverage"]["observations"] == result["coverage"]["preference_observations"] == 2


def test_configured_trial_budget_is_not_clamped_to_three():
    catalog = {**CATALOG, "champions": [
        *CATALOG["champions"],
        {"id": "F", "name": "Foxtrot", "classes": ["class:mage"], "tags": [], "roles": ["MIDDLE"]},
        {"id": "G", "name": "Golf", "classes": ["class:mage"], "tags": [], "roles": ["MIDDLE"]},
        {"id": "H", "name": "Hotel", "classes": ["class:mage"], "tags": [], "roles": ["MIDDLE"]},
    ]}
    result = build_recommendations([row("one", "1", "A")], [row("one", "1", "A")], ["one"], "MIDDLE",
                                   catalog=catalog, include_performance=False, trial_budget=5)

    assert result["trial_plan"]["budget"] == 5
    assert len(result["trial_plan"]["items"]) == 5


def test_dislike_removes_implicit_frequency_denominator_per_account_without_changing_raw_games():
    catalog = {**CATALOG, "champions": [
        *CATALOG["champions"],
        {"id": "X", "name": "Xray", "classes": ["class:mage"], "tags": [], "roles": ["MIDDLE"]},
        {"id": "Y", "name": "Yankee", "classes": ["class:mage"], "tags": [], "roles": ["MIDDLE"]},
        {"id": "Z", "name": "Zulu", "classes": ["class:mage"], "tags": [], "roles": ["MIDDLE"]},
    ]}
    rows = [*[row("one", f"x-{index}", "X") for index in range(9)], row("one", "y", "Y"), row("two", "z", "Z")]
    result = build_recommendations(
        rows, rows, ["one", "two"], "MIDDLE", catalog=catalog, include_performance=False,
        feedback=[{"account": "one", "champion": "X", "role": "MIDDLE", "preference": "dislike"}],
    )

    y = next(item for item in result["known"] if item["champion"] == "Y")
    assert y["preference_score"] == .5
    assert y["games"] == 1
    assert result["coverage"]["observations"] == 11


def test_known_ties_sort_by_display_name_then_canonical_id_not_raw_id():
    catalog = {**CATALOG, "champions": [
        {"id": "ZedId", "name": "Alpha", "classes": ["class:mage"], "tags": [], "roles": ["MIDDLE"]},
        {"id": "AardvarkId", "name": "Zulu", "classes": ["class:mage"], "tags": [], "roles": ["MIDDLE"]},
    ]}
    result = build_recommendations(
        [row("one", "z", "ZedId"), row("one", "a", "AardvarkId")],
        [row("one", "z", "ZedId"), row("one", "a", "AardvarkId")], ["one"], "MIDDLE",
        catalog=catalog, include_performance=False,
    )

    assert [item["champion"] for item in result["known"]] == ["ZedId", "AardvarkId"]


def test_unknown_observed_dislike_is_stored_and_suppresses_the_known_pick():
    result = build(
        [row("one", "future", "Future Champion")], feedback=[
            {"account": "one", "champion": "Future Champion", "role": "MIDDLE", "preference": "dislike"},
        ],
    )

    assert result["known"] == []
    assert result["coverage"]["excluded_count"] == 1


def test_unknown_observed_like_is_familiar_priority_but_never_a_discovery_similarity_source():
    result = build(
        [row("one", "future", "Future Champion"), row("one", "known", "A")], feedback=[
            {"account": "one", "champion": "Future Champion", "role": "MIDDLE", "preference": "like"},
        ],
    )

    assert result["known"][0]["champion"] == "Future Champion"
    assert result["known"][0]["feedback"] == "like"
    assert result["discover"]
    assert all(source["champion"] != "Future Champion"
               for item in result["discover"] for source in item["source_champions"])
    assert result["discover"][0]["source_champions"][0]["champion"] == "A"


def test_all_role_discovery_priority_uses_role_exposure_but_keeps_raw_similarity():
    rows = [
        *[row("one", f"middle-{index}", "A") for index in range(4)],
        row("one", "top", "D", role="TOP"),
    ]
    middle = build_recommendations(
        rows[:-1], rows, ["one"], "MIDDLE", catalog=CATALOG,
        include_performance=False, ranking_scope_rows=rows,
    )
    top = build_recommendations(
        rows[-1:], rows, ["one"], "TOP", catalog=CATALOG,
        include_performance=False, ranking_scope_rows=rows,
    )

    beta = next(item for item in middle["discover"] if item["champion"] == "B")
    epsilon = next(item for item in top["discover"] if item["champion"] == "E")
    assert beta["similarity"] == epsilon["similarity"] == 1
    assert beta["priority_score"] == 4 / 5
    assert epsilon["priority_score"] == 1 / 5

    explicitly_liked = build_recommendations(
        [], rows, ["one"], "TOP", catalog=CATALOG, include_performance=False,
        ranking_scope_rows=rows,
        feedback=[{"account": "one", "champion": "D", "role": "TOP", "preference": "like"}],
    )
    explicit_epsilon = next(
        item for item in explicitly_liked["discover"] if item["champion"] == "E"
    )
    assert explicit_epsilon["similarity"] == explicit_epsilon["priority_score"] == 1


def test_all_role_denominator_removes_each_accounts_dislikes_in_other_roles():
    rows = [
        *[row("one", f"middle-{index}", "A") for index in range(4)],
        row("one", "top", "D", role="TOP"),
    ]

    result = build_recommendations(
        rows[:-1], rows, ["one"], "MIDDLE", catalog=CATALOG,
        include_performance=False, ranking_scope_rows=rows,
        feedback=[{"account": "one", "champion": "D", "role": "TOP", "preference": "dislike"}],
    )

    assert result["known"][0]["champion"] == "A"
    assert result["known"][0]["preference_score"] == 1


def test_all_role_recent_window_uses_one_global_account_window_for_numerator_and_denominator():
    old_top = row("one", "old-top", "D", role="TOP", date="2026-09-01T00:00:00Z")
    recent_middle = [
        row("one", "middle-a", "A", date="2026-09-02T00:00:00Z"),
        row("one", "middle-b", "B", date="2026-09-03T00:00:00Z"),
    ]
    all_rows = [old_top, *recent_middle]

    result = build_recommendations(
        [old_top], all_rows, ["one"], "TOP", catalog=CATALOG,
        include_performance=False, ranking_scope_rows=all_rows, recent_games=2,
    )

    assert result["known"][0]["champion"] == "D"
    assert result["known"][0]["preference_score"] == 0
    assert result["coverage"]["preference_observations"] == 0
