"""Versioned, outcome-independent Match-V5 facts. No raw JSON is read by fetch_metrics.

Materialization participates in the caller's transaction. Identity is deliberately
resolved at read time from the ingestion proof, including current policy vetoes.
"""
from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime, timezone
import hashlib
import json
import math

EXTRACTOR_VERSION = "playstyle_v1"
METRIC_NAMES = ("farm", "vision", "participation", "turrets")
SCHEMA_STATEMENTS = (
    """CREATE TABLE IF NOT EXISTS playstyle_metric_sources (
        match_id TEXT PRIMARY KEY, source_fingerprint TEXT NOT NULL,
        extractor_version TEXT NOT NULL, status TEXT NOT NULL,
        participant_count INTEGER NOT NULL, updated_at TEXT NOT NULL)""",
    """CREATE TABLE IF NOT EXISTS playstyle_match_metrics (
        match_id TEXT NOT NULL, participant_id INTEGER NOT NULL,
        participant_puuid TEXT NOT NULL, champion TEXT NOT NULL, role TEXT NOT NULL,
        queue TEXT NOT NULL, duration_minutes REAL,
        farm REAL, vision REAL, participation REAL, turrets REAL,
        extractor_version TEXT NOT NULL, source_fingerprint TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(match_id,participant_id), UNIQUE(match_id,participant_puuid),
        FOREIGN KEY(match_id) REFERENCES playstyle_metric_sources(match_id) ON DELETE CASCADE)""",
    """CREATE TABLE IF NOT EXISTS playstyle_backfill_checkpoints (
        job_name TEXT PRIMARY KEY, extractor_version TEXT NOT NULL,
        last_match_id TEXT NOT NULL DEFAULT '', processed_matches INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL DEFAULT 'running', updated_at TEXT NOT NULL)""",
)


def ensure_schema(connection) -> None:
    # executescript() can commit SQLite caller transactions; use separate statements.
    for statement in SCHEMA_STATEMENTS:
        connection.execute(statement)


def _exists(connection, table: str) -> bool:
    if hasattr(connection, "raw"):
        return bool(connection.execute(
            "SELECT 1 FROM information_schema.tables WHERE table_name=?", (table,),
        ).fetchone())
    return bool(connection.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,),
    ).fetchone())


def _number(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    value = float(value)
    return value if math.isfinite(value) and value >= 0 else None


def source_fingerprint(detail) -> str:
    return hashlib.sha256(json.dumps(detail, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


def extract_metrics(detail, match_id: str) -> tuple[str, list[dict]]:
    """farm=CS/min; vision=score/min; participation=K+A/team kills; turrets=damage/min.

    Missing inputs are null. Zero team kills leaves the undefined ratio null.
    Metadata participant slots, not potentially stale info-level PUUIDs, identify rows.
    """
    from queue_rules import is_supported_queue
    from riot_sync import _payload_participants

    if not isinstance(detail, Mapping) or not isinstance(detail.get("info"), Mapping):
        return "invalid_payload", []
    info = detail["info"]
    if info.get("mapId") != 11:
        return "unsupported_map", []
    if not is_supported_queue(info.get("queueId")):
        return "unsupported_queue", []
    participants = _payload_participants(detail, match_id)
    if not participants:
        return "invalid_payload", []
    # Legacy imports can resolve an account from its PUUID without a roster
    # slot. That remains valid ingestion evidence, but cannot key these facts.
    # Do not invent a slot or let optional metric extraction abort ingestion.
    slots = [p.get("participantId") for p in participants]
    puuids = [p.get("puuid") for p in participants]
    if (any(type(slot) is not int or not 1 <= slot <= 10 for slot in slots)
            or len(set(slots)) != len(slots)
            or any(not isinstance(puuid, str) or not puuid.strip() for puuid in puuids)
            or len(set(puuids)) != len(puuids)):
        return "invalid_payload", []
    seconds = _number(info.get("gameDuration"))
    duration = seconds / 60 if seconds else None
    team_kills = {}
    for team_id in {p.get("teamId") for p in participants}:
        team = [p for p in participants if p.get("teamId") == team_id]
        values = [_number(p.get("kills")) for p in team]
        # A complete five-player team avoids silently undercounting missing allies.
        team_kills[team_id] = sum(values) if len(team) == 5 and all(v is not None for v in values) else None
    result = []
    for participant in participants:
        lane = _number(participant.get("totalMinionsKilled"))
        jungle = _number(participant.get("neutralMinionsKilled"))
        vision = _number(participant.get("visionScore"))
        turrets = _number(participant.get("damageDealtToTurrets"))
        kills = _number(participant.get("kills"))
        assists = _number(participant.get("assists"))
        denominator = team_kills.get(participant.get("teamId"))
        participation = ((kills + assists) / denominator
                         if denominator and kills is not None and assists is not None else None)
        if participation is not None and participation > 1:
            participation = None  # Conflicting/incomplete source, not a value to clip.
        result.append({
            "match_id": match_id, "participant_id": int(participant["participantId"]),
            "participant_puuid": participant["puuid"],
            "champion": str(participant.get("championName") or ""),
            "role": str(participant.get("teamPosition") or "INVALID").upper(),
            "queue": str(info.get("queueId")), "duration_minutes": duration,
            "farm": (lane + jungle) / duration if duration and lane is not None and jungle is not None else None,
            "vision": vision / duration if duration and vision is not None else None,
            "participation": participation,
            "turrets": turrets / duration if duration and turrets is not None else None,
        })
    return "ready", result


def materialize_detail(connection, match_id: str, detail, *, fingerprint: str | None = None) -> dict:
    """Replace one source atomically; invalid replacements clear old derived facts."""
    fingerprint = fingerprint or source_fingerprint(detail)
    old = connection.execute(
        "SELECT source_fingerprint,extractor_version,participant_count,status "
        "FROM playstyle_metric_sources WHERE match_id=?", (match_id,),
    ).fetchone()
    if old and old["source_fingerprint"] == fingerprint and old["extractor_version"] == EXTRACTOR_VERSION:
        return {"changed": False, "status": old["status"], "participants": old["participant_count"]}
    status, rows = extract_metrics(detail, match_id)
    now = datetime.now(timezone.utc).isoformat()
    connection.execute(
        """INSERT INTO playstyle_metric_sources VALUES(?,?,?,?,?,?)
        ON CONFLICT(match_id) DO UPDATE SET source_fingerprint=excluded.source_fingerprint,
        extractor_version=excluded.extractor_version,status=excluded.status,
        participant_count=excluded.participant_count,updated_at=excluded.updated_at""",
        (match_id, fingerprint, EXTRACTOR_VERSION, status, len(rows), now),
    )
    connection.execute("DELETE FROM playstyle_match_metrics WHERE match_id=?", (match_id,))
    connection.executemany(
        """INSERT INTO playstyle_match_metrics
        (match_id,participant_id,participant_puuid,champion,role,queue,duration_minutes,
        farm,vision,participation,turrets,extractor_version,source_fingerprint,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        [(r["match_id"], r["participant_id"], r["participant_puuid"], r["champion"], r["role"],
          r["queue"], r["duration_minutes"], *(r[k] for k in METRIC_NAMES),
          EXTRACTOR_VERSION, fingerprint, now) for r in rows],
    )
    return {"changed": True, "status": status, "participants": len(rows)}


def materialize_details(connection, details: Mapping) -> dict:
    ensure_schema(connection)
    results = [materialize_detail(connection, str(match_id), detail) for match_id, detail in details.items()]
    return {"matches": len(results), "changed": sum(r["changed"] for r in results),
            "participants": sum(r["participants"] for r in results)}


def fetch_metrics(connection, account_match_rows) -> list[dict]:
    """Enrich already-scoped observations; no raw JSON reads, writes, or identity guesses.

    All input fields are preserved. Four nullable metric fields and metrics_status,
    participant_id, metrics_duration_minutes, and metrics_extractor_version are added.
    A materialized trusted PUUID must still be admitted by the current identity policy.
    """
    rows = [dict(row) for row in account_match_rows]
    enriched = [r | dict.fromkeys(METRIC_NAMES) | {"metrics_status": "not_materialized",
                "participant_id": None, "metrics_duration_minutes": None,
                "metrics_extractor_version": None} for r in rows]
    if not rows or not _exists(connection, "playstyle_match_metrics"):
        return enriched
    from account_identity import canonical_account_name

    canonical = {account: canonical_account_name(connection, account) for account in {r["account"] for r in rows}}
    indexed = {}
    for index, row in enumerate(rows):
        indexed.setdefault((canonical[row["account"]], row["match_id"]), []).append(index)
    pairs = list(indexed)
    for start in range(0, len(pairs), 200):
        batch = pairs[start:start + 200]
        where = " OR ".join("(mm.account=? AND mm.match_id=?)" for _ in batch)
        found = connection.execute(
            f"""SELECT mm.account,mm.match_id,mm.status materialization_status,mm.identity_resolution,
                mm.participant_puuid, p.participant_id,p.duration_minutes,p.farm,p.vision,p.participation,p.turrets,
                p.extractor_version,p.source_fingerprint,s.source_fingerprint current_fingerprint,s.status source_status,
                ai.account registry_account,
                EXISTS(SELECT 1 FROM riot_identity_policy pol WHERE pol.state='exception'
                    AND (pol.puuid=mm.participant_puuid OR pol.identity_id=ip.identity_id)) suspended
            FROM riot_match_materialization mm
            LEFT JOIN playstyle_match_metrics p ON p.match_id=mm.match_id AND p.participant_puuid=mm.participant_puuid
            LEFT JOIN playstyle_metric_sources s ON s.match_id=mm.match_id
            LEFT JOIN riot_identity_puuids ip ON ip.puuid=mm.participant_puuid
            LEFT JOIN riot_account_identities ai ON ai.identity_id=ip.identity_id
            WHERE {where}""", [value for pair in batch for value in pair],
        )
        for raw in found:
            item = dict(raw)
            state = "ready"
            if item["suspended"]:
                state = "identity_suspended"
            elif (item["materialization_status"] != "materialized" or
                  item["identity_resolution"] not in {"puuid_exact", "verified_riot_id_exact"} or
                  not item["participant_puuid"] or
                  (item["registry_account"] and item["registry_account"] != item["account"])):
                state = "identity_unresolved"
            elif item["participant_id"] is None or item["source_status"] != "ready":
                state = "not_materialized"
            elif item["extractor_version"] != EXTRACTOR_VERSION or item["source_fingerprint"] != item["current_fingerprint"]:
                state = "stale_extractor"
            elif any(item[k] is None for k in METRIC_NAMES):
                state = "partial"
            for index in indexed[(item["account"], item["match_id"])]:
                enriched[index]["metrics_status"] = state
                if state in {"ready", "partial"}:
                    enriched[index].update({key: item[key] for key in METRIC_NAMES})
                    enriched[index].update(participant_id=item["participant_id"],
                                           metrics_duration_minutes=item["duration_minutes"],
                                           metrics_extractor_version=item["extractor_version"])
    return enriched
