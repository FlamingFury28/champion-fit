"""Only public GET routes that bind champion reject malformed text."""
from copy import deepcopy
from hashlib import sha256

import pytest

from test_get_identifier_text_boundaries import (
    COMMON,
    identifier_http,  # noqa: F401
    identifier_source,  # noqa: F401
    identifier_storage,  # noqa: F401
    payload_hash,
    snapshot,
)


ROUTES = ("/api/champion", "/api/matches", "/api/recommendation-evidence")
CHAMPIONS = (
    ("nul", "Ahri\x00", 400),
    ("known", "Ahri", 200),
    ("unknown-unicode", "Élodie 友達 Ω", 200),
)


@pytest.mark.parametrize("endpoint", ROUTES, ids=[path.removeprefix("/api/") for path in ROUTES])
@pytest.mark.parametrize("kind,champion,expected_status", CHAMPIONS, ids=[case[0] for case in CHAMPIONS])
def test_bound_champion_filters_reject_nul_and_keep_supported_strings(
    identifier_http, endpoint, kind, champion, expected_status,
):
    get, storage, source, controls = identifier_http
    before = snapshot(storage)
    file_before = sha256(source.path.read_bytes()).hexdigest()
    params = COMMON | {"champion": champion}
    if endpoint != "/api/matches":
        params |= {"role": "MIDDLE", "queue": "420"}
    original = deepcopy(params)

    status, body = get(endpoint, params)
    if kind == "nul":
        # A failed request must leave the connection/server able to serve the
        # complete previously captured known-account response immediately.
        valid_status, valid_body = get("/api/matches", COMMON)
        assert (valid_status, valid_body) == controls["known-account"][:2]
        assert payload_hash(valid_body) == controls["known-account"][2]
    assert snapshot(storage) == before
    assert sha256(source.path.read_bytes()).hexdigest() == file_before
    assert params == original

    assert status == expected_status, body
    if kind == "nul":
        assert isinstance(body.get("error"), str) and body["error"]
    elif endpoint == "/api/champion":
        assert body["champion"] == champion
        if kind == "known":
            assert body["stats"]["games"] > 0
            assert body["recent"]
        else:
            assert body["stats"]["games"] == 0
            assert body["recent"] == []
    elif endpoint == "/api/recommendation-evidence":
        assert body["champion"] == champion
        if kind == "known":
            assert body["total"] > 0
            assert body["items"]
            assert all(row["champion"] == champion for row in body["items"])
        else:
            assert body["total"] == 0 and body["items"] == []
    elif kind == "known":
        assert body["items"]
        assert all(row["champion"] == champion for row in body["items"])
    else:
        assert body["items"] == []


@pytest.mark.parametrize("endpoint,extra", [
    ("/api/friends", {"min_shared_games": "1"}),
    ("/api/playstyle-evidence", {"category": "class:mage"}),
], ids=["friends", "playstyle-evidence"])
def test_routes_that_ignore_champion_keep_their_complete_payload(identifier_http, endpoint, extra):
    get, storage, source, _ = identifier_http
    before = snapshot(storage)
    file_before = sha256(source.path.read_bytes()).hexdigest()
    params = COMMON | extra
    ordinary_status, ordinary_body = get(endpoint, params)
    status, body = get(endpoint, params | {"champion": "Ahri\x00"})

    assert ordinary_status == status == 200, body
    assert body == ordinary_body
    assert payload_hash(body) == payload_hash(ordinary_body)
    if endpoint == "/api/playstyle-evidence":
        assert body["category_id"] == "class:mage"
        assert body["matches"]
    assert snapshot(storage) == before
    assert sha256(source.path.read_bytes()).hexdigest() == file_before
