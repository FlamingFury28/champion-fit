"""Projection safety and request snapshot isolation, independently of models."""
from contextlib import closing
from unittest.mock import Mock, patch

import app
from algorithm_settings import ensure_settings, get_settings_snapshot, settings_context
from analysis_runtime import prepare_analysis
from queue_rules import is_supported_queue
from test_algorithm_scope import ScopeFixture


def test_projection_keeps_import_coverage_lifetime_and_never_drops_main_table(tmp_path):
    fixture = ScopeFixture(tmp_path)
    fixture.series("selected", "Lux", 2, 1)
    with closing(fixture.storage.connect()) as connection:
        connection.execute("UPDATE match_quality SET date='2020-01-01' WHERE match_id='scope-2'")
        connection.execute("CREATE TABLE analysis_match_quality (sentinel TEXT)")
        connection.execute("INSERT INTO analysis_match_quality VALUES('preserve me')")
        connection.commit()
        ensure_settings(connection)
        snapshot = get_settings_snapshot(connection)
        with settings_context(snapshot["settings"], snapshot["revision"], snapshot["fingerprint"]):
            view, _ = prepare_analysis(connection, {"account": ["selected"], "as_of": ["2026-09-24"], "days": ["180"]},
                                       account_filter=app.account_filter, companion_filter=app.companion_filter)
            assert view.execute("SELECT COUNT(*) FROM match_quality").fetchone()[0] == 1
            assert app.account_coverage_counts(view, ["selected"])["analyzed_games"] == 2
            assert connection.execute("SELECT sentinel FROM main.analysis_match_quality").fetchone()[0] == "preserve me"
        connection.rollback()
    with closing(fixture.storage.connect()) as reopened:
        assert reopened.execute("SELECT COUNT(*) FROM match_quality").fetchone()[0] == 2
        assert reopened.execute("SELECT sentinel FROM main.analysis_match_quality").fetchone()[0] == "preserve me"


def test_postgres_requests_start_repeatable_read_before_loading_settings():
    connection = Mock()
    storage = Mock(engine="postgres")
    storage.connect.return_value = connection
    events = []
    connection.execute.side_effect = lambda query, *args: events.append(query)
    snapshot = {"revision": 2, "settings": {}, "fingerprint": "test"}
    def load(conn):
        assert events == ["BEGIN ISOLATION LEVEL REPEATABLE READ"]
        return snapshot
    with patch.object(app, "STORAGE", storage), patch("algorithm_settings.get_settings_snapshot", side_effect=load):
        with patch.object(app, "_query_with_settings", return_value=(200, {})):
            assert app.query_database("/api/profile", {})[0] == 200
        events.clear()
        with patch("algorithm_settings.validate_settings", return_value={}):
            assert app.preview_algorithm_settings({"expected_revision": 1, "settings": {}})[0] == 409
    assert connection.close.call_count == 2


def test_sql_scope_accepts_legacy_riot_queue_names(tmp_path):
    assert is_supported_queue("RANKED_SOLO_5x5")
    fixture = ScopeFixture(tmp_path)
    fixture.series("selected", "Lux", 2, 1)
    with closing(fixture.storage.connect()) as connection:
        connection.execute("UPDATE match_quality SET queue='RANKED_SOLO_5x5'")
        connection.commit()
        ensure_settings(connection)
        snapshot = get_settings_snapshot(connection)
        with settings_context(snapshot["settings"], snapshot["revision"], snapshot["fingerprint"]):
            view, _ = prepare_analysis(
                connection,
                {"account": ["selected"], "as_of": ["2026-09-24"], "days": ["180"]},
                account_filter=app.account_filter,
                companion_filter=app.companion_filter,
            )
            assert view.context["queue"] == "420"
            assert view.context["observations"] == 2
            assert view.execute("SELECT COUNT(*) FROM match_quality").fetchone()[0] == 2
