"""Malformed numeric exporter facts are skipped without aborting valid peers."""
from contextlib import closing
from copy import deepcopy
import json

import pytest

import app
from ingest import ingest, ingest_rows
from migrate_postgres import TABLES
from storage import SQLiteStorage


MATCH = {
    "account": "NumericImport#EUW", "match_id": "SAVED", "date": "2026-09-24T10:00:00Z",
    "patch": "16.19", "queue": "420", "champion": "Lux", "role": "MIDDLE",
    "duration_minutes": 30, "win": False, "explicit_afk": False,
    "suspected_quasi_afk": False, "early_surrender": False, "anomaly_flags": "none",
    "match_quality_score": 0.4, "loss_attribution_weight": 0.4,
    "win_evidence_weight": 0.0, "reason": "Trusted exporter review",
}
NUMERIC_FIELDS = (
    "duration_minutes", "win", "explicit_afk", "suspected_quasi_afk", "early_surrender",
    "match_quality_score", "loss_attribution_weight", "win_evidence_weight",
)
IMPORT_WRITTEN_TABLES = {"champions", "match_quality", "match_import_provenance", "source_metadata"}


def snapshot(connection):
    return {
        table: [dict(row) for row in connection.execute(f"SELECT * FROM {table} ORDER BY 1,2")]
        for table in TABLES
    }


@pytest.fixture
def owned_storage(tmp_path):
    storage = SQLiteStorage(tmp_path / "numeric-import.db", app.SCHEMA_PATH)
    storage.initialize()
    with closing(storage.connect()) as connection, connection:
        assert ingest_rows(connection, [
            MATCH,
            MATCH | {"account": "OtherOwner#EUW", "match_id": "OTHER", "champion": "Ashe"},
        ], "trusted seed")["inserted"] == 2
        connection.execute(
            "INSERT INTO match_annotations(match_id,manual_label,note,confidence,updated_at) VALUES(?,?,?,?,?)",
            ("SAVED", "team issue", "Preserve the saved judgment", 0.8, "2026-09-24T11:00:00Z"),
        )
    return storage


def assert_prior_data_preserved(before, after):
    for table in ("match_quality", "match_import_provenance"):
        for saved in before[table]:
            assert next(row for row in after[table]
                        if (row["account"], row["match_id"]) == (saved["account"], saved["match_id"])) == saved
    for table in TABLES:
        if table not in IMPORT_WRITTEN_TABLES:
            assert after[table] == before[table], table


def broken_rows(field):
    rows = [MATCH | {"match_id": "VALID_BEFORE", "champion": "Ahri"}]
    for sign, suffix in ((1, "POSITIVE"), (-1, "NEGATIVE")):
        broken = MATCH | {field: sign * 10**400, "champion": "RejectedOnlyChampion",
                          "reason": "Must not replace the saved import"}
        rows.extend([broken, broken | {"match_id": f"INVALID_NEW_{suffix}"}])
    rows.append(MATCH | {"match_id": "VALID_AFTER", "champion": "Ahri"})
    # Huge integers are ordinary JSON numbers, not nonstandard Infinity tokens.
    return json.loads(json.dumps(rows, allow_nan=False))


@pytest.mark.parametrize("field", NUMERIC_FIELDS)
def test_huge_numeric_facts_skip_only_their_rows_and_preserve_saved_judgments(owned_storage, field):
    matches = broken_rows(field)
    original = deepcopy(matches)
    with closing(owned_storage.connect()) as connection, connection:
        before = snapshot(connection)
        result = ingest_rows(connection, matches, "mixed exporter snapshot")
        after = snapshot(connection)

    assert (result["inserted"], result["updated"], result["skipped"]) == (2, 0, 4)
    assert {row["match_id"] for row in after["match_quality"]} == {"SAVED", "OTHER", "VALID_BEFORE", "VALID_AFTER"}
    assert {row["match_id"] for row in after["match_import_provenance"]} == {"SAVED", "OTHER", "VALID_BEFORE", "VALID_AFTER"}
    assert "RejectedOnlyChampion" not in {row["champion"] for row in after["champions"]}
    assert_prior_data_preserved(before, after)
    assert matches == original
    assert {row["key"]: row["value"] for row in after["source_metadata"]}["last_sync_inserted"] == "2"


def test_supported_numbers_strings_booleans_and_optional_nulls_still_import(owned_storage):
    matches = [
        MATCH | {"match_id": "NUMBERS", "duration_minutes": 31.5, "win": 1,
                 "explicit_afk": 0, "suspected_quasi_afk": 1.0, "early_surrender": -0.0,
                 "match_quality_score": 0.8, "loss_attribution_weight": 0.25, "win_evidence_weight": 0.75},
        MATCH | {"match_id": "STRINGS", "duration_minutes": "32.5", "win": "loss",
                 "explicit_afk": "yes", "suspected_quasi_afk": "false", "early_surrender": "1",
                 "match_quality_score": "0.6", "loss_attribution_weight": "0.2", "win_evidence_weight": "0.1"},
        MATCH | {"match_id": "NULL_OPTIONALS", "win": True, "explicit_afk": None,
                 "suspected_quasi_afk": None, "early_surrender": None,
                 "match_quality_score": None, "loss_attribution_weight": None, "win_evidence_weight": None},
    ]
    original = deepcopy(matches)
    with closing(owned_storage.connect()) as connection, connection:
        before = snapshot(connection)
        result = ingest_rows(connection, matches, "ordinary exporter snapshot")
        after = snapshot(connection)

    assert (result["inserted"], result["updated"], result["skipped"]) == (3, 0, 0)
    rows = {row["match_id"]: row for row in after["match_quality"]}
    assert (rows["NUMBERS"]["duration_minutes"], rows["NUMBERS"]["win"], rows["NUMBERS"]["explicit_afk"],
            rows["NUMBERS"]["suspected_quasi_afk"], rows["NUMBERS"]["early_surrender"]) == (31.5, 1, 0, 1, 0)
    assert (rows["STRINGS"]["duration_minutes"], rows["STRINGS"]["win"], rows["STRINGS"]["explicit_afk"],
            rows["STRINGS"]["suspected_quasi_afk"], rows["STRINGS"]["early_surrender"],
            rows["STRINGS"]["match_quality_score"], rows["STRINGS"]["loss_attribution_weight"],
            rows["STRINGS"]["win_evidence_weight"]) == (32.5, 0, 1, 0, 1, 0.6, 0.2, 0.1)
    assert (rows["NULL_OPTIONALS"]["win"], rows["NULL_OPTIONALS"]["explicit_afk"],
            rows["NULL_OPTIONALS"]["suspected_quasi_afk"], rows["NULL_OPTIONALS"]["early_surrender"],
            rows["NULL_OPTIONALS"]["match_quality_score"], rows["NULL_OPTIONALS"]["loss_attribution_weight"],
            rows["NULL_OPTIONALS"]["win_evidence_weight"]) == (1, 0, 0, 0, 0.95, 0.0, 0.95)
    assert_prior_data_preserved(before, after)
    assert matches == original


def test_other_malformed_numeric_values_remain_skipped_without_new_provenance(owned_storage):
    values = [
        ("duration_minutes", True), ("duration_minutes", -1), ("duration_minutes", float("inf")),
        ("win", None), ("win", 2), ("explicit_afk", float("inf")),
        ("suspected_quasi_afk", float("nan")), ("early_surrender", -1),
        ("match_quality_score", True), ("match_quality_score", float("nan")),
        ("loss_attribution_weight", -0.1), ("win_evidence_weight", 1.1),
        ("win_evidence_weight", float("inf")), ("duration_minutes", str(10**400)),
    ]
    matches = [MATCH | {"match_id": f"INVALID_{index}", field: value, "champion": "RejectedOnlyChampion"}
               for index, (field, value) in enumerate(values)]
    with closing(owned_storage.connect()) as connection, connection:
        before = snapshot(connection)
        result = ingest_rows(connection, matches, "invalid controls")
        after = snapshot(connection)

    assert (result["inserted"], result["updated"], result["skipped"]) == (0, 0, len(matches))
    for table in TABLES:
        if table != "source_metadata":
            assert after[table] == before[table], table


def test_public_json_file_import_keeps_valid_peers_of_huge_numbers(owned_storage, tmp_path):
    matches = broken_rows("loss_attribution_weight")
    source = tmp_path / "snapshot.json"
    source.write_text(json.dumps({"source": "public exporter snapshot", "matches": matches}, allow_nan=False),
                      encoding="utf-8")
    original_bytes = source.read_bytes()
    with closing(owned_storage.connect()) as connection:
        before = snapshot(connection)

    result = ingest(source, owned_storage.path)

    with closing(owned_storage.connect()) as connection:
        after = snapshot(connection)
    assert (result["inserted"], result["updated"], result["skipped"]) == (2, 0, 4)
    assert {row["match_id"] for row in after["match_quality"]} == {"SAVED", "OTHER", "VALID_BEFORE", "VALID_AFTER"}
    assert {row["match_id"] for row in after["match_import_provenance"]} == {"SAVED", "OTHER", "VALID_BEFORE", "VALID_AFTER"}
    assert "RejectedOnlyChampion" not in {row["champion"] for row in after["champions"]}
    assert_prior_data_preserved(before, after)
    assert source.read_bytes() == original_bytes
