"""PUUID ownership and transactional reconciliation of renamed accounts.

Names are display aliases, never the proof that two players are the same.
Registry links come from verified history or an explicit, separately recorded
user assumption. A manual exception suspends reconciliation without rewriting
existing history. No function commits.
"""
from __future__ import annotations

import json
import sqlite3
import unicodedata
from datetime import datetime, timezone


class AccountIdentityConflict(ValueError):
    """Ownership is ambiguous or the user has suspended its reconciliation."""


def _key(value: str) -> str:
    name, separator, tag = str(value or "").partition("#")
    if not separator:
        return ""
    name = unicodedata.normalize("NFKC", name).strip().casefold()
    tag = unicodedata.normalize("NFKC", tag).strip().casefold()
    return f"{name}#{tag}" if name and tag else ""


def _exists(connection, table: str) -> bool:
    if hasattr(connection, "raw"):
        return bool(connection.execute(
            "SELECT 1 FROM information_schema.tables WHERE table_name=?", (table,),
        ).fetchone())
    return bool(connection.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,),
    ).fetchone())


def record_identity_policy(connection, puuid: str, state: str, source: str,
                           note: str = "") -> dict:
    """Record an explicit policy for an existing registry link; caller commits.

    This does not create ownership evidence, move a PUUID, or split old matches.
    Exception transitions retain the prior state for an explicit later restore.
    The append-only history retains the source and note of earlier decisions.
    """
    puuid, state, source, note = (str(value).strip() for value in (puuid, state, source, note))
    if state not in {"assumed", "verified", "exception"} or not source:
        raise ValueError("Stato policy non valido o fonte mancante")
    if not _exists(connection, "riot_identity_policy"):
        raise ValueError("Schema identità non aggiornato: avvia prima l'applicazione aggiornata")
    mapped = connection.execute(
        "SELECT identity_id FROM riot_identity_puuids WHERE puuid=?", (puuid,),
    ).fetchone()
    if not mapped:
        raise ValueError(f"PUUID non presente nel registro: {puuid}")
    identity_id = str(mapped["identity_id"])
    old = connection.execute("SELECT * FROM riot_identity_policy WHERE puuid=?", (puuid,)).fetchone()
    if old and old["identity_id"] != identity_id:
        raise AccountIdentityConflict("Policy e registro PUUID discordanti; nessuna modifica applicata")
    inherited_assumption = connection.execute(
        "SELECT 1 FROM riot_identity_policy WHERE identity_id=? "
        "AND (state='assumed' OR resume_state='assumed') LIMIT 1", (identity_id,),
    ).fetchone()
    previous = str(old["state"]) if old else ("assumed" if inherited_assumption else "verified")
    resume_state = (str(old["resume_state"]) if old and previous == "exception" else previous) if state == "exception" else ""
    if state == "exception" and resume_state not in {"assumed", "verified"}:
        raise ValueError("Stato di ripristino mancante o non valido")
    try:
        history = json.loads(old["history_json"]) if old else []
    except (ValueError, TypeError) as error:
        raise ValueError("Cronologia policy non valida; nessuna modifica applicata") from error
    if not isinstance(history, list):
        raise ValueError("Cronologia policy non valida; nessuna modifica applicata")
    if old and all(old[key] == value for key, value in {
        "state": state, "resume_state": resume_state, "source": source, "note": note,
    }.items()):
        return dict(old)
    now = datetime.now(timezone.utc).isoformat()
    history.append({"at": now, "from": str(old["state"]) if old else None,
                    "to": state, "source": source, "note": note,
                    "resume_state": resume_state})
    connection.execute(
        "INSERT INTO riot_identity_policy(puuid,identity_id,state,resume_state,source,note,updated_at,history_json) "
        "VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(puuid) DO UPDATE SET "
        "state=excluded.state,resume_state=excluded.resume_state,source=excluded.source,"
        "note=excluded.note,updated_at=excluded.updated_at,history_json=excluded.history_json",
        (puuid, identity_id, state, resume_state, source, note, now, json.dumps(history, ensure_ascii=False)),
    )
    return dict(connection.execute("SELECT * FROM riot_identity_policy WHERE puuid=?", (puuid,)).fetchone())


def _assert_no_identity_exception(connection, puuids: set[str], identity_ids: set[str] | None = None) -> None:
    """Veto the whole linked group, including a traversal from another PUUID."""
    if not _exists(connection, "riot_identity_policy"):
        return
    identities = set(identity_ids or ())
    if puuids:
        placeholders = ",".join("?" for _ in puuids)
        identities.update(str(row["identity_id"]) for row in connection.execute(
            f"SELECT identity_id FROM riot_identity_puuids WHERE puuid IN ({placeholders})", tuple(sorted(puuids)),
        ))
    if not identities:
        return
    placeholders = ",".join("?" for _ in identities)
    blocked = connection.execute(
        "SELECT p.puuid,p.note,i.account FROM riot_identity_policy p "
        "JOIN riot_account_identities i ON i.identity_id=p.identity_id "
        f"WHERE p.state='exception' AND p.identity_id IN ({placeholders}) ORDER BY p.puuid LIMIT 1",
        tuple(sorted(identities)),
    ).fetchone()
    if blocked:
        raise AccountIdentityConflict(
            f"Riconciliazione sospesa per {blocked['account']!r}: eccezione manuale sul PUUID "
            f"{blocked['puuid']} ({blocked['note']}). Lo storico resta conservato; "
            "usa manage_identities.py restore per riabilitare il collegamento."
        )


def canonical_account_name(connection, account: str) -> str:
    """Resolve a saved display alias only when its registry owner is unique."""
    if not account or not _exists(connection, "riot_identity_puuids"):
        return account
    # A current name is authoritative, even if a different player used it before.
    direct = {str(row["account"]) for row in connection.execute(
        "SELECT account FROM riot_account_identities WHERE account=?", (account,),
    )}
    if len(direct) == 1:
        return next(iter(direct))
    names = {str(row["account"]) for row in connection.execute(
        "SELECT DISTINCT i.account FROM riot_account_aliases a "
        "JOIN riot_identity_puuids p ON p.puuid=a.puuid "
        "JOIN riot_account_identities i ON i.identity_id=p.identity_id "
        "WHERE a.normalized_riot_id=?", (_key(account),),
    )}
    return next(iter(names)) if len(names) == 1 else account


def _ids(value) -> list[str]:
    try:
        values = json.loads(value)
    except (ValueError, TypeError):
        return []
    if not isinstance(values, list):
        return []
    return list(dict.fromkeys(str(item).strip() for item in values if item and str(item).strip()))


def _verified_historical_puuids(connection, puuid: str) -> set[str]:
    """Follow admitted ownership history, never a raw/list display-name join.

    Account-V1 proves one name/PUUID pair. It does not prove that another PUUID
    which used that name belongs to the same player. Historical ownership is
    asserted separately by an imported PUUID history or a resolved alias edge.
    Registry groups can also carry an explicit user assumption; their policy
    remains assumed, never promoted to verified by this traversal. Exceptions
    veto a traversal that would use any member of the suspended group.
    """
    explicit_sources = {"imported_accounts_json", "verified_import", "manual_verified", "match_v5_verified_alias"}
    groups: dict[str, list[dict]] = {}
    for row in connection.execute("SELECT account,puuid,verification_source FROM riot_account_aliases"):
        if row["puuid"]:
            groups.setdefault(_key(str(row["account"])), []).append(dict(row))
    history_groups = [
        {str(row["puuid"]) for row in rows if row["verification_source"] in explicit_sources}
        for rows in groups.values()
    ]
    stable_groups: dict[str, set[str]] = {}
    for row in connection.execute("SELECT identity_id,puuid FROM riot_identity_puuids"):
        stable_groups.setdefault(str(row["identity_id"]), set()).add(str(row["puuid"]))
    verified = {puuid}
    while True:
        expanded = set(verified)
        for group in [*history_groups, *stable_groups.values()]:
            if verified & group:
                expanded.update(group)
        if expanded == verified:
            _assert_no_identity_exception(connection, verified)
            return verified
        verified = expanded


def _reconcile_account_identity(connection, account: str, puuid: str,
                                canonical_account: str | None = None) -> str:
    """Bind an admitted PUUID and merge its historical display-name read models.

    The caller supplies Account-V1/list evidence. The heuristic legacy
    tracked_account_puuids table is intentionally excluded as evidence.
    """
    account, puuid = str(account).strip(), str(puuid).strip()
    canonical = str(canonical_account or account).strip()
    if not puuid:
        return canonical_account_name(connection, account)
    _assert_no_identity_exception(connection, {puuid})
    prior = connection.execute(
        "SELECT identity_id FROM riot_identity_puuids WHERE puuid=?", (puuid,),
    ).fetchone()
    identity_id = str(prior["identity_id"]) if prior else puuid
    names = {account, canonical}
    for table in ("riot_accounts_raw", "riot_match_list_raw", "riot_account_aliases"):
        names.update(str(row["account"]) for row in connection.execute(
            f"SELECT DISTINCT account FROM {table} WHERE puuid=?", (puuid,),
        ))
    if prior:
        names.update(str(row["account"]) for row in connection.execute(
            "SELECT account FROM riot_account_identities WHERE identity_id=?", (identity_id,),
        ))
    names.discard("")
    # Apply the same exact NFKC/case-insensitive comparison as Riot ID lookup.
    # SQL equality alone would miss a second owner spelled Owner#EUW/owner#euw.
    name_keys = {_key(name) for name in names}
    for table in ("riot_accounts_raw", "riot_match_list_raw", "riot_account_aliases", "riot_account_identities"):
        names.update(str(row["account"]) for row in connection.execute(f"SELECT DISTINCT account FROM {table}")
                     if _key(str(row["account"])) in name_keys)
    placeholders = ",".join("?" for _ in names)
    params = tuple(sorted(names))
    source_puuids = set()
    # These are candidate owners, not proof that they are the same owner.
    for table in ("riot_accounts_raw", "riot_match_list_raw", "riot_account_aliases"):
        source_puuids.update(str(row["puuid"]) for row in connection.execute(
            f"SELECT DISTINCT puuid FROM {table} WHERE account IN ({placeholders})", params,
        ) if row["puuid"])
    verified_puuids = _verified_historical_puuids(connection, puuid)
    _assert_no_identity_exception(connection, source_puuids)
    if source_puuids - verified_puuids:
        raise AccountIdentityConflict(f"Riot ID {canonical!r} contiene PUUID distinti senza una storia di proprietà verificata; riconciliazione annullata")
    existing_ids = {str(row["identity_id"]) for row in connection.execute(
        f"SELECT identity_id FROM riot_account_identities WHERE account IN ({placeholders})", params,
    )}
    for verified in verified_puuids:
        mapped = connection.execute("SELECT identity_id FROM riot_identity_puuids WHERE puuid=?", (verified,)).fetchone()
        if mapped:
            existing_ids.add(str(mapped["identity_id"]))
    if len(existing_ids) > 1 or (prior and existing_ids - {identity_id}):
        raise AccountIdentityConflict(f"Riot ID {canonical!r} coinvolge proprietari PUUID distinti; riconciliazione annullata")
    if not prior and puuid not in source_puuids and (source_puuids or existing_ids):
        raise AccountIdentityConflict(f"Riot ID {canonical!r} riutilizzato da un PUUID non verificato nello storico; riconciliazione annullata")
    if not prior and existing_ids:
        identity_id = next(iter(existing_ids))
    _assert_no_identity_exception(connection, verified_puuids, existing_ids)
    if _exists(connection, "recommendation_preferences"):
        # Persist name-keyed feedback under the verified owner before a later
        # player can reuse the Riot ID.  The helper neither commits nor changes
        # the explicit-feedback revision, so it remains part of this merge.
        from recommendation_feedback import reconcile_feedback_identity
        reconcile_feedback_identity(connection, identity_id, canonical, names)
    # Archive legacy scoring inputs only after all identity vetoes, and before
    # deduplication can discard a row.
    from ingest import backfill_import_provenance
    backfill_import_provenance(connection)
    connection.execute(
        "INSERT INTO riot_account_identities(identity_id,account) VALUES(?,?) "
        "ON CONFLICT(identity_id) DO UPDATE SET account=excluded.account", (identity_id, canonical),
    )
    for verified in sorted(verified_puuids):
        old = connection.execute(
            "SELECT identity_id FROM riot_identity_puuids WHERE puuid=?", (verified,),
        ).fetchone()
        if old and old["identity_id"] != identity_id:
            raise AccountIdentityConflict("Proprietà PUUID incompatibile con la riconciliazione")
        connection.execute(
            "INSERT INTO riot_identity_puuids(puuid,identity_id) VALUES(?,?) "
            "ON CONFLICT(puuid) DO UPDATE SET identity_id=excluded.identity_id", (verified, identity_id),
        )
    params = tuple(sorted(names))
    placeholders = ",".join("?" for _ in params)
    # Record every old label before moving its rows; saved profile filters keep
    # resolving after the display account has changed.
    now = datetime.now(timezone.utc).isoformat()
    connection.executemany(
        "INSERT INTO riot_account_aliases(account,normalized_riot_id,display_riot_id,puuid,verification_source,verified_at) "
        "VALUES(?,?,?,?,?,?) ON CONFLICT(account,normalized_riot_id,puuid) DO NOTHING",
        [(canonical, _key(name), name, puuid, "verified_account_puuid", now) for name in names if _key(name)],
    )
    if names != {canonical}:
        provenance = list(connection.execute(
            f"SELECT * FROM match_import_provenance WHERE account IN ({placeholders})", params,
        ))
        merged_provenance = {}
        for row in sorted(provenance, key=lambda item: item["account"] != canonical):
            key = str(row["match_id"])
            overrides = json.loads(row["overrides_json"])
            if key in merged_provenance:
                kept, saved = merged_provenance[key]
                if any(field in saved and saved[field] != value for field, value in overrides.items()):
                    raise AccountIdentityConflict("Override storici discordanti per la stessa partita: riconciliazione annullata")
                saved.update(overrides)
            else:
                merged_provenance[key] = (row, overrides)
        connection.execute(f"DELETE FROM match_import_provenance WHERE account IN ({placeholders})", params)
        connection.executemany("INSERT INTO match_import_provenance VALUES(?,?,?,?,?,?)", [
            (canonical, match_id, row["source"], row["classification"], json.dumps(overrides), row["recorded_at"])
            for match_id, (row, overrides) in merged_provenance.items()
        ])
        matches = list(connection.execute(
            f"SELECT id,account,match_id FROM match_quality WHERE account IN ({placeholders}) ORDER BY id DESC", params,
        ))
        keep: dict[str, int] = {}
        for row in sorted(matches, key=lambda row: row["account"] != canonical):
            match_id = str(row["match_id"])
            if match_id in keep:
                connection.execute("DELETE FROM match_quality WHERE id=?", (row["id"],))
            else:
                keep[match_id] = int(row["id"])
        for row_id in keep.values():
            connection.execute("UPDATE match_quality SET account=? WHERE id=?", (canonical, row_id))
        lists: dict[str, dict] = {}
        for row in connection.execute(
            f"SELECT * FROM riot_match_list_raw WHERE account IN ({placeholders}) ORDER BY fetched_at DESC", params,
        ):
            item = lists.setdefault(str(row["puuid"]), {"ids": [], "fetched_at": row["fetched_at"]})
            item["ids"].extend(_ids(row["match_ids_json"]))
        connection.execute(f"DELETE FROM riot_match_list_raw WHERE account IN ({placeholders})", params)
        connection.executemany("INSERT INTO riot_match_list_raw VALUES(?,?,?,?)", [
            (canonical, key, item["fetched_at"], json.dumps(list(dict.fromkeys(item["ids"]))))
            for key, item in lists.items()
        ])
        aliases = list(connection.execute(
            f"SELECT * FROM riot_account_aliases WHERE account IN ({placeholders})", params,
        ))
        connection.execute(f"DELETE FROM riot_account_aliases WHERE account IN ({placeholders})", params)
        connection.executemany(
            "INSERT INTO riot_account_aliases VALUES(?,?,?,?,?,?) ON CONFLICT(account,normalized_riot_id,puuid) DO NOTHING",
            [(canonical, row["normalized_riot_id"], row["display_riot_id"], row["puuid"], row["verification_source"], row["verified_at"]) for row in aliases],
        )
        states = list(connection.execute(
            f"SELECT * FROM riot_match_materialization WHERE account IN ({placeholders}) ORDER BY last_attempt_at DESC", params,
        ))
        connection.execute(f"DELETE FROM riot_match_materialization WHERE account IN ({placeholders})", params)
        for row in states:
            connection.execute(
                "INSERT INTO riot_match_materialization VALUES(?,?,?,?,?,?,?,?) "
                "ON CONFLICT(account,match_id) DO UPDATE SET attempts=riot_match_materialization.attempts+excluded.attempts",
                (canonical, row["match_id"], row["status"], row["reason"], row["identity_resolution"], row["participant_puuid"], row["attempts"], row["last_attempt_at"]),
            )
        connection.execute(f"UPDATE riot_accounts_raw SET account=? WHERE account IN ({placeholders})", (canonical, *params))
    connection.execute(
        "UPDATE tracked_account_puuids SET account=? WHERE puuid IN "
        "(SELECT puuid FROM riot_identity_puuids WHERE identity_id=?)", (canonical, identity_id),
    )
    return canonical


def reconcile_account_identity(connection, account: str, puuid: str,
                               canonical_account: str | None = None) -> str:
    """Atomically reconcile every projection while leaving commit to the caller."""
    started_transaction = isinstance(connection, sqlite3.Connection) and not connection.in_transaction
    if started_transaction:
        connection.execute("BEGIN")
    savepoint = "account_identity_reconcile"
    connection.execute(f"SAVEPOINT {savepoint}")
    try:
        result = _reconcile_account_identity(connection, account, puuid, canonical_account)
        connection.execute(f"RELEASE SAVEPOINT {savepoint}")
        return result
    except BaseException:
        connection.execute(f"ROLLBACK TO SAVEPOINT {savepoint}")
        connection.execute(f"RELEASE SAVEPOINT {savepoint}")
        if started_transaction:
            connection.rollback()
        raise


def reconcile_existing_identities(connection) -> None:
    """Backfill stable ownership and rename deduplication from retained evidence."""
    rows = list(connection.execute(
        "SELECT account,puuid,fetched_at FROM riot_accounts_raw "
        "UNION ALL SELECT account,puuid,fetched_at FROM riot_match_list_raw ORDER BY fetched_at",
    ))
    for row in rows:
        # Prefer the latest retained Account-V1 display name for the same PUUID.
        current = connection.execute("SELECT account,game_name,tag_line FROM riot_accounts_raw WHERE puuid=?", (row["puuid"],)).fetchone()
        display = f"{current['game_name']}#{current['tag_line']}" if current else ""
        canonical = display if _key(display) else (str(current["account"]) if current else canonical_account_name(connection, str(row["account"])))
        reconcile_account_identity(connection, str(row["account"]), str(row["puuid"]), canonical)
