"""Normalized NUL text is rejected before it can enter portable match ledgers."""
from contextlib import closing
from copy import deepcopy
import json

import pytest

import app
from ingest import ingest, ingest_rows, valid_normalized_match
from migrate_postgres import TABLES
from storage import SQLiteStorage


MATCH = {
    "account": "TextImport#EUW", "match_id": "SAVED", "date": "2026-09-24T10:00:00Z",
    "patch": "16.19", "queue": "420", "champion": "Lux", "role": "MIDDLE",
    "identity_resolution": "reviewed_csv", "duration_minutes": 30, "win": False,
    "explicit_afk": False, "suspected_quasi_afk": False, "early_surrender": False,
    "anomaly_flags": "reviewed_export", "match_quality_score": .73,
    "loss_attribution_weight": .37, "win_evidence_weight": .0, "reason": "Trusted exporter review",
}
TEXT_FIELDS = ("account", "match_id", "date", "patch", "queue", "champion", "role",
               "anomaly_flags", "reason", "identity_resolution")
IMPORT_TABLES = {"champions", "match_quality", "match_import_provenance", "source_metadata"}


def snapshot(connection):
    return {table: [dict(row) for row in connection.execute(f"SELECT * FROM {table} ORDER BY 1,2")]
            for table in TABLES}


def write_input(path, matches, source="ordinary exporter"):
    path.write_text(json.dumps({"source": source, "matches": matches}, ensure_ascii=True, allow_nan=False),
                    encoding="utf-8")
    return path.read_bytes()


@pytest.fixture
def owned_storage(tmp_path):
    path = tmp_path / "owned.db"
    seed_input = tmp_path / "seed.json"
    write_input(seed_input, [MATCH, MATCH | {"account": "Other#EUW", "match_id": "OTHER", "champion": "Ashe"}],
                "trusted seed")
    assert ingest(seed_input, path)["inserted"] == 2
    storage = SQLiteStorage(path, app.SCHEMA_PATH)
    with closing(storage.connect()) as connection:
        connection.execute("INSERT INTO match_annotations(match_id,manual_label,note,confidence,updated_at) VALUES(?,?,?,?,?)",
                           ("SAVED", "team issue", "Preserve the saved review", .8, "2026-09-24T11:00:00Z"))
        connection.commit()
    return storage


def assert_prior_data_preserved(before, after):
    for table in ("match_quality", "match_import_provenance"):
        for old in before[table]:
            assert next(row for row in after[table]
                        if (row["account"], row["match_id"]) == (old["account"], old["match_id"])) == old
    for table in TABLES:
        if table not in IMPORT_TABLES:
            assert after[table] == before[table], table


@pytest.mark.parametrize("field", TEXT_FIELDS)
def test_validator_rejects_nul_in_required_and_optional_normalized_text(field):
    row = MATCH | {field: MATCH[field] + "\x00"}
    original = deepcopy(row)
    assert valid_normalized_match(row) is False
    assert row == original


@pytest.mark.parametrize("field", TEXT_FIELDS)
def test_public_import_skips_malformed_text_peers_and_preserves_saved_facts_and_judgments(owned_storage, tmp_path, field):
    broken = MATCH | {"champion": "RejectedOnlyChampion", "match_quality_score": .9,
                      "loss_attribution_weight": .8, "reason": "Must not replace saved review"}
    broken[field] = MATCH[field] + "\x00"
    # account/match_id are the key: corrupting one necessarily addresses a new
    # key. The other eight fields also exercise a literal same-key replacement.
    new_broken = broken | {"match_id": "INVALID_NEW\x00" if field == "match_id" else "INVALID_NEW"}
    matches = [MATCH | {"match_id": "VALID_BEFORE", "champion": "Ahri"}, broken, new_broken,
               MATCH | {"match_id": "VALID_AFTER", "champion": "Ahri"}]
    original = deepcopy(matches)
    path = tmp_path / "mixed.json"
    input_bytes = write_input(path, matches, "mixed snapshot")
    with closing(owned_storage.connect()) as connection:
        before = snapshot(connection)

    result = ingest(path, owned_storage.path)

    with closing(owned_storage.connect()) as connection:
        after = snapshot(connection)
    assert (result["inserted"], result["updated"], result["skipped"]) == (2, 0, 2)
    assert {row["match_id"] for row in after["match_quality"]} == {"SAVED", "OTHER", "VALID_BEFORE", "VALID_AFTER"}
    assert {row["match_id"] for row in after["match_import_provenance"]} == {"SAVED", "OTHER", "VALID_BEFORE", "VALID_AFTER"}
    assert {row["champion"] for row in after["champions"]} == {"Lux", "Ashe", "Ahri"}
    assert_prior_data_preserved(before, after)
    assert path.read_bytes() == input_bytes
    assert matches == original


def test_normal_unicode_text_and_explicit_calibration_remain_importable(owned_storage, tmp_path):
    row = MATCH | {"account": "Élodie Straße 友達#EUW", "match_id": "PARTIE-Ω-友達",
                   "patch": "16.19 · révision", "champion": "Étoile 友達",
                   "identity_resolution": "CSV vérifié 友達", "anomaly_flags": "export_équipe_友達",
                   "reason": "Caffè, 友達 👋"}
    original = deepcopy(row)
    assert valid_normalized_match(row) is True
    source = "Équipe 友達 · exporter"
    path = tmp_path / "unicode.json"
    input_bytes = write_input(path, [row], source)
    with closing(owned_storage.connect()) as connection:
        before = snapshot(connection)

    result = ingest(path, owned_storage.path)

    with closing(owned_storage.connect()) as connection:
        after = snapshot(connection)
    assert (result["inserted"], result["updated"], result["skipped"]) == (1, 0, 0)
    saved = next(item for item in after["match_quality"] if item["match_id"] == row["match_id"])
    for field in TEXT_FIELDS:
        assert saved[field] == row[field]
    assert (saved["match_quality_score"], saved["loss_attribution_weight"], saved["win_evidence_weight"]) == (.73, .37, .0)
    provenance = next(item for item in after["match_import_provenance"] if item["match_id"] == row["match_id"])
    assert provenance["source"] == source
    overrides = json.loads(provenance["overrides_json"])
    assert overrides["reason"] == row["reason"] and overrides["anomaly_flags"] == row["anomaly_flags"]
    assert {item["key"]: item["value"] for item in after["source_metadata"]}["last_sync_source"] == source
    assert_prior_data_preserved(before, after)
    assert path.read_bytes() == input_bytes and row == original


def test_null_optional_text_still_clears_only_the_requested_overrides(owned_storage, tmp_path):
    row = MATCH | {"anomaly_flags": None, "reason": None, "identity_resolution": None}
    assert valid_normalized_match(row) is True
    path = tmp_path / "clear.json"
    input_bytes = write_input(path, [row], "clear optional texts")
    with closing(owned_storage.connect()) as connection:
        before = snapshot(connection)

    result = ingest(path, owned_storage.path)

    with closing(owned_storage.connect()) as connection:
        after = snapshot(connection)
    assert (result["inserted"], result["updated"], result["skipped"]) == (0, 1, 0)
    saved = next(item for item in after["match_quality"] if item["match_id"] == "SAVED")
    old = next(item for item in before["match_quality"] if item["match_id"] == "SAVED")
    assert saved["id"] == old["id"]
    assert (saved["anomaly_flags"], saved["reason"], saved["identity_resolution"]) == ("none", "Imported normalized match", "external")
    assert (saved["match_quality_score"], saved["loss_attribution_weight"], saved["win_evidence_weight"]) == (.73, .37, .0)
    overrides = json.loads(next(item for item in after["match_import_provenance"] if item["match_id"] == "SAVED")["overrides_json"])
    assert "reason" not in overrides and "anomaly_flags" not in overrides
    assert overrides["match_quality_score"] == .73 and overrides["loss_attribution_weight"] == .37
    assert after["match_annotations"] == before["match_annotations"]
    assert next(item for item in after["match_quality"] if item["match_id"] == "OTHER") == next(
        item for item in before["match_quality"] if item["match_id"] == "OTHER")
    assert path.read_bytes() == input_bytes


@pytest.mark.parametrize("existing", [False, True], ids=["new-database", "existing-database"])
def test_public_nul_source_fails_without_creating_or_changing_a_database(tmp_path, owned_storage, existing):
    database = owned_storage.path if existing else tmp_path / "not-created.db"
    before_bytes = database.read_bytes() if existing else None
    source = tmp_path / "source-nul.json"
    input_bytes = write_input(source, [MATCH | {"match_id": "MUST_NOT_IMPORT"}], "bad\x00exporter")

    with pytest.raises(ValueError) as error:
        ingest(source, database)

    assert str(error.value)
    if existing:
        assert database.read_bytes() == before_bytes
    else:
        assert not database.exists()
        assert not database.with_name(database.name + "-journal").exists()
    assert source.read_bytes() == input_bytes


def test_ingest_rows_nul_source_fails_before_any_database_operation():
    class NoDatabaseAccess:
        def execute(self, *args, **kwargs):
            pytest.fail("invalid source reached the database")

        executemany = execute
        commit = execute
        rollback = execute

    rows = [MATCH | {"match_id": "MUST_NOT_IMPORT"}]
    original = deepcopy(rows)
    with pytest.raises(ValueError) as error:
        ingest_rows(NoDatabaseAccess(), rows, "bad\x00exporter")
    assert str(error.value) and rows == original


def test_ingest_rows_nul_source_preserves_caller_work_and_does_not_backfill_or_write_metadata(owned_storage):
    with closing(owned_storage.connect()) as connection:
        # This gap is a legitimate old archive that an ordinary import would
        # backfill. An invalid batch-level source must leave it untouched.
        connection.execute("DELETE FROM match_import_provenance WHERE match_id='OTHER'")
        connection.execute("CREATE TABLE caller_work(value INTEGER NOT NULL)")
        connection.commit()
        baseline = snapshot(connection)
        connection.execute("BEGIN")
        connection.execute("INSERT INTO caller_work VALUES(17)")
        try:
            with pytest.raises(ValueError) as error:
                ingest_rows(connection, [MATCH | {"match_id": "MUST_NOT_IMPORT"}], "bad\x00exporter")
            assert str(error.value)
            assert connection.in_transaction
            assert [row[0] for row in connection.execute("SELECT value FROM caller_work")] == [17]
            assert snapshot(connection) == baseline
        finally:
            connection.rollback()
        assert connection.execute("SELECT value FROM caller_work").fetchall() == []
        assert snapshot(connection) == baseline
