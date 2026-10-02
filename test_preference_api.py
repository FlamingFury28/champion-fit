"""End-to-end preference contracts on disposable databases, without live writes."""
from contextlib import closing
from copy import deepcopy
from unittest.mock import patch

import app
from algorithm_settings import get_settings_snapshot, save_settings
from test_algorithm_scope import ScopeFixture
from test_web_server import isolated_server, request


def query(fixture, **params):
    with patch.object(app, "STORAGE", fixture.storage):
        return app.query_database("/api/recommendations", {k: v if isinstance(v, list) else [str(v)] for k, v in params.items()})


def test_one_game_produces_choices_and_unknown_account_does_not_invent_results(tmp_path):
    fixture = ScopeFixture(tmp_path)
    fixture.series("one", "Annie", 1, 1)
    status, single = query(fixture, account=["one"])
    assert status == 200
    assert single["known"][0]["champion"] == "Annie"
    assert single["known"][0]["performance"]["win_rate"] == 100
    assert single["discover"]
    assert single["trial_plan"]["items"]
    status, group = query(fixture, account=["one", "absent"])
    assert status == 200
    assert group["known"][0]["preference_score"] == single["known"][0]["preference_score"]
    assert "absent" in group["coverage"]["missing_accounts"]
    assert group["context"]["unresolved_accounts"] == ["absent"]
    assert group["known"][0]["performance"]["win_rate"] == 100
    assert group["known"][0]["performance"]["baseline_win_rate"] is None


def test_default_scope_includes_tracked_account_with_only_explicit_feedback(tmp_path):
    from recommendation_feedback import save_feedback

    fixture = ScopeFixture(tmp_path)
    with closing(fixture.storage.connect()) as connection, connection:
        connection.execute(
            "INSERT INTO riot_account_identities(identity_id,account) VALUES(?,?)",
            ("identity-new", "New#EUW"),
        )
        connection.execute(
            "INSERT INTO riot_identity_puuids(puuid,identity_id) VALUES(?,?)",
            ("puuid-new", "identity-new"),
        )
        connection.execute(
            "INSERT INTO tracked_account_puuids(puuid,account) VALUES(?,?)",
            ("puuid-new", "New#EUW"),
        )
        save_feedback(connection, ["New#EUW"], "Ahri", "MIDDLE", "like", 0)

    status, data = query(fixture, role="ALL", queue="all")

    assert status == 200
    assert data["coverage"]["selected_accounts"] == ["New#EUW"]
    assert data["coverage"]["active_accounts"] == []
    assert [(item["champion"], item["role"], item["feedback"])
            for item in data["known"]] == [("Ahri", "MIDDLE", "like")]


def test_verified_rename_maps_historical_rows_without_duplicating_default_scope(tmp_path):
    from recommendation_feedback import save_feedback

    fixture = ScopeFixture(tmp_path)
    fixture.series("Old#EUW", "Annie", 1, 1)
    with closing(fixture.storage.connect()) as connection, connection:
        connection.executemany(
            "INSERT INTO riot_account_identities(identity_id,account) VALUES(?,?)",
            [("identity-new", "New#EUW"), ("identity-zero", "Zero#EUW")],
        )
        connection.executemany(
            "INSERT INTO riot_identity_puuids(puuid,identity_id) VALUES(?,?)",
            [("puuid-new", "identity-new"), ("puuid-zero", "identity-zero")],
        )
        connection.executemany(
            "INSERT INTO tracked_account_puuids(puuid,account) VALUES(?,?)",
            [("puuid-new", "New#EUW"), ("puuid-zero", "Zero#EUW")],
        )
        connection.execute(
            "INSERT INTO riot_account_aliases"
            "(account,normalized_riot_id,display_riot_id,puuid,verification_source,verified_at) "
            "VALUES(?,?,?,?,?,?)",
            ("New#EUW", "old#euw", "Old#EUW", "puuid-new", "verified_account_puuid", "2026-09-01"),
        )
        save_feedback(connection, ["Zero#EUW"], "Ahri", "MIDDLE", "like", 0)

    status, default = query(fixture, role="ALL", queue="all")
    explicit_status, explicit = query(
        fixture, account=["New#EUW"], role="MIDDLE", queue="all",
    )

    assert status == explicit_status == 200
    assert default["coverage"]["selected_accounts"] == ["New#EUW", "Zero#EUW"]
    assert default["coverage"]["active_accounts"] == ["New#EUW"]
    assert default["coverage"]["missing_accounts"] == ["Zero#EUW"]
    assert {(item["champion"], item["feedback"]) for item in default["known"]} == {
        ("Ahri", "like"), ("Annie", None),
    }
    assert [(item["champion"], item["games"]) for item in explicit["known"]] == [
        ("Annie", 1),
    ]


def test_ambiguous_verified_alias_cannot_claim_same_named_raw_history(tmp_path):
    fixture = ScopeFixture(tmp_path)
    fixture.series("Shared#EUW", "Annie", 1, 1)
    with closing(fixture.storage.connect()) as connection, connection:
        connection.executemany(
            "INSERT INTO riot_account_identities(identity_id,account) VALUES(?,?)",
            [("identity-first", "First#EUW"), ("identity-second", "Second#EUW")],
        )
        connection.executemany(
            "INSERT INTO riot_identity_puuids(puuid,identity_id) VALUES(?,?)",
            [("puuid-first", "identity-first"), ("puuid-second", "identity-second")],
        )
        connection.executemany(
            "INSERT INTO riot_account_aliases"
            "(account,normalized_riot_id,display_riot_id,puuid,verification_source,verified_at) "
            "VALUES(?,?,?,?,?,?)",
            [
                ("First#EUW", "shared#euw", "Shared#EUW", "puuid-first", "verified_account_puuid", "2026-09-01"),
                ("Second#EUW", "shared#euw", "Shared#EUW", "puuid-second", "verified_account_puuid", "2026-09-01"),
            ],
        )

    status, data = query(
        fixture, account=["Shared#EUW"], role="MIDDLE", queue="all",
    )

    assert status == 200
    assert data["coverage"]["selected_accounts"] == ["Shared#EUW"]
    assert data["coverage"]["active_accounts"] == []
    assert data["coverage"]["missing_accounts"] == ["Shared#EUW"]
    assert data["known"] == data["discover"] == []


def test_explicit_empty_context_is_not_broadened_and_lifetime_is_respected(tmp_path):
    fixture = ScopeFixture(tmp_path)
    fixture.series("one", "Annie", 3, 1)
    fixture.series("one", "Ahri", 1, 1)
    with closing(fixture.storage.connect()) as connection, connection:
        connection.execute("UPDATE match_quality SET date='2020-01-01T00:00:00Z' WHERE champion='Ahri'")
    status, data = query(fixture, account=["one"], days=365, queue=420, role="MIDDLE")
    assert status == 200
    assert "Ahri" not in {r["champion"] for r in data["discover"]}
    status, empty = query(fixture, account=["one"], queue=440, role="TOP")
    assert status == 200
    assert empty["context"]["queue"] == "440" and empty["context"]["role"] == "TOP"
    assert empty["known"] == empty["discover"] == []


def test_default_and_all_roles_keep_recommendations_and_performance_separate_by_role(tmp_path):
    fixture = ScopeFixture(tmp_path)
    fixture.series("one", "Ahri", 2, 1)
    fixture.series("one", "Ahri", 1, 1)
    fixture.series("one", "Ahri", 1, 0)
    fixture.series("one", "Ahri", 1, 1)
    fixture.series("one", "Ahri", 1, 0)
    with closing(fixture.storage.connect()) as connection, connection:
        connection.execute("UPDATE match_quality SET role='TOP' WHERE match_id='scope-3'")
        connection.execute("UPDATE match_quality SET role='JUNGLE' WHERE match_id='scope-4'")
        connection.execute("UPDATE match_quality SET role='BOTTOM' WHERE match_id='scope-5'")
        connection.execute("UPDATE match_quality SET role='SUPPORT' WHERE match_id='scope-6'")

    status, default = query(fixture, account=["one"])
    assert status == 200
    assert default["context"]["role"] == "ALL"
    entries = [item for item in default["known"] if item["champion"] == "Ahri"]
    assert {(item["role"], item["performance"]["games"], item["performance"]["win_rate"])
            for item in entries} == {
                ("MIDDLE", 2, 50.0), ("TOP", 1, 100.0), ("JUNGLE", 1, 0.0),
                ("BOTTOM", 1, 100.0), ("SUPPORT", 1, 0.0),
            }
    assert {item["role"] for item in entries} == {"TOP", "JUNGLE", "MIDDLE", "BOTTOM", "SUPPORT"}

    status, all_roles = query(fixture, account=["one"], role="ALL")
    assert status == 200
    assert [(item["champion"], item["role"]) for item in all_roles["known"]] == [
        (item["champion"], item["role"]) for item in default["known"]
    ]

    status, middle = query(fixture, account=["one"], role="MIDDLE")
    assert status == 200
    assert middle["context"]["role"] == "MIDDLE"
    assert {(item["champion"], item["role"]) for item in middle["known"]} == {("Ahri", "MIDDLE")}


def test_all_role_champion_detail_returns_distinct_role_candidates(tmp_path):
    fixture = ScopeFixture(tmp_path)
    fixture.series("one", "Ahri", 2, 1)
    fixture.series("one", "Ahri", 1, 1)
    fixture.series("one", "Ahri", 1, 0)
    fixture.series("one", "Ahri", 1, 1)
    fixture.series("one", "Ahri", 1, 0)
    with closing(fixture.storage.connect()) as connection, connection:
        connection.execute("UPDATE match_quality SET role='TOP' WHERE match_id='scope-3'")
        connection.execute("UPDATE match_quality SET role='JUNGLE' WHERE match_id='scope-4'")
        connection.execute("UPDATE match_quality SET role='BOTTOM' WHERE match_id='scope-5'")
        connection.execute("UPDATE match_quality SET role='SUPPORT' WHERE match_id='scope-6'")

    status, data = query(fixture, account=["one"], role="ALL", champion="Ahri")
    assert status == 200
    assert data["candidate"] is None
    variants = {item["role"]: item for item in data["candidates"]}
    assert set(variants) == {"TOP", "JUNGLE", "MIDDLE", "BOTTOM", "SUPPORT"}
    assert variants["MIDDLE"]["performance"]["games"] == 2
    assert variants["TOP"]["performance"]["games"] == 1
    assert variants["MIDDLE"]["performance"]["win_rate"] == 50.0
    assert variants["TOP"]["performance"]["win_rate"] == 100.0


def test_all_role_lists_and_trial_plan_keep_global_configured_limits(tmp_path):
    fixture = ScopeFixture(tmp_path)
    fixture.series("one", "Annie", 1, 1)
    fixture.series("one", "Ahri", 1, 1)
    fixture.series("one", "Lux", 1, 1)
    with closing(fixture.storage.connect()) as connection, connection:
        connection.execute("UPDATE match_quality SET role='TOP' WHERE match_id='scope-2'")
        connection.execute("UPDATE match_quality SET role='SUPPORT' WHERE match_id='scope-3'")
        snapshot = get_settings_snapshot(connection)
        settings = deepcopy(snapshot["settings"])
        settings["recommendations"].update(limit=2, trial_budget=1)
        save_settings(connection, snapshot["revision"], settings)

    status, data = query(fixture, account=["one"])
    assert status == 200
    assert len(data["known"]) == 2
    assert len(data["discover"]) <= 2
    assert data["trial_plan"]["budget"] <= 1
    assert len(data["trial_plan"]["items"]) <= 1
    assert all(item["role"] in {"MIDDLE", "TOP", "SUPPORT"} for item in data["known"])

    status, automatic = query(fixture, account=["one"], role="AUTO")
    assert status == 200
    assert automatic["context"]["automatic_role"] is True
    assert automatic["context"]["role"] in {"MIDDLE", "TOP", "SUPPORT"}


def test_game_period_is_applied_after_explicit_role_and_queue_filters(tmp_path):
    fixture = ScopeFixture(tmp_path)
    fixture.series("one", "Ahri", 3, 2)
    fixture.series("one", "Riven", 3, 1)
    with closing(fixture.storage.connect()) as connection, connection:
        connection.execute(
            "UPDATE match_quality SET date=printf('2026-09-%02dT00:00:00Z', id)"
        )
        connection.execute(
            "UPDATE match_quality SET role='TOP',queue='440' WHERE champion='Riven'"
        )
        snapshot = get_settings_snapshot(connection)
        settings = deepcopy(snapshot["settings"])
        settings["recommendations"]["period"] = {"value": 3, "unit": "games"}
        save_settings(connection, snapshot["revision"], settings)

    status, data = query(
        fixture, account=["one"], role="MIDDLE", queue="420",
        as_of="2026-10-01T00:00:00Z",
    )

    assert status == 200
    assert [(item["champion"], item["games"]) for item in data["known"]] == [("Ahri", 3)]
    assert data["context"]["period"] == {"value": 3, "unit": "games"}
    assert data["context"]["observations"] == 3


def test_automatic_queue_is_selected_before_the_game_window_is_sliced(tmp_path):
    fixture = ScopeFixture(tmp_path)
    fixture.series("one", "Ahri", 4, 2)
    fixture.series("one", "Riven", 3, 1)
    with closing(fixture.storage.connect()) as connection, connection:
        connection.execute(
            "UPDATE match_quality SET date=printf('2026-09-%02dT00:00:00Z', id)"
        )
        connection.execute(
            "UPDATE match_quality SET role='TOP',queue='440' WHERE champion='Riven'"
        )
        snapshot = get_settings_snapshot(connection)
        settings = deepcopy(snapshot["settings"])
        settings["recommendations"]["period"] = {"value": 2, "unit": "games"}
        save_settings(connection, snapshot["revision"], settings)

    status, data = query(
        fixture, account=["one"], role="ALL", queue="auto",
        as_of="2026-10-01T00:00:00Z",
    )

    assert status == 200
    assert data["context"]["queue"] == "420"
    assert data["context"]["observations"] == 2
    assert [(item["champion"], item["games"]) for item in data["known"]] == [("Ahri", 2)]


def test_companion_filter_is_applied_before_the_game_window_is_sliced(tmp_path):
    fixture = ScopeFixture(tmp_path)
    fixture.series("one", "Ahri", 3, 2)
    fixture.series("one", "Lux", 3, 1)
    with closing(fixture.storage.connect()) as connection, connection:
        connection.execute(
            "UPDATE match_quality SET date=printf('2026-09-%02dT00:00:00Z', id)"
        )
        connection.executemany(
            "INSERT INTO match_participants(match_id,puuid,riot_id) VALUES(?,?,?)",
            [(f"scope-{index}", f"friend-{index}", "Friend#EUW") for index in range(4, 7)],
        )
        snapshot = get_settings_snapshot(connection)
        settings = deepcopy(snapshot["settings"])
        settings["recommendations"]["period"] = {"value": 2, "unit": "games"}
        save_settings(connection, snapshot["revision"], settings)

    status, data = query(
        fixture, account=["one"], role="MIDDLE", queue="420",
        companion_account=["Friend#EUW"], companion_mode="exclude",
        as_of="2026-10-01T00:00:00Z",
    )

    assert status == 200
    assert data["context"]["companion_filter_active"] is True
    assert data["context"]["observations"] == 2
    assert [(item["champion"], item["games"]) for item in data["known"]] == [("Ahri", 2)]


def test_all_role_ranking_uses_each_accounts_full_context_denominator(tmp_path):
    fixture = ScopeFixture(tmp_path)
    fixture.series("one", "Ahri", 4, 2)
    fixture.series("one", "Lux", 1, 1)
    fixture.series("one", "Riven", 1, 1)
    with closing(fixture.storage.connect()) as connection, connection:
        connection.execute("UPDATE match_quality SET role='TOP' WHERE champion='Riven'")

    status, data = query(fixture, account=["one"], role="ALL", queue="all")

    assert status == 200
    assert [
        (item["champion"], item["role"], item["preference_score"])
        for item in data["known"]
    ] == [
        ("Ahri", "MIDDLE", 4 / 6),
        ("Lux", "MIDDLE", 1 / 6),
        ("Riven", "TOP", 1 / 6),
    ]


def test_lifetime_tried_detail_is_familiar_outside_current_role(tmp_path):
    fixture = ScopeFixture(tmp_path)
    fixture.series("one", "Annie", 1, 1)

    status, data = query(
        fixture, account=["one"], role="SUPPORT", queue="all", champion="Annie",
    )

    assert status == 200
    assert data["candidate"]["kind"] == "familiar"
    assert data["candidate"]["games"] == 0
    assert data["candidate"]["similarity"] is None
    assert "storico selezionato" in data["candidate"]["reasons"][0]


def test_all_role_performance_uses_global_family_and_configured_decision_settings(tmp_path):
    from observed_performance import observed_performance

    fixture = ScopeFixture(tmp_path)
    fixture.series("one", "Annie", 1, 1)
    fixture.series("one", "Riven", 1, 0)
    with closing(fixture.storage.connect()) as connection, connection:
        connection.execute("UPDATE match_quality SET role='TOP' WHERE champion='Riven'")
        snapshot = get_settings_snapshot(connection)
        settings = deepcopy(snapshot["settings"])
        settings["evidence"].update(meaningful_delta=.07, family_alpha=.02)
        save_settings(connection, snapshot["revision"], settings)

    calls = []

    def recording_performance(*args, **kwargs):
        calls.append(kwargs)
        return observed_performance(*args, **kwargs)

    with patch("observed_performance.observed_performance", side_effect=recording_performance):
        status, data = query(
            fixture, account=["one"], role="ALL", queue="all", champion="Annie",
        )

    assert status == 200
    support = next(item for item in data["candidates"] if item["role"] == "SUPPORT")
    assert support["kind"] == "familiar"
    assert support["performance"]["family_size"] == 2
    assert support["performance"]["meaningful_delta"] == .07
    assert support["performance"]["family_alpha"] == .02
    assert calls
    assert {call["family_size"] for call in calls} == {2}
    assert {call["meaningful_delta"] for call in calls} == {.07}
    assert {call["family_alpha"] for call in calls} == {.02}


def test_recommendations_ignore_old_prior_weights_and_wins_but_keep_actual_record(tmp_path):
    fixture = ScopeFixture(tmp_path)
    fixture.series("one", "Annie", 3, 1)
    fixture.series("one", "Ahri", 1, 1)
    _, before = query(fixture, account=["one"])
    with closing(fixture.storage.connect()) as connection:
        snapshot = get_settings_snapshot(connection)
        settings = deepcopy(snapshot["settings"])
        settings["evidence"]["prior_mean"] = .6
        settings["evidence"]["prior_strength"] = 50
        settings["evidence"]["min_games"] = 200
        save_settings(connection, snapshot["revision"], settings)
        connection.execute("UPDATE match_quality SET win=1-win,loss_attribution_weight=0,win_evidence_weight=0")
        connection.commit()
    _, after = query(fixture, account=["one"])
    for section in ("known", "discover"):
        assert [(r["champion"], r["preference_score"], r["similarity"]) for r in before[section]] == [
            (r["champion"], r["preference_score"], r["similarity"]) for r in after[section]]
    assert before["known"][0]["performance"]["wins"] != after["known"][0]["performance"]["wins"]
    status, stale = query(fixture, account=["one"], algorithm_revision=before["algorithm_revision"])
    assert status == 409


def test_feedback_changes_live_recommendations_and_persists_on_reopen(tmp_path):
    from recommendation_feedback import save_feedback
    fixture = ScopeFixture(tmp_path)
    fixture.series("one", "Annie", 3, 1)
    _, before = query(fixture, account=["one"])
    with closing(fixture.storage.connect()) as connection, connection:
        save_feedback(connection, ["one"], "Annie", "MIDDLE", "dislike", before["feedback_revision"])
    _, after = query(fixture, account=["one"], champion="Annie")
    assert after["feedback_revision"] == before["feedback_revision"] + 1
    assert "Annie" not in {r["champion"] for r in after["known"]}
    candidate = next(item for item in after["candidates"] if item["role"] == "MIDDLE")
    assert candidate["feedback"] == "dislike"
    assert candidate["performance"]["games"] == 3


def test_new_settings_control_context_and_limits_without_minimum_sample(tmp_path):
    fixture = ScopeFixture(tmp_path)
    fixture.series("one", "Annie", 1, 0)
    with closing(fixture.storage.connect()) as connection:
        snapshot = get_settings_snapshot(connection)
        settings = deepcopy(snapshot["settings"])
        settings["recommendations"].update(limit=2, trial_budget=2, confidence=.8)
        save_settings(connection, snapshot["revision"], settings)
    _, data = query(fixture, account=["one"], champion="Annie")
    assert len(data["known"]) == 1
    assert len(data["discover"]) <= 2
    candidate = next(item for item in data["candidates"] if item["role"] == "MIDDLE")
    assert candidate["performance"]["confidence"] == .8
    assert sum(r["games"] for r in data["trial_plan"]["items"]) <= 2


def test_preview_compares_current_preferences_without_persisting(tmp_path):
    fixture = ScopeFixture(tmp_path)
    fixture.series("one", "Annie", 2, 1)
    fixture.series("one", "Ahri", 1, 0)
    with closing(fixture.storage.connect()) as connection:
        snapshot = get_settings_snapshot(connection)
    proposed = deepcopy(snapshot["settings"])
    proposed["recommendations"].update(limit=1, trial_budget=1)
    with patch.object(app, "STORAGE", fixture.storage):
        status, result = app.preview_algorithm_settings({"expected_revision": snapshot["revision"],
            "settings": proposed, "scope": {"account": ["one"]}})
    assert status == 200
    comparison = next(r for r in result["comparisons"] if r["algorithm"] == "Preferenze e prove personali")
    assert len(comparison["before"]["known"]) == 2
    assert len(comparison["after"]["known"]) == 1
    assert comparison["after"]["trial_plan"]["budget"] == 1
    for scenario in result["sensitivity"]:
        assert scenario["preferences"] == comparison["after"]
    with closing(fixture.storage.connect()) as connection:
        assert get_settings_snapshot(connection)["revision"] == snapshot["revision"]


def test_feedback_http_is_atomic_and_rejects_stale_revision(isolated_server):
    import json
    import sqlite3
    with sqlite3.connect(isolated_server["database"]) as connection:
        connection.execute("INSERT INTO champions VALUES ('Annie','Annie','/Annie.png')")
        connection.execute("INSERT INTO match_quality(account,match_id,date,patch,queue,champion,role,identity_resolution,"
                           "duration_minutes,win,explicit_afk,suspected_quasi_afk,early_surrender,anomaly_flags,"
                           "match_quality_score,loss_attribution_weight,win_evidence_weight,reason) "
                           "VALUES ('one','m','2026-08-01','16.16','420','Annie','MIDDLE','test',30,1,0,0,0,'none',1,0,1,'fixture')")
    payload = {"accounts": ["one"], "champion": "Annie", "role": "MIDDLE", "preference": "dislike", "expected_revision": 0}
    status, _, body = request(isolated_server, "POST", "/api/recommendation-feedback", payload=payload)
    assert status == 200, body
    saved = json.loads(body)
    assert saved["revision"] == 1
    status, _, body = request(isolated_server, "POST", "/api/recommendation-feedback", payload={**payload, "preference": "like"})
    assert status == 409
    assert json.loads(body)["snapshot"]["revision"] == 1
    status, _, body = request(isolated_server, "GET", "/api/recommendations?account=one")
    assert status == 200, body
    assert not json.loads(body)["known"]
    assert not json.loads(body)["discover"]
    status, _, body = request(isolated_server, "POST", "/api/recommendation-feedback", payload={**payload, "preference": "neutral", "expected_revision": 1})
    assert status == 200, body
    status, _, body = request(isolated_server, "GET", "/api/recommendations?account=one")
    assert status == 200
    assert json.loads(body)["known"][0]["champion"] == "Annie"
    # An imported champion missing from this catalog remains a usable personal
    # choice. Explicit feedback must survive the HTTP/persistence/engine path.
    with sqlite3.connect(isolated_server["database"]) as connection:
        connection.execute("INSERT INTO champions VALUES ('UnknownChampion','UnknownChampion','')")
        connection.execute("INSERT INTO match_quality(account,match_id,date,patch,queue,champion,role,identity_resolution,"
                           "duration_minutes,win,explicit_afk,suspected_quasi_afk,early_surrender,anomaly_flags,"
                           "match_quality_score,loss_attribution_weight,win_evidence_weight,reason) "
                           "SELECT account,'unknown-match',date,patch,queue,'UnknownChampion',role,identity_resolution,"
                           "duration_minutes,win,explicit_afk,suspected_quasi_afk,early_surrender,anomaly_flags,"
                           "match_quality_score,loss_attribution_weight,win_evidence_weight,reason FROM match_quality WHERE match_id='m'")
    status, _, body = request(isolated_server, "POST", "/api/recommendation-feedback", payload={**payload,
        "champion": "UnknownChampion", "preference": "like", "expected_revision": 2})
    assert status == 200, body
    status, _, body = request(isolated_server, "GET", "/api/recommendations?account=one")
    current = json.loads(body)
    assert status == 200
    assert current["known"][0]["champion"] == "UnknownChampion"
    assert current["known"][0]["feedback"] == "like"
