#!/usr/bin/env python3
"""Synchronize Summoner's Rift matches from Riot Match-V5 into the local DB.

API keys are read only from RIOT_API_KEY(S) and are never written to disk or
printed. The import is idempotent on account + match_id.
"""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import json
import os
import sqlite3
import sys
import time
from itertools import cycle
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen

from app import DB_PATH, SCHEMA_PATH, normalize_role
from ingest import ingest
from queue_rules import is_supported_queue
from storage import SQLiteStorage

ACCOUNT_ROUTING = "europe"
MATCH_ROUTING = "europe"


def configured_accounts() -> tuple[str, ...]:
    """Read local Riot IDs without storing personal account data in code."""
    raw = os.environ.get("RIOT_ACCOUNTS", "")
    return tuple(account.strip() for account in raw.replace(";", ",").split(",") if account.strip())


TRACKED_ACCOUNTS = configured_accounts()
_key_ring = None


def checkpoint_stem(account: str) -> str:
    """Return a collision-resistant, filesystem-safe checkpoint identifier."""
    readable = "".join(character if character.isalnum() else "_" for character in account)[:48]
    digest = hashlib.sha256(account.encode("utf-8")).hexdigest()[:16]
    return f"{readable}_{digest}"


def configure_api_keys(keys: list[str]) -> None:
    global _key_ring
    cleaned = [key.strip() for key in keys if key.strip()]
    if not cleaned:
        raise ValueError("Nessuna chiave Riot valida configurata")
    _key_ring = cycle(cleaned)


def riot_get(path: str, api_key: str | None = None) -> object:
    selected_key = api_key or (next(_key_ring) if _key_ring is not None else None)
    if not selected_key:
        raise ValueError("Chiave Riot mancante")
    request = Request(
        f"https://{ACCOUNT_ROUTING if path.startswith('/riot/') else MATCH_ROUTING}.api.riotgames.com{path}",
        headers={
            "X-Riot-Token": selected_key,
            "Accept": "application/json",
            "User-Agent": "ChampionFit/1.0 (local data synchronization)",
        },
    )
    for attempt in range(5):
        try:
            with urlopen(request, timeout=30) as response:
                return json.load(response)
        except HTTPError as error:
            if error.code == 429 and attempt < 4:
                wait_seconds = max(float(error.headers.get("Retry-After", "30")), 30.0)
                remaining = wait_seconds
                while remaining > 0:
                    pause = min(30.0, remaining)
                    print(f"Riot rate limit: attendo {int(pause)}s prima di riprovare", file=sys.stderr)
                    time.sleep(pause)
                    remaining -= pause
                continue
            raise RuntimeError(f"Riot API HTTP {error.code} on {path}") from error
        except URLError as error:
            if attempt < 4:
                time.sleep(2 ** attempt)
                continue
            raise RuntimeError(f"Riot API connection error on {path}: {error.reason}") from error
    raise RuntimeError(f"Riot API request failed on {path}")


def riot_id(value: str) -> tuple[str, str]:
    game_name, separator, tag_line = value.partition("#")
    if not separator or not game_name or not tag_line:
        raise ValueError(f"Riot ID non valido: {value}")
    return game_name, tag_line


def normalized_rows_from_raw(account: str, puuid: str, raw_matches: dict[str, dict]) -> list[dict]:
    """Convert already downloaded Riot details into analysis rows.

    This deliberately does not require a fresh API call or a pre-existing
    match_quality row. A match can be valid and usable even before any manual
    performance annotation exists.
    """
    rows: list[dict] = []
    for fallback_match_id, detail in raw_matches.items():
        metadata = detail.get("metadata", {})
        info = detail.get("info", {})
        if info.get("mapId") != 11:
            continue
        participant = next((p for p in info.get("participants", []) if p.get("puuid") == puuid), None)
        if not participant or not is_supported_queue(info.get("queueId")):
            continue
        game_start = int(info.get("gameStartTimestamp", 0))
        date = datetime.fromtimestamp(game_start / 1000, timezone.utc).isoformat() if game_start else datetime.now(timezone.utc).isoformat()
        duration = float(info.get("gameDuration", 0)) / 60
        role = str(participant.get("teamPosition") or "INVALID").upper()
        rows.append({
            "account": account, "match_id": metadata.get("matchId", fallback_match_id), "date": date,
            "patch": str(info.get("gameVersion", "")), "queue": str(info.get("queueId", "Unknown")),
            "champion": participant.get("championName", "Unknown"), "role": normalize_role(role),
            "identity_resolution": "riot_api", "duration_minutes": duration,
            "win": bool(participant.get("win")), "match_quality_score": 0.95 if duration >= 20 else 0.45,
            "reason": "Imported from Riot Match-V5; duration model v2",
        })
    return rows


def reprocess_raw_matches(db_path: Path = DB_PATH) -> dict[str, int]:
    """Populate analysis rows from details already stored locally."""
    connection = sqlite3.connect(db_path)
    connection.row_factory = sqlite3.Row
    try:
        accounts = connection.execute("SELECT account, puuid FROM riot_accounts_raw ORDER BY account").fetchall()
        batches = []
        for row in accounts:
            details = {
                detail["match_id"]: json.loads(detail["payload_json"])
                for detail in connection.execute(
                    "SELECT match_id, payload_json FROM riot_match_raw WHERE match_id IN "
                    "(SELECT value FROM json_each((SELECT match_ids_json FROM riot_match_list_raw WHERE account=?)))",
                    (row["account"],),
                )
            }
            batches.append((row["account"], row["puuid"], normalized_rows_from_raw(row["account"], row["puuid"], details)))
    finally:
        connection.close()

    inserted = skipped = 0
    for account, _puuid, rows in batches:
        temp = db_path.with_name(f".champion_fit_reprocess_{abs(hash(account))}.json")
        temp.write_text(json.dumps({"source": "riot_api_raw_reprocess", "matches": rows}, ensure_ascii=False), encoding="utf-8")
        try:
            result = ingest(temp, db_path)
            inserted += int(result["inserted"])
            skipped += int(result["skipped"])
        finally:
            temp.unlink(missing_ok=True)
    return {"accounts": len(batches), "normalized_rows": sum(len(rows) for _, _, rows in batches), "inserted": inserted, "skipped": skipped}


def match_rows(account: str, puuid: str, api_key: str, checkpoint: Path) -> tuple[list[dict], list[dict], dict[str, dict], list[str]]:
    state = json.loads(checkpoint.read_text(encoding="utf-8")) if checkpoint.exists() else {}
    ids: list[str] = [str(match_id) for match_id in state.get("ids", [])]
    if not ids:
        start = 0
        while True:
            batch = riot_get(f"/lol/match/v5/matches/by-puuid/{quote(puuid, safe='')}/ids?start={start}&count=100", api_key)
            if not isinstance(batch, list):
                raise RuntimeError(f"Risposta match IDs inattesa per {account}")
            ids.extend(str(match_id) for match_id in batch)
            if len(batch) < 100:
                break
            start += len(batch)

    rows: list[dict] = list(state.get("rows", []))
    participants: list[dict] = list(state.get("participants", []))
    raw_matches: dict[str, dict] = dict(state.get("raw_matches", {}))
    completed = int(state.get("completed", 0))
    for offset in range(completed, len(ids), 100):
        for match_id in ids[offset:offset + 100]:
            detail = riot_get(f"/lol/match/v5/matches/{quote(match_id, safe='')}", api_key)
            raw_matches[match_id] = detail
            metadata = detail.get("metadata", {})
            info = detail.get("info", {})
            if info.get("mapId") != 11:
                continue
            participant = next((p for p in info.get("participants", []) if p.get("puuid") == puuid), None)
            if not participant:
                continue
            if not is_supported_queue(info.get("queueId")):
                continue
            game_start = int(info.get("gameStartTimestamp", 0))
            date = datetime.fromtimestamp(game_start / 1000, timezone.utc).isoformat() if game_start else datetime.now(timezone.utc).isoformat()
            duration = float(info.get("gameDuration", 0)) / 60
            role = str(participant.get("teamPosition") or "INVALID").upper()
            rows.append({
            "account": account, "match_id": metadata.get("matchId", match_id), "date": date,
            "patch": str(info.get("gameVersion", "")), "queue": str(info.get("queueId", "Unknown")),
            "champion": participant.get("championName", "Unknown"), "role": normalize_role(role),
            "identity_resolution": "riot_api", "duration_minutes": duration,
            "win": bool(participant.get("win")), "match_quality_score": 0.95 if duration >= 20 else 0.45,
            "reason": "Imported from Riot Match-V5; duration model v2",
            })
            for p in info.get("participants", []):
                participants.append({"match_id": metadata.get("matchId", match_id), "puuid": p.get("puuid", ""),
                                 "riot_id": f"{p.get('riotIdGameName', '')}#{p.get('riotIdTagline', '')}",
                                     "team_id": p.get("teamId", 0), "win": bool(p.get("win"))})
        completed = min(offset + 100, len(ids))
        checkpoint.write_text(json.dumps({"account": account, "puuid": puuid, "ids": ids, "completed": completed,
                                          "rows": rows, "participants": participants, "raw_matches": raw_matches}, ensure_ascii=False), encoding="utf-8")
    return rows, participants, raw_matches, ids


def sync(api_key: str | list[str], db_path: Path = DB_PATH, accounts: tuple[str, ...] = TRACKED_ACCOUNTS) -> dict[str, object]:
    keys = api_key if isinstance(api_key, list) else [api_key]
    configure_api_keys(keys)
    all_rows: list[dict] = []
    all_participants: list[dict] = []
    puuids: list[tuple[str, str]] = []
    unresolved: list[str] = []
    inserted = skipped = fetched_matches = 0
    def fetch_account(account: str, account_key: str) -> tuple[str, str, dict, list[dict], list[dict], dict[str, dict], list[str]]:
        game_name, tag_line = riot_id(account)
        identity = riot_get(f"/riot/account/v1/accounts/by-riot-id/{quote(game_name, safe='')}/{quote(tag_line, safe='')}", account_key)
        puuid = str(identity["puuid"])
        safe_name = checkpoint_stem(account)
        checkpoint = db_path.with_name(f".{db_path.stem}.riot-{safe_name}.checkpoint.json")
        rows, participants, raw_matches, ids = match_rows(account, puuid, account_key, checkpoint)
        return account, puuid, identity, rows, participants, raw_matches, ids

    # Every sync must refresh the account match lists.  The normalized import
    # remains idempotent, so already-known matches are skipped without making
    # an account permanently invisible to future syncs.
    pending_accounts = list(accounts)
    assignments = [(account, keys[index % len(keys)]) for index, account in enumerate(pending_accounts)]

    def commit_account(account: str, puuid: str, identity: dict, rows: list[dict], participants: list[dict], raw_matches: dict[str, dict], ids: list[str]) -> tuple[int, int]:
        safe_name = checkpoint_stem(account)
        temp = db_path.with_name(f".{db_path.stem}.riot-{safe_name}.json")
        temp.write_text(json.dumps({"source": "riot_api", "matches": rows}, ensure_ascii=False), encoding="utf-8")
        try:
            result = ingest(temp, db_path)
        finally:
            temp.unlink(missing_ok=True)
        storage = SQLiteStorage(db_path, SCHEMA_PATH)
        connection = storage.connect()
        try:
            storage.initialize()
            fetched_at = datetime.now(timezone.utc).isoformat()
            connection.execute("INSERT INTO riot_accounts_raw(puuid,account,game_name,tag_line,fetched_at,payload_json) VALUES(?,?,?,?,?,?) ON CONFLICT(puuid) DO UPDATE SET account=excluded.account,game_name=excluded.game_name,tag_line=excluded.tag_line,fetched_at=excluded.fetched_at,payload_json=excluded.payload_json",
                               (puuid, account, identity.get("gameName", ""), identity.get("tagLine", ""), fetched_at, json.dumps(identity, ensure_ascii=False)))
            connection.execute("INSERT INTO riot_match_list_raw(account,puuid,fetched_at,match_ids_json) VALUES(?,?,?,?) ON CONFLICT(account,puuid) DO UPDATE SET fetched_at=excluded.fetched_at,match_ids_json=excluded.match_ids_json",
                               (account, puuid, fetched_at, json.dumps(ids, ensure_ascii=False)))
            connection.executemany("INSERT INTO riot_match_raw(match_id,routing_region,fetched_at,payload_json) VALUES(?,?,?,?) ON CONFLICT(match_id) DO UPDATE SET routing_region=excluded.routing_region,fetched_at=excluded.fetched_at,payload_json=excluded.payload_json",
                                  [(match_id, MATCH_ROUTING, fetched_at, json.dumps(payload, ensure_ascii=False)) for match_id, payload in raw_matches.items()])
            connection.execute("INSERT INTO tracked_account_puuids(puuid,account) VALUES(?,?) ON CONFLICT(puuid) DO UPDATE SET account=excluded.account", (puuid, account))
            connection.executemany("INSERT OR IGNORE INTO match_participants(match_id,puuid,riot_id,team_id,win) VALUES(?,?,?,?,?)",
                                  [(p["match_id"], p["puuid"], p["riot_id"], p["team_id"], int(p["win"])) for p in participants if p["puuid"]])
            connection.commit()
        finally:
            connection.close()
        checkpoint = db_path.with_name(f".{db_path.stem}.riot-{safe_name}.checkpoint.json")
        checkpoint.unlink(missing_ok=True)
        return int(result["inserted"]), int(result["skipped"])

    if assignments:
        with ThreadPoolExecutor(max_workers=min(len(keys), len(assignments))) as executor:
            futures = [executor.submit(fetch_account, account, key) for account, key in assignments]
            for future in as_completed(futures):
                account = assignments[futures.index(future)][0]
                try:
                    resolved_account, puuid, identity, rows, participants, raw_matches, ids = future.result()
                except RuntimeError as error:
                    if "HTTP 404" in str(error):
                        unresolved.append(account)
                        continue
                    raise
                puuids.append((puuid, resolved_account))
                account_inserted, account_skipped = commit_account(resolved_account, puuid, identity, rows, participants, raw_matches, ids)
                inserted += account_inserted
                skipped += account_skipped
                fetched_matches += len(rows)
                print(json.dumps({"account_committed": resolved_account, "fetched_matches": len(rows), "inserted": account_inserted, "skipped": account_skipped}, ensure_ascii=False), flush=True)
    return {"accounts": len(accounts), "resolved_accounts": len(puuids), "unresolved_accounts": len(unresolved),
            "fetched_matches": fetched_matches, "inserted": inserted, "skipped": skipped,
            "unresolved": unresolved}


def main() -> None:
    parser = argparse.ArgumentParser(description="Importa le partite Riot di Summoner's Rift nel database Champion Fit")
    parser.add_argument("--api-key", default=os.environ.get("RIOT_API_KEY"), help="Riot API key; preferibile RIOT_API_KEY")
    parser.add_argument("--api-keys", default=os.environ.get("RIOT_API_KEYS"), help="Più chiavi separate da virgola o punto e virgola")
    parser.add_argument("--db", type=Path, default=DB_PATH)
    parser.add_argument("--account", action="append", help="Controlla solo questo Riot ID; ripetibile")
    parser.add_argument("--reprocess-raw", action="store_true", help="Analizza tutti i dettagli Riot già presenti localmente")
    args = parser.parse_args()
    if args.reprocess_raw:
        print(json.dumps(reprocess_raw_matches(args.db), ensure_ascii=False))
        return
    raw_keys = args.api_keys or args.api_key or ""
    keys = [key for chunk in raw_keys.replace(";", ",").split(",") if (key := chunk.strip())]
    if not keys:
        raise SystemExit("Chiave mancante: imposta RIOT_API_KEY(S) o passa --api-key(s)")
    accounts = tuple(args.account) if args.account else TRACKED_ACCOUNTS
    if not accounts:
        raise SystemExit("Nessun account configurato: imposta RIOT_ACCOUNTS o passa --account")
    print(json.dumps(sync(keys, args.db, accounts), ensure_ascii=False))


if __name__ == "__main__":
    main()
