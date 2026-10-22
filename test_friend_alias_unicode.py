"""Friend alias mutations must share the Unicode identity rules used by reads."""
import json
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import quote

import app
from test_web_server import isolated_server, request


def create_group(server, name, aliases):
    status, _, body = request(server, "POST", "/api/friend-groups", payload={
        "name": name, "aliases": aliases,
    })
    assert status == 200, body


def groups(server):
    status, _, body = request(server, "GET", "/api/friends")
    assert status == 200, body
    return {group["name"]: group for group in json.loads(body)["manual_groups"]}


def test_adding_unicode_alias_owned_by_another_group_rolls_back(isolated_server):
    create_group(isolated_server, "Alpha", ["Élodie#EUW"])
    create_group(isolated_server, "Beta", ["Other#EUW"])
    before = groups(isolated_server)
    status, _, _ = request(
        isolated_server, "POST", f"/api/friend-groups/{before['Beta']['id']}/aliases",
        payload={"aliases": ["New#EUW", "éLODIE#euw"]},
    )
    assert status == 409
    assert groups(isolated_server) == before


def test_adding_unicode_case_variant_to_same_group_is_noop(isolated_server):
    create_group(isolated_server, "Alpha", ["Straße#EUW"])
    before = groups(isolated_server)
    status, _, body = request(
        isolated_server, "POST", f"/api/friend-groups/{before['Alpha']['id']}/aliases",
        payload={"aliases": ["STRASSE#euw"]},
    )
    assert status == 200
    assert json.loads(body)["added_aliases"] == []
    assert groups(isolated_server) == before


def test_create_reuses_group_with_unicode_alias_and_preserves_display_name(isolated_server):
    create_group(isolated_server, "Alpha", ["Élodie#EUW"])
    create_group(isolated_server, "Beta", ["éLODIE#euw", "New#EUW"])
    actual = groups(isolated_server)
    assert list(actual) == ["Alpha"]
    assert set(actual["Alpha"]["aliases"]) == {"Élodie#EUW", "New#EUW"}


def test_merge_deduplicates_preexisting_unicode_aliases(isolated_server):
    create_group(isolated_server, "Alpha", ["Élodie#EUW"])
    create_group(isolated_server, "Beta", ["Other#EUW"])
    beta_id = groups(isolated_server)["Beta"]["id"]
    # Legacy databases could contain these duplicates before Unicode lookups.
    with app.STORAGE.connect() as connection:
        connection.execute(
            "INSERT INTO friend_group_aliases(group_id,alias) VALUES(?,?)",
            (beta_id, "éLODIE#euw"),
        )
        connection.commit()
    create_group(isolated_server, "Alpha", ["Other#EUW"])
    actual = groups(isolated_server)
    assert list(actual) == ["Alpha"]
    assert set(actual["Alpha"]["aliases"]) == {"Élodie#EUW", "Other#EUW"}


def test_deleting_unicode_alias_variant_removes_empty_group(isolated_server):
    create_group(isolated_server, "Alpha", ["Élodie#EUW"])
    group_id = groups(isolated_server)["Alpha"]["id"]
    status, _, _ = request(
        isolated_server, "DELETE",
        f"/api/friend-groups/{group_id}/aliases/{quote('éLODIE#euw', safe='')}",
    )
    assert status == 200
    assert groups(isolated_server) == {}


def test_concurrent_unicode_alias_additions_have_one_owner(isolated_server):
    create_group(isolated_server, "Alpha", ["One#EUW"])
    create_group(isolated_server, "Beta", ["Two#EUW"])
    before = groups(isolated_server)
    operations = [(before['Alpha']['id'], "Élodie#EUW"),
                  (before['Beta']['id'], "éLODIE#euw")]
    with ThreadPoolExecutor(max_workers=2) as executor:
        responses = list(executor.map(
            lambda operation: request(
                isolated_server, "POST", f"/api/friend-groups/{operation[0]}/aliases",
                payload={"aliases": [operation[1]]},
            ), operations,
        ))
    assert sorted(response[0] for response in responses) == [200, 409]
    aliases = [alias for group in groups(isolated_server).values() for alias in group["aliases"]]
    assert sum(alias.casefold() == "élodie#euw" for alias in aliases) == 1
