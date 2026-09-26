from __future__ import annotations

import sqlite3
import json
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from types import MappingProxyType

import pytest

import algorithm_settings
from algorithm_settings import (
    SettingsConflictError,
    SettingsValidationError,
    current_settings,
    current_snapshot,
    ensure_settings,
    fingerprint_settings,
    get_settings_snapshot,
    migrate_recommendation_settings,
    recommended_settings,
    save_settings,
    settings_context,
    validate_settings,
)


def connection(path) -> sqlite3.Connection:
    result = sqlite3.connect(path)
    result.row_factory = sqlite3.Row
    result.execute("PRAGMA foreign_keys=ON")
    return result


def test_defaults_are_independent_plain_json_and_validation_normalizes_numbers():
    first = recommended_settings()
    second = recommended_settings()
    first["evidence"]["prior_mean"] = 0.41
    first["attribution"]["duration_bounds"][0] = 2
    assert second["evidence"]["prior_mean"] == 0.5
    assert second["attribution"]["duration_bounds"][0] == 10
    assert validate_settings(second)["attribution"]["loss_weights"] == [1.0] * 6
    assert fingerprint_settings(second) == fingerprint_settings(validate_settings(second))


@pytest.mark.parametrize(
    ("change", "message"),
    [
        (lambda value: value.update({"unknown": 1}), "unknown keys"),
        (lambda value: value["evidence"].update({"min_games": True}), "must be an integer"),
        (lambda value: value["evidence"].update({"prior_mean": float("nan")}), "must be finite"),
        (lambda value: value["evidence"].update({"prior_mean": 10**400}), "must be finite"),
        (lambda value: value["context"].update({"queue": "all"}), "canonical queue"),
        (lambda value: value["attribution"].update({"negative_veto": 0}), "must be a boolean"),
        (lambda value: value["attribution"].update({"duration_bounds": [10, 15, 15, 23, 27]}), "strictly increasing"),
        (lambda value: value["attribution"].update({"loss_weights": [0, 0.2, 0.1, 1, 1, 1]}), "nondecreasing"),
        (lambda value: value["playstyle"].update({"duration_bounds": [20, 30]}), "exactly 3"),
        (lambda value: value["evidence"].update({"display_min_games": 21}), "must not exceed"),
        (lambda value: value["evidence"].update({"indicative_games": 2}), "must be between"),
        (lambda value: value["recommendations"].update({"limit": 41}), "recommendations.limit"),
        (lambda value: value["recommendations"].update({"trial_budget": 11}), "recommendations.trial_budget"),
        (lambda value: value["recommendations"]["period"].update({"value": -1}), "recommendations.period.value"),
        (lambda value: value["recommendations"]["period"].update({"unit": "hours"}), "recommendations.period.unit"),
        (lambda value: value["recommendations"].update({"queue": "unknown"}), "recommendations.queue"),
        (lambda value: value["recommendations"].update({"confidence": 0.7}), "recommendations.confidence"),
    ],
)
def test_validation_rejects_unknown_nonfinite_nonstrict_and_relational_values(change, message):
    settings = recommended_settings()
    change(settings)
    with pytest.raises(SettingsValidationError, match=message):
        validate_settings(settings)


def test_context_is_deeply_immutable_nested_and_does_not_leak_across_threads():
    baseline = current_settings()
    baseline_meta = current_snapshot()
    assert isinstance(baseline, MappingProxyType)
    assert isinstance(baseline["evidence"], MappingProxyType)
    assert isinstance(baseline["attribution"]["duration_bounds"], tuple)
    with pytest.raises(TypeError):
        baseline["evidence"]["prior_mean"] = 0.4

    custom = recommended_settings()
    custom["evidence"]["prior_mean"] = 0.41
    custom_fingerprint = fingerprint_settings(custom)
    observed = []

    def other_thread():
        return current_settings()["evidence"]["prior_mean"], current_snapshot()

    with settings_context(custom, revision=9, fingerprint=custom_fingerprint) as active:
        observed.append((active["evidence"]["prior_mean"], current_snapshot()))
        with ThreadPoolExecutor(max_workers=1) as pool:
            outside = pool.submit(other_thread).result()
    assert observed == [(0.41, {"revision": 9, "fingerprint": custom_fingerprint})]
    assert outside == (0.5, baseline_meta)
    assert current_settings() is baseline
    assert current_snapshot() == baseline_meta


def test_new_store_archives_legacy_and_activates_recommended_revision_two(tmp_path):
    database = tmp_path / "settings.db"
    with connection(database) as db:
        ensure_settings(db)
        snapshot = get_settings_snapshot(db)
    assert snapshot["revision"] == 2
    assert snapshot["settings"] == recommended_settings()
    assert snapshot["defaults"] == recommended_settings()
    assert fingerprint_settings(snapshot["settings"]) == snapshot["fingerprint"]
    assert [item["revision"] for item in snapshot["history"]] == [2, 1]
    legacy = snapshot["history"][1]["settings"]
    assert legacy["context"] == {"days": "all", "queue": "all"}
    assert legacy["attribution"]["loss_weights"] == [0, 0.04, 0.15, 0.35, 0.6, 0.88]
    assert legacy["attribution"]["negative_veto"] is True
    assert legacy["matchup"]["recent_weight"] == 0.15
    assert legacy["training"]["budget"] == 400
    assert "recommendations" not in legacy
    assert snapshot["settings"]["recommendations"] == {
        "limit": 6, "trial_budget": 3,
        "period": {"value": 0, "unit": "days"}, "queue": "all", "confidence": 0.9,
    }
    assert all(set(field) == {"path", "label", "description", "type", "min", "max", "options", "group"} for field in snapshot["schema"])
    assert {field["type"] for field in snapshot["schema"]} >= {"number", "integer", "boolean", "select", "number[]", "period"}


def test_preview_validation_does_not_mutate_store_and_failed_save_rolls_back(tmp_path):
    database = tmp_path / "settings.db"
    with connection(database) as db:
        ensure_settings(db)
        before = get_settings_snapshot(db)
        candidate = recommended_settings()
        candidate["training"]["budget"] = 21
        validated = validate_settings(candidate)
        assert validated["training"]["budget"] == 21
        assert get_settings_snapshot(db) == before

        db.execute("""CREATE TRIGGER reject_settings_insert BEFORE INSERT ON algorithm_settings_revisions
            WHEN NEW.revision > 2 BEGIN SELECT RAISE(ABORT, 'forced failure'); END""")
        db.commit()
        with pytest.raises(sqlite3.IntegrityError, match="forced failure"):
            save_settings(db, 2, candidate)
        after = get_settings_snapshot(db)
        assert after["revision"] == 2
        assert [item["revision"] for item in after["history"]] == [2, 1]


def test_snapshot_read_preserves_the_callers_open_transaction(tmp_path):
    database = tmp_path / "settings.db"
    with connection(database) as db:
        ensure_settings(db)
        db.execute("CREATE TABLE caller_work(value INTEGER NOT NULL)")
        db.commit()
        db.execute("INSERT INTO caller_work(value) VALUES(1)")
        changes_before = db.total_changes
        snapshot = get_settings_snapshot(db)
        assert snapshot["revision"] == 2
        assert db.in_transaction is True
        assert db.total_changes == changes_before
        db.rollback()
        assert db.execute("SELECT COUNT(*) FROM caller_work").fetchone()[0] == 0


def test_failed_savepoint_preserves_unrelated_caller_transaction(tmp_path):
    database = tmp_path / "settings.db"
    with connection(database) as db:
        ensure_settings(db)
        db.execute("CREATE TABLE caller_work(value INTEGER NOT NULL)")
        db.execute("""CREATE TRIGGER reject_settings_save BEFORE INSERT ON algorithm_settings_revisions
            WHEN NEW.revision > 2 BEGIN SELECT RAISE(ABORT, 'forced savepoint failure'); END""")
        db.commit()
        db.execute("INSERT INTO caller_work(value) VALUES(1)")
        candidate = recommended_settings()
        candidate["training"]["budget"] = 21
        with pytest.raises(sqlite3.IntegrityError, match="forced savepoint failure"):
            save_settings(db, 2, candidate)
        assert db.in_transaction is True
        assert db.execute("SELECT COUNT(*) FROM caller_work").fetchone()[0] == 1
        assert get_settings_snapshot(db)["revision"] == 2
        db.rollback()
        assert db.execute("SELECT COUNT(*) FROM caller_work").fetchone()[0] == 0


def test_snapshot_initializes_only_a_missing_store(tmp_path):
    database = tmp_path / "settings.db"
    with connection(database) as db:
        snapshot = get_settings_snapshot(db)
        assert snapshot["revision"] == 2
        assert [item["revision"] for item in snapshot["history"]] == [2, 1]


def test_save_is_append_only_conflicts_carry_current_snapshot_and_reopen_persists(tmp_path):
    database = tmp_path / "settings.db"
    with connection(database) as db:
        ensure_settings(db)
        candidate = recommended_settings()
        candidate["training"]["budget"] = 30
        saved = save_settings(db, 2, candidate)
        assert saved["revision"] == 3
        assert saved["settings"]["training"]["budget"] == 30
        assert [item["revision"] for item in saved["history"]] == [3, 2, 1]

        stale = recommended_settings()
        stale["training"]["budget"] = 40
        with pytest.raises(SettingsConflictError) as raised:
            save_settings(db, 2, stale)
        assert raised.value.snapshot["revision"] == 3
        assert raised.value.snapshot["settings"]["training"]["budget"] == 30
        assert [item["revision"] for item in raised.value.snapshot["history"]] == [3, 2, 1]

    with connection(database) as reopened:
        persisted = get_settings_snapshot(reopened)
        assert persisted["revision"] == 3
        assert persisted["fingerprint"] == saved["fingerprint"]
        # A rollback creates a new immutable revision, even when its content and
        # fingerprint match an archived revision.
        rolled_back = save_settings(reopened, 3, persisted["history"][1]["settings"])
        assert rolled_back["revision"] == 4
        assert rolled_back["settings"] == recommended_settings()
        assert rolled_back["fingerprint"] == persisted["history"][1]["fingerprint"]


def test_concurrent_writers_cannot_silently_overwrite_each_other(tmp_path):
    database = tmp_path / "settings.db"
    with connection(database) as db:
        ensure_settings(db)
    barrier = Barrier(2)

    def write(budget):
        with connection(database) as db:
            candidate = recommended_settings()
            candidate["training"]["budget"] = budget
            barrier.wait()
            try:
                return "saved", save_settings(db, 2, candidate)
            except SettingsConflictError as error:
                return "conflict", error.snapshot

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = [future.result() for future in (pool.submit(write, 31), pool.submit(write, 32))]
    assert sorted(result[0] for result in results) == ["conflict", "saved"]
    assert {result[1]["revision"] for result in results} == {3}
    with connection(database) as db:
        snapshot = get_settings_snapshot(db)
    assert snapshot["revision"] == 3
    assert len(snapshot["history"]) == 3


def test_concurrent_initializers_seed_exactly_one_legacy_and_recommended_pair(tmp_path):
    database = tmp_path / "settings.db"
    with connection(database) as db:
        db.executescript("""CREATE TABLE algorithm_settings_revisions (
            revision INTEGER PRIMARY KEY, fingerprint TEXT NOT NULL,
            settings_json TEXT NOT NULL, created_at TEXT NOT NULL);
            CREATE TABLE algorithm_settings_state (
            singleton_id INTEGER PRIMARY KEY, current_revision INTEGER NOT NULL,
            FOREIGN KEY(current_revision) REFERENCES algorithm_settings_revisions(revision));""")
    barrier = Barrier(2)

    def initialize():
        with connection(database) as db:
            barrier.wait()
            ensure_settings(db)

    with ThreadPoolExecutor(max_workers=2) as pool:
        for future in (pool.submit(initialize), pool.submit(initialize)):
            future.result()
    with connection(database) as db:
        snapshot = get_settings_snapshot(db)
    assert snapshot["revision"] == 2
    assert [item["revision"] for item in snapshot["history"]] == [2, 1]


def test_schema_sql_and_ensure_settings_initialize_the_same_store_contract(tmp_path):
    database = tmp_path / "settings.db"
    # Initialization from the project schema creates empty tables; the helper
    # then installs the same two historical seed revisions exactly once.
    from pathlib import Path
    schema_text = Path(__file__).with_name("schema.sql").read_text(encoding="utf-8")
    with connection(database) as db:
        db.executescript(schema_text)
        assert db.execute("SELECT COUNT(*) FROM algorithm_settings_revisions").fetchone()[0] == 0
        ensure_settings(db)
        ensure_settings(db)
        assert db.execute("SELECT COUNT(*) FROM algorithm_settings_revisions").fetchone()[0] == 2
        assert get_settings_snapshot(db)["revision"] == 2


def test_recommendation_migration_appends_once_and_preserves_old_custom_revision(tmp_path):
    database = tmp_path / "settings.db"
    with connection(database) as db:
        ensure_settings(db)
        old = recommended_settings()
        old.pop("recommendations")
        old["evidence"]["prior_mean"] = 0.55
        db.execute(
            "UPDATE algorithm_settings_revisions SET settings_json=?, fingerprint=? WHERE revision=2",
            (json.dumps(old, sort_keys=True, separators=(",", ":")), "historic-without-recommendations"),
        )
        db.commit()

        migrated = migrate_recommendation_settings(db)
        assert migrated["revision"] == 3
        assert migrated["settings"]["evidence"]["prior_mean"] == 0.55
        assert migrated["settings"]["recommendations"] == recommended_settings()["recommendations"]
        archived = next(item for item in migrated["history"] if item["revision"] == 2)
        assert archived["fingerprint"] == "historic-without-recommendations"
        assert archived["settings"] == old
        assert migrate_recommendation_settings(db)["revision"] == 3

    with connection(database) as reopened:
        snapshot = get_settings_snapshot(reopened)
        assert snapshot["revision"] == 3
        assert [item["revision"] for item in snapshot["history"]] == [3, 2, 1]
        assert snapshot["history"][1]["settings"] == old


def test_settings_context_accepts_historical_snapshot_without_rewriting_its_fingerprint():
    old = recommended_settings()
    old.pop("recommendations")
    historical_fingerprint = __import__("hashlib").sha256(
        json.dumps(old, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    ).hexdigest()
    with settings_context(old, revision=2, fingerprint=historical_fingerprint):
        assert current_settings()["recommendations"] == recommended_settings()["recommendations"]
        assert current_snapshot() == {"revision": 2, "fingerprint": historical_fingerprint}


def test_recommendation_migration_accepts_a_concurrent_completed_cas(tmp_path, monkeypatch):
    database = tmp_path / "settings.db"
    with connection(database) as db:
        ensure_settings(db)
        old = recommended_settings()
        old.pop("recommendations")
        db.execute(
            "UPDATE algorithm_settings_revisions SET settings_json=? WHERE revision=2",
            (json.dumps(old, sort_keys=True, separators=(",", ":")),),
        )
        db.commit()

        original_save = algorithm_settings.save_settings

        def competing_save(active_connection, expected_revision, settings):
            # Model the other process winning the real append-only CAS before
            # this process receives its stale-revision conflict.
            original_save(active_connection, expected_revision, settings)
            raise SettingsConflictError(get_settings_snapshot(active_connection))

        monkeypatch.setattr(algorithm_settings, "save_settings", competing_save)
        migrated = migrate_recommendation_settings(db)
        assert migrated["revision"] == 3
        assert migrated["settings"]["recommendations"] == recommended_settings()["recommendations"]
        assert [item["revision"] for item in migrated["history"]] == [3, 2, 1]
