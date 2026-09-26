"""Integration regressions for the findings in outputs/algorithm_validation.

Run explicitly after the shared statistical model is integrated:
    python -m pytest test_algorithm_corrections.py -q
All writes use disposable SQLite databases, never the operational database.
"""

from contextlib import closing

import pytest

from test_algorithm_scope import ScopeFixture, simpson_case


@pytest.fixture
def scope(tmp_path):
    return ScopeFixture(tmp_path)


def by_champion(items):
    return {item["champion"]: item for item in items}


def test_three_game_prior_does_not_exclude_neutral_rate_or_claim_advantage(scope):
    scope.series("selected", "Small", 3, 2)
    item = scope.recommendations(["selected"])[0]
    assert item["credible_lower_90"] < 50 < item["credible_upper_90"]
    assert item["confidence"] == "da confermare"
    assert item["actionable"] is False


def test_candidate_does_not_borrow_its_posterior_from_other_champions(scope):
    scope.series("selected", "Small", 3, 2)
    before = by_champion(scope.recommendations(["selected"]))["Small"]
    scope.series("selected", "Context", 100, 90)
    after = by_champion(scope.recommendations(["selected"]))["Small"]
    # The comparison reference may change, but the candidate's estimate and
    # its interval must not gain fictitious personal observations.
    for field in ("posterior_fit", "credible_lower_90", "credible_upper_90"):
        assert before[field] == after[field]


def test_excluded_losses_do_not_become_a_high_positive_claim_from_context(scope):
    scope.series("selected", "Excluded", 3, 0, loss_weight=0)
    scope.series("selected", "Context", 100, 90)
    items = by_champion(scope.recommendations(["selected"]))
    if "Excluded" in items:
        item = items["Excluded"]
        assert item["actionable"] is False
        assert item["score"] < 50
        assert item["posterior_fit"] < 50


def test_account_standardization_removes_demonstrated_simpson_reversal(scope):
    result = simpson_case(scope)
    assert result["low"][0]["champion"] == "A"
    assert result["high"][0]["champion"] == "A"
    assert result["pooled"][0]["champion"] == "A"
    pooled = by_champion(result["pooled"])
    assert pooled["A"]["posterior_fit"] > pooled["B"]["posterior_fit"]
    assert abs(pooled["A"]["posterior_fit"] - 60) < 2
    assert abs(pooled["B"]["posterior_fit"] - 50) < 2


def test_loss_attribution_changes_audit_without_inflating_outcome_inference(scope):
    scope.series("selected", "A", 40, 20)
    scope.series("selected", "B", 40, 28)
    before = by_champion(scope.recommendations(["selected"]))
    with closing(scope.storage.connect()) as connection, connection:
        connection.execute("UPDATE match_quality SET loss_attribution_weight=0.1 WHERE champion='A' AND win=0")
    after = by_champion(scope.recommendations(["selected"]))
    assert before["A"]["explanation"]["negative_evidence"] == 20
    assert after["A"]["explanation"]["negative_evidence"] == 2
    for champion in before:
        for field in ("score", "posterior_fit", "credible_lower_90", "credible_upper_90", "actionable"):
            assert before[champion][field] == after[champion][field]


def test_loss_weights_do_not_remove_or_strengthen_a_supported_decision(scope):
    scope.series("selected", "Strong", 100, 90)
    scope.series("selected", "Context", 100, 20)
    before = by_champion(scope.recommendations(["selected"]))["Strong"]
    assert before["actionable"] is True
    with closing(scope.storage.connect()) as connection, connection:
        connection.execute("UPDATE match_quality SET loss_attribution_weight=0 WHERE win=0")
    after = by_champion(scope.recommendations(["selected"]))["Strong"]
    assert after["negative_evidence"] == 0
    for field in ("actionable", "score", "posterior_fit", "advantage_probability", "decision_threshold"):
        assert before[field] == after[field]


def test_absent_account_cell_does_not_claim_personal_advantage(scope):
    scope.series("one", "A", 40, 40)
    scope.series("two", "B", 40, 0)
    item = by_champion(scope.recommendations(["one", "two"]))["A"]
    # A's posterior on one is Beta(44,4); two has no A data and retains Beta(4,4).
    expected = ((44 / 48) + .5) / 2 * 100
    assert abs(item["posterior_fit"] - expected) < .11
    assert item["actionable"] is False
    assert item["confidence"] == "da confermare"


def test_explicit_account_without_any_matches_stays_in_target(scope):
    scope.series("one", "A", 40, 40)
    item = by_champion(scope.recommendations(["one", "empty"]))["A"]
    expected = ((44 / 48) + .5) / 2 * 100
    assert abs(item["posterior_fit"] - expected) < .11
    assert item["missing_accounts"] == ["empty"]
    assert item["actionable"] is False


def test_unselected_extreme_account_has_no_effect_on_selected_profile(scope):
    scope.series("selected", "A", 40, 24)
    scope.series("selected", "B", 40, 20)
    before = scope.query("/api/profile", ["selected"])
    scope.series("outside", "A", 300, 0)
    scope.series("outside", "Foreign", 300, 300)
    assert before == scope.query("/api/profile", ["selected"])


def test_common_account_mix_does_not_depend_on_parameter_order(scope):
    scope.series("one", "A", 40, 30)
    scope.series("two", "A", 20, 8)
    scope.series("one", "B", 20, 8)
    scope.series("two", "B", 40, 30)
    first = scope.recommendations(["one", "two"])
    second = scope.recommendations(["two", "one", "one"])
    # The response may preserve selection order in its account labels.
    # The target population, calculations and ranking must remain identical.
    for item in first + second:
        item["accounts"] = sorted(item["accounts"])
    assert first == second
