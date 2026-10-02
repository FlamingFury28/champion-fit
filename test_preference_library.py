"""Complete, reversible preference editing without requiring played matches."""
from contextlib import closing
from unittest.mock import patch

import app
import pytest
from recommendation_feedback import all_scoped_accounts, feedback_library, save_feedback
from test_algorithm_scope import ScopeFixture
from test_recommendation_feedback import add_account, add_alias, add_observed_champion, database
from test_web_server import isolated_server, request


def test_tracked_account_without_matches_can_start_a_profile_and_reset_on_reopen(tmp_path):
    path, connection = database(tmp_path)
    with closing(connection), connection:
        add_account(connection, "identity-a", "First#EUW", "puuid-a", match=False)
        library = feedback_library(connection, [])
        assert library["accounts"] == ["First#EUW"]
        assert len(library["options"]) == 173
        assert library["items"] == []
        option = next(row for row in library["options"] if row["champion"] == "Leblanc")
        assert option["name"] == "LeBlanc"
        assert "MIDDLE" in option["roles"]
        assert option["roles_by_account"] == {"First#EUW": option["roles"]}
        save_feedback(connection, library["accounts"], "LeBlanc", "MIDDLE", "dislike", library["revision"])
    import sqlite3
    with closing(sqlite3.connect(path)) as reopened, reopened:
        reopened.row_factory = sqlite3.Row
        library = feedback_library(reopened, ["First#EUW"])
        assert library["items"][0]["preference"] == "dislike"
        assert any(row["champion"] == "Leblanc" for row in library["options"])
        save_feedback(reopened, ["First#EUW"], "LeBlanc", "MIDDLE", "neutral", library["revision"])
        assert feedback_library(reopened, ["First#EUW"])["items"] == []


def test_ledger_preserves_per_account_states_aliases_and_explicit_unknown_scope(tmp_path):
    _, connection = database(tmp_path)
    with closing(connection), connection:
        add_account(connection, "identity-a", "A#EUW", "puuid-a")
        add_account(connection, "identity-b", "B#EUW", "puuid-b")
        add_alias(connection, "A#EUW", "OldA#EUW", "puuid-a")
        save_feedback(connection, ["A#EUW"], "Ahri", "MIDDLE", "like", 0)
        save_feedback(connection, ["B#EUW"], "Ahri", "MIDDLE", "dislike", 1)
        library = feedback_library(connection, ["OldA#EUW", "A#EUW", "B#EUW"])
        assert library["accounts"] == ["A#EUW", "B#EUW"]
        assert all_scoped_accounts(connection) == ["A#EUW", "B#EUW"]
        assert [(row["account"], row["preference"]) for row in library["items"]] == [
            ("A#EUW", "like"), ("B#EUW", "dislike")]
        unknown = feedback_library(connection, ["Missing#EUW"])
        assert unknown["accounts"] == []
        assert unknown["items"] == []
        assert unknown["unresolved_accounts"] == ["Missing#EUW"]


@pytest.mark.parametrize(("raw_role", "role"), [("UTILITY", "SUPPORT"), ("MID", "MIDDLE"), ("ADC", "BOTTOM")])
def test_unknown_role_alias_offered_by_library_can_be_saved(tmp_path, raw_role, role):
    _, connection = database(tmp_path)
    with closing(connection), connection:
        add_account(connection, "identity-a", "A#EUW", "puuid-a")
        add_observed_champion(connection, "A#EUW", "unknown-a", "Future Hero")
        connection.execute("UPDATE match_quality SET role=? WHERE champion='Future Hero'", (raw_role,))
        library = feedback_library(connection, ["A#EUW"])
        option = next(row for row in library["options"] if row["champion"] == "Future Hero")
        assert option["roles"] == [role]
        saved = save_feedback(connection, ["A#EUW"], "Future Hero", role, "like", library["revision"])
        assert saved["items"][0]["role"] == role


def test_default_population_deduplicates_current_and_historical_fact_names(tmp_path):
    _, connection = database(tmp_path)
    with closing(connection), connection:
        add_account(connection, "identity-a", "New#EUW", "puuid-a")
        add_alias(connection, "New#EUW", "Old#EUW", "puuid-a")
        connection.execute("UPDATE match_quality SET account='Old#EUW'")
        connection.execute("UPDATE tracked_account_puuids SET account='Old#EUW'")
        assert all_scoped_accounts(connection) == ["New#EUW"]
        assert feedback_library(connection, [])["accounts"] == ["New#EUW"]


def test_unknown_choices_require_shared_role_history_but_old_ledger_remains_resettable(tmp_path):
    _, connection = database(tmp_path)
    with closing(connection), connection:
        add_account(connection, "identity-a", "A#EUW", "puuid-a")
        add_account(connection, "identity-b", "B#EUW", "puuid-b")
        add_observed_champion(connection, "A#EUW", "unknown-a", "Future Hero")
        assert any(row["champion"] == "Future Hero" for row in feedback_library(connection, ["A#EUW"])["options"])
        option = next(
            row for row in feedback_library(connection, ["A#EUW", "B#EUW"])["options"]
            if row["champion"] == "Future Hero"
        )
        assert option["roles"] == []
        assert option["roles_by_account"] == {
            "A#EUW": ["MIDDLE"], "B#EUW": [],
        }
        with pytest.raises(ValueError, match="must be observed"):
            save_feedback(
                connection, ["A#EUW", "B#EUW"], "Future Hero", "MIDDLE",
                "like", 0,
            )
        save_feedback(connection, ["A#EUW"], "Future Hero", "MIDDLE", "dislike", 0)
        connection.execute("DELETE FROM match_quality WHERE champion='Future Hero'")
        library = feedback_library(connection, ["A#EUW"])
        assert library["items"][0]["champion"] == "Future Hero"
        save_feedback(connection, ["A#EUW"], "Future Hero", "MIDDLE", "neutral", library["revision"])
        assert feedback_library(connection, ["A#EUW"])["items"] == []


def test_ambiguous_historical_alias_cannot_supply_unknown_champion_scope(tmp_path):
    _, connection = database(tmp_path)
    with closing(connection), connection:
        add_account(connection, "identity-a", "A#EUW", "puuid-a")
        add_account(connection, "identity-b", "B#EUW", "puuid-b")
        add_alias(connection, "A#EUW", "Shared#EUW", "puuid-a")
        add_alias(connection, "B#EUW", "Shared#EUW", "puuid-b")
        add_observed_champion(connection, "Shared#EUW", "unknown-shared", "Future Hero")

        library = feedback_library(connection, ["A#EUW", "B#EUW"])

        assert not any(
            row["champion"] == "Future Hero" for row in library["options"]
        )
        with pytest.raises(ValueError, match="must be observed"):
            save_feedback(
                connection, ["A#EUW", "B#EUW"], "Future Hero", "MIDDLE",
                "like", library["revision"],
            )


def test_suspended_identity_is_reported_and_has_no_editable_ledger(tmp_path):
    _, connection = database(tmp_path)
    with closing(connection), connection:
        add_account(connection, "identity-a", "A#EUW", "puuid-a")
        save_feedback(connection, ["A#EUW"], "Ahri", "MIDDLE", "like", 0)
        connection.execute("INSERT INTO riot_identity_policy VALUES(?,?,?,?,?,?,?,?)",
            ("puuid-a", "identity-a", "exception", "verified", "manual", "paused", "2026-09-01", "[]"))
        library = feedback_library(connection, ["A#EUW"])
        assert library["accounts"] == []
        assert library["suspended_accounts"] == ["A#EUW"]
        assert library["items"] == []


def test_library_read_is_read_only_and_choices_do_not_depend_on_outcomes(tmp_path):
    _, connection = database(tmp_path)
    with closing(connection), connection:
        add_account(connection, "identity-a", "A#EUW", "puuid-a")
        before = feedback_library(connection, ["A#EUW"])
        connection.execute("UPDATE match_quality SET win=0,loss_attribution_weight=0.01")
        assert feedback_library(connection, ["A#EUW"]) == before
        connection.execute("PRAGMA query_only=ON")
        assert feedback_library(connection, ["A#EUW"]) == before


def test_get_feedback_ignores_match_filters_and_does_not_broaden_unknown_account(tmp_path):
    fixture = ScopeFixture(tmp_path)
    fixture.series("one", "Ahri", 1, 1)
    with patch.object(app, "STORAGE", fixture.storage):
        status, library = app.query_database("/api/recommendation-feedback", {
            "account": ["one"], "queue": ["440"], "days": ["90"], "role": ["TOP"],
            "algorithm_revision": ["obsolete"], "companion_account": ["missing"],
        })
        assert status == 200
        assert library["accounts"] == ["one"]
        assert len(library["options"]) == 173
        status, unknown = app.query_database("/api/recommendation-feedback", {"account": ["missing"]})
        assert status == 200
        assert unknown["accounts"] == []


def test_http_complete_ledger_survives_dislike_and_neutral_reset(isolated_server):
    import sqlite3
    with sqlite3.connect(isolated_server["database"]) as connection:
        connection.execute("INSERT INTO tracked_account_puuids(puuid,account) VALUES('a','Alpha#EUW')")
    status, _, body = request(isolated_server, "GET", "/api/recommendation-feedback?account=Alpha%23EUW")
    import json
    library = json.loads(body)
    assert status == 200
    assert len(library["options"]) == 173
    # The fixture's account is known even when a chosen champion is unplayed.
    accounts = library["accounts"]
    assert accounts == ["Alpha#EUW"]
    payload = {"accounts": accounts, "champion": "Tahm Kench", "role": "TOP",
               "preference": "dislike", "expected_revision": library["revision"]}
    status, _, _ = request(isolated_server, "POST", "/api/recommendation-feedback", payload=payload)
    assert status == 200
    status, _, body = request(isolated_server, "GET", "/api/recommendation-feedback?account=Alpha%23EUW")
    saved = json.loads(body)
    assert saved["items"][0]["champion"] == "TahmKench"
    assert saved["items"][0]["preference"] == "dislike"
    status, _, _ = request(isolated_server, "POST", "/api/recommendation-feedback",
        payload={**payload, "preference": "neutral", "expected_revision": saved["revision"]})
    assert status == 200
