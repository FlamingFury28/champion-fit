#!/usr/bin/env python3
"""Check every tracked Riot account for newly played Summoner's Rift matches.

This is deliberately separate from the historical importer: it refreshes only
pages recent Match-V5 IDs until it reaches locally saved history, reuses saved
details, and retries raw matches that were never materialized into the analysis table.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import json
import os
import sqlite3
import threading
import time
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Mapping
from urllib.parse import quote

from app import DB_PATH, SCHEMA_PATH
from riot_sync import (
    AccountIdentityEvidence,
    MATCH_ROUTING,
    RiotAPIError,
    SyncActivityMarker,
    TRACKED_ACCOUNTS,
    dedupe_match_ids,
    identity_evidence,
    initialize_ingestion_database,
    normalize_match_detail,
    normalize_riot_id,
    record_verified_account_identity,
    riot_get,
    riot_id,
    upsert_match_participants,
)
from storage import SQLiteStorage
from account_identity import AccountIdentityConflict, canonical_account_name, reconcile_account_identity
from riot_sync import account_raw_matches, persist_account_materialization
from sync_runs import SyncRun, current_run
from runtime_metrics import configure_logging, measure, metrics_scope, record_metric


_API_REQUEST_INTERVAL = 1.22  # Below 100 requests per rolling 120 seconds per key.
_RATE_LOCK_REGISTRY_LOCK = threading.Lock()
_RATE_LOCKS: dict[str, threading.Lock] = {}
_RATE_LAST_STARTED: dict[str, float] = {}


def _riot_get_limited(path: str, api_key: str) -> object:
    """Serialize calls per key and stay within the supplied application limits."""
    with _RATE_LOCK_REGISTRY_LOCK:
        key_lock = _RATE_LOCKS.setdefault(api_key, threading.Lock())
    with key_lock:
        last_started = _RATE_LAST_STARTED.get(api_key)
        if last_started is not None:
            delay = _API_REQUEST_INTERVAL - (time.monotonic() - last_started)
            if delay > 0:
                time.sleep(delay)
        _RATE_LAST_STARTED[api_key] = time.monotonic()
        return riot_get(path, api_key)


def _known_match_ids_for_puuid(connection, puuid: str) -> set[str]:
    """Read saved match IDs for this PUUID and its established identity group."""
    puuids = {str(puuid).strip()} - {""}
    identity = connection.execute(
        "SELECT identity_id FROM riot_identity_puuids WHERE puuid=?", (puuid,),
    ).fetchone()
    if identity:
        puuids.update(
            str(row["puuid"])
            for row in connection.execute(
                "SELECT puuid FROM riot_identity_puuids WHERE identity_id=?",
                (identity["identity_id"],),
            )
        )
    ids: list[str] = []
    ordered_puuids = sorted(puuids)
    for offset in range(0, len(ordered_puuids), 400):
        chunk = ordered_puuids[offset:offset + 400]
        placeholders = ",".join("?" for _ in chunk)
        for row in connection.execute(
            f"SELECT match_ids_json FROM riot_match_list_raw WHERE puuid IN ({placeholders})",
            tuple(chunk),
        ):
            try:
                values = json.loads(row["match_ids_json"])
            except (TypeError, ValueError, json.JSONDecodeError):
                values = []
            if isinstance(values, list):
                ids.extend(values)
    return set(dedupe_match_ids(ids))


def _retry_detail_ids(
    connection, known_ids: set[str], account: str, puuid: str,
) -> tuple[list[str], list[str]]:
    """Return retained materialization retries and their provider refetch subset.

    The queue is independent from the recent Match-V5 pages so an incomplete
    historical item remains recoverable after it falls outside their overlap.
    """
    retry = []
    refetch = []
    account_scope = {str(account).strip(), canonical_account_name(connection, account)} - {""}
    identity = connection.execute(
        "SELECT identity_id FROM riot_identity_puuids WHERE puuid=?", (puuid,),
    ).fetchone()
    if identity:
        current = connection.execute(
            "SELECT account FROM riot_account_identities WHERE identity_id=?",
            (identity["identity_id"],),
        ).fetchone()
        if current and current["account"]:
            account_scope.add(str(current["account"]))
    scope_params = tuple(sorted(account_scope))
    scope_placeholders = ",".join("?" for _ in scope_params)
    ordered_ids = sorted(known_ids)
    # Three bounded reads per batch replace three reads per historical match.
    # Keep the same exact account/identity scope and evaluate the same statuses;
    # an invalid payload owned by another player cannot force a provider call.
    with measure("sync.retry_scan"):
        record_metric("sync.retry.known_ids", len(ordered_ids))
        for offset in range(0, len(ordered_ids), 400):
            chunk = ordered_ids[offset:offset + 400]
            placeholders = ",".join("?" for _ in chunk)
            raw_by_id = {row["match_id"]: row["payload_json"] for row in connection.execute(
                f"SELECT match_id,payload_json FROM riot_match_raw WHERE match_id IN ({placeholders})", tuple(chunk),
            )}
            states_by_id = defaultdict(set)
            for row in connection.execute(
                f"SELECT match_id,status FROM riot_match_materialization "
                f"WHERE match_id IN ({placeholders}) AND account IN ({scope_placeholders})",
                (*chunk, *scope_params),
            ):
                states_by_id[row["match_id"]].add(str(row["status"]))
            materialized_ids = {row["match_id"] for row in connection.execute(
                f"SELECT DISTINCT match_id FROM match_quality "
                f"WHERE match_id IN ({placeholders}) AND account IN ({scope_placeholders})",
                (*chunk, *scope_params),
            )}
            record_metric("sync.retry.batch_queries", 3)
            for match_id in chunk:
                try:
                    cached = json.loads(raw_by_id.get(match_id))
                except (TypeError, ValueError, json.JSONDecodeError):
                    cached = None
                states = states_by_id[match_id]
                materialized = match_id in materialized_ids
                missing_raw = not isinstance(cached, dict) or not cached.get("info")
                invalid = "invalid_payload" in states
                needs_materialization = (
                    missing_raw or invalid or "identity_unresolved" in states
                    or (not states and not materialized)
                    or ("eligible" in states and not materialized)
                    or ("materialized" in states and not materialized)
                )
                if needs_materialization:
                    retry.append(match_id)
                if missing_raw or invalid:
                    refetch.append(match_id)
    return retry, refetch


def _fetch_match_ids_until_overlap(puuid: str, api_key: str, known_ids: set[str]) -> list[str]:
    """Fetch newest ID pages through the first page containing a saved match."""
    ids: list[str] = []
    start = 0
    while True:
        batch = _riot_get_limited(
            f"/lol/match/v5/matches/by-puuid/{quote(puuid, safe='')}/ids?start={start}&count=100",
            api_key,
        )
        if not isinstance(batch, list):
            raise RuntimeError("Risposta match IDs inattesa da Match-V5")
        page_ids = dedupe_match_ids(batch)
        previous_count = len(ids)
        ids = dedupe_match_ids([*ids, *page_ids])
        if known_ids.intersection(page_ids) or len(batch) < 100:
            return ids
        if len(ids) == previous_count:
            raise RuntimeError("Match-V5 ha restituito una pagina piena senza nuovi ID")
        start += len(batch)


def _stored_accounts(db_path: Path) -> tuple[str, ...]:
    """Use saved Riot account labels when no explicit account scope is configured."""
    resolved_path = Path(db_path).resolve(strict=True)
    connection = sqlite3.connect(f"{resolved_path.as_uri()}?mode=ro", uri=True)
    try:
        return tuple(
            str(row[0])
            for row in connection.execute(
                "SELECT DISTINCT account FROM riot_match_list_raw ORDER BY account"
            )
            if row[0]
        )
    finally:
        connection.close()


def _stored_puuids(db_path: Path, account: str) -> tuple[str, ...]:
    """Resolve one saved owner for an unavailable configured Riot ID.

    A current registry name wins over historical aliases.  This keeps an old
    configured Riot ID usable after a rename, while a Riot ID later assigned
    to another registered owner no longer falls back to its previous owner.
    """
    resolved_path = Path(db_path).resolve(strict=True)
    connection = sqlite3.connect(f"{resolved_path.as_uri()}?mode=ro", uri=True)
    try:
        current = tuple(
            str(row[0])
            for row in connection.execute(
                "SELECT DISTINCT p.puuid FROM riot_identity_puuids p "
                "JOIN riot_account_identities i ON i.identity_id=p.identity_id "
                "WHERE i.account=? ORDER BY p.puuid",
                (account,),
            )
            if row[0]
        )
        if current:
            return current
        exact = tuple(
            str(row[0])
            for row in connection.execute(
                "SELECT DISTINCT puuid FROM riot_match_list_raw WHERE account=? ORDER BY puuid",
                (account,),
            )
            if row[0]
        )
        if exact:
            return exact
        normalized = normalize_riot_id(account)
        if not normalized:
            return ()
        aliases = list(connection.execute(
            "SELECT DISTINCT a.puuid,p.identity_id FROM riot_account_aliases a "
            "JOIN riot_identity_puuids p ON p.puuid=a.puuid "
            "WHERE a.normalized_riot_id=? ORDER BY a.puuid",
            (normalized,),
        ))
        owners = {str(row[1]) for row in aliases}
        if len(owners) != 1:
            return ()
        return tuple(str(row[0]) for row in aliases if row[0])
    finally:
        connection.close()


def _normalize(
    account: str,
    puuid: str,
    detail: dict,
    evidence: AccountIdentityEvidence | None = None,
) -> tuple[dict | None, list[dict]]:
    """Compatibility wrapper around the shared exact identity resolver."""
    evidence = evidence or AccountIdentityEvidence(
        account,
        frozenset({str(puuid).strip()}),
        frozenset({normalize_riot_id(account)} - {""}),
    )
    result = normalize_match_detail(account, evidence, detail)
    return result.row, list(result.participants) if result.row else []


def check_account(account: str, key: str, db_path: Path) -> dict:
    initialize_ingestion_database(db_path)
    storage = SQLiteStorage(db_path, SCHEMA_PATH)
    run = current_run()
    if run is not None:
        return _check_account(account, key, db_path, storage, run)
    run = SyncRun(storage, "incremental", [account])
    with metrics_scope("sync.incremental", run_id=run.run_id), run:
        record_metric("sync_accounts", 1)
        with run.account_attempt(account):
            return _check_account(account, key, db_path, storage, run)


def _check_account(account: str, key: str, db_path: Path, storage, run: SyncRun) -> dict:
    requested_account = account
    game_name, tag_line = riot_id(account)
    account_path = (
        f"/riot/account/v1/accounts/by-riot-id/"
        f"{quote(game_name, safe='')}/{quote(tag_line, safe='')}"
    )
    try:
        identity = _riot_get_limited(account_path, key)
    except RiotAPIError as error:
        if error.status_code != 404 or not error.path.startswith("/riot/account/v1/"):
            raise
        saved_puuids = _stored_puuids(db_path, account)
        if len(saved_puuids) != 1:
            raise
        stored_puuid = saved_puuids[0]
        identity = _riot_get_limited(
            f"/riot/account/v1/accounts/by-puuid/{quote(stored_puuid, safe='')}", key,
        )
        if isinstance(identity, Mapping) and str(identity.get("puuid", "")) != stored_puuid:
            raise AccountIdentityConflict(
                f"Account-V1 by PUUID ha restituito un proprietario diverso per {account!r}"
            )
    if not isinstance(identity, Mapping):
        raise RuntimeError(f"Risposta Account-V1 inattesa per {account}")
    puuid = str(identity["puuid"])
    connection = storage.connect()
    try:
        known_api_ids = _known_match_ids_for_puuid(connection, puuid)
        retry_ids, refetch_ids = _retry_detail_ids(
            connection, known_api_ids, account, puuid,
        )
    finally:
        connection.close()
    ids = _fetch_match_ids_until_overlap(puuid, key, known_api_ids)
    downloaded = {}
    pending_details = []
    refetch_set = set(refetch_ids)
    connection = storage.connect()
    try:
        # Raw details are global by match ID, including when an account renamed.
        for match_id in dedupe_match_ids([*ids, *refetch_ids]):
            raw = connection.execute("SELECT payload_json FROM riot_match_raw WHERE match_id=?", (match_id,)).fetchone()
            try:
                cached = json.loads(raw["payload_json"]) if raw else None
            except (TypeError, ValueError):
                cached = None
            if isinstance(cached, dict) and cached.get("info") and match_id not in refetch_set:
                continue
            detail_path = f"/lol/match/v5/matches/{quote(match_id, safe='')}"
            try:
                detail = _riot_get_limited(detail_path, key)
            except RiotAPIError as error:
                if error.status_code == 404 and error.path == detail_path:
                    pending_details.append(match_id)
                    continue
                raise
            if not isinstance(detail, Mapping):
                pending_details.append(match_id)
                continue
            downloaded[match_id] = dict(detail)
    finally:
        connection.close()
    connection = storage.connect()
    try:
        connection.execute("BEGIN IMMEDIATE")
        canonical = f"{identity.get('gameName', '')}#{identity.get('tagLine', '')}"
        account = reconcile_account_identity(
            connection, account, puuid, canonical if normalize_riot_id(canonical) else account,
        )
        known_ids, _known_details = account_raw_matches(connection, account)
        merged_ids = dedupe_match_ids([*ids, *known_ids])
        fetched_at = datetime.now(timezone.utc).isoformat()
        connection.execute(
            "INSERT INTO riot_accounts_raw(puuid,account,game_name,tag_line,fetched_at,payload_json) VALUES(?,?,?,?,?,?) "
            "ON CONFLICT(puuid) DO UPDATE SET account=excluded.account,game_name=excluded.game_name,tag_line=excluded.tag_line,fetched_at=excluded.fetched_at,payload_json=excluded.payload_json",
            (puuid, account, identity.get("gameName", ""), identity.get("tagLine", ""), fetched_at, json.dumps(identity, ensure_ascii=False)),
        )
        connection.execute(
            "INSERT INTO riot_match_list_raw(account,puuid,fetched_at,match_ids_json) VALUES(?,?,?,?) "
            "ON CONFLICT(account,puuid) DO UPDATE SET fetched_at=excluded.fetched_at,match_ids_json=excluded.match_ids_json",
            (account, puuid, fetched_at, json.dumps(merged_ids, ensure_ascii=False)),
        )
        connection.executemany(
            "INSERT INTO riot_match_raw(match_id,routing_region,fetched_at,payload_json) VALUES(?,?,?,?) "
            "ON CONFLICT(match_id) DO UPDATE SET routing_region=excluded.routing_region,fetched_at=excluded.fetched_at,payload_json=excluded.payload_json",
            [(match_id, MATCH_ROUTING, fetched_at, json.dumps(payload, ensure_ascii=False)) for match_id, payload in downloaded.items()],
        )
        connection.execute("INSERT INTO tracked_account_puuids(puuid,account) VALUES(?,?) ON CONFLICT(puuid) DO UPDATE SET account=excluded.account", (puuid, account))
        record_verified_account_identity(connection, account, puuid, identity, fetched_at)
        _all_ids, details = account_raw_matches(connection, account)
        with measure("sync.materialization"):
            result = persist_account_materialization(
                connection, account, identity_evidence(connection, account, puuid, identity),
                details, "riot_api_new_matches", participant_writer=upsert_match_participants,
            )
        result = result | {
            "account": account, "recent_ids": len(ids),
            "new_ids": len(set(ids) - set(known_ids)), "retried_raw": len(retry_ids),
            "pending_details": len(pending_details), "raw_known": len(_all_ids),
            "raw_available": len(details), "raw_missing": len(set(_all_ids) - set(details)),
        }
        run.record_result(connection, requested_account, result, resolved_account=account)
        connection.commit()
    except BaseException:
        connection.rollback()
        raise
    finally:
        connection.close()
    return result


def main() -> None:
    configure_logging()
    parser = argparse.ArgumentParser()
    parser.add_argument("--api-keys", default=os.environ.get("RIOT_API_KEYS"))
    parser.add_argument("--db", type=Path, default=DB_PATH)
    parser.add_argument("--account", action="append", help="Controlla solo questo Riot ID; ripetibile")
    args = parser.parse_args()
    keys = [key.strip() for key in (args.api_keys or "").replace(";", ",").split(",") if key.strip()]
    if not keys:
        raise SystemExit("RIOT_API_KEYS mancante")
    accounts = tuple(args.account) if args.account else TRACKED_ACCOUNTS
    if not accounts:
        accounts = _stored_accounts(args.db)
    if not accounts:
        raise SystemExit("Nessun account configurato o salvato: imposta RIOT_ACCOUNTS o passa --account")
    pending_accounts, seen_accounts = [], set()
    for account in accounts:
        identity_key = normalize_riot_id(account) or str(account).strip().casefold()
        if identity_key and identity_key not in seen_accounts:
            pending_accounts.append(str(account).strip())
            seen_accounts.add(identity_key)
    accounts = tuple(pending_accounts)
    initialize_ingestion_database(args.db)
    storage = SQLiteStorage(args.db, SCHEMA_PATH)
    marker = SyncActivityMarker(args.db, len(accounts))
    marker.start()
    try:
        with metrics_scope("sync.incremental", run_id=marker.run_id), SyncRun(
            storage, "incremental", accounts, run_id=marker.run_id,
        ) as run:
            record_metric("sync_accounts", len(accounts))
            def checked_account(account, key):
                with metrics_scope("sync.incremental.account", run_id=run.run_id), run.account_attempt(account):
                    result = check_account(account, key, args.db)
                    run.complete_account(account, result, resolved_account=result.get("account", account))
                    return result

            assignments = [(account, keys[index % len(keys)]) for index, account in enumerate(accounts)]
            results, unresolved, identity_conflicts = [], [], []
            with ThreadPoolExecutor(max_workers=min(len(keys), len(assignments))) as executor:
                futures = {executor.submit(checked_account, account, key): account for account, key in assignments}
                for future in as_completed(futures):
                    account = futures[future]
                    try:
                        result = future.result()
                        results.append(result)
                        print(json.dumps(result, ensure_ascii=True), flush=True)
                    except AccountIdentityConflict as error:
                        identity_conflicts.append(account)
                        print(json.dumps({
                            "identity_conflict": account,
                            "reason": str(error),
                        }, ensure_ascii=True), flush=True)
                    except RiotAPIError as error:
                        if error.status_code == 404 and error.path.startswith("/riot/account/v1/"):
                            unresolved.append(account)
                        else:
                            raise
            print(json.dumps({
                "accounts": len(accounts),
                "checked": len(results),
                "unresolved": sorted(unresolved),
                "identity_conflicts": sorted(identity_conflicts),
                "new_ids": sum(r["new_ids"] for r in results),
                "retried_raw": sum(r["retried_raw"] for r in results),
                "pending_details": sum(r["pending_details"] for r in results),
                "inserted": sum(r["inserted"] for r in results),
                "removed_stale": sum(r["removed_stale"] for r in results),
                "identity_edges_persisted": sum(r["identity_edges_persisted"] for r in results),
            }, ensure_ascii=True), flush=True)
    finally:
        marker.close()


if __name__ == "__main__":
    main()
