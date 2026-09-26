from contextlib import closing
from pathlib import Path
from unittest.mock import patch

import app
from storage import SQLiteStorage
from test_algorithm_scope import ScopeFixture


def _query(fixture, path, params):
    with patch.object(app, "STORAGE", fixture.storage):
        return app.query_database(path, params)


def test_champion_matrix_and_training_plan_share_explicit_context(tmp_path):
    fixture = ScopeFixture(Path(tmp_path))
    fixture.series("selected", "Ahri", 12, 8)
    fixture.series("selected", "Lux", 12, 5)
    with closing(fixture.storage.connect()) as connection, connection:
        connection.execute("UPDATE match_quality SET queue='440', patch='16.17' WHERE champion='Lux'")

    status, matrix = _query(fixture, "/api/champions", {
        "account": ["selected"], "role": ["MIDDLE"], "queue": ["all"], "days": ["all"],
    })
    plan_status, plan = _query(fixture, "/api/training-plan", {
        "account": ["selected"], "role": ["MIDDLE"], "queue": ["all"], "days": ["all"], "budget": ["20"],
    })

    assert status == plan_status == 200
    assert matrix["context"]["queue"] == plan["context"]["queue"] == "all"
    assert matrix["context"]["days"] == plan["context"]["days"] == "all"
    assert matrix["model"]["model_version"] == plan["model"]["model_version"]
    assert plan["budget_total"] == plan["budget_assigned"] == 20
    assert sum(item["allocation_games"] for item in plan["items"]) == 20
    assert {item["champion"] for item in matrix["items"]} == {"Ahri", "Lux"}


def test_champion_model_cache_changes_after_a_new_match_is_imported(tmp_path):
    fixture = ScopeFixture(Path(tmp_path))
    fixture.series("selected", "Ahri", 8, 4)
    before_status, before = _query(fixture, "/api/champions", {
        "account": ["selected"], "role": ["MIDDLE"], "queue": ["420"], "days": ["all"],
    })
    before_item = next(item for item in before["items"] if item["champion"] == "Ahri")

    fixture.series("selected", "Ahri", 2, 2)
    after_status, after = _query(fixture, "/api/champions", {
        "account": ["selected"], "role": ["MIDDLE"], "queue": ["420"], "days": ["all"],
    })
    after_item = next(item for item in after["items"] if item["champion"] == "Ahri")

    assert before_status == after_status == 200
    assert before_item["unique_games"] == 8
    assert after_item["unique_games"] == 10
    assert before_item["posterior_win_rate"] != after_item["posterior_win_rate"]


def test_empty_historical_scope_keeps_model_status_and_returns_empty_plan(tmp_path):
    fixture = ScopeFixture(Path(tmp_path))
    fixture.series("selected", "Ahri", 4, 2)
    params = {
        "account": ["selected"], "role": ["MIDDLE"], "queue": ["440"], "days": ["all"],
    }

    status, matrix = _query(fixture, "/api/champions", params)
    plan_status, plan = _query(fixture, "/api/training-plan", params | {"budget": ["20"]})

    assert status == plan_status == 200
    assert matrix["items"] == []
    assert matrix["model"]["status"] == "exploratory"
    assert plan["model"]["status"] == matrix["model"]["status"]
    assert plan["budget_total"] == 20
    assert plan["budget_assigned"] == 0
    assert plan["budget_unassigned"] == 20
