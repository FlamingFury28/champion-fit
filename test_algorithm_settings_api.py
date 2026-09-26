"""Runtime settings contracts on disposable SQLite analysis fixtures."""

from __future__ import annotations

from copy import deepcopy
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

import app
from algorithm_settings import get_settings_snapshot, save_settings
from test_algorithm_scope import ScopeFixture


def query(fixture, path, **extra):
    params = {
        "account": ["selected"], "queue": ["420"], "days": ["all"],
        **{key: [str(value)] for key, value in extra.items()},
    }
    with patch.object(app, "STORAGE", fixture.storage):
        return app.query_database(path, params)


def archive_snapshot(fixture):
    with closing(fixture.storage.connect()) as connection:
        return {
            table: [dict(row) for row in connection.execute(f"SELECT * FROM {table} ORDER BY 1")]
            for table in ("match_quality", "match_import_provenance", "match_annotations")
        }


def known_riot_defaults(fixture):
    with closing(fixture.storage.connect()) as connection, connection:
        connection.executemany(
            """INSERT INTO match_import_provenance
               (account,match_id,source,classification,overrides_json,recorded_at)
               VALUES(?,?,?,?,?,?)""",
            [
                (row["account"], row["match_id"], "riot", "known_riot_default", "{}", "now")
                for row in connection.execute("SELECT account,match_id FROM match_quality")
            ],
        )


def matching(items, champion):
    return next(item for item in items if item["champion"] == champion)


def test_settings_get_save_revision_and_stale_analytical_request(tmp_path):
    fixture = ScopeFixture(Path(tmp_path))
    fixture.series("selected", "A", 30, 21)
    fixture.series("selected", "B", 30, 12)

    with patch.object(app, "STORAGE", fixture.storage):
        status, before_settings = app.query_database("/api/algorithm-settings", {})
        before_status, before = app.query_database(
            "/api/profile", {"account": ["selected"], "queue": ["420"], "days": ["all"]},
        )
        assert status == before_status == 200
        assert before_settings["revision"] == 2
        assert before_settings["settings"] == before_settings["defaults"]
        assert before_settings["settings"]["context"] == {"queue": "420", "days": 180}

        proposed = deepcopy(before_settings["settings"])
        proposed["evidence"]["prior_mean"] = 0.6
        with closing(fixture.storage.connect()) as connection:
            saved = save_settings(connection, before_settings["revision"], proposed)

        stale_status, stale = app.query_database(
            "/api/profile",
            {"account": ["selected"], "queue": ["420"], "days": ["all"],
             "algorithm_revision": [str(before_settings["revision"])]},
        )
        fresh_status, fresh = app.query_database(
            "/api/profile", {"account": ["selected"], "queue": ["420"], "days": ["all"]},
        )

    assert saved["revision"] == 3
    assert stale_status == 409
    assert stale["algorithm_revision"] == 3
    assert fresh_status == 200
    assert fresh["algorithm_revision"] == 3
    before_a = matching(before["recommendations"], "A")
    fresh_a = matching(fresh["recommendations"], "A")
    assert before_a["posterior_fit"] != fresh_a["posterior_fit"]
    # Changing the prior does not silently change the established 90% field contract.
    assert fresh_a["credible_mass"] == 0.9
    assert fresh_a["credible_lower_90"] < fresh_a["credible_upper_90"]


def test_preview_compares_effective_models_without_persisting_archived_facts(tmp_path):
    fixture = ScopeFixture(Path(tmp_path))
    fixture.series("selected", "A", 24, 8)
    fixture.series("selected", "B", 24, 20)
    known_riot_defaults(fixture)
    with closing(fixture.storage.connect()) as connection, connection:
        connection.execute(
            "INSERT INTO match_annotations(match_id,afk_player,updated_at) VALUES(?,?,?)",
            ("scope-9", 1, "now"),
        )
    before_archive = archive_snapshot(fixture)

    with patch.object(app, "STORAGE", fixture.storage):
        with closing(fixture.storage.connect()) as connection:
            snapshot = get_settings_snapshot(connection)
        proposed = deepcopy(snapshot["settings"])
        proposed["attribution"]["loss_weights"] = [0, 0, 0, 0, 0, 0]
        status, preview = app.preview_algorithm_settings({
            "expected_revision": snapshot["revision"], "settings": proposed,
            "scope": {"account": ["selected"], "queue": "420", "days": "all", "role": "ALL"},
        })

    assert status == 200
    assert preview["base_revision"] == snapshot["revision"]
    assert preview["changed_paths"] == ["attribution.loss_weights"]
    assert preview["comparisons"] and {"algorithm", "before", "after"} <= set(preview["comparisons"][0])
    comparison = preview["comparisons"][0]
    assert comparison["before"]["attribution"]["negative"] > comparison["after"]["attribution"]["negative"]
    assert {item["label"] for item in preview["sensitivity"]} == {"Pesi pieni", "Fasce storiche"}
    assert archive_snapshot(fixture) == before_archive


def test_default_context_selects_most_played_role_and_never_falls_back(tmp_path):
    fixture = ScopeFixture(Path(tmp_path))
    fixture.series("selected", "Middle", 6, 4)
    fixture.series("selected", "Support", 2, 1)
    with closing(fixture.storage.connect()) as connection, connection:
        connection.execute("UPDATE match_quality SET role='SUPPORT' WHERE champion='Support'")
        connection.execute("UPDATE match_quality SET queue='440' WHERE champion='Support'")

    with patch.object(app, "STORAGE", fixture.storage):
        default_status, default = app.query_database("/api/profile", {"account": ["selected"]})
        support_status, support = app.query_database(
            "/api/profile", {"account": ["selected"], "role": ["SUPPORT"], "queue": ["440"], "days": ["180"]},
        )
        missing_status, missing = app.query_database(
            "/api/profile", {"account": ["selected"], "role": ["SUPPORT"], "queue": ["420"], "days": ["180"]},
        )

    assert default_status == support_status == missing_status == 200
    assert default["context"] | {"as_of": default["context"]["as_of"]} == {
        "accounts": ["selected"], "role": "MIDDLE", "queue": "420", "days": "180",
        "observations": 6, "unique_games": 6, "suspended_accounts": [],
        "companion_filter_active": False, "as_of": default["context"]["as_of"],
    }
    assert support["context"]["role"] == "SUPPORT"
    assert support["summary"]["games"] == 2
    assert missing["context"]["role"] == "SUPPORT"
    assert missing["context"]["queue"] == "420"
    assert missing["summary"]["games"] == 0


def test_annotations_change_effective_evidence_without_changing_outcome_advice_or_archive_weights(tmp_path):
    fixture = ScopeFixture(Path(tmp_path))
    fixture.series("selected", "A", 40, 20)
    fixture.series("selected", "B", 40, 28)
    before_status, before = query(fixture, "/api/profile", role="ALL")
    archive_before = archive_snapshot(fixture)
    with closing(fixture.storage.connect()) as connection, connection:
        connection.execute(
            "INSERT INTO match_annotations(match_id,afk_player,updated_at) VALUES(?,?,?)",
            ("scope-21", 1, "now"),
        )
    after_status, after = query(fixture, "/api/profile", role="ALL")
    evidence_status, evidence = query(fixture, "/api/recommendation-evidence", champion="A", role="MIDDLE")

    assert before_status == after_status == evidence_status == 200
    before_a, after_a = matching(before["recommendations"], "A"), matching(after["recommendations"], "A")
    assert after_a["negative_evidence"] == before_a["negative_evidence"] - 1
    for field in ("posterior_fit", "credible_lower_90", "credible_upper_90", "recommendation", "actionable"):
        assert after_a[field] == before_a[field]
    marked = next(item for item in evidence["items"] if item["match_id"] == "scope-21")
    assert marked["attribution_source"] == "manual_annotation"
    assert marked["evidence_weight"] == 0
    archive_after = archive_snapshot(fixture)
    assert archive_after["match_quality"] == archive_before["match_quality"]
    assert archive_after["match_import_provenance"] == archive_before["match_import_provenance"]
    assert len(archive_after["match_annotations"]) == len(archive_before["match_annotations"]) + 1


def test_live_endpoints_keep_champion_detail_match_evidence_and_exploration_lifetime_scoped(tmp_path):
    fixture = ScopeFixture(Path(tmp_path))
    fixture.series("selected", "Lux", 30, 22)
    fixture.series("selected", "Garen", 30, 8)
    champions_status, champions = query(fixture, "/api/champions", role="MIDDLE")
    detail_status, detail = query(fixture, "/api/champion", champion="Lux", role="MIDDLE")
    matches_status, matches = query(fixture, "/api/matches", champion="Lux", role="MIDDLE", limit="100")
    exploration_status, exploration = query(fixture, "/api/exploration", role="MIDDLE")

    assert champions_status == detail_status == matches_status == exploration_status == 200
    champion = matching(champions["items"], "Lux")
    assert detail["fit"]["champion"] == champion["champion"]
    assert detail["fit"]["posterior_win_rate"] == champion["posterior_win_rate"]
    assert detail["stats"]["games"] == len(matches["items"]) == 30
    assert all(item["attribution_source"] == "archived_fallback" for item in matches["items"])
    assert exploration["items"]
    assert all(item["classification"] == "exploration" and item["lifetime_games_selected"] == 0
               for item in exploration["items"])


def test_suspended_identity_vetoes_live_analysis_without_erasing_archive(tmp_path):
    fixture = ScopeFixture(Path(tmp_path))
    fixture.series("selected", "Lux", 20, 14)
    archive_before = archive_snapshot(fixture)
    with closing(fixture.storage.connect()) as connection, connection:
        connection.execute("INSERT INTO riot_account_identities VALUES('owner','selected')")
        connection.execute(
            """INSERT INTO riot_identity_policy
               (puuid,identity_id,state,resume_state,source,note,updated_at,history_json)
               VALUES(?,?,?,?,?,?,?,?)""",
            ("p", "owner", "exception", "assumed", "manual", "review", "now", "[]"),
        )

    status, payload = query(fixture, "/api/profile", role="ALL")

    assert status == 200
    assert payload["context"]["suspended_accounts"] == ["selected"]
    assert payload["summary"]["games"] == 0
    assert payload["recommendations"] == []
    assert archive_snapshot(fixture)["match_quality"] == archive_before["match_quality"]
