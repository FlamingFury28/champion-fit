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
    assert group["known"][0]["performance"]["win_rate"] == 100
    assert group["known"][0]["performance"]["baseline_win_rate"] is None


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
