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
from champion_taxonomy import canonical_champion, champion_entry


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
        account = value.strip()
        key = _account_key(account)
        if key not in seen:
            seen.add(key)
            result.append(account)
    return result


def _all_scoped_accounts(connection: Any) -> list[str]:
    return [str(_row_value(row, "account", 0)) for row in connection.execute(
        "SELECT DISTINCT account FROM match_quality ORDER BY account"
    ) if _row_value(row, "account", 0)]


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
        updated_at = max(str(_row_value(row, "updated_at", 5)) for row in rows)
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


def _state_revision(connection: Any) -> int:
    row = connection.execute(
        "SELECT revision FROM recommendation_feedback_state WHERE singleton_id=1"
    ).fetchone()
    if row is None:
        raise RuntimeError("recommendation feedback store is not initialized")
    return int(_row_value(row, "revision", 0))


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
    rows = connection.execute(
        "SELECT identity_key,account,champion,role,preference,updated_at "
        "FROM recommendation_preferences ORDER BY account,champion,role"
    )
    for row in rows:
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
    items.sort(key=lambda item: (item["account"].casefold(), item["champion"], item["role"]))
    return {"revision": _state_revision(connection), "items": items}


def read_feedback(connection: Any, accounts: list[str]) -> dict[str, Any]:
    """Read feedback without schema changes, writes, or raw JSON exposure."""
    return _snapshot(connection, accounts)


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


def _row_belongs_to_account(row_account: object, account: dict[str, Any]) -> bool:
    return _account_key(row_account) in set(account.get("account_keys", ()))


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
    observed_for_every_account = True
    for account in accounts:
        local = [
            str(_row_value(row, "champion", 1))
            for row in all_matches
            if _row_belongs_to_account(_row_value(row, "account", 0), account)
            and str(_row_value(row, "role", 2)).upper() == role
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
    if type(expected_revision) is not int or expected_revision < 0:
        raise ValueError("expected_revision must be a non-negative integer")
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
