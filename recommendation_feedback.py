"""Transactional persistence for explicit recommendation preferences.

Feedback is user-authored context.  It is stored separately from raw match
outcomes and addressed by a stable account identity when the verified identity
registry can provide one.  These functions never commit the caller's work.
"""
from __future__ import annotations

from datetime import datetime, timezone
import json
import sqlite3
import unicodedata
from typing import Any

from account_identity import canonical_account_name
from analysis_runtime import parse_time
from champion_taxonomy import canonical_champion, champion_entry, load_catalog
from storage import SQL_INTEGER_MAX


ROLES = {"TOP", "JUNGLE", "MIDDLE", "BOTTOM", "SUPPORT"}
PREFERENCES = {"like", "dislike", "neutral"}
_SAVEPOINT = "recommendation_feedback_save"


class FeedbackConflictError(RuntimeError):
    """The caller tried to save against a stale feedback revision."""

    def __init__(self, snapshot: dict[str, Any]) -> None:
        self.snapshot = snapshot
        super().__init__(f"feedback revision conflict; current revision is {snapshot['revision']}")


def _row_value(row: Any, key: str, index: int) -> Any:
    try:
        return row[key]
    except (KeyError, TypeError, IndexError):
        return row[index]


def _updated_at_key(value: str) -> tuple[bool, datetime, str]:
    """Order exact UTC instants; retain raw-text ties and invalid-only fallback."""
    parsed = parse_time(value)
    return parsed is not None, parsed or datetime.min.replace(tzinfo=timezone.utc), value


def _riot_key(value: object) -> str:
    name, separator, tag = str(value or "").partition("#")
    if not separator:
        return ""
    name = unicodedata.normalize("NFKC", name).strip().casefold()
    tag = unicodedata.normalize("NFKC", tag).strip().casefold()
    return f"{name}#{tag}" if name and tag else ""


def _account_key(value: object) -> str:
    riot_key = _riot_key(value)
    if riot_key:
        return f"riot:{riot_key}"
    legacy = unicodedata.normalize("NFKC", str(value or "")).strip().casefold()
    return f"legacy:{legacy}" if legacy else ""


def _validated_accounts(accounts: object) -> list[str]:
    if not isinstance(accounts, list):
        raise ValueError("accounts must be a list of account strings")
    result = []
    seen = set()
    for value in accounts:
        if not isinstance(value, str) or not value.strip():
            raise ValueError("accounts must contain only nonempty strings")
        if "\x00" in value:
            raise ValueError("accounts must not contain NUL")
        account = value.strip()
        key = _account_key(account)
        if key not in seen:
            seen.add(key)
            result.append(account)
    return result


def _all_scoped_accounts(connection: Any) -> list[str]:
    return [str(_row_value(row, "account", 0)) for row in connection.execute(
        "SELECT account FROM match_quality UNION SELECT account FROM tracked_account_puuids "
        "UNION SELECT account FROM riot_account_identities ORDER BY account"
    ) if _row_value(row, "account", 0)]


def all_scoped_accounts(connection: Any) -> list[str]:
    """Canonical population, deduplicated by identity, including zero-game accounts.

    This is a population, not a list of stored fact labels. A fact reader must
    resolve historical labels separately before applying the population filter.
    Ambiguous aliases cannot add or merge an identity.
    """
    return resolved_scoped_accounts(connection, _all_scoped_accounts(connection))


def resolved_scoped_accounts(connection: Any, accounts: list[str]) -> list[str]:
    """Known canonical identities only; ambiguous/unknown requests yield no facts.

    Callers retain unresolved requested labels separately for missing coverage.
    Empty input resolves to the full known pool, matching the account selector.
    """
    return sorted({item["canonical"] for item in _resolved_accounts(
        connection, accounts, for_write=False
    )})


def _identity_rows(connection: Any) -> list[dict[str, str]]:
    return [
        {
            "identity_id": str(_row_value(row, "identity_id", 0)),
            "account": str(_row_value(row, "account", 1)),
        }
        for row in connection.execute(
            "SELECT identity_id,account FROM riot_account_identities ORDER BY identity_id"
        )
    ]


def _stable_name_owners(connection: Any, value: object) -> set[str]:
    """Return every stable identity that currently or historically owns a label."""
    account_key = _account_key(value)
    riot_key = _riot_key(value)
    owners = {
        item["identity_id"] for item in _identity_rows(connection)
        if _account_key(item["account"]) == account_key
    }
    for row in connection.execute(
        "SELECT a.account,a.normalized_riot_id,a.display_riot_id,p.identity_id "
        "FROM riot_account_aliases a "
        "JOIN riot_identity_puuids p ON p.puuid=a.puuid"
    ):
        if (
            _account_key(_row_value(row, "account", 0)) == account_key
            or str(_row_value(row, "normalized_riot_id", 1)) == riot_key
            or _account_key(_row_value(row, "display_riot_id", 2)) == account_key
        ):
            owners.add(str(_row_value(row, "identity_id", 3)))
    for row in connection.execute(
        "SELECT t.account,p.identity_id FROM tracked_account_puuids t "
        "JOIN riot_identity_puuids p ON p.puuid=t.puuid"
    ):
        if _account_key(_row_value(row, "account", 0)) == account_key:
            owners.add(str(_row_value(row, "identity_id", 1)))
    return owners


def _safe_feedback_names(
    connection: Any, identity_key: str, values: set[str],
) -> set[str]:
    """Keep name-keyed feedback only when the label has one possible owner."""
    return {
        value for value in values
        if not (_stable_name_owners(connection, value) - {identity_key})
    }


def reconcile_feedback_identity(
    connection: Any,
    identity_key: str,
    canonical_account: str,
    fallback_accounts: set[str],
) -> None:
    """Move legacy name-keyed preferences onto one verified identity.

    This is storage reconciliation, not a new user preference: the caller owns
    the surrounding account-merge transaction and this function deliberately
    leaves the feedback revision and event stream unchanged.  Rows already
    owned by another stable identity are never considered, even when their
    saved display name has since been reused.
    """
    identity_key = str(identity_key).strip()
    canonical_account = str(canonical_account).strip()
    safe_accounts = _safe_feedback_names(
        connection, identity_key, {canonical_account, *fallback_accounts},
    )
    account_keys = {
        _account_key(value) for value in safe_accounts
        if _account_key(value)
    }
    stable_identity_keys = {
        item["identity_id"] for item in _identity_rows(connection)
    }
    candidates = []
    for row in connection.execute(
        "SELECT identity_key,account,champion,role,preference,updated_at "
        "FROM recommendation_preferences"
    ):
        stored_key = str(_row_value(row, "identity_key", 0))
        if stored_key == identity_key or (
            stored_key not in stable_identity_keys
            and _account_key(stored_key) in account_keys
        ):
            candidates.append(row)
    if not candidates:
        return

    grouped: dict[tuple[str, str], list[Any]] = {}
    for row in candidates:
        champion = str(_row_value(row, "champion", 2))
        role = str(_row_value(row, "role", 3))
        champion_identity = _champion_key(canonical_champion(champion))
        grouped.setdefault((champion_identity, role), []).append(row)

    from account_identity import AccountIdentityConflict

    for rows in grouped.values():
        preferences = {
            str(_row_value(row, "preference", 4)) for row in rows
        }
        if len(preferences) > 1:
            sample = rows[0]
            raise AccountIdentityConflict(
                "Feedback raccomandazioni discordante per "
                f"{canonical_account!r}, campione {_row_value(sample, 'champion', 2)!r}, "
                f"ruolo {_row_value(sample, 'role', 3)!r}: riconciliazione annullata"
            )

    # Validate every semantic champion/role group before changing any row.
    # Prefer an existing stable row's spelling and retain the newest timestamp.
    reconciled = []
    for rows in grouped.values():
        representative = sorted(
            rows,
            key=lambda row: (
                str(_row_value(row, "identity_key", 0)) == identity_key,
                str(_row_value(row, "champion", 2)),
            ),
            reverse=True,
        )[0]
        updated_at = max((str(_row_value(row, "updated_at", 5)) for row in rows), key=_updated_at_key)
        reconciled.append((
            identity_key,
            canonical_account,
            str(_row_value(representative, "champion", 2)),
            str(_row_value(representative, "role", 3)),
            str(_row_value(representative, "preference", 4)),
            updated_at,
        ))

    connection.executemany(
        "DELETE FROM recommendation_preferences "
        "WHERE identity_key=? AND champion=? AND role=?",
        [
            (
                str(_row_value(row, "identity_key", 0)),
                str(_row_value(row, "champion", 2)),
                str(_row_value(row, "role", 3)),
            )
            for row in candidates
        ],
    )
    connection.executemany(
        "INSERT INTO recommendation_preferences"
        "(identity_key,account,champion,role,preference,updated_at) "
        "VALUES(?,?,?,?,?,?)",
        reconciled,
    )


def _resolve_account(connection: Any, requested: str, *, for_write: bool) -> dict[str, Any] | None:
    """Resolve one Riot ID without inferring ownership from a shared label."""
    requested_key = _account_key(requested)
    canonical = str(canonical_account_name(connection, requested) or requested).strip()
    canonical_key = _account_key(canonical)
    identities = _identity_rows(connection)
    direct_identity_ids = {
        item["identity_id"] for item in identities
        if _account_key(item["account"]) == requested_key
    }
    identity_ids = set(direct_identity_ids)

    alias_rows = list(connection.execute(
        "SELECT a.account,a.normalized_riot_id,a.display_riot_id,p.identity_id "
        "FROM riot_account_aliases a "
        "LEFT JOIN riot_identity_puuids p ON p.puuid=a.puuid "
        "WHERE a.normalized_riot_id=?",
        (_riot_key(requested),),
    ))
    if not direct_identity_ids:
        identity_ids.update(
            str(_row_value(row, "identity_id", 3))
            for row in alias_rows if _row_value(row, "identity_id", 3) is not None
        )

    tracked_rows = list(connection.execute(
        "SELECT t.account,p.identity_id FROM tracked_account_puuids t "
        "LEFT JOIN riot_identity_puuids p ON p.puuid=t.puuid"
    ))
    if not direct_identity_ids:
        identity_ids.update(
            str(_row_value(row, "identity_id", 1))
            for row in tracked_rows
            if _account_key(_row_value(row, "account", 0)) in {requested_key, canonical_key}
            and _row_value(row, "identity_id", 1) is not None
        )

    if len(identity_ids) > 1:
        if for_write:
            raise ValueError(f"account identity is ambiguous: {requested}")
        # A historical Riot ID can be shared by unrelated identities. Reading
        # must not merge those people merely because the caller supplied that
        # ambiguous old label.
        return None

    identity_id = next(iter(identity_ids), None)
    if identity_id is not None:
        current = next(item["account"] for item in identities if item["identity_id"] == identity_id)
        linked_names = {current}
        account_keys = {_account_key(current), requested_key, canonical_key}
        linked = connection.execute(
            "SELECT a.account,a.display_riot_id FROM riot_account_aliases a "
            "JOIN riot_identity_puuids p ON p.puuid=a.puuid WHERE p.identity_id=?",
            (identity_id,),
        )
        for row in linked:
            for value in (_row_value(row, "account", 0), _row_value(row, "display_riot_id", 1)):
                if value:
                    linked_names.add(str(value))
                    key = _account_key(value)
                    if key:
                        account_keys.add(key)
        fallback_keys = _safe_feedback_names(connection, identity_id, linked_names)
        feedback_account_keys = {
            _account_key(value) for value in fallback_keys if _account_key(value)
        }
        return {
            "requested": requested,
            "identity_id": identity_id,
            "identity_ids": {identity_id},
            "identity_key": identity_id,
            "keys": {identity_id, *fallback_keys},
            "fallback_keys": fallback_keys,
            "account_keys": account_keys,
            "feedback_account_keys": feedback_account_keys,
            "canonical": current,
        }

    known_names = set()
    for query in (
        "SELECT DISTINCT account FROM match_quality",
        "SELECT DISTINCT account FROM tracked_account_puuids",
    ):
        known_names.update(
            str(_row_value(row, "account", 0)) for row in connection.execute(query)
            if _row_value(row, "account", 0)
        )
    matching = {
        value for value in known_names
        if _account_key(value) in {requested_key, canonical_key}
    }
    if len(matching) > 1:
        if for_write:
            raise ValueError(f"account name is ambiguous: {requested}")
        return None
    if not matching:
        if for_write:
            raise ValueError(f"unknown account: {requested}")
        return None
    current = next(iter(matching))
    return {
        "requested": requested,
        "identity_id": None,
        "identity_ids": set(),
        "identity_key": current,
        "keys": {current},
        "fallback_keys": {current},
        "account_keys": {_account_key(current), requested_key, canonical_key},
        "feedback_account_keys": {_account_key(current), requested_key, canonical_key},
        "canonical": current,
    }


def _resolved_accounts(connection: Any, accounts: object, *, for_write: bool) -> list[dict[str, Any]]:
    requested = _validated_accounts(accounts)
    if not requested:
        requested = _all_scoped_accounts(connection)
    resolved = []
    seen = set()
    for account in requested:
        item = _resolve_account(connection, account, for_write=for_write)
        if item is None:
            continue
        identity_key = item.get("identity_key")
        dedup_key = identity_key or tuple(sorted(item.get("identity_ids", ()))) or _account_key(account)
        if dedup_key in seen:
            continue
        seen.add(dedup_key)
        resolved.append(item)
    if for_write and not resolved:
        raise ValueError("no known accounts in the active scope")
    return resolved


def _fact_owner_key(connection: Any, account: object) -> str | None:
    """Resolve one stored fact label only when it has a single safe owner."""
    resolved = _resolve_account(connection, str(account or ""), for_write=False)
    return str(resolved["identity_key"]) if resolved is not None else None


def _assert_not_suspended(connection: Any, resolved: list[dict[str, Any]]) -> None:
    identities = sorted({
        identity_id for item in resolved for identity_id in item.get("identity_ids", ())
    })
    if not identities:
        return
    placeholders = ",".join("?" for _ in identities)
    row = connection.execute(
        "SELECT p.identity_id,p.puuid,i.account FROM riot_identity_policy p "
        "JOIN riot_account_identities i ON i.identity_id=p.identity_id "
        f"WHERE p.state='exception' AND p.identity_id IN ({placeholders}) "
        "ORDER BY p.identity_id,p.puuid LIMIT 1",
        tuple(identities),
    ).fetchone()
    if row is not None:
        raise ValueError(
            f"feedback is suspended for account {_row_value(row, 'account', 2)} "
            f"because identity {_row_value(row, 'identity_id', 0)} has an exception"
        )


def _suspended_identity_ids(connection: Any) -> set[str]:
    return {
        str(_row_value(row, "identity_id", 0))
        for row in connection.execute(
            "SELECT DISTINCT identity_id FROM riot_identity_policy WHERE state='exception'"
        )
    }


def _snapshot(connection: Any, accounts: object) -> dict[str, Any]:
    resolved = _resolved_accounts(connection, accounts, for_write=False)
    suspended = _suspended_identity_ids(connection)
    resolved = [
        item for item in resolved
        if not (set(item.get("identity_ids", ())) & suspended)
    ]
    selected_ids = {identity_id for item in resolved for identity_id in item.get("identity_ids", ())}
    selected_fallbacks = {
        value for item in resolved for value in item.get("fallback_keys", ())
    }
    selected_account_keys = {
        key for item in resolved for key in item.get("feedback_account_keys", ()) if key
    }
    current_identities = {
        item["identity_id"]: item["account"] for item in _identity_rows(connection)
    }
    items = []
    seen = set()
    revision = None
    # A conflict releases its CAS savepoint before reading this snapshot. Keep
    # the projection and revision in one statement even under READ COMMITTED.
    # LEFT JOIN also retains the revision when the preference store is empty.
    rows = connection.execute(
        "SELECT p.identity_key,p.account,p.champion,p.role,p.preference,p.updated_at,s.revision "
        "FROM recommendation_feedback_state s LEFT JOIN recommendation_preferences p ON 1=1 "
        "WHERE s.singleton_id=1 ORDER BY p.account,p.champion,p.role"
    )
    for row in rows:
        if revision is None:
            revision = int(_row_value(row, "revision", 6))
        if _row_value(row, "identity_key", 0) is None:
            continue
        identity_key = str(_row_value(row, "identity_key", 0))
        stored_account = str(_row_value(row, "account", 1))
        if identity_key in current_identities:
            if identity_key not in selected_ids:
                continue
        elif identity_key not in selected_fallbacks:
            if _account_key(stored_account) not in selected_account_keys:
                continue
        account = current_identities.get(identity_key, canonical_account_name(connection, stored_account))
        key = identity_key, str(_row_value(row, "champion", 2)), str(_row_value(row, "role", 3))
        if key in seen:
            continue
        seen.add(key)
        items.append({
            "account": str(account),
            "champion": key[1],
            "role": key[2],
            "preference": str(_row_value(row, "preference", 4)),
            "updated_at": str(_row_value(row, "updated_at", 5)),
        })
    if revision is None:
        raise RuntimeError("recommendation feedback store is not initialized")
    items.sort(key=lambda item: (item["account"].casefold(), item["champion"], item["role"]))
    return {"revision": revision, "items": items}


def read_feedback(connection: Any, accounts: list[str]) -> dict[str, Any]:
    """Read feedback without schema changes, writes, or raw JSON exposure."""
    return _snapshot(connection, accounts)


def feedback_library(connection: Any, accounts: list[str]) -> dict[str, Any]:
    """Return the complete preference ledger and outcome-independent choices.

    Preferences belong to account/champion/role, independently of the current
    match filters. A first preference therefore needs no played match. Unknown
    observed champions are offered only in roles observed by every target;
    saved unknown labels remain in the ledger so they can always be reset.
    """
    requested = _validated_accounts(accounts) or _all_scoped_accounts(connection)
    resolved = _resolved_accounts(connection, requested, for_write=False)
    suspended = _suspended_identity_ids(connection)
    active = [item for item in resolved if not (item["identity_ids"] & suspended)]
    snapshot = read_feedback(connection, requested)
    catalog = load_catalog()
    active_accounts = [item["canonical"] for item in active]
    options = {
        entry["id"]: {
            "champion": entry["id"], "name": entry["name"],
            "roles": sorted(set(entry.get("roles", [])) & ROLES),
            "roles_by_account": {
                account: sorted(set(entry.get("roles", [])) & ROLES)
                for account in active_accounts
            },
            "icon_url": f"https://ddragon.leagueoflegends.com/cdn/{catalog['source_version']}/img/champion/{entry['id']}.png",
            "classified": True,
        }
        for entry in catalog["champions"]
    }
    # Compact facts only: neither JSON payloads nor outcomes inform choices.
    if active:
        active_owner_keys = {str(item["identity_key"]) for item in active}
        rows = list(connection.execute(
            "SELECT DISTINCT account,champion,role FROM match_quality"
        ))
        fact_accounts = {
            str(_row_value(row, "account", 0)) for row in rows
        }
        fact_owners = {
            account: _fact_owner_key(connection, account)
            for account in fact_accounts
        }
        observed_roles: dict[str, dict[str, set[str]]] = {}
        for row in rows:
            owner = fact_owners[str(_row_value(row, "account", 0))]
            if owner not in active_owner_keys:
                continue
            champion = canonical_champion(_row_value(row, "champion", 1))
            role = str(_row_value(row, "role", 2)).strip().upper()
            role = {"UTILITY": "SUPPORT", "MID": "MIDDLE", "ADC": "BOTTOM"}.get(role, role)
            if role not in ROLES or champion in options or not champion:
                continue
            observed_roles.setdefault(champion, {}).setdefault(owner, set()).add(role)
        for champion, owners in observed_roles.items():
            roles_by_account = {
                str(account["canonical"]): sorted(
                    owners.get(str(account["identity_key"]), set())
                )
                for account in active
            }
            local_roles = [set(roles_by_account[account]) for account in active_accounts]
            shared_roles = set.intersection(*local_roles)
            options[champion] = {
                "champion": champion, "name": champion,
                "roles": sorted(shared_roles),
                "roles_by_account": roles_by_account,
                "icon_url": None, "classified": False,
            }
    return {
        **snapshot,
        "accounts": active_accounts,
        "suspended_accounts": [item["canonical"] for item in resolved if item not in active],
        "unresolved_accounts": [account for account in requested
                                if _resolve_account(connection, account, for_write=False) is None],
        "options": sorted(options.values(), key=lambda item: (item["name"].casefold(), item["champion"])),
        "catalog_version": catalog["version"],
    }


def _has_active_transaction(connection: Any) -> bool:
    if isinstance(connection, sqlite3.Connection):
        return connection.in_transaction
    raw = getattr(connection, "raw", None)
    status = getattr(getattr(raw, "info", None), "transaction_status", None)
    if status is None:
        return False
    try:
        return int(status) != 0
    except (TypeError, ValueError):
        return not str(status).upper().endswith("IDLE")


def _start_savepoint(connection: Any) -> None:
    # Keep ownership with the caller even when a direct unit-level invocation
    # arrives without an outer transaction.
    if not _has_active_transaction(connection):
        connection.execute("BEGIN")
    connection.execute(f"SAVEPOINT {_SAVEPOINT}")


def _release_savepoint(connection: Any) -> None:
    connection.execute(f"RELEASE SAVEPOINT {_SAVEPOINT}")


def _rollback_savepoint(connection: Any) -> None:
    connection.execute(f"ROLLBACK TO SAVEPOINT {_SAVEPOINT}")
    connection.execute(f"RELEASE SAVEPOINT {_SAVEPOINT}")


def _champion_key(value: object) -> str:
    return "".join(
        character for character in unicodedata.normalize("NFKD", str(value or "")).casefold()
        if character.isalnum()
    )


def _existing_feedback_rows(
    connection: Any, account: dict[str, Any], champion_key: str, role: str,
) -> list[Any]:
    identity_key = str(account["identity_key"])
    fallback_keys = {
        _account_key(value) for value in account.get("fallback_keys", ()) if _account_key(value)
    }
    result = []
    for row in connection.execute(
        "SELECT identity_key,preference,account,champion FROM recommendation_preferences WHERE role=?",
        (role,),
    ):
        stored_key = str(_row_value(row, "identity_key", 0))
        if stored_key != identity_key and _account_key(stored_key) not in fallback_keys:
            continue
        if _champion_key(_row_value(row, "champion", 3)) == champion_key:
            result.append(row)
    return result


def _validated_champion(
    connection: Any,
    value: object,
    role: str,
    preference: str,
    accounts: list[dict[str, Any]],
) -> str:
    """Resolve known taxonomy or a raw champion observed by every target.

    Unknown observed names gain no taxonomy, aliases, or role compatibility;
    they are retained only as the raw canonical label present in local match
    history.  A neutral reset may also resolve an existing stored label so a
    later catalog revision cannot make explicit feedback impossible to remove.
    """
    if not isinstance(value, str) or not value.strip():
        raise ValueError("champion must be a known champion string")
    try:
        value.encode("utf-8")
    except UnicodeEncodeError as error:
        raise ValueError("champion must be a known champion string") from error
    champion = canonical_champion(value)
    if champion_entry(champion) is not None:
        return champion
    requested_key = _champion_key(champion)
    if not requested_key:
        raise ValueError(f"unknown champion: {value}")
    observed_names = []
    all_matches = list(connection.execute(
        "SELECT account,champion,role FROM match_quality"
    ))
    fact_accounts = {
        str(_row_value(row, "account", 0)) for row in all_matches
    }
    fact_owners = {
        account: _fact_owner_key(connection, account)
        for account in fact_accounts
    }
    observed_for_every_account = True
    for account in accounts:
        local = [
            str(_row_value(row, "champion", 1))
            for row in all_matches
            if fact_owners[str(_row_value(row, "account", 0))] == str(account["identity_key"])
            and {"UTILITY": "SUPPORT", "MID": "MIDDLE", "ADC": "BOTTOM"}.get(
                str(_row_value(row, "role", 2)).strip().upper(),
                str(_row_value(row, "role", 2)).strip().upper(),
            ) == role
            and _champion_key(_row_value(row, "champion", 1)) == requested_key
        ]
        if not local:
            observed_for_every_account = False
            break
        observed_names.extend(local)
    if observed_for_every_account and observed_names:
        return sorted(
            {str(canonical_champion(name) or name).strip() for name in observed_names},
            key=lambda name: (name.casefold(), name),
        )[0]

    if preference == "neutral":
        stored_names = []
        for account in accounts:
            rows = _existing_feedback_rows(connection, account, requested_key, role)
            if not rows:
                break
            stored_names.extend(str(_row_value(row, "champion", 3)) for row in rows)
        else:
            if stored_names:
                return sorted(set(stored_names), key=lambda name: (name.casefold(), name))[0]
    raise ValueError(
        f"unknown champion {value!r} must be observed in role {role} for every target account"
    )


def _validated_role(value: object) -> str:
    if not isinstance(value, str):
        raise ValueError("role must be one of the five concrete roles")
    role = value.strip().upper()
    if role == "UTILITY":
        role = "SUPPORT"
    if role not in ROLES:
        raise ValueError("role must be one of TOP, JUNGLE, MIDDLE, BOTTOM, SUPPORT")
    return role


def _validated_preference(value: object) -> str:
    if not isinstance(value, str):
        raise ValueError("preference must be like, dislike, or neutral")
    preference = value.strip().lower()
    if preference not in PREFERENCES:
        raise ValueError("preference must be like, dislike, or neutral")
    return preference


def save_feedback(
    connection: Any,
    accounts: list[str],
    champion: str,
    role: str,
    preference: str,
    expected_revision: int,
) -> dict[str, Any]:
    """Apply one explicit preference to a fixed account scope using CAS.

    ``neutral`` removes the explicit override.  A no-op leaves the revision and
    append-only event stream unchanged.  The function releases only its own
    savepoint; the surrounding transaction remains the caller's responsibility.
    """
    if type(expected_revision) is not int or not 0 <= expected_revision <= SQL_INTEGER_MAX:
        raise ValueError(f"expected_revision must be an integer between 0 and {SQL_INTEGER_MAX}")
    requested_accounts = _validated_accounts(accounts)
    role = _validated_role(role)
    preference = _validated_preference(preference)
    resolved = _resolved_accounts(connection, requested_accounts, for_write=True)
    _assert_not_suspended(connection, resolved)
    champion = _validated_champion(connection, champion, role, preference, resolved)

    _start_savepoint(connection)
    try:
        checked = connection.execute(
            "UPDATE recommendation_feedback_state SET revision=revision "
            "WHERE singleton_id=1 AND revision=?",
            (expected_revision,),
        )
        if checked.rowcount != 1:
            _rollback_savepoint(connection)
            raise FeedbackConflictError(_snapshot(connection, requested_accounts))

        changes = []
        for account in resolved:
            identity_key = str(account["identity_key"])
            existing_rows = _existing_feedback_rows(
                connection, account, _champion_key(champion), role,
            )
            existing_preferences = {
                str(_row_value(row, "preference", 1)) for row in existing_rows
            }
            if len(existing_preferences) > 1:
                raise ValueError(
                    f"conflicting stored feedback for account {account['canonical']}, "
                    f"champion {champion}, role {role}"
                )
            old_preference = next(iter(existing_preferences), "neutral")
            existing_keys = sorted({
                str(_row_value(row, "identity_key", 0)) for row in existing_rows
            })
            existing_records = sorted({
                (
                    str(_row_value(row, "identity_key", 0)),
                    str(_row_value(row, "champion", 3)),
                )
                for row in existing_rows
            })
            needs_reconciliation = any(key != identity_key for key in existing_keys) or any(
                str(_row_value(row, "account", 2)) != account["canonical"]
                for row in existing_rows if str(_row_value(row, "identity_key", 0)) == identity_key
            ) or any(
                str(_row_value(row, "champion", 3)) != champion for row in existing_rows
            )
            if old_preference == preference and not needs_reconciliation:
                continue
            changes.append({
                "requested_account": account["requested"],
                "account": account["canonical"],
                "identity_key": identity_key,
                "champion": champion,
                "role": role,
                "from": old_preference,
                "to": preference,
                "reconciled_identity_keys": [key for key in existing_keys if key != identity_key],
                "existing_identity_keys": existing_keys,
                "existing_records": existing_records,
            })

        if not changes:
            result = _snapshot(connection, requested_accounts) | {"ok": True}
            _release_savepoint(connection)
            return result

        revision = expected_revision + 1
        now = datetime.now(timezone.utc).isoformat()
        for change in changes:
            for existing_key, existing_champion in change["existing_records"]:
                connection.execute(
                    "DELETE FROM recommendation_preferences "
                    "WHERE identity_key=? AND champion=? AND role=?",
                    (existing_key, existing_champion, role),
                )
            if preference == "neutral":
                continue
            else:
                connection.execute(
                    "INSERT INTO recommendation_preferences"
                    "(identity_key,account,champion,role,preference,updated_at) "
                    "VALUES(?,?,?,?,?,?) ON CONFLICT(identity_key,champion,role) DO UPDATE SET "
                    "account=excluded.account,preference=excluded.preference,updated_at=excluded.updated_at",
                    (change["identity_key"], change["account"], champion, role, preference, now),
                )
        connection.execute(
            "INSERT INTO recommendation_feedback_events(revision,created_at,payload_json) VALUES(?,?,?)",
            (revision, now, json.dumps(
                {"changes": [
                    {key: value for key, value in change.items()
                     if key not in {"existing_identity_keys", "existing_records"}}
                    for change in changes
                ]},
                sort_keys=True, separators=(",", ":"), ensure_ascii=False,
            )),
        )
        advanced = connection.execute(
            "UPDATE recommendation_feedback_state SET revision=? "
            "WHERE singleton_id=1 AND revision=?",
            (revision, expected_revision),
        )
        if advanced.rowcount != 1:
            raise RuntimeError("feedback revision changed during save")
        result = _snapshot(connection, requested_accounts) | {"ok": True}
        _release_savepoint(connection)
        return result
    except FeedbackConflictError:
        raise
    except Exception:
        _rollback_savepoint(connection)
        raise
