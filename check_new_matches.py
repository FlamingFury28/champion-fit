#!/usr/bin/env python3
"""Check every tracked Riot account for newly played Summoner's Rift matches.

This is deliberately separate from the historical importer: it refreshes only
the first Match-V5 page and downloads details only for IDs not already saved.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import json
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from tempfile import NamedTemporaryFile
from urllib.parse import quote

from app import DB_PATH, SCHEMA_PATH
from ingest import ingest
from queue_rules import is_supported_queue
from riot_sync import (
    ACCOUNT_ROUTING,
    MATCH_ROUTING,
    TRACKED_ACCOUNTS,
    riot_get,
    riot_id,
)
from storage import SQLiteStorage


def _normalize(account: str, puuid: str, detail: dict) -> tuple[dict | None, list[dict]]:
    info = detail.get("info", {})
    metadata = detail.get("metadata", {})
    if info.get("mapId") != 11 or not is_supported_queue(info.get("queueId")):
        return None, []
    participant = next((p for p in info.get("participants", []) if p.get("puuid") == puuid), None)
    if not participant:
        return None, []
    from app import normalize_role
    game_start = int(info.get("gameStartTimestamp", 0))
    date = datetime.fromtimestamp(game_start / 1000, timezone.utc).isoformat() if game_start else datetime.now(timezone.utc).isoformat()
    row = {
        "account": account,
        "match_id": metadata.get("matchId"),
        "date": date,
        "patch": str(info.get("gameVersion", "")),
        "queue": str(info.get("queueId", "Unknown")),
        "champion": participant.get("championName", "Unknown"),
        "role": normalize_role(str(participant.get("teamPosition") or "INVALID").upper()),
        "identity_resolution": "riot_api",
        "duration_minutes": float(info.get("gameDuration", 0)) / 60,
        "win": bool(participant.get("win")),
        "match_quality_score": 0.95 if float(info.get("gameDuration", 0)) / 60 >= 20 else 0.45,
        "reason": "Imported from Riot Match-V5; duration model v2",
    }
    participants = [{
        "match_id": metadata.get("matchId"),
        "puuid": p.get("puuid", ""),
        "riot_id": f"{p.get('riotIdGameName', '')}#{p.get('riotIdTagline', '')}",
        "team_id": p.get("teamId", 0),
        "win": bool(p.get("win")),
    } for p in info.get("participants", [])]
    return row, participants


def check_account(account: str, key: str, db_path: Path) -> dict:
    game_name, tag_line = riot_id(account)
    identity = riot_get(f"/riot/account/v1/accounts/by-riot-id/{quote(game_name, safe='')}/{quote(tag_line, safe='')}", key)
    puuid = str(identity["puuid"])
    connection = sqlite3.connect(db_path)
    try:
        old = connection.execute("SELECT match_ids_json FROM riot_match_list_raw WHERE account=?", (account,)).fetchone()
        known_ids = set(json.loads(old[0])) if old else set()
    finally:
        connection.close()

    recent = riot_get(f"/lol/match/v5/matches/by-puuid/{quote(puuid, safe='')}/ids?start=0&count=100", key)
    ids = [str(match_id) for match_id in recent]
    new_ids = [match_id for match_id in ids if match_id not in known_ids]
    raw_matches: dict[str, dict] = {}
    rows: list[dict] = []
    participants: list[dict] = []
    for match_id in new_ids:
        detail = riot_get(f"/lol/match/v5/matches/{quote(match_id, safe='')}", key)
        raw_matches[match_id] = detail
        row, match_participants = _normalize(account, puuid, detail)
        if row:
            rows.append(row)
            participants.extend(match_participants)

    merged_ids = ids + [match_id for match_id in known_ids if match_id not in ids]
    fetched_at = datetime.now(timezone.utc).isoformat()
    if rows:
        with NamedTemporaryFile("w", encoding="utf-8", suffix=".json", delete=False, dir=db_path.parent) as handle:
            json.dump({"source": "riot_api_new_matches", "matches": rows}, handle, ensure_ascii=False)
            temp_path = Path(handle.name)
        try:
            result = ingest(temp_path, db_path)
        finally:
            temp_path.unlink(missing_ok=True)
    else:
        result = {"inserted": 0, "skipped": 0}

    storage = SQLiteStorage(db_path, SCHEMA_PATH)
    connection = storage.connect()
    try:
        storage.initialize()
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
            [(match_id, MATCH_ROUTING, fetched_at, json.dumps(payload, ensure_ascii=False)) for match_id, payload in raw_matches.items()],
        )
        connection.execute("INSERT INTO tracked_account_puuids(puuid,account) VALUES(?,?) ON CONFLICT(puuid) DO UPDATE SET account=excluded.account", (puuid, account))
        connection.executemany("INSERT OR IGNORE INTO match_participants(match_id,puuid,riot_id,team_id,win) VALUES(?,?,?,?,?)", [(p["match_id"], p["puuid"], p["riot_id"], p["team_id"], int(p["win"])) for p in participants if p["puuid"]])
        connection.commit()
    finally:
        connection.close()
    return {"account": account, "recent_ids": len(ids), "new_ids": len(new_ids), "inserted": int(result["inserted"]), "skipped": int(result["skipped"])}


def main() -> None:
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
        raise SystemExit("Nessun account configurato: imposta RIOT_ACCOUNTS o passa --account")
    assignments = [(account, keys[index % len(keys)]) for index, account in enumerate(accounts)]
    results, unresolved = [], []
    with ThreadPoolExecutor(max_workers=min(len(keys), len(assignments))) as executor:
        futures = {executor.submit(check_account, account, key, args.db): account for account, key in assignments}
        for future in as_completed(futures):
            account = futures[future]
            try:
                result = future.result()
                results.append(result)
                print(json.dumps(result, ensure_ascii=False), flush=True)
            except RuntimeError as error:
                if "HTTP 404" in str(error):
                    unresolved.append(account)
                else:
                    raise
    print(json.dumps({"accounts": len(accounts), "checked": len(results), "unresolved": sorted(unresolved), "new_ids": sum(r["new_ids"] for r in results), "inserted": sum(r["inserted"] for r in results)}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
