"""Projection safety and request snapshot isolation, independently of models."""
from contextlib import closing
from datetime import datetime, timezone
import re
from unittest.mock import Mock, patch

import pytest

import app
from algorithm_settings import ensure_settings, get_settings_snapshot, settings_context
from analysis_runtime import _source_filters, parse_time, prepare_analysis
from playstyle_analysis import QUEUE_ALIASES
from queue_rules import is_supported_queue
from storage import PostgresConnection
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


@pytest.mark.parametrize("as_of", [None, "invalid", "2026-09-24T14:00:00.000499+02:00"])
def test_projection_anchors_normalized_time_before_downstream_clock_moves(tmp_path, as_of):
    import playstyle_analysis

    fixture = ScopeFixture(tmp_path)
    fixture.series("selected", "Lux", 2, 1)
    first_clock = datetime(2026, 9, 24, 12, 0, 0, 499, tzinfo=timezone.utc)
    later_clock = first_clock.replace(microsecond=501)
    params = {"account": ["selected"], "role": ["ALL"], "queue": ["420"], "days": ["all"]}
    if as_of is not None:
        params["as_of"] = [as_of]
    original_params = {key: list(values) for key, values in params.items()}
    with closing(fixture.storage.connect()) as connection:
        connection.execute("UPDATE match_quality SET date=? WHERE match_id='scope-1'", (first_clock.isoformat(),))
        connection.execute("UPDATE match_quality SET date=? WHERE match_id='scope-2'",
                           (first_clock.replace(microsecond=500).isoformat(),))
        connection.commit()
        with patch("analysis_runtime.datetime", wraps=datetime) as projection_clock, \
                patch.object(playstyle_analysis, "datetime", wraps=datetime) as downstream_clock:
            projection_clock.now.return_value = first_clock
            downstream_clock.now.return_value = later_clock
            view, normalized = prepare_analysis(
                connection, params, account_filter=app.account_filter, companion_filter=app.companion_filter,
            )
            rows = [dict(row) for row in connection.execute("SELECT * FROM main.match_quality")]

            evidence = playstyle_analysis.evidence(rows, normalized | {"category": ["class:mage"]})

            assert evidence["total"] == view.context["observations"] == 1
            assert normalized["as_of"] == [first_clock.isoformat()]
            downstream_clock.now.assert_not_called()
    assert params == original_params


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


@pytest.mark.parametrize("date,expected", [
    ("2026-08-01T12:00:00Z", 1),
    ("2026-08-01T12:00:00+02:00", 1),
    ("2026-08-01T12:00:00+02", 1),
    ("2026-08-01T12:00:00+0200", 1),
    ("2026-08-01T12:00:00+02:00:30", 1),
    ("20260801T120000Z", 1),
    ("2026-W31-6T12:00:00Z", 1),
    ("2026-08-01x12:00:00Z", 1),
    ("2026-08-01T12:00:00,5Z", 1),
    ("2026-09-24T12:00:00.0000009Z", 1),
    ("2026-09-24T12:00:00.000Z", 1),
    ("2026-09-24T12:00:00.001Z", 0),
    ("2026-09-24T12:00:00.0004999Z", 1),
    ("2026-09-24T12:00:00.000499Z", 1),
    ("2026-09-24T14:00:00.000499+02:00", 1),
    ("2026-09-24T12:00:00.0005000Z", 0),
    ("2026-09-24T13:00:00+02", 1),
    ("2026-09-24T13:00:00+00", 0),
    ("20261001T120000Z", 0),
    ("2026-03-28T02:00:00+02", 1),
    ("2026-03-28T00:30:00+02", 0),
    ("not a timestamp", 0),
    ("2026-02-30T12:00:00Z", 0),
    ("0001-01-01T00:00:00+01:00", 0),
    ("9999-12-31T23:59:59-01:00", 0),
])
def test_projection_preserves_python_date_formats_and_exact_time_scope(tmp_path, date, expected):
    fixture = ScopeFixture(tmp_path)
    fixture.series("selected", "Lux", 1, 1)
    with closing(fixture.storage.connect()) as connection:
        connection.execute("UPDATE match_quality SET date=?", (date,))
        connection.commit()
        ensure_settings(connection)
        snapshot = get_settings_snapshot(connection)
        with settings_context(snapshot["settings"], snapshot["revision"], snapshot["fingerprint"]):
            view, _ = prepare_analysis(
                connection,
                {"account": ["selected"], "as_of": ["2026-09-24T12:00:00.000499Z"], "days": ["180"]},
                account_filter=app.account_filter,
                companion_filter=app.companion_filter,
            )
            assert view.context["observations"] == expected
            assert view.execute("SELECT COUNT(*) FROM match_quality").fetchone()[0] == expected
        assert connection.execute("SELECT date FROM main.match_quality").fetchone()[0] == date


@pytest.mark.parametrize("value", [
    "0001-01-01T00:00:00+01:00",
    "9999-12-31T23:59:59-01:00",
])
def test_parse_time_discards_unrepresentable_utc_instants(value):
    assert parse_time(value) is None
    assert parse_time("2026-08-01T12:00:00+02") == datetime(2026, 8, 1, 10, tzinfo=timezone.utc)


@pytest.mark.parametrize("value,native", [
    ("2026-09-24T12:00:00Z", True),
    ("2026-09-24T12:00:00.000000Z", True),
    ("2026-09-24T12:00:00.000Z", True),
    ("2026-09-24T12:00:00+02:00", True),
    ("2026-09-24T12:00:00.0000009Z", False),
    ("2026-09-24T12:00:00+02", False),
    ("2026-09-24T12:00:00+0200", False),
    ("2026-09-24T12:00:00+02:00:30", False),
    ("20260924T120000Z", False),
    ("2026-W39-4T12:00:00Z", False),
    ("2026-09-24x12:00:00Z", False),
])
def test_postgres_adapter_preserves_conservative_native_date_guard(value, native):
    raw = Mock()
    adapter = PostgresConnection(raw)
    sql, values, _ = _source_filters(
        adapter, targets=["selected"], params={}, suspended=set(), queue="420",
        cutoff=datetime(2026, 3, 28, tzinfo=timezone.utc),
        now=datetime(2026, 9, 24, 12, tzinfo=timezone.utc),
        account_filter=app.account_filter, companion_filter=app.companion_filter,
        queue_aliases=QUEUE_ALIASES,
    )
    adapter.execute("SELECT m.date FROM match_quality m WHERE 1=1" + sql, values)
    query, bound = raw.execute.call_args.args
    assert query.count("%s") == len(bound)
    pattern = re.search(r"m\.date ~ '([^']+)'", query).group(1)
    # These simple ISO patterns share Python/PostgreSQL regex semantics. This
    # exercises adapter rendering without claiming a live PostgreSQL execution.
    assert (re.fullmatch(pattern, value) is not None) is native
    assert "ELSE TRUE END" in query
