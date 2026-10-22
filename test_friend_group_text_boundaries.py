"""Friend-group JSON cannot admit text that PostgreSQL cannot represent."""
import pytest

from test_friend_group_names import (
    assert_facts_unchanged, create, name_http, postgres_groups,  # noqa: F401
)


@pytest.mark.parametrize("operation", [
    "create-name", "create-alias-first", "create-alias-last", "rename",
    "add-alias-first", "add-alias-last",
])
def test_nul_group_text_is_rejected_before_connect_without_mutations(name_http, monkeypatch, operation):
    send, groups, storage, snapshot = name_http
    create(send, "Équipe", "Élodie#EUW")
    group_id = groups()[0]["id"]
    before = snapshot()
    bad_alias = "Bad\x00#EUW"
    aliases = ([bad_alias, "New#EUW"] if operation.endswith("first")
               else ["New#EUW", bad_alias])
    if operation == "create-name":
        method, path, payload = "POST", "/api/friend-groups", {"name": "Team\x00Name", "aliases": ["New#EUW"]}
    elif operation.startswith("create-alias"):
        method, path, payload = "POST", "/api/friend-groups", {"name": "éQUIPE", "aliases": aliases}
    elif operation == "rename":
        method, path, payload = "PATCH", f"/api/friend-groups/{group_id}", {"name": "Team\x00Name"}
    else:
        method, path, payload = "POST", f"/api/friend-groups/{group_id}/aliases", {"aliases": aliases}

    def unexpected_connect():
        raise AssertionError("invalid JSON text reached the database")

    with monkeypatch.context() as guarded:
        guarded.setattr(storage, "connect", unexpected_connect)
        status, body = send(method, path, payload)
    assert status == 400, body
    assert "error" in body
    assert snapshot() == before


def test_ordinary_unicode_names_and_aliases_still_use_normal_mutations(name_http):
    send, groups, _, snapshot = name_http
    before = snapshot()
    create(send, "  Équipe Straße  ", "Élodie#EUW")
    original = groups()[0]
    create(send, "éQUIPE STRASSE", "友達#JP")
    status, renamed = send("PATCH", f"/api/friend-groups/{original['id']}", {"name": "友達 équipe"})
    assert status == 200 and renamed["id"] == original["id"] and renamed["name"] == "友達 équipe"
    status, added = send("POST", f"/api/friend-groups/{original['id']}/aliases", {"aliases": ["Straße#EUW", "STRASSE#euw"]})
    assert status == 200 and added["added_aliases"] == ["Straße#EUW"]
    actual = groups()
    assert len(actual) == 1 and actual[0]["name"] == "友達 équipe"
    assert actual[0]["id"] == original["id"]
    assert set(actual[0]["aliases"]) == {"Élodie#EUW", "友達#JP", "Straße#EUW"}
    assert_facts_unchanged(before, snapshot())
