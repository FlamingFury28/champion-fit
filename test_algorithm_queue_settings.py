"""Global defaults must cover the same canonical queues as the analyses."""
from contextlib import closing

import pytest

import app
from algorithm_settings import get_settings_snapshot, recommended_settings, save_settings, validate_settings
from queue_rules import SUPPORTED_QUEUE_IDS
from test_algorithm_scope import ScopeFixture


@pytest.mark.parametrize("queue", sorted(SUPPORTED_QUEUE_IDS))
def test_supported_queue_is_a_valid_global_default(queue):
    settings = recommended_settings()
    settings["context"]["queue"] = queue
    assert validate_settings(settings)["context"]["queue"] == queue


@pytest.mark.parametrize("queue", ["480", "700"])
def test_settings_schema_save_and_analysis_agree_on_supported_default(tmp_path, monkeypatch, queue):
    fixture = ScopeFixture(tmp_path)
    fixture.series("selected", "Ahri", 3, 2)
    with closing(fixture.storage.connect()) as connection:
        connection.execute("UPDATE match_quality SET queue=?", (queue,))
        connection.commit()
        before = get_settings_snapshot(connection)
        options = next(field["options"] for field in before["schema"] if field["path"] == "context.queue")
        assert set(options) == SUPPORTED_QUEUE_IDS
        settings = before["settings"]
        settings["context"]["queue"] = queue
        saved = save_settings(connection, before["revision"], settings)
        assert saved["settings"]["context"]["queue"] == queue
    monkeypatch.setattr(app, "STORAGE", fixture.storage)
    status, payload = app.query_database("/api/matchups", {"account": ["selected"], "days": ["all"]})
    assert status == 200
    assert str(payload["context"]["queue"]) == queue
    assert payload["games"] == 3
