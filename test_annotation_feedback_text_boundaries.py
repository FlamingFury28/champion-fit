"""NUL text is a bad request without changing annotations, feedback or facts."""
from contextlib import closing
from urllib.parse import urlencode

import pytest

from recommendation_feedback import feedback_library, read_feedback, save_feedback
from test_friend_group_names import name_http, postgres_groups  # noqa: F401


PROTECTED_TABLES = (
    "match_quality", "match_import_provenance", "match_participants", "tracked_account_puuids",
    "match_annotations", "recommendation_preferences", "recommendation_feedback_state",
    "recommendation_feedback_events", "friend_groups", "friend_group_aliases",
)
ANNOTATION = {
    "match_id": "protected", "invincible": False, "carryable_loss": False,
    "afk_player": False, "griefer": False, "team_collapse": False,
    "manual_label": "Review", "note": "Preserve saved note", "confidence": .5,
    "expected_revision": None,
}


def snapshot(storage):
    with closing(storage.connect()) as connection:
        return {table: [dict(row) for row in connection.execute(f"SELECT * FROM {table} ORDER BY 1,2")]
                for table in PROTECTED_TABLES}


def feedback(accounts, revision):
    return {"accounts": accounts, "champion": "Ahri", "role": "MIDDLE", "preference": "like",
            "expected_revision": revision}


@pytest.mark.parametrize("field", ["match_id", "manual_label", "note"])
@pytest.mark.parametrize("existing", [False, True], ids=["create", "update"])
def test_nul_annotation_text_is_rejected_before_connect(name_http, monkeypatch, field, existing):
    send, _, storage, _ = name_http
    payload = dict(ANNOTATION)
    if existing:
        status, saved = send("POST", "/api/annotations", payload)
        assert status == 200, saved
        payload["expected_revision"] = saved["revision"]
    before = snapshot(storage)
    payload[field] = payload[field] + "\x00"

    def unexpected_connect():
        raise AssertionError("invalid annotation text reached the database")

    with monkeypatch.context() as guarded:
        guarded.setattr(storage, "connect", unexpected_connect)
        status, body = send("POST", "/api/annotations", payload)
    assert status == 400, body
    assert body["error"]
    assert snapshot(storage) == before


@pytest.mark.parametrize("bad_first", [False, True], ids=["bad-last", "bad-first"])
def test_nul_feedback_batch_is_a_bad_request_without_partial_changes(name_http, bad_first):
    send, _, storage, _ = name_http
    status, saved = send("POST", "/api/recommendation-feedback", feedback(["Names#EUW"], 0))
    assert status == 200, saved
    before = snapshot(storage)
    accounts = ["Bad\x00#EUW", "Names#EUW"] if bad_first else ["Names#EUW", "Bad\x00#EUW"]
    status, body = send("POST", "/api/recommendation-feedback", feedback(accounts, saved["revision"]) | {
        "preference": "dislike",
    })
    assert status == 400, body
    assert body["error"]
    assert snapshot(storage) == before


@pytest.mark.parametrize("bad_first", [False, True], ids=["bad-last", "bad-first"])
def test_nul_feedback_get_is_rejected_before_canonical_account_binding(name_http, monkeypatch, bad_first):
    send, _, storage, _ = name_http
    before = snapshot(storage)
    accounts = ["Bad\x00#EUW", "Names#EUW"] if bad_first else ["Names#EUW", "Bad\x00#EUW"]

    def unexpected_resolution(*args, **kwargs):
        raise AssertionError("invalid account reached canonical account resolution")

    with monkeypatch.context() as guarded:
        guarded.setattr("account_identity.canonical_account_name", unexpected_resolution)
        status, body = send("GET", "/api/recommendation-feedback?" + urlencode({"account": ",".join(accounts)}))
    assert status == 400, body
    assert body["error"]
    assert snapshot(storage) == before


@pytest.mark.parametrize("reader", ["save", "read", "library"])
def test_nul_feedback_accounts_fail_before_direct_database_access(reader):
    class NoDatabaseAccess:
        def execute(self, *args, **kwargs):
            pytest.fail("invalid feedback account reached the database")

    accounts = ["Names#EUW", "Bad\x00#EUW"]
    with pytest.raises(ValueError, match="NUL"):
        if reader == "save":
            save_feedback(NoDatabaseAccess(), accounts, "Ahri", "MIDDLE", "like", 0)
        elif reader == "read":
            read_feedback(NoDatabaseAccess(), accounts)
        else:
            feedback_library(NoDatabaseAccess(), accounts)


def test_ordinary_unicode_annotations_and_feedback_remain_supported(name_http):
    send, _, storage, _ = name_http
    account = "Élodie Straße#EUW"
    with closing(storage.connect()) as connection:
        connection.execute("INSERT INTO tracked_account_puuids(puuid,account) VALUES(?,?)", ("unicode-owner", account))
        connection.commit()
    before = snapshot(storage)
    note, label = "Caffè, 友達 👋", "Équipe ß"
    status, saved = send("POST", "/api/annotations", ANNOTATION | {"note": note, "manual_label": label})
    assert status == 200, saved
    status, loaded = send("GET", "/api/annotations?match_id=protected")
    assert status == 200 and loaded["item"]["note"] == note and loaded["item"]["manual_label"] == label
    status, saved = send("POST", "/api/recommendation-feedback", feedback([account], 0))
    assert status == 200 and saved["revision"] == 1, saved
    after_write = snapshot(storage)
    status, loaded = send("GET", "/api/recommendation-feedback?" + urlencode({"account": account}))
    assert status == 200 and loaded["accounts"] == [account]
    assert loaded["items"] == saved["items"]
    assert snapshot(storage) == after_write
    mutable = {"match_annotations", "recommendation_preferences", "recommendation_feedback_state", "recommendation_feedback_events"}
    assert {key: value for key, value in after_write.items() if key not in mutable} == {
        key: value for key, value in before.items() if key not in mutable
    }
