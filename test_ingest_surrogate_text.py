"""Isolated surrogate code units cannot enter normalized match ledgers."""
from contextlib import closing
from copy import deepcopy
import json

import pytest

from ingest import ingest, ingest_rows, valid_normalized_match
from storage import SQLiteStorage
from test_ingest_text_boundaries import (
    MATCH,
    TEXT_FIELDS,
    assert_prior_data_preserved,
    owned_storage,  # noqa: F401
    snapshot,
    write_input,
)


@pytest.mark.parametrize("field", TEXT_FIELDS)
@pytest.mark.parametrize("surrogate", ["\ud800", "\udfff"], ids=["isolated-high", "isolated-low"])
def test_stored_text_validator_rejects_isolated_surrogate_without_mutating_input(field, surrogate):
    row = MATCH | {field: MATCH[field] + surrogate}
    original = deepcopy(row)
    assert valid_normalized_match(row) is False
    assert row == original


@pytest.mark.parametrize("field,surrogate", [
    ("account", "\ud800"), ("reason", "\udfff"), ("champion", "\ud800"),
], ids=["account-high", "reason-low", "champion-high"])
def test_public_escaped_surrogate_rows_are_skipped_without_losing_valid_peers_or_saved_reviews(
    owned_storage, tmp_path, field, surrogate,
):
    broken = MATCH | {"champion": "RejectedOnlyChampion", "match_quality_score": .9,
                      "loss_attribution_weight": .8, "reason": "Must not replace the saved review"}
    broken[field] = MATCH[field] + surrogate
    rows = [MATCH | {"match_id": "VALID_BEFORE", "champion": "Ahri"}, broken,
            broken | {"match_id": "INVALID_NEW"}, MATCH | {"match_id": "VALID_AFTER", "champion": "Ahri"}]
    original = deepcopy(rows)
    path = tmp_path / "escaped-surrogates.json"
    input_bytes = write_input(path, rows, "ordinary exporter")
    assert input_bytes.decode("utf-8").isascii()
    assert surrogate.encode("unicode_escape").decode("ascii") in input_bytes.decode("ascii")
    assert json.loads(input_bytes)["matches"] == rows
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
    assert path.read_bytes() == input_bytes and rows == original


@pytest.mark.parametrize("existing", [False, True], ids=["new-database", "existing-database"])
def test_public_isolated_surrogate_source_fails_before_database_initialization(
    tmp_path, owned_storage, monkeypatch, existing,
):
    database = owned_storage.path if existing else tmp_path / "not-created.db"
    before_bytes = database.read_bytes() if existing else None
    path = tmp_path / "source-surrogate.json"
    input_bytes = write_input(path, [MATCH | {"match_id": "MUST_NOT_IMPORT"}], "Exporter\ud800")
    assert json.loads(input_bytes)["source"] == "Exporter\ud800"

    def unexpected_initialization(*args, **kwargs):
        pytest.fail("malformed batch source reached database initialization")

    monkeypatch.setattr(SQLiteStorage, "initialize", unexpected_initialization)
    with pytest.raises(ValueError) as error:
        ingest(path, database)
    # UnicodeEncodeError is itself a ValueError. A deliberate source rejection
    # must happen before initialization and must not be that late driver error.
    assert type(error.value) is ValueError
    assert str(error.value)
    if existing:
        assert database.read_bytes() == before_bytes
    else:
        assert not database.exists()
    assert path.read_bytes() == input_bytes


def test_ingest_rows_isolated_surrogate_source_fails_before_any_database_operation():
    class NoDatabaseAccess:
        def execute(self, *args, **kwargs):
            pytest.fail("malformed batch source reached the database")

        executemany = execute
        commit = execute
        rollback = execute

    rows = [MATCH | {"match_id": "MUST_NOT_IMPORT"}]
    original = deepcopy(rows)
    with pytest.raises(ValueError) as error:
        ingest_rows(NoDatabaseAccess(), rows, "Exporter\udfff")
    assert type(error.value) is ValueError
    assert str(error.value) and rows == original


def test_ingest_rows_isolated_surrogate_source_preserves_caller_transaction_and_legacy_gap(owned_storage):
    with closing(owned_storage.connect()) as connection:
        connection.execute("DELETE FROM match_import_provenance WHERE match_id='OTHER'")
        connection.execute("CREATE TABLE caller_work(value INTEGER NOT NULL)")
        connection.commit()
        baseline = snapshot(connection)
        connection.execute("BEGIN")
        connection.execute("INSERT INTO caller_work VALUES(17)")
        try:
            with pytest.raises(ValueError) as error:
                ingest_rows(connection, [MATCH | {"match_id": "MUST_NOT_IMPORT"}], "Exporter\udfff")
            assert type(error.value) is ValueError
            assert str(error.value)
            assert connection.in_transaction
            assert [row[0] for row in connection.execute("SELECT value FROM caller_work")] == [17]
            assert snapshot(connection) == baseline
        finally:
            connection.rollback()
        assert connection.execute("SELECT value FROM caller_work").fetchall() == []
        assert snapshot(connection) == baseline


def test_valid_json_surrogate_pairs_joiners_and_combining_unicode_keep_their_spelling(owned_storage, tmp_path):
    astronaut = "\U0001f469\u200d\U0001f680"
    row = MATCH | {"account": f"Élodie {astronaut}#EUW", "match_id": f"PARTIE-Ω-{astronaut}",
                   "champion": f"Étoile {astronaut} e\u0301", "patch": "16.19 · e\u0301",
                   "identity_resolution": "CSV vérifié e\u0301", "anomaly_flags": f"export_équipe_{astronaut}",
                   "reason": f"Caffè e\u0301 友達 {astronaut}"}
    original = deepcopy(row)
    source = f"Équipe {astronaut} · café e\u0301"
    path = tmp_path / "valid-unicode.json"
    input_bytes = write_input(path, [row], source)
    assert b"\\ud83d\\udc69\\u200d\\ud83d\\ude80" in input_bytes
    parsed = json.loads(input_bytes)
    assert parsed["matches"][0] == row
    assert valid_normalized_match(parsed["matches"][0]) is True
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
    assert json.loads(provenance["overrides_json"])["reason"] == row["reason"]
    assert_prior_data_preserved(before, after)
    assert path.read_bytes() == input_bytes and row == original


def test_unknown_json_fields_with_isolated_surrogates_are_still_ignored(owned_storage, tmp_path):
    row = MATCH | {"match_id": "IGNORED-UNKNOWN", "unused_exporter_metadata": "\ud800",
                   "unused_key_\udfff": "not a stored field"}
    original = deepcopy(row)
    path = tmp_path / "unknown-fields.json"
    input_bytes = write_input(path, [row], "ordinary exporter")
    parsed_row = json.loads(input_bytes)["matches"][0]
    assert valid_normalized_match(parsed_row) is True
    with closing(owned_storage.connect()) as connection:
        before = snapshot(connection)

    result = ingest(path, owned_storage.path)

    with closing(owned_storage.connect()) as connection:
        after = snapshot(connection)
    assert (result["inserted"], result["updated"], result["skipped"]) == (1, 0, 0)
    saved = next(item for item in after["match_quality"] if item["match_id"] == "IGNORED-UNKNOWN")
    provenance = next(item for item in after["match_import_provenance"] if item["match_id"] == "IGNORED-UNKNOWN")
    assert "unused_exporter_metadata" not in saved
    assert "unused_key_\udfff" not in saved
    overrides = json.loads(provenance["overrides_json"])
    assert "unused_exporter_metadata" not in overrides
    assert "unused_key_\udfff" not in overrides
    assert saved["reason"] == MATCH["reason"]
    assert_prior_data_preserved(before, after)
    assert path.read_bytes() == input_bytes and row == original
