"""API regressions for decisions based on raw, personal observations.

All writes target a temporary SQLite database; no operational database is opened.
Numerical distribution accuracy is covered separately in test_statistical_evidence.
"""

from contextlib import closing

import pytest

import app
from algorithm_settings import recommended_settings, settings_context
from decision_models import candidate_metrics, control_decisions, outcome_metrics, rank_recommendations
from storage import SQLiteStorage
from test_reliability import add_match, add_roster


class DecisionFixture:
    def __init__(self, storage):
        self.storage = storage
        self.serial = 0

    def series(
        self, champion, games, wins, *, role="MIDDLE", account="Player#EUW",
        loss_weight=1.0, win_weight=1.0, ally=None, opponent=None,
    ):
        match_ids = []
        with closing(self.storage.connect()) as connection, connection:
            connection.execute(
                "INSERT OR IGNORE INTO tracked_account_puuids(puuid,account) VALUES(?,?)",
                (f"owner-{account}", account),
            )
            for number in range(games):
                self.serial += 1
                match_id = f"decision-{self.serial}"
                match_ids.append(match_id)
                win = int(number < wins)
                add_match(
                    connection, account=account, match_id=match_id, champion=champion,
                    role=role, win=win, loss_weight=loss_weight, win_weight=win_weight,
                )
                if ally or opponent:
                    add_roster(
                        connection, match_id=match_id, owner_puuid=f"owner-{account}",
                        owner_riot_id=account, owner_champion=champion, win=win,
                        teammates=[] if not ally else [(f"ally-{ally}", f"{ally}#EUW", ally)],
                    )
                if opponent:
                    connection.execute(
                        """INSERT INTO match_participants
                           (match_id,puuid,riot_id,team_id,win,champion) VALUES(?,?,?,?,?,?)""",
                        (match_id, f"opponent-{opponent}", f"{opponent}#EUW", 200, 1 - win, opponent),
                    )
        return match_ids

    def query(self, endpoint, **params):
        query = {"account": ["Player#EUW"]}
        query.update(params)
        status, payload = app.query_database(endpoint, query)
        assert status == 200, payload
        return payload

    def recommendation(self, champion="Ahri", **params):
        return next(item for item in self.query("/api/profile", **params)["recommendations"]
                    if item["champion"] == champion)


@pytest.fixture
def decisions(tmp_path, monkeypatch):
    storage = SQLiteStorage(tmp_path / "statistical-decisions.db", app.SCHEMA_PATH)
    storage.initialize()
    monkeypatch.setattr(app, "STORAGE", storage)
    return DecisionFixture(storage)


def candidate(champion, games, wins, role="MIDDLE"):
    return {
        "champion": champion, "role": role, "games": games, "wins": wins,
        "positive_evidence": wins, "negative_evidence": games - wins,
    }


def test_unique_games_not_account_observations_control_the_minimum_gate():
    rows = [candidate("Ahri", 40, 40) | {"unique_games": 19}, candidate("Lux", 40, 0)]
    below = {item["champion"]: item for item in control_decisions(
        candidate_metrics(rows), "advantage_probability",
    )}["Ahri"]
    assert below["decision_games"] == 19
    assert below["statistical_actionable"] is False
    rows[0]["unique_games"] = 20
    enough = {item["champion"]: item for item in control_decisions(
        candidate_metrics(rows), "advantage_probability",
    )}["Ahri"]
    assert enough["decision_games"] == 20
    assert enough["statistical_actionable"] is True


def test_missing_complementary_baseline_blocks_relative_actionability():
    source = candidate("Ahri", 100, 100) | {
        "unique_games": 100,
        "accounts": ["a", "b"],
        "account_cells": {
            "a": {"wins": 50, "losses": 0, "baseline_wins": 0, "baseline_losses": 50},
            "b": {"wins": 50, "losses": 0, "baseline_wins": 0, "baseline_losses": 0},
        },
    }
    item = outcome_metrics(source)
    control_decisions([item], "advantage_probability")
    assert item["missing_accounts"] == []
    assert item["missing_baseline_accounts"] == ["b"]
    assert item["statistical_actionable"] is False
    assert item["relative_actionable"] is False


def test_attribution_conflict_is_audit_only_unless_legacy_veto_is_enabled():
    rows = [candidate("Ahri", 100, 0) | {"negative_evidence": 0}, candidate("Lux", 100, 100)]
    current = {item["champion"]: item for item in control_decisions(
        candidate_metrics(rows), "disadvantage_probability", attribution_gate=True,
    )}["Ahri"]
    assert current["statistical_actionable"] is True
    assert current["attribution_conflict"] is True
    assert current["attribution_veto_applied"] is False
    assert current["actionable"] is True

    legacy = recommended_settings()
    legacy["attribution"]["negative_veto"] = True
    with settings_context(legacy):
        vetoed = {item["champion"]: item for item in control_decisions(
            candidate_metrics(rows), "disadvantage_probability", attribution_gate=True,
        )}["Ahri"]
    assert vetoed["statistical_actionable"] is True
    assert vetoed["attribution_veto_applied"] is True
    assert vetoed["actionable"] is False


def test_ranking_uses_configured_interval_limit_and_snapshot_metadata():
    configured = recommended_settings()
    configured["evidence"].update({"credible_mass": .8, "recommendation_limit": 1})
    with settings_context(configured, revision=12):
        ranked = rank_recommendations([candidate("Ahri", 30, 25), candidate("Lux", 30, 20)])
    assert len(ranked) == 1
    item = ranked[0]
    assert item["score"] == item["credible_lower"]
    assert item["credible_lower"] > item["credible_lower_90"]
    assert item["credible_upper"] < item["credible_upper_90"]
    assert item["credible_mass"] == .8
    assert item["algorithm_revision"] == 12
    assert item["algorithm_fingerprint"]


@pytest.mark.parametrize("wins", [2, 3])
def test_two_or_three_wins_from_three_games_are_candidates_not_confirmed_advice(decisions, wins):
    decisions.series("Ahri", 3, wins)
    item = decisions.recommendation()
    assert item["games"] == 3
    assert item["posterior_fit"] == pytest.approx(100 * (4 + wins) / 11, abs=0.1)
    assert item["credible_lower_90"] < 50 < item["credible_upper_90"]
    assert item["score"] == item["credible_lower_90"]
    assert item["actionable"] is False
    assert item["confidence"] != "sufficiente"


def test_role_context_cannot_narrow_or_inflate_a_three_game_personal_posterior(decisions):
    decisions.series("Ahri", 3, 3)
    before = decisions.recommendation()
    decisions.series("Orianna", 500, 490)
    after = decisions.recommendation()
    for field in ("posterior_fit", "credible_lower_90", "credible_upper_90", "score"):
        assert after[field] == before[field]
    assert after["actionable"] is False


def test_role_baseline_excludes_candidate_and_other_roles():
    rows = [candidate("Ahri", 3, 3), candidate("Lux", 20, 12)]
    before = {item["champion"]: item for item in app.rank_recommendations(rows)}["Ahri"]
    rows[0] = candidate("Ahri", 100, 100)
    rows.append(candidate("Darius", 300, 0, role="TOP"))
    after = {item["champion"]: item for item in app.rank_recommendations(rows)}["Ahri"]
    expected_baseline = round(100 * (4 + 12) / (8 + 20), 1)
    assert before["baseline_win_rate"] == after["baseline_win_rate"] == expected_baseline


def test_uncertain_comparison_baseline_reduces_evidence_for_the_same_effect():
    target = candidate("Ahri", 20, 16)
    uncertain = next(item for item in app.rank_recommendations([
        target, candidate("Lux", 2, 1),
    ]) if item["champion"] == "Ahri")
    precise = next(item for item in app.rank_recommendations([
        target, candidate("Lux", 1000, 500),
    ]) if item["champion"] == "Ahri")
    for field in ("posterior_fit", "credible_lower_90", "credible_upper_90", "baseline_win_rate"):
        assert uncertain[field] == precise[field]
    assert uncertain["probability_meaningful_advantage"] < precise["probability_meaningful_advantage"]
    assert uncertain["actionable"] is False


def test_recommendation_family_is_counted_before_top_three_selection():
    rows = [candidate(f"Candidate{number}", 40, 20 + number) for number in range(5)]
    top_three = app.rank_recommendations(rows)
    complete = {item["champion"]: item for item in app.rank_recommendations(rows, limit=10)}
    assert len(top_three) == 3
    for item in top_three:
        assert item["family_size"] == 5
        assert item["decision_threshold"] == 99.5
        assert item["actionable"] == complete[item["champion"]]["actionable"]
        assert item["decision_threshold"] == complete[item["champion"]]["decision_threshold"]


def test_nineteen_perfect_results_cannot_become_actionable():
    item = app.rank_recommendations([candidate("Ahri", 19, 19)])[0]
    assert item["actionable"] is False
    assert item["confidence"] != "sufficiente"


def test_large_repeated_advantage_can_be_actionable(decisions):
    decisions.series("Ahri", 100, 90)
    decisions.series("Lux", 100, 50)
    item = decisions.recommendation()
    assert item["actionable"] is True
    assert item["probability_meaningful_advantage"] >= item["decision_threshold"]
    assert item["family_size"] == 2


def test_two_accounts_with_repeated_advantage_pass_the_family_specific_bound(decisions):
    for account in ("Player#EUW", "Alt#EUW"):
        decisions.series("Ahri", 100, 95, account=account)
        decisions.series("Lux", 100, 30, account=account)
    item = decisions.recommendation(account=["Player#EUW", "Alt#EUW"])
    assert item["account_count"] == item["observed_account_count"] == 2
    assert item["account_weighting"] == "equal"
    assert item["missing_accounts"] == []
    assert item["posterior_fit"] == 91.7
    assert item["probabilities_are_lower_bounds"] is True
    assert item["family_size"] == 2
    assert item["decision_threshold"] == 98.75
    # The coarse 90% summary is insufficient: the decision must evaluate the
    # family-specific bound and certify this unambiguous, well-supported case.
    assert item["probability_meaningful_advantage"] >= item["decision_threshold"]
    assert item["actionable"] is True
    assert item["reliability"] == "reliable"
    negative = decisions.recommendation("Lux", account=["Player#EUW", "Alt#EUW"])
    assert negative["probability_worse_than_baseline"] >= negative["probability_meaningful_disadvantage"]


def test_candidate_missing_from_one_selected_account_stays_nonactionable(decisions):
    decisions.series("Ahri", 100, 100)
    decisions.series("Lux", 100, 0)
    decisions.series("Lux", 100, 0, account="Alt#EUW")
    item = decisions.recommendation(account=["Player#EUW", "Alt#EUW"])
    assert item["account_count"] == 2
    assert item["observed_account_count"] == 1
    assert item["missing_accounts"] == ["Alt#EUW"]
    assert item["posterior_fit"] == pytest.approx(100 * ((104 / 108) + 0.5) / 2, abs=0.1)
    assert item["actionable"] is False
    assert item["reliability"] != "reliable"
    assert item["confidence"] != "sufficiente"


def test_shared_match_on_another_champion_is_excluded_from_the_candidate_baseline(decisions):
    shared_ids = decisions.series("Ahri", 3, 2)
    decisions.series("Lux", 5, 5, account="Alt#EUW")
    accounts = {"account": ["Player#EUW", "Alt#EUW"]}
    before = decisions.recommendation(**accounts)
    with closing(decisions.storage.connect()) as connection, connection:
        add_match(connection, account="Alt#EUW", match_id=shared_ids[0],
                  champion="Lux", role="MIDDLE", win=0)
    after = decisions.recommendation(**accounts)
    for field in (
        "baseline_games", "baseline_win_rate", "baseline_credible_lower_90",
        "baseline_credible_upper_90", "posterior_lift_pp", "probability_meaningful_advantage",
    ):
        assert after[field] == before[field]
    assert after["baseline_games"] == 5
    assert after["baseline_win_rate"] == pytest.approx(100 * (0.5 + 9 / 13) / 2, abs=0.1)


@pytest.mark.parametrize("games,wins", [(12, 5), (8, 3)])
def test_small_negative_records_do_not_create_blacklist_advice(decisions, games, wins):
    decisions.series("Ahri", games, wins)
    assert decisions.query("/api/blacklist")["items"] == []


def test_blacklist_keeps_raw_outcome_advice_separate_from_attribution_audit(decisions):
    decisions.series("Ahri", 100, 10)
    decisions.series("Lux", 100, 50)
    strong = next(item for item in decisions.query("/api/blacklist")["items"]
                  if item["champion"] == "Ahri")
    assert strong["tier"] == "strong"
    assert strong["actionable"] is True
    with closing(decisions.storage.connect()) as connection, connection:
        connection.execute("UPDATE match_quality SET loss_attribution_weight=0 WHERE champion='Ahri'")
    audited = next(item for item in decisions.query("/api/blacklist")["items"]
                   if item["champion"] == "Ahri")
    assert audited["statistical_actionable"] is True
    assert audited["attribution_conflict"] is True
    assert audited["attribution_veto_applied"] is False
    assert audited["actionable"] is True


@pytest.mark.parametrize("kind", ["matchup", "synergy"])
def test_small_pair_samples_keep_raw_intervals_and_cannot_become_actionable(decisions, kind):
    roster = {"opponent": "Lux"} if kind == "matchup" else {"ally": "Lux"}
    baseline_roster = {"opponent": "Zed"} if kind == "matchup" else {"ally": "Leona"}
    decisions.series("Ahri", 3, 3, **roster)
    decisions.series("Ahri", 20, 10, **baseline_roster)
    if kind == "matchup":
        with closing(decisions.storage.connect()) as connection:
            payload = app.matchup_data(connection, {"account": ["Player#EUW"]}, "Ahri", "MIDDLE")
        positive, negative = payload["beats"], payload["loses_to"]
    else:
        with closing(decisions.storage.connect()) as connection:
            payload = app.synergy_data(connection, {
                "account": ["Player#EUW"], "champion": ["Ahri"],
                "min_games": ["1"], "include_exploratory": ["true"],
            })
        positive, negative = payload["better_with"], payload["worse_with"]
    assert {item["champion"] for item in positive}.isdisjoint(item["champion"] for item in negative)
    item = next(item for item in positive + negative + payload.get("exploratory", [])
                if item["champion"] == "Lux")
    assert item["posterior_win_rate"] == pytest.approx(100 * 7 / 11, abs=0.1)
    assert item["credible_lower_90"] < 50 < item["credible_upper_90"]
    assert item["actionable"] is False
    assert item["reliability"] != "reliable"


def test_borrowed_context_cannot_create_personal_matchup_support():
    item = {
        "games": 3, "wins": 3, "positive_evidence": 0.03,
        "negative_evidence": 0, "evidence_square": 0.0003,
    }
    isolated = app.matchup_metrics(item, 0.5, 3)
    borrowed = app.matchup_metrics(item, 0.5, 3, {
        "mean": 0.99, "strength": 30, "effective_sample_size": 1000,
        "games": 1000, "source": "peer_role",
    })
    for field in ("posterior_win_rate", "credible_lower_90", "credible_upper_90"):
        assert borrowed[field] == isolated[field]
    assert borrowed["actionable"] is False
    assert borrowed["reliability"] != "reliable"


def test_friends_aliases_and_multiple_accounts_do_not_multiply_observations(decisions):
    match_ids = decisions.series("Ahri", 3, 2, ally="Buddy")
    before = next(item for item in decisions.query("/api/friends", min_shared_games=["1"])["items"]
                  if item["friend"] == "Buddy#EUW")
    with closing(decisions.storage.connect()) as connection, connection:
        connection.execute(
            "INSERT INTO tracked_account_puuids(puuid,account) VALUES(?,?)", ("alt-owner", "Alt#EUW"),
        )
        for number, match_id in enumerate(match_ids):
            win = int(number < 2)
            add_match(connection, account="Alt#EUW", match_id=match_id,
                      champion="Orianna", role="MIDDLE", win=win)
            connection.executemany(
                """INSERT INTO match_participants
                   (match_id,puuid,riot_id,team_id,win,champion) VALUES(?,?,?,?,?,?)""",
                [(match_id, "alt-owner", "Alt#EUW", 100, win, "Orianna"),
                 (match_id, "buddy-old-puuid", "Buddy#EUW", 100, win, "Buddy")],
            )
    after = next(item for item in decisions.query(
        "/api/friends", account=["Player#EUW", "Alt#EUW"], min_shared_games=["1"],
    )["items"] if item["friend"] == "Buddy#EUW")
    # Riot ID aliases within one account stay deduplicated, while a second
    # selected account contributes its own observations of the shared matches.
    assert after["games"] == after["observations"] == 6
    assert after["shared_games"] == after["unique_games"] == 3
    assert after["friend_win_rate"] == 66.7
    assert after["posterior_win_rate"] == 54.5
    assert after["posterior_win_rate"] == before["posterior_win_rate"]
    assert after["credible_lower_90"] <= before["credible_lower_90"]
    assert after["credible_upper_90"] >= before["credible_upper_90"]
    assert after["credible_lower_90"] < 50 < after["credible_upper_90"]
    assert after["actionable"] is False


def test_friends_name_and_minimum_games_filters_do_not_reduce_the_decision_family(decisions):
    decisions.series("Ahri", 30, 27, ally="Leona")
    decisions.series("Ahri", 30, 15, ally="Buddy")
    decisions.series("Ahri", 1, 1, ally="NewFriend")
    full = next(item for item in decisions.query("/api/friends", min_shared_games=["1"])["items"]
                if item["friend"] == "Leona#EUW")
    filtered = decisions.query("/api/friends", min_shared_games=["20"], friend_q=["Leona"])["items"]
    assert len(filtered) == 1
    assert full["family_size"] == filtered[0]["family_size"] == 3
    for field in ("decision_threshold", "probability_meaningful_advantage", "actionable"):
        assert full[field] == filtered[0][field]


def test_synergy_minimum_games_filter_does_not_reduce_the_decision_family(decisions):
    decisions.series("Ahri", 30, 27, ally="Leona")
    decisions.series("Ahri", 30, 3, ally="Yuumi")
    decisions.series("Ahri", 1, 1, ally="Sona")
    params = {"account": ["Player#EUW"], "champion": ["Ahri"], "include_exploratory": ["true"]}
    with closing(decisions.storage.connect()) as connection:
        full_payload = app.synergy_data(connection, {**params, "min_games": ["1"]})
        filtered_payload = app.synergy_data(connection, {**params, "min_games": ["20"]})
    full = next(item for item in full_payload["better_with"] if item["champion"] == "Leona")
    filtered = next(item for item in filtered_payload["better_with"] if item["champion"] == "Leona")
    assert full["family_size"] == filtered["family_size"] == 3
    for field in ("decision_threshold", "probability_meaningful_advantage", "actionable"):
        assert full[field] == filtered[field]


def test_scout_single_role_win_has_a_shrunk_effect_on_personalized_prior(decisions):
    with closing(decisions.storage.connect()) as connection, connection:
        connection.execute("INSERT INTO champions VALUES(?,?,?)", ("Unplayed", "Unplayed", "/Unplayed.png"))
        connection.execute(
            "INSERT INTO screening_candidates VALUES(?,?,?,?,?,?,?,?)",
            ("MIDDLE", "Unplayed", 0, "mage", 0.6, 0.5, "exploratory", "test fixture"),
        )
    before = decisions.query("/api/screen")["items"][0]
    decisions.series("Ahri", 1, 1)
    after = decisions.query("/api/screen")["items"][0]
    assert after["role_games"] == 1
    assert after["role_posterior_win_rate"] == 55.6
    assert after["role_credible_lower_90"] < 50 < after["role_credible_upper_90"]
    assert after["personalized_prior"] - before["personalized_prior"] == pytest.approx(1 / 60, abs=1e-5)
    assert after["personalized_prior"] - before["personalized_prior"] < 0.02


def test_scout_excludes_shared_matches_with_opposite_selected_account_outcomes(decisions):
    with closing(decisions.storage.connect()) as connection, connection:
        connection.execute("INSERT INTO champions VALUES(?,?,?)", ("Unplayed", "Unplayed", "/Unplayed.png"))
        connection.execute(
            "INSERT INTO screening_candidates VALUES(?,?,?,?,?,?,?,?)",
            ("MIDDLE", "Unplayed", 0, "mage", 0.6, 0.5, "exploratory", "test fixture"),
        )
    shared_ids = decisions.series("Ahri", 30, 30)
    with closing(decisions.storage.connect()) as connection, connection:
        for match_id in shared_ids:
            add_match(connection, account="Alt#EUW", match_id=match_id,
                      champion="Lux", role="MIDDLE", win=0)
    item = decisions.query("/api/screen", account=["Player#EUW", "Alt#EUW"])["items"][0]
    assert item["role_games"] == item["role_wins"] == 0
    assert item["role_ambiguous_games"] == 30
    assert item["role_posterior_win_rate"] == 50.0
    assert item["role_credible_lower_90"] < 50 < item["role_credible_upper_90"]
