#!/usr/bin/env python3
"""Synchronize Summoner's Rift matches from Riot Match-V5 into the local DB.

API keys are read only from RIOT_API_KEY(S) and are never written to disk or
printed. The import is idempotent on account + match_id.
"""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
import hashlib
import json
import os
import sqlite3
import sys
import threading
import time
import unicodedata
from itertools import cycle
from datetime import datetime, timezone
from pathlib import Path
from tempfile import NamedTemporaryFile
from typing import Iterable, Mapping, Sequence
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen
from uuid import uuid4

from app import DB_PATH, SCHEMA_PATH, normalize_role
from ingest import ingest, ingest_rows
from account_identity import AccountIdentityConflict, reconcile_account_identity, reconcile_existing_identities
from queue_rules import is_supported_queue
from storage import SQLiteStorage, postgres_table_columns, postgres_table_exists
from sync_runs import SyncRun
from runtime_metrics import configure_logging, measure, metrics_scope, record_metric

ACCOUNT_ROUTING = "europe"
MATCH_ROUTING = "europe"
STALE_ANALYSIS_STATUSES = frozenset({
    "identity_unresolved",
    "unsupported_map",
    "unsupported_queue",
})


def configured_accounts() -> tuple[str, ...]:
    """Read local Riot IDs without storing personal account data in code."""
    raw = os.environ.get("RIOT_ACCOUNTS", "")
    return tuple(account.strip() for account in raw.replace(";", ",").split(",") if account.strip())


TRACKED_ACCOUNTS = configured_accounts()
_key_ring = None
_database_init_lock = threading.Lock()


class RiotAPIError(RuntimeError):
    """A Riot request failure with enough context to classify its endpoint."""

    def __init__(self, message: str, path: str, status_code: int | None = None) -> None:
        super().__init__(message)
        self.path = path
        self.status_code = status_code


def checkpoint_stem(account: str) -> str:
    """Return a collision-resistant, filesystem-safe checkpoint identifier."""
    readable = "".join(character if character.isalnum() else "_" for character in account)[:48]
    digest = hashlib.sha256(account.encode("utf-8")).hexdigest()[:16]
    return f"{readable}_{digest}"


class SyncActivityMarker:
    """Cross-process liveness marker for one historical sync run.

    Readers should accept only version 1 files whose ``heartbeat_at`` is
    recent. A crashed process may leave a stale marker; a normal exit removes
    only the file owned by this run.
    """

    VERSION = 1
    INTERVAL_SECONDS = 5.0

    def __init__(self, db_path: Path, account_count: int) -> None:
        self.run_id = uuid4().hex
        self.path = db_path.with_name(
            f".{db_path.stem}.riot-sync-{self.run_id}.active.json"
        )
        now = datetime.now(timezone.utc).isoformat()
        self.state = {
            "version": self.VERSION,
            "run_id": self.run_id,
            "pid": os.getpid(),
            "database": db_path.name,
            "account_count": int(account_count),
            "started_at": now,
            "heartbeat_at": now,
        }
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def _write(self) -> None:
        pending = None
        try:
            self.state["heartbeat_at"] = datetime.now(timezone.utc).isoformat()
            with NamedTemporaryFile(
                "w", encoding="utf-8", delete=False, dir=self.path.parent,
                prefix=self.path.name + ".", suffix=".tmp",
            ) as handle:
                pending = Path(handle.name)
                json.dump(self.state, handle, ensure_ascii=False)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(pending, self.path)
        finally:
            if pending is not None:
                pending.unlink(missing_ok=True)

    def start(self) -> None:
        self._write()
        self._thread = threading.Thread(
            target=self._heartbeat, name=f"riot-sync-{self.run_id[:8]}", daemon=True,
        )
        self._thread.start()

    def _heartbeat(self) -> None:
        while not self._stop.wait(self.INTERVAL_SECONDS):
            try:
                self._write()
            except OSError as error:
                print(f"Riot sync heartbeat failed: {error}", file=sys.stderr)

    def close(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=self.INTERVAL_SECONDS + 1)
        try:
            state = json.loads(self.path.read_text(encoding="utf-8"))
        except (FileNotFoundError, UnicodeDecodeError, ValueError):
            return
        if isinstance(state, dict) and state.get("run_id") == self.run_id:
            self.path.unlink(missing_ok=True)


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
            raise RiotAPIError(
                f"Riot API HTTP {error.code} on {path}", path, error.code,
            ) from error
        except URLError as error:
            if attempt < 4:
                time.sleep(2 ** attempt)
                continue
            raise RiotAPIError(
                f"Riot API connection error on {path}: {error.reason}", path,
            ) from error
    raise RiotAPIError(f"Riot API request failed on {path}", path)


def riot_id(value: str) -> tuple[str, str]:
    game_name, separator, tag_line = value.partition("#")
    if not separator or not game_name or not tag_line:
        raise ValueError(f"Riot ID non valido: {value}")
    return game_name, tag_line


def normalize_riot_id(value: str) -> str:
    """Return the exact comparison key used for Riot IDs.

    Comparison is deliberately conservative: Unicode compatibility and case
    differences are ignored, but internal whitespace and both Riot ID parts
    must still match.  This is not a fuzzy player-name matcher.
    """
    game_name, separator, tag_line = str(value or "").partition("#")
    if not separator:
        return ""
    game_name = unicodedata.normalize("NFKC", game_name).strip().casefold()
    tag_line = unicodedata.normalize("NFKC", tag_line).strip().casefold()
    return f"{game_name}#{tag_line}" if game_name and tag_line else ""


def dedupe_match_ids(values: Iterable[object]) -> list[str]:
    """Deduplicate provider/checkpoint IDs while retaining provider order."""
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        match_id = str(value or "").strip()
        if match_id and match_id not in seen:
            seen.add(match_id)
            result.append(match_id)
    return result


@dataclass(frozen=True)
class AccountIdentityEvidence:
    """Only explicit evidence that may identify the tracked participant."""

    account: str
    puuids: frozenset[str]
    normalized_riot_ids: frozenset[str]


@dataclass(frozen=True)
class ParticipantResolution:
    participant: dict | None
    method: str
    observed_puuid: str = ""


@dataclass(frozen=True)
class NormalizedMatchResult:
    match_id: str
    row: dict | None
    participants: tuple[dict, ...]
    status: str
    reason: str
    identity_resolution: str = ""
    observed_puuid: str = ""


@dataclass(frozen=True)
class VerifiedIdentityDiscovery:
    """A PUUID/Riot-ID edge proven by one resolved Match-V5 participant."""

    match_id: str
    puuid: str
    normalized_riot_id: str
    display_riot_id: str
    verification_source: str


def _as_int(value: object, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _as_float(value: object, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _participant_riot_id(participant: Mapping[str, object]) -> str:
    game_name = str(participant.get("riotIdGameName", "") or "").strip()
    tag_line = str(participant.get("riotIdTagline", "") or "").strip()
    return f"{game_name}#{tag_line}" if game_name and tag_line else ""


def _participant_payload_error(detail: Mapping[str, object]) -> str:
    """Validate roster shape before canonical PUUIDs can overwrite info fields."""
    info = detail.get("info", {})
    metadata = detail.get("metadata", {})
    info = info if isinstance(info, Mapping) else {}
    metadata = metadata if isinstance(metadata, Mapping) else {}
    participants = info.get("participants")
    if not isinstance(participants, list) or not participants:
        return "missing_participants"
    if any(not isinstance(item, Mapping) for item in participants):
        return "invalid_participant_entry"
    if "participants" not in metadata:
        # Some historical compact exports contain only info-level identities.
        # There is no parallel identity vector to repair or shift in this case.
        puuids = [str(item.get("puuid", "") or "").strip() for item in participants]
        if len(puuids) != len(set(puuids)) or "" in puuids:
            return "incoherent_participant_identity"
        return ""
    metadata_puuids = metadata.get("participants")
    if not isinstance(metadata_puuids, list) or len(metadata_puuids) != 10 or len(participants) != 10:
        return "incomplete_identity_roster"
    puuids = [str(value or "").strip() for value in metadata_puuids]
    if len(set(puuids)) != 10 or "" in puuids:
        return "incoherent_metadata_identity"
    slots = [_as_int(item.get("participantId")) for item in participants]
    if set(slots) != set(range(1, 11)):
        return "incoherent_participant_slots"
    info_puuids = [str(item.get("puuid", "") or "").strip() for item in participants]
    nonempty_info_puuids = [value for value in info_puuids if value]
    if len(nonempty_info_puuids) != len(set(nonempty_info_puuids)):
        return "incoherent_participant_identity"
    for slot, info_puuid in zip(slots, info_puuids):
        # Historical exports can encode a different info-level PUUID. But an
        # identity already present in the canonical vector cannot move slots.
        if info_puuid in puuids and info_puuid != puuids[slot - 1]:
            return "participant_identity_slot_mismatch"
    return ""


def _payload_participants(detail: Mapping[str, object], fallback_match_id: str = "") -> list[dict]:
    metadata = detail.get("metadata", {})
    info = detail.get("info", {})
    metadata = metadata if isinstance(metadata, Mapping) else {}
    info = info if isinstance(info, Mapping) else {}
    metadata_match_id = str(metadata.get("matchId") or "").strip()
    fallback_match_id = str(fallback_match_id or "").strip()
    if metadata_match_id and fallback_match_id and metadata_match_id != fallback_match_id:
        return []
    if _participant_payload_error(detail):
        return []
    match_id = metadata_match_id or fallback_match_id
    raw_participants = info.get("participants", [])
    raw_participants = raw_participants if isinstance(raw_participants, list) else []
    metadata_puuids = metadata.get("participants", [])
    metadata_puuids = metadata_puuids if isinstance(metadata_puuids, list) else []
    rows: list[dict] = []
    for raw in raw_participants:
        if not isinstance(raw, Mapping):
            continue
        participant = dict(raw)
        info_puuid = str(participant.get("puuid", "") or "").strip()
        slot = _as_int(participant.get("participantId"))
        metadata_puuid = str(metadata_puuids[slot - 1] or "").strip() if metadata_puuids else ""
        # Metadata.participants is the canonical Match-V5 identity vector.  It
        # also repairs historical details whose info-level PUUID was serialized
        # differently, without guessing by display name.
        participant["puuid"] = metadata_puuid or info_puuid
        participant["_match_id"] = match_id
        rows.append(participant)
    return rows


def participant_rows_from_detail(detail: Mapping[str, object], fallback_match_id: str = "") -> list[dict]:
    """Return a canonical roster, including Riot's stable in-match slot ID."""
    rows: list[dict] = []
    for participant in _payload_participants(detail, fallback_match_id):
        puuid = str(participant.get("puuid", "") or "").strip()
        riot_id_value = _participant_riot_id(participant)
        if not puuid:
            continue
        rows.append({
            "match_id": str(participant.get("_match_id", "")),
            "puuid": puuid,
            "riot_id": riot_id_value,
            "normalized_riot_id": normalize_riot_id(riot_id_value),
            "participant_id": _as_int(participant.get("participantId")),
            "team_id": _as_int(participant.get("teamId")),
            "win": bool(participant.get("win")),
            "champion": str(participant.get("championName", "") or "").strip(),
        })
    return canonical_participant_rows(rows)


def _table_exists(connection, table: str) -> bool:
    if hasattr(connection, "raw"):
        return postgres_table_exists(connection, table)
    return bool(connection.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)
    ).fetchone())


def identity_evidence(
    connection,
    account: str,
    current_puuid: str = "",
    identity: Mapping[str, object] | None = None,
    verified_aliases: Iterable[str] = (),
) -> AccountIdentityEvidence:
    """Build resolver evidence from explicit, auditable local sources."""
    puuids = {str(current_puuid).strip()} if str(current_puuid).strip() else set()
    aliases = {normalize_riot_id(account), *(normalize_riot_id(alias) for alias in verified_aliases)}
    aliases.discard("")
    if identity:
        response_id = f"{identity.get('gameName', '')}#{identity.get('tagLine', '')}"
        normalized = normalize_riot_id(response_id)
        if normalized:
            aliases.add(normalized)
        response_puuid = str(identity.get("puuid", "") or "").strip()
        if response_puuid:
            puuids.add(response_puuid)
    # `tracked_account_puuids` is intentionally not resolver evidence: older
    # versions also populated it heuristically from frequent duo partners.
    # Account-V1/raw-list PUUIDs and audited aliases below are verifiable.
    for row in connection.execute("SELECT puuid FROM riot_match_list_raw WHERE account=?", (account,)):
        if row["puuid"]:
            puuids.add(str(row["puuid"]).strip())
    if _table_exists(connection, "riot_identity_puuids"):
        for row in connection.execute(
            "SELECT p.puuid FROM riot_identity_puuids p JOIN riot_account_identities i "
            "ON i.identity_id=p.identity_id WHERE i.account=?", (account,),
        ):
            puuids.add(str(row["puuid"]))
    for row in connection.execute(
        "SELECT puuid,account,game_name,tag_line FROM riot_accounts_raw WHERE account=?", (account,)
    ):
        raw_puuid = str(row["puuid"] or "").strip()
        if raw_puuid:
            puuids.add(raw_puuid)
        for candidate in (
            str(row["account"] or ""),
            f"{row['game_name'] or ''}#{row['tag_line'] or ''}",
        ):
            normalized = normalize_riot_id(candidate)
            if normalized:
                aliases.add(normalized)
    if _table_exists(connection, "riot_account_aliases"):
        for row in connection.execute(
            "SELECT normalized_riot_id,puuid FROM riot_account_aliases WHERE account=?", (account,)
        ):
            normalized = normalize_riot_id(str(row["normalized_riot_id"] or ""))
            alias_puuid = str(row["puuid"] or "").strip()
            if normalized:
                aliases.add(normalized)
            if alias_puuid:
                puuids.add(alias_puuid)
    # A configured Riot ID may itself have been renamed.  PUUID-linked alias
    # records preserve that history even when the display `account` changes.
    if puuids:
        placeholders = ",".join("?" for _ in puuids)
        if _table_exists(connection, "riot_account_aliases"):
            for row in connection.execute(
                f"SELECT normalized_riot_id,puuid FROM riot_account_aliases WHERE puuid IN ({placeholders})",
                tuple(sorted(puuids)),
            ):
                normalized = normalize_riot_id(str(row["normalized_riot_id"] or ""))
                if normalized:
                    aliases.add(normalized)
        for row in connection.execute(
            f"SELECT game_name,tag_line FROM riot_accounts_raw WHERE puuid IN ({placeholders})",
            tuple(sorted(puuids)),
        ):
            normalized = normalize_riot_id(f"{row['game_name'] or ''}#{row['tag_line'] or ''}")
            if normalized:
                aliases.add(normalized)
    return AccountIdentityEvidence(account, frozenset(puuids), frozenset(aliases))


def resolve_tracked_participant(
    participants: Sequence[Mapping[str, object]],
    evidence: AccountIdentityEvidence,
) -> ParticipantResolution:
    """Resolve only by a trusted PUUID; names can diagnose but not prove ownership."""
    payload = [dict(participant) for participant in participants if isinstance(participant, Mapping)]
    by_puuid = [
        participant for participant in payload
        if str(participant.get("puuid", "") or "").strip() in evidence.puuids
    ]
    if len(by_puuid) == 1:
        puuid = str(by_puuid[0].get("puuid", "") or "").strip()
        return ParticipantResolution(by_puuid[0], "puuid_exact", puuid)
    if len(by_puuid) > 1:
        return ParticipantResolution(None, "ambiguous_puuid")
    by_alias = [
        participant for participant in payload
        if normalize_riot_id(_participant_riot_id(participant)) in evidence.normalized_riot_ids
    ]
    if len(by_alias) == 1:
        puuid = str(by_alias[0].get("puuid", "") or "").strip()
        # A Riot ID can be renamed and later reused by another player.  The
        # exact alias therefore explains why resolution stopped, but it cannot
        # add its previously unknown PUUID to this account's ownership graph.
        return ParticipantResolution(None, "unverified_alias_puuid", puuid)
    if len(by_alias) > 1:
        return ParticipantResolution(None, "ambiguous_verified_riot_id")
    return ParticipantResolution(None, "identity_unresolved")


def normalize_match_detail(
    account: str,
    evidence: AccountIdentityEvidence,
    detail: Mapping[str, object],
    fallback_match_id: str = "",
) -> NormalizedMatchResult:
    metadata = detail.get("metadata", {})
    info = detail.get("info", {})
    metadata = metadata if isinstance(metadata, Mapping) else {}
    info = info if isinstance(info, Mapping) else {}
    metadata_match_id = str(metadata.get("matchId") or "").strip()
    fallback_match_id = str(fallback_match_id or "").strip()
    if metadata_match_id and fallback_match_id and metadata_match_id != fallback_match_id:
        return NormalizedMatchResult(fallback_match_id, None, (), "invalid_payload", "match_id_mismatch")
    match_id = metadata_match_id or fallback_match_id
    if not match_id:
        return NormalizedMatchResult("", None, (), "invalid_payload", "missing_match_id")
    if "mapId" not in info or "queueId" not in info:
        return NormalizedMatchResult(match_id, None, (), "invalid_payload", "missing_queue_or_map")
    if info.get("mapId") != 11:
        return NormalizedMatchResult(match_id, None, (), "unsupported_map", "map_is_not_summoners_rift")
    if not is_supported_queue(info.get("queueId")):
        return NormalizedMatchResult(match_id, None, (), "unsupported_queue", "queue_not_supported")
    payload_error = _participant_payload_error(detail)
    if payload_error:
        return NormalizedMatchResult(match_id, None, (), "invalid_payload", payload_error)
    payload_participants = _payload_participants(detail, match_id)
    roster = tuple(participant_rows_from_detail(detail, match_id))
    if not payload_participants:
        return NormalizedMatchResult(match_id, None, roster, "invalid_payload", "missing_participants")
    resolution = resolve_tracked_participant(payload_participants, evidence)
    if resolution.participant is None:
        # A partial snapshot may positively identify its player, but absence
        # is evidence only in a complete, coherent Riot roster.
        slots = {_as_int(item.get("participantId")) for item in payload_participants}
        puuids = {str(item.get("puuid", "") or "").strip() for item in payload_participants}
        metadata_puuids = metadata.get("participants", [])
        complete = (
            len(payload_participants) == 10 and slots == set(range(1, 11))
            and len(puuids) == 10 and "" not in puuids
            and isinstance(metadata_puuids, list) and len(metadata_puuids) == 10
            and set(str(value or "").strip() for value in metadata_puuids) == puuids
        )
        if not complete:
            return NormalizedMatchResult(match_id, None, roster, "invalid_payload", "incomplete_identity_roster")
        return NormalizedMatchResult(
            match_id, None, roster, "identity_unresolved", resolution.method,
            resolution.method, resolution.observed_puuid,
        )
    participant = resolution.participant
    game_start = _as_int(info.get("gameStartTimestamp"))
    try:
        date = (
            datetime.fromtimestamp(game_start / 1000, timezone.utc).isoformat()
            if game_start else datetime.now(timezone.utc).isoformat()
        )
    except (OSError, OverflowError, ValueError):
        date = datetime.now(timezone.utc).isoformat()
    duration = _as_float(info.get("gameDuration")) / 60
    role = str(participant.get("teamPosition") or "INVALID").upper()
    row = {
        "account": account,
        "match_id": match_id,
        "date": date,
        "patch": str(info.get("gameVersion", "")),
        "queue": str(info.get("queueId", "Unknown")),
        "champion": participant.get("championName", "Unknown"),
        "role": normalize_role(role),
        "identity_resolution": resolution.method,
        "duration_minutes": duration,
        "win": bool(participant.get("win")),
        "match_quality_score": 0.95 if duration >= 20 else 0.45,
        "reason": "Imported from Riot Match-V5; duration model v2",
    }
    return NormalizedMatchResult(
        match_id, row, roster, "eligible", "eligible_supported_match",
        resolution.method, resolution.observed_puuid,
    )


def resolve_account_matches_fixed_point(
    account: str,
    initial_evidence: AccountIdentityEvidence,
    raw_matches: Mapping[str, Mapping[str, object]],
) -> tuple[list[NormalizedMatchResult], AccountIdentityEvidence, list[VerifiedIdentityDiscovery]]:
    """Resolve an account's raw matches to closure over verified identity edges.

    A PUUID-exact match can verify a historical Riot ID.  Riot IDs never grow
    the PUUID set: names are reusable and cannot prove ownership of a newly
    observed PUUID. Results are returned only after the alias set stops growing,
    so deletion/materialization never depends on raw-detail visit order.
    """
    puuids = set(initial_evidence.puuids)
    aliases = set(initial_evidence.normalized_riot_ids)
    discoveries: dict[tuple[str, str], VerifiedIdentityDiscovery] = {}
    ordered_matches = [
        (str(match_id), detail)
        for match_id, detail in raw_matches.items()
        if isinstance(detail, Mapping)
    ]
    final_results: list[NormalizedMatchResult] = []
    while True:
        evidence = AccountIdentityEvidence(account, frozenset(puuids), frozenset(aliases))
        pass_results = [
            normalize_match_detail(account, evidence, detail, match_id)
            for match_id, detail in ordered_matches
        ]
        added_evidence = False
        for result in pass_results:
            if not result.row or result.identity_resolution != "puuid_exact":
                continue
            participant = next((
                row for row in result.participants
                if str(row.get("puuid", "") or "").strip() == result.observed_puuid
            ), None)
            if not participant:
                continue
            puuid = str(participant.get("puuid", "") or "").strip()
            display_id = str(participant.get("riot_id", "") or "").strip()
            normalized_id = normalize_riot_id(display_id)
            new_alias = bool(normalized_id and normalized_id not in aliases)
            if new_alias:
                aliases.add(normalized_id)
                added_evidence = True
            if puuid in puuids and normalized_id and new_alias:
                discoveries[(normalized_id, puuid)] = VerifiedIdentityDiscovery(
                    result.match_id, puuid, normalized_id, display_id,
                    "match_v5_verified_puuid",
                )
        final_results = pass_results
        if not added_evidence:
            final_evidence = AccountIdentityEvidence(
                account, frozenset(puuids), frozenset(aliases),
            )
            return final_results, final_evidence, list(discoveries.values())


def _participant_record(row: Mapping[str, object], preferred: bool = False) -> dict:
    riot_id_value = str(row.get("riot_id", "") or "").strip()
    return {
        "match_id": str(row.get("match_id", "") or "").strip(),
        "puuid": str(row.get("puuid", "") or "").strip(),
        "riot_id": riot_id_value,
        "normalized_riot_id": (
            normalize_riot_id(str(row.get("normalized_riot_id", "") or ""))
            or normalize_riot_id(riot_id_value)
        ),
        "participant_id": _as_int(row.get("participant_id")),
        "team_id": _as_int(row.get("team_id")),
        "win": bool(row.get("win")),
        "champion": str(row.get("champion", "") or "").strip(),
        "_preferred": preferred or bool(row.get("_preferred", False)),
    }


def canonical_participant_rows(rows: Iterable[Mapping[str, object]]) -> list[dict]:
    """Collapse logical roster duplicates using slot ID, then exact Riot ID.

    Match-V5's participantId is scoped to one match and is the strongest key.
    Exact normalized Riot ID is the fallback for legacy rows without that slot.
    PUUID remains the storage-compatible final fallback.
    """
    by_match: dict[str, list[dict]] = {}
    for raw in rows:
        row = _participant_record(raw, bool(raw.get("_preferred", False)))
        if row["match_id"] and row["puuid"]:
            by_match.setdefault(row["match_id"], []).append(row)
    canonical: list[dict] = []
    for match_id, match_rows in by_match.items():
        groups: list[list[dict]] = []
        for row in match_rows:
            matching: list[int] = []
            for index, group in enumerate(groups):
                same_slot = row["participant_id"] > 0 and any(
                    member["participant_id"] == row["participant_id"] for member in group
                )
                same_riot_id = bool(row["normalized_riot_id"]) and any(
                    member["normalized_riot_id"] == row["normalized_riot_id"] for member in group
                )
                same_puuid = any(member["puuid"] == row["puuid"] for member in group)
                if same_slot or same_riot_id or same_puuid:
                    matching.append(index)
            if not matching:
                groups.append([row])
                continue
            target = matching[0]
            groups[target].append(row)
            for index in reversed(matching[1:]):
                groups[target].extend(groups.pop(index))
        for group in groups:
            ranked = sorted(
                group,
                key=lambda item: (
                    bool(item["_preferred"]),
                    item["participant_id"] > 0,
                    bool(item["normalized_riot_id"]),
                    bool(item["champion"]),
                    bool(item["riot_id"]),
                ),
                reverse=True,
            )
            winner = dict(ranked[0])
            for field in ("participant_id", "team_id"):
                if not winner[field]:
                    winner[field] = next((item[field] for item in ranked if item[field]), 0)
            for field in ("riot_id", "normalized_riot_id", "champion"):
                if not winner[field]:
                    winner[field] = next((item[field] for item in ranked if item[field]), "")
            winner.pop("_preferred", None)
            canonical.append(winner)
    return sorted(
        canonical,
        key=lambda item: (item["match_id"], item["participant_id"] or 999, item["normalized_riot_id"], item["puuid"]),
    )


def _table_columns(connection, table: str) -> set[str]:
    if hasattr(connection, "raw"):
        return postgres_table_columns(connection, table)
    return {str(row["name"]) for row in connection.execute(f"PRAGMA table_info({table})")}


def upsert_match_participants(connection, participants: Iterable[Mapping[str, object]]) -> int:
    """Idempotently replace affected rosters with their canonical rows."""
    incoming = []
    for participant in participants:
        preferred = dict(participant)
        preferred["_preferred"] = True
        incoming.append(preferred)
    match_ids = dedupe_match_ids(row.get("match_id") for row in incoming)
    if not match_ids:
        return 0
    existing: list[dict] = []
    for match_id in match_ids:
        for row in connection.execute(
            "SELECT match_id,puuid,riot_id,team_id,win,champion,participant_id,normalized_riot_id "
            "FROM match_participants WHERE match_id=?",
            (match_id,),
        ):
            existing.append(dict(row))
    canonical = canonical_participant_rows([*existing, *incoming])
    for match_id in match_ids:
        connection.execute("DELETE FROM match_participants WHERE match_id=?", (match_id,))
    connection.executemany(
        """INSERT INTO match_participants
           (match_id,puuid,riot_id,team_id,win,champion,participant_id,normalized_riot_id)
           VALUES(?,?,?,?,?,?,?,?)
           ON CONFLICT(match_id,puuid) DO UPDATE SET
             riot_id=excluded.riot_id,
             team_id=excluded.team_id,
             win=excluded.win,
             champion=CASE WHEN excluded.champion <> '' THEN excluded.champion
                           ELSE match_participants.champion END,
             participant_id=CASE WHEN excluded.participant_id > 0 THEN excluded.participant_id
                                 ELSE match_participants.participant_id END,
             normalized_riot_id=CASE WHEN excluded.normalized_riot_id <> '' THEN excluded.normalized_riot_id
                                     ELSE match_participants.normalized_riot_id END""",
        [(
            row["match_id"], row["puuid"], row["riot_id"], row["team_id"], int(row["win"]),
            row["champion"], row["participant_id"], row["normalized_riot_id"],
        ) for row in canonical if row["match_id"] in match_ids],
    )
    return sum(1 for row in canonical if row["match_id"] in match_ids)


def migrate_ingestion_schema(connection) -> dict[str, int]:
    """Upgrade old SQLite/PostgreSQL read models without rebuilding them."""
    columns = _table_columns(connection, "match_participants")
    if "champion" not in columns:
        connection.execute("ALTER TABLE match_participants ADD COLUMN champion TEXT NOT NULL DEFAULT ''")
    if "participant_id" not in columns:
        connection.execute("ALTER TABLE match_participants ADD COLUMN participant_id INTEGER NOT NULL DEFAULT 0")
    if "normalized_riot_id" not in columns:
        connection.execute("ALTER TABLE match_participants ADD COLUMN normalized_riot_id TEXT NOT NULL DEFAULT ''")

    version_row = connection.execute(
        "SELECT value FROM source_metadata WHERE key=?", ("ingestion_schema_version",)
    ).fetchone()
    schema_current = bool(version_row and str(version_row["value"]) == "2")

    duplicate_matches = list(connection.execute(
        """SELECT account,match_id,MIN(id) keep_id,COUNT(*) copies
           FROM match_quality GROUP BY account,match_id HAVING COUNT(*) > 1"""
    ))
    for duplicate in duplicate_matches:
        connection.execute(
            "DELETE FROM match_quality WHERE account=? AND match_id=? AND id<>?",
            (duplicate["account"], duplicate["match_id"], duplicate["keep_id"]),
        )

    normalized_updates = []
    normalization_match_ids = set()
    for row in connection.execute(
        "SELECT match_id,puuid,riot_id FROM match_participants WHERE normalized_riot_id=''"
    ):
        normalization_match_ids.add(str(row["match_id"]))
        normalized = normalize_riot_id(str(row["riot_id"] or ""))
        if normalized:
            normalized_updates.append((normalized, row["match_id"], row["puuid"]))
    if schema_current and not normalization_match_ids:
        # The expensive raw-roster backfill is a one-time migration.  We still
        # revisit any legacy rows inserted later with default identity columns.
        connection.commit()
        return {
            "deduplicated_matches": sum(int(row["copies"]) - 1 for row in duplicate_matches),
            "normalized_participants": 0,
            "deduplicated_rosters": 0,
        }
    for match_id in normalization_match_ids:
        rows = []
        for row in connection.execute(
            "SELECT match_id,puuid,riot_id,team_id,win,champion,participant_id,normalized_riot_id "
            "FROM match_participants WHERE match_id=?", (match_id,)
        ):
            item = dict(row)
            item["normalized_riot_id"] = (
                normalize_riot_id(str(item.get("normalized_riot_id", "") or ""))
                or normalize_riot_id(str(item.get("riot_id", "") or ""))
            )
            rows.append(item)
        upsert_match_participants(connection, rows)

    roster_backfill: list[dict] = []
    for raw in connection.execute(
        """SELECT r.match_id,r.payload_json
           FROM riot_match_raw r
           WHERE EXISTS (SELECT 1 FROM match_quality m WHERE m.match_id=r.match_id)
             AND (
                 (SELECT COUNT(*) FROM match_participants p WHERE p.match_id=r.match_id) < 10
                 OR EXISTS (
                 SELECT 1 FROM match_participants p
                 WHERE p.match_id=r.match_id
                   AND (p.participant_id=0 OR p.normalized_riot_id='')
                 )
             )"""
    ):
        try:
            payload = json.loads(raw["payload_json"])
        except (TypeError, ValueError, json.JSONDecodeError):
            continue
        if isinstance(payload, Mapping):
            roster_backfill.extend(participant_rows_from_detail(payload, str(raw["match_id"])))
        if len(roster_backfill) >= 2000:
            upsert_match_participants(connection, roster_backfill)
            roster_backfill = []
    if roster_backfill:
        upsert_match_participants(connection, roster_backfill)

    affected_match_ids = {
        str(row["match_id"])
        for row in connection.execute(
            """SELECT match_id FROM match_participants
               WHERE normalized_riot_id<>''
               GROUP BY match_id,normalized_riot_id HAVING COUNT(*)>1"""
        )
    }
    affected_match_ids.update(
        str(row["match_id"])
        for row in connection.execute(
            """SELECT match_id FROM match_participants
               WHERE participant_id>0
               GROUP BY match_id,participant_id HAVING COUNT(*)>1"""
        )
    )
    for match_id in affected_match_ids:
        rows = [dict(row) for row in connection.execute(
            "SELECT match_id,puuid,riot_id,team_id,win,champion,participant_id,normalized_riot_id "
            "FROM match_participants WHERE match_id=?", (match_id,)
        )]
        upsert_match_participants(connection, rows)

    connection.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_match_quality_account_match "
        "ON match_quality(account,match_id)"
    )
    connection.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_match_participants_slot "
        "ON match_participants(match_id,participant_id) WHERE participant_id>0"
    )
    connection.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_match_participants_riot_id "
        "ON match_participants(match_id,normalized_riot_id) WHERE normalized_riot_id<>''"
    )
    connection.execute(
        "INSERT INTO source_metadata(key,value) VALUES(?,?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        ("ingestion_schema_version", "2"),
    )
    connection.commit()
    return {
        "deduplicated_matches": sum(int(row["copies"]) - 1 for row in duplicate_matches),
        "normalized_participants": len(normalized_updates),
        "deduplicated_rosters": len(affected_match_ids),
    }


def initialize_ingestion_database(db_path: Path) -> None:
    """Initialize and migrate a SQLite ingestion target before any import."""
    with _database_init_lock:
        storage = SQLiteStorage(db_path, SCHEMA_PATH)
        storage.initialize()
        connection = storage.connect()
        try:
            migrate_ingestion_schema(connection)
        finally:
            connection.close()


def record_verified_account_identity(
    connection,
    account: str,
    puuid: str,
    identity: Mapping[str, object],
    verified_at: str,
) -> None:
    """Persist requested and canonical Account-V1 Riot IDs as audited aliases."""
    display_ids = {str(account).strip()}
    response_id = f"{identity.get('gameName', '')}#{identity.get('tagLine', '')}"
    if normalize_riot_id(response_id):
        display_ids.add(response_id)
    rows = []
    for display_id in display_ids:
        normalized = normalize_riot_id(display_id)
        if normalized:
            rows.append((account, normalized, display_id, puuid, "riot_account_v1", verified_at))
    connection.executemany(
        """INSERT INTO riot_account_aliases
           (account,normalized_riot_id,display_riot_id,puuid,verification_source,verified_at)
           VALUES(?,?,?,?,?,?)
           ON CONFLICT(account,normalized_riot_id,puuid) DO UPDATE SET
             display_riot_id=excluded.display_riot_id,
             verification_source=excluded.verification_source,
             verified_at=excluded.verified_at""",
        rows,
    )


def record_verified_observed_identity(
    connection,
    account: str,
    result: NormalizedMatchResult,
    verified_at: str,
) -> bool:
    """Compatibility wrapper that persists one resolved identity edge."""
    if result.identity_resolution != "puuid_exact":
        return False
    participant = next((
        row for row in result.participants
        if str(row.get("puuid", "")) == result.observed_puuid
    ), None)
    if not participant:
        return False
    display_id = str(participant.get("riot_id", "") or "").strip()
    normalized = normalize_riot_id(display_id)
    if not normalized:
        return False
    discovery = VerifiedIdentityDiscovery(
        result.match_id, result.observed_puuid, normalized, display_id,
        "match_v5_verified_puuid",
    )
    return bool(record_verified_identity_discoveries(
        connection, account, [discovery], verified_at,
    ))


def record_verified_identity_discoveries(
    connection,
    account: str,
    discoveries: Iterable[VerifiedIdentityDiscovery],
    verified_at: str,
) -> int:
    """Persist fixed-point identity edges and their auditable source."""
    unique = {
        (discovery.normalized_riot_id, discovery.puuid): discovery
        for discovery in discoveries
        if discovery.normalized_riot_id and discovery.puuid
        and discovery.verification_source == "match_v5_verified_puuid"
    }
    if not unique:
        return 0
    if _table_exists(connection, "riot_identity_puuids"):
        owner = connection.execute("SELECT identity_id FROM riot_account_identities WHERE account=?", (account,)).fetchone()
        if owner:
            for puuid in {key[1] for key in unique}:
                other = connection.execute("SELECT identity_id FROM riot_identity_puuids WHERE puuid=?", (puuid,)).fetchone()
                if other and other["identity_id"] != owner["identity_id"]:
                    raise AccountIdentityConflict("Alias storico ambiguo: il PUUID appartiene a un'altra identità verificata")
    connection.executemany(
        """INSERT INTO riot_account_aliases
           (account,normalized_riot_id,display_riot_id,puuid,verification_source,verified_at)
           VALUES(?,?,?,?,?,?)
           ON CONFLICT(account,normalized_riot_id,puuid) DO UPDATE SET
             display_riot_id=excluded.display_riot_id,
             verification_source=excluded.verification_source,
             verified_at=excluded.verified_at""",
        [(
            account,
            discovery.normalized_riot_id,
            discovery.display_riot_id,
            discovery.puuid,
            discovery.verification_source,
            verified_at,
        ) for discovery in unique.values()],
    )
    connection.executemany(
        "INSERT INTO tracked_account_puuids(puuid,account) VALUES(?,?) "
        "ON CONFLICT(puuid) DO UPDATE SET account=excluded.account",
        [(puuid, account) for puuid in sorted({key[1] for key in unique})],
    )
    return len(unique)


def record_materialization_results(
    connection,
    account: str,
    results: Iterable[NormalizedMatchResult],
    materialized_ids: Iterable[str] = (),
) -> None:
    materialized = set(dedupe_match_ids(materialized_ids))
    attempted_at = datetime.now(timezone.utc).isoformat()
    rows = []
    for result in results:
        # `materialized` is valid only when the current resolver produced an
        # eligible row.  A historical match_quality row must never mask a
        # current identity failure or an ineligible raw payload.
        status = (
            "materialized"
            if result.status == "eligible" and result.match_id in materialized
            else result.status
        )
        rows.append((
            account, result.match_id, status, result.reason, result.identity_resolution,
            result.observed_puuid, attempted_at,
        ))
    connection.executemany(
        """INSERT INTO riot_match_materialization
           (account,match_id,status,reason,identity_resolution,participant_puuid,attempts,last_attempt_at)
           VALUES(?,?,?,?,?,?,1,?)
           ON CONFLICT(account,match_id) DO UPDATE SET
             status=excluded.status,
             reason=excluded.reason,
             identity_resolution=excluded.identity_resolution,
             participant_puuid=excluded.participant_puuid,
             attempts=riot_match_materialization.attempts+1,
             last_attempt_at=excluded.last_attempt_at""",
        rows,
    )


def remove_stale_analysis_rows(
    connection,
    account: str,
    results: Iterable[NormalizedMatchResult],
) -> int:
    """Remove analysis rows contradicted by a complete current raw result.

    Invalid/truncated payloads are deliberately excluded: absence of evidence
    is not enough to destroy an otherwise valid historical row.  Deletion is
    scoped to the exact account-match pairs evaluated in this run.
    """
    stale_ids = dedupe_match_ids(
        result.match_id for result in results
        if result.status in STALE_ANALYSIS_STATUSES
    )
    removed = 0
    for offset in range(0, len(stale_ids), 400):
        chunk = stale_ids[offset:offset + 400]
        placeholders = ",".join("?" for _ in chunk)
        existing = connection.execute(
            f"SELECT COUNT(*) value FROM match_quality "
            f"WHERE account=? AND match_id IN ({placeholders})",
            (account, *chunk),
        ).fetchone()
        removed += int(existing["value"])
        connection.execute(
            f"DELETE FROM match_quality WHERE account=? AND match_id IN ({placeholders})",
            (account, *chunk),
        )
    return removed


def materialization_coverage(connection, accounts: Iterable[str] = ()) -> dict[str, int]:
    """Return distinct raw/evaluated/eligible/analyzed account-match counts."""
    selected = set(accounts)
    raw_pairs: set[tuple[str, str]] = set()
    for row in connection.execute("SELECT account,match_ids_json FROM riot_match_list_raw"):
        account = str(row["account"])
        if selected and account not in selected:
            continue
        try:
            ids = json.loads(row["match_ids_json"])
        except (TypeError, ValueError, json.JSONDecodeError):
            ids = []
        raw_pairs.update((account, match_id) for match_id in dedupe_match_ids(ids))
    statuses = {}
    for row in connection.execute(
        "SELECT account,match_id,status FROM riot_match_materialization"
    ):
        pair = (str(row["account"]), str(row["match_id"]))
        if (not selected or pair[0] in selected) and pair in raw_pairs:
            statuses[pair] = str(row["status"])
    analyzed = {
        (str(row["account"]), str(row["match_id"]))
        for row in connection.execute("SELECT DISTINCT account,match_id FROM match_quality")
        if not selected or str(row["account"]) in selected
    }
    terminal = {"unsupported_map", "unsupported_queue", "invalid_payload"}
    return {
        "raw": len(raw_pairs),
        "evaluated": len(statuses),
        "eligible": sum(status not in terminal for status in statuses.values()),
        "analyzed": len(analyzed & raw_pairs),
        "identity_unresolved": sum(status == "identity_unresolved" for status in statuses.values()),
    }


def ingest_normalized_rows(rows: Iterable[Mapping[str, object]], db_path: Path, source: str) -> dict:
    unique: dict[tuple[str, str], Mapping[str, object]] = {}
    for row in rows:
        key = (str(row.get("account", "")).strip(), str(row.get("match_id", "")).strip())
        if all(key):
            unique[key] = row
    with NamedTemporaryFile("w", encoding="utf-8", suffix=".json", delete=False, dir=db_path.parent) as handle:
        json.dump({"source": source, "matches": list(unique.values())}, handle, ensure_ascii=False)
        temp_path = Path(handle.name)
    try:
        return ingest(temp_path, db_path)
    finally:
        temp_path.unlink(missing_ok=True)


def account_raw_matches(connection, account: str) -> tuple[list[str], dict[str, dict]]:
    """Read the union of retained IDs, including invalid details for retry status."""
    ids = []
    for row in connection.execute("SELECT match_ids_json FROM riot_match_list_raw WHERE account=?", (account,)):
        try:
            values = json.loads(row["match_ids_json"])
        except (TypeError, ValueError):
            values = []
        ids.extend(values if isinstance(values, list) else [])
    ids = dedupe_match_ids(ids)
    details = {}
    for offset in range(0, len(ids), 400):
        chunk = ids[offset:offset + 400]
        placeholders = ",".join("?" for _ in chunk)
        for row in connection.execute(
            f"SELECT match_id,payload_json FROM riot_match_raw WHERE match_id IN ({placeholders})", tuple(chunk),
        ):
            try:
                payload = json.loads(row["payload_json"])
            except (TypeError, ValueError):
                payload = {}
            details[str(row["match_id"])] = payload if isinstance(payload, dict) else {}
    return ids, details


def persist_account_materialization(connection, account: str, evidence: AccountIdentityEvidence,
                                    details: Mapping[str, Mapping[str, object]], source: str,
                                    participant_writer=None) -> dict:
    """Reconcile all projections as one unit within the caller's transaction."""
    results, _final_evidence, discoveries = resolve_account_matches_fixed_point(account, evidence, details)
    rows = [result.row for result in results if result.row]
    result = ingest_rows(connection, rows, source, derived=True)
    participants = [participant for item in results if item.row for participant in item.participants]
    (participant_writer or upsert_match_participants)(connection, participants)
    removed = remove_stale_analysis_rows(connection, account, results)
    materialized = {str(row["match_id"]) for row in connection.execute(
        "SELECT match_id FROM match_quality WHERE account=?", (account,),
    )}
    record_materialization_results(connection, account, results, materialized)
    trusted_discoveries = [
        item for item in discoveries
        if item.puuid in evidence.puuids
        and item.verification_source == "match_v5_verified_puuid"
    ]
    edge_count = record_verified_identity_discoveries(
        connection, account, trusted_discoveries, datetime.now(timezone.utc).isoformat(),
    )
    # Only PUUID-exact discoveries can reinforce the stable identity registry.
    identity = connection.execute("SELECT identity_id FROM riot_account_identities WHERE account=?", (account,)).fetchone()
    if identity:
        for puuid in sorted({item.puuid for item in trusted_discoveries}):
            connection.execute(
                "INSERT INTO riot_identity_puuids(puuid,identity_id) VALUES(?,?) "
                "ON CONFLICT(puuid) DO NOTHING", (puuid, identity["identity_id"]),
            )
    from playstyle_metrics import materialize_details
    playstyle = materialize_details(connection, details)
    return dict(result) | {
        "normalized_rows": len(rows), "attempted": len(results),
        "eligible": sum(item.status in {"eligible", "identity_unresolved"} for item in results),
        "identity_unresolved": sum(item.status == "identity_unresolved" for item in results),
        "invalid_payload": sum(item.status == "invalid_payload" for item in results),
        "removed_stale": removed, "identity_edges_persisted": edge_count,
        "playstyle_metrics_changed": playstyle["changed"],
    }


def normalized_rows_from_raw(
    account: str,
    puuid: str,
    raw_matches: dict[str, dict],
    verified_aliases: Iterable[str] = (),
) -> list[dict]:
    """Convert already downloaded Riot details into analysis rows.

    This deliberately does not require a fresh API call or a pre-existing
    match_quality row. A match can be valid and usable even before any manual
    performance annotation exists.
    """
    aliases = {normalize_riot_id(account), *(normalize_riot_id(alias) for alias in verified_aliases)}
    aliases.discard("")
    evidence = AccountIdentityEvidence(
        account,
        frozenset({str(puuid).strip()} if str(puuid).strip() else set()),
        frozenset(aliases),
    )
    results, _evidence, _discoveries = resolve_account_matches_fixed_point(
        account, evidence, raw_matches,
    )
    return [result.row for result in results if result.row]


def audit_raw_materialization(db_path: Path = DB_PATH) -> dict[str, int]:
    """Read-only projection of a raw reprocess; safe to run on the live DB."""
    resolved_path = Path(db_path).resolve(strict=True)
    connection = sqlite3.connect(f"{resolved_path.as_uri()}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    try:
        account_lists: dict[str, dict[str, object]] = {}
        for row in connection.execute(
            "SELECT account,puuid,match_ids_json FROM riot_match_list_raw ORDER BY account,puuid"
        ):
            try:
                ids = json.loads(row["match_ids_json"])
            except (TypeError, ValueError, json.JSONDecodeError):
                ids = []
            batch = account_lists.setdefault(str(row["account"]), {"puuids": set(), "ids": []})
            batch["puuids"].add(str(row["puuid"]))
            batch["ids"].extend(ids if isinstance(ids, list) else [])
        analyzed = {
            (str(row["account"]), str(row["match_id"]))
            for row in connection.execute("SELECT DISTINCT account,match_id FROM match_quality")
        }
        report = {
            "accounts": len(account_lists),
            "raw_known": 0,
            "raw_available": 0,
            "missing_raw": 0,
            "eligible": 0,
            "resolvable": 0,
            "already_analyzed": 0,
            "verified_analyzed": 0,
            "would_remove_stale": 0,
            "would_insert": 0,
            "would_persist_identity_edges": 0,
            "identity_unresolved": 0,
            "unsupported_map": 0,
            "unsupported_queue": 0,
            "invalid_payload": 0,
        }
        for account, batch in account_lists.items():
            ids = dedupe_match_ids(batch["ids"])
            report["raw_known"] += len(ids)
            report["already_analyzed"] += sum((account, match_id) in analyzed for match_id in ids)
            evidence = identity_evidence(connection, account, next(iter(batch["puuids"]), ""))
            evidence = AccountIdentityEvidence(
                account,
                frozenset(set(evidence.puuids) | set(batch["puuids"])),
                evidence.normalized_riot_ids,
            )
            details: dict[str, dict] = {}
            present_raw_ids: set[str] = set()
            for offset in range(0, len(ids), 400):
                chunk = ids[offset:offset + 400]
                if not chunk:
                    continue
                placeholders = ",".join("?" for _ in chunk)
                for raw in connection.execute(
                    f"SELECT match_id,payload_json FROM riot_match_raw WHERE match_id IN ({placeholders})",
                    tuple(chunk),
                ):
                    match_id = str(raw["match_id"])
                    present_raw_ids.add(match_id)
                    try:
                        payload = json.loads(raw["payload_json"])
                    except (TypeError, ValueError, json.JSONDecodeError):
                        report["invalid_payload"] += 1
                        continue
                    if isinstance(payload, dict):
                        details[match_id] = payload
                    else:
                        report["invalid_payload"] += 1
            report["raw_available"] += len(present_raw_ids)
            report["missing_raw"] += len(set(ids) - present_raw_ids)
            results, _final_evidence, discoveries = resolve_account_matches_fixed_point(
                account, evidence, details,
            )
            report["would_persist_identity_edges"] += len(discoveries)
            for result in results:
                if result.status in {"eligible", "identity_unresolved"}:
                    report["eligible"] += 1
                if result.row:
                    report["resolvable"] += 1
                    if (account, result.match_id) in analyzed:
                        report["verified_analyzed"] += 1
                    else:
                        report["would_insert"] += 1
                elif (
                    result.status in STALE_ANALYSIS_STATUSES
                    and (account, result.match_id) in analyzed
                ):
                    report["would_remove_stale"] += 1
                if result.status in {
                    "identity_unresolved", "unsupported_map", "unsupported_queue", "invalid_payload"
                }:
                    report[result.status] += 1
        report["projected_analyzed"] = (
            report["already_analyzed"]
            + report["would_insert"]
            - report["would_remove_stale"]
        )
        return report
    finally:
        connection.close()


def reprocess_raw_matches(db_path: Path = DB_PATH) -> dict[str, int]:
    """Rebuild raw-derived rows atomically, including legacy interrupted imports."""
    initialize_ingestion_database(db_path)
    storage = SQLiteStorage(db_path, SCHEMA_PATH)
    connection = storage.connect()
    try:
        pending_accounts = [str(row["account"]) for row in connection.execute(
            "SELECT DISTINCT account FROM riot_match_list_raw ORDER BY account",
        )]
    finally:
        connection.close()
    run = SyncRun(storage, "reprocess", pending_accounts)
    with metrics_scope("sync.reprocess", run_id=run.run_id), run:
        record_metric("sync_accounts", len(pending_accounts))
        return _reprocess_raw_matches(storage, run)


def _reprocess_raw_matches(storage, run: SyncRun) -> dict[str, int]:
    connection = storage.connect()
    totals = {key: 0 for key in (
        "accounts", "raw_known", "raw_available", "eligible", "identity_unresolved",
        "removed_stale", "identity_edges_persisted", "normalized_rows", "inserted", "updated", "skipped",
    )}
    try:
        connection.execute("BEGIN IMMEDIATE")
        reconcile_existing_identities(connection)
        accounts = [str(row["account"]) for row in connection.execute(
            "SELECT DISTINCT account FROM riot_match_list_raw ORDER BY account",
        )]
        run.replace_pending_accounts(connection, accounts)
        for account in accounts:
            ids, details = account_raw_matches(connection, account)
            evidence = identity_evidence(connection, account)
            with measure("sync.materialization"):
                result = persist_account_materialization(
                    connection, account, evidence, details, "riot_api_raw_reprocess",
                )
            run.record_result(connection, account, result | {
                "raw_known": len(ids), "raw_available": len(details),
                "raw_missing": len(set(ids) - set(details)),
            })
            totals["accounts"] += 1
            totals["raw_known"] += len(ids)
            totals["raw_available"] += len(details)
            for key in totals.keys() - {"accounts", "raw_known", "raw_available"}:
                totals[key] += int(result[key])
        connection.commit()
    except BaseException:
        connection.rollback()
        raise
    finally:
        connection.close()
    return totals


def _read_match_checkpoint(checkpoint: Path, account: str, puuid: str) -> dict:
    """A checkpoint is a disposable cache; corruption cannot prevent recovery."""
    try:
        state = json.loads(checkpoint.read_text(encoding="utf-8"))
    except (FileNotFoundError, UnicodeDecodeError, ValueError):
        return {}
    if not isinstance(state, dict):
        return {}
    if state.get("account") != account or state.get("puuid") != puuid:
        return {}
    ids, raw = state.get("ids"), state.get("raw_matches")
    if not isinstance(ids, list) or not isinstance(raw, dict):
        return {}
    if any(not isinstance(match_id, str) or not match_id.strip() for match_id in ids):
        return {}
    if any(not isinstance(value, Mapping) for value in raw.values()):
        return {}
    completed = _as_int(state.get("completed"), -1)
    if completed < 0 or completed > len(ids):
        return {}
    pending = state.get("pending_match_ids", [])
    if not isinstance(pending, list):
        return {}
    known_ids = set(ids)
    if any(
        not isinstance(match_id, str)
        or not match_id.strip()
        or match_id not in known_ids
        for match_id in pending
    ):
        return {}
    # Legacy checkpoints tracked only a batch counter. Any listed match that
    # has no stored Mapping is pending regardless of that counter.
    state["pending_match_ids"] = dedupe_match_ids([
        *pending,
        *(match_id for match_id in ids if match_id not in raw),
    ])
    completed_prefix = 0
    for match_id in ids:
        if match_id not in raw:
            break
        completed_prefix += 1
    state["completed"] = completed_prefix
    return state


def _write_match_checkpoint(checkpoint: Path, state: Mapping[str, object]) -> None:
    """Replace the cache only after its complete JSON is durable on disk."""
    pending = None
    try:
        with NamedTemporaryFile("w", encoding="utf-8", delete=False,
                                dir=checkpoint.parent, prefix=checkpoint.name + ".", suffix=".tmp") as handle:
            pending = Path(handle.name)
            json.dump(state, handle, ensure_ascii=False)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(pending, checkpoint)
    finally:
        if pending is not None:
            pending.unlink(missing_ok=True)


def match_rows(
    account: str,
    puuid: str,
    api_key: str,
    checkpoint: Path,
    evidence: AccountIdentityEvidence | None = None,
) -> tuple[list[dict], list[dict], dict[str, dict], list[str]]:
    state = _read_match_checkpoint(checkpoint, account, puuid)
    checkpoint_ids = dedupe_match_ids(state.get("ids", []))
    current_ids: list[str] = []
    start = 0
    while True:
        batch = riot_get(f"/lol/match/v5/matches/by-puuid/{quote(puuid, safe='')}/ids?start={start}&count=100", api_key)
        if not isinstance(batch, list):
            raise RuntimeError(f"Risposta match IDs inattesa per {account}")
        current_ids = dedupe_match_ids([*current_ids, *batch])
        if len(batch) < 100:
            break
        start += len(batch)
    # Always refresh the provider list, but retain checkpoint-only IDs so a
    # detail that previously failed remains retryable after it ages out.
    ids = dedupe_match_ids([*current_ids, *checkpoint_ids])

    raw_matches: dict[str, dict] = dict(state.get("raw_matches", {}))
    evidence = evidence or AccountIdentityEvidence(
        account,
        frozenset({str(puuid).strip()}),
        frozenset({normalize_riot_id(account)} - {""}),
    )

    # Rebuild normalized rows from checkpointed raw details. A checkpoint
    # created by an older resolver must not permanently preserve a miss.
    pending_match_ids = dedupe_match_ids([
        *state.get("pending_match_ids", []),
        *(match_id for match_id in ids if match_id not in raw_matches),
    ])
    pending_set = set(pending_match_ids)
    for offset in range(0, len(pending_match_ids), 100):
        for match_id in pending_match_ids[offset:offset + 100]:
            detail_path = f"/lol/match/v5/matches/{quote(match_id, safe='')}"
            try:
                detail = riot_get(detail_path, api_key)
            except RiotAPIError as error:
                if error.status_code != 404 or error.path != detail_path:
                    raise
                print(
                    f"Riot match detail pending for {match_id}: {error}",
                    file=sys.stderr,
                )
                continue
            if not isinstance(detail, Mapping):
                print(
                    f"Riot match detail pending for {match_id}: unexpected response",
                    file=sys.stderr,
                )
                continue
            raw_matches[match_id] = detail
            pending_set.discard(match_id)
        remaining_pending = [match_id for match_id in ids if match_id in pending_set]
        completed = 0
        for match_id in ids:
            if match_id not in raw_matches:
                break
            completed += 1
        pass_results, _pass_evidence, _pass_discoveries = resolve_account_matches_fixed_point(
            account, evidence, raw_matches,
        )
        rows = [result.row for result in pass_results if result.row]
        participants = canonical_participant_rows(
            participant
            for result in pass_results if result.row
            for participant in result.participants
        )
        _write_match_checkpoint(checkpoint, {
            "account": account, "puuid": puuid, "ids": ids, "completed": completed,
            "pending_match_ids": remaining_pending,
            "rows": rows, "participants": participants, "raw_matches": raw_matches,
        })
    final_results, _final_evidence, _discoveries = resolve_account_matches_fixed_point(
        account, evidence, raw_matches,
    )
    rows = [result.row for result in final_results if result.row]
    participants = canonical_participant_rows(
        participant
        for result in final_results if result.row
        for participant in result.participants
    )
    return rows, participants, raw_matches, ids


def _sync(api_key: str | list[str], db_path: Path = DB_PATH, accounts: tuple[str, ...] = TRACKED_ACCOUNTS,
          *, run: SyncRun | None = None) -> dict[str, object]:
    keys = api_key if isinstance(api_key, list) else [api_key]
    configure_api_keys(keys)
    initialize_ingestion_database(db_path)
    storage = SQLiteStorage(db_path, SCHEMA_PATH)
    puuids: list[tuple[str, str]] = []
    unresolved: list[str] = []
    inserted = updated = skipped = fetched_matches = removed_stale = identity_edges_persisted = 0
    def _fetch_account(account: str, account_key: str) -> tuple[str, str, dict, list[dict], list[dict], dict[str, dict], list[str]]:
        game_name, tag_line = riot_id(account)
        identity = riot_get(f"/riot/account/v1/accounts/by-riot-id/{quote(game_name, safe='')}/{quote(tag_line, safe='')}", account_key)
        if not isinstance(identity, Mapping):
            raise RuntimeError(f"Risposta Account-V1 inattesa per {account}")
        puuid = str(identity["puuid"])
        connection = storage.connect()
        try:
            evidence = identity_evidence(connection, account, puuid, identity)
        finally:
            connection.close()
        safe_name = checkpoint_stem(account)
        checkpoint = db_path.with_name(f".{db_path.stem}.riot-{safe_name}.checkpoint.json")
        rows, participants, raw_matches, ids = match_rows(
            account, puuid, account_key, checkpoint, evidence,
        )
        return account, puuid, identity, rows, participants, raw_matches, ids

    def fetch_account(account: str, account_key: str):
        with metrics_scope("sync.historical.account_fetch", run_id=run.run_id if run else None):
            if run is not None:
                with run.account_attempt(account):
                    return _fetch_account(account, account_key)
            else:
                return _fetch_account(account, account_key)

    # Every sync must refresh the account match lists.  The normalized import
    # remains idempotent, so already-known matches are skipped without making
    # an account permanently invisible to future syncs.
    pending_accounts = []
    seen_accounts = set()
    for account in accounts:
        key = normalize_riot_id(account) or str(account).strip().casefold()
        if key and key not in seen_accounts:
            seen_accounts.add(key)
            pending_accounts.append(str(account).strip())
    assignments = [(account, keys[index % len(keys)]) for index, account in enumerate(pending_accounts)]

    def commit_account(account: str, puuid: str, identity: dict, rows: list[dict], participants: list[dict], raw_matches: dict[str, dict], ids: list[str]) -> tuple[int, int, int, int, int]:
        requested_account = account
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
            connection.execute("INSERT INTO riot_accounts_raw(puuid,account,game_name,tag_line,fetched_at,payload_json) VALUES(?,?,?,?,?,?) ON CONFLICT(puuid) DO UPDATE SET account=excluded.account,game_name=excluded.game_name,tag_line=excluded.tag_line,fetched_at=excluded.fetched_at,payload_json=excluded.payload_json",
                               (puuid, account, identity.get("gameName", ""), identity.get("tagLine", ""), fetched_at, json.dumps(identity, ensure_ascii=False)))
            connection.execute("INSERT INTO riot_match_list_raw(account,puuid,fetched_at,match_ids_json) VALUES(?,?,?,?) ON CONFLICT(account,puuid) DO UPDATE SET fetched_at=excluded.fetched_at,match_ids_json=excluded.match_ids_json",
                               (account, puuid, fetched_at, json.dumps(merged_ids, ensure_ascii=False)))
            connection.executemany("INSERT INTO riot_match_raw(match_id,routing_region,fetched_at,payload_json) VALUES(?,?,?,?) ON CONFLICT(match_id) DO UPDATE SET routing_region=excluded.routing_region,fetched_at=excluded.fetched_at,payload_json=excluded.payload_json",
                                  [(match_id, MATCH_ROUTING, fetched_at, json.dumps(payload, ensure_ascii=False)) for match_id, payload in raw_matches.items()])
            connection.execute("INSERT INTO tracked_account_puuids(puuid,account) VALUES(?,?) ON CONFLICT(puuid) DO UPDATE SET account=excluded.account", (puuid, account))
            record_verified_account_identity(connection, account, puuid, identity, fetched_at)
            _all_ids, all_details = account_raw_matches(connection, account)
            with measure("sync.materialization"):
                result = persist_account_materialization(
                    connection, account, identity_evidence(connection, account, puuid, identity), all_details, "riot_api",
                )
            if run is not None:
                run.record_result(connection, requested_account, result | {
                    "fetched_matches": len(rows), "raw_known": len(_all_ids),
                    "raw_available": len(all_details), "raw_missing": len(set(_all_ids) - set(all_details)),
                }, resolved_account=account)
            connection.commit()
        except BaseException:
            connection.rollback()
            raise
        finally:
            connection.close()
        checkpoint = db_path.with_name(f".{db_path.stem}.riot-{checkpoint_stem(requested_account)}.checkpoint.json")
        checkpoint_state = _read_match_checkpoint(checkpoint, requested_account, puuid)
        if not checkpoint_state.get("pending_match_ids"):
            checkpoint.unlink(missing_ok=True)
        return tuple(int(result[key]) for key in ("inserted", "skipped", "removed_stale", "identity_edges_persisted", "updated"))

    if assignments:
        with ThreadPoolExecutor(max_workers=min(len(keys), len(assignments))) as executor:
            futures = {executor.submit(fetch_account, account, key): account for account, key in assignments}
            for future in as_completed(futures):
                account = futures[future]
                try:
                    resolved_account, puuid, identity, rows, participants, raw_matches, ids = future.result()
                except RiotAPIError as error:
                    if (
                        error.status_code == 404
                        and error.path.startswith("/riot/account/v1/")
                    ):
                        unresolved.append(account)
                        continue
                    raise
                puuids.append((puuid, resolved_account))
                account_inserted, account_skipped, account_removed_stale, account_identity_edges, account_updated = commit_account(
                    resolved_account, puuid, identity, rows, participants, raw_matches, ids,
                )
                inserted += account_inserted
                updated += account_updated
                skipped += account_skipped
                removed_stale += account_removed_stale
                identity_edges_persisted += account_identity_edges
                fetched_matches += len(rows)
                print(json.dumps({
                    "account_committed": resolved_account,
                    "fetched_matches": len(rows),
                    "inserted": account_inserted,
                    "updated": account_updated,
                    "skipped": account_skipped,
                    "removed_stale": account_removed_stale,
                    "identity_edges_persisted": account_identity_edges,
                }, ensure_ascii=False), flush=True)
    return {"accounts": len(pending_accounts), "resolved_accounts": len(puuids), "unresolved_accounts": len(unresolved),
            "fetched_matches": fetched_matches, "inserted": inserted, "updated": updated, "skipped": skipped,
            "removed_stale": removed_stale,
            "identity_edges_persisted": identity_edges_persisted,
            "unresolved": unresolved}


def sync(api_key: str | list[str], db_path: Path = DB_PATH,
         accounts: tuple[str, ...] = TRACKED_ACCOUNTS) -> dict[str, object]:
    """Run a historical sync with a continuously refreshed process marker."""
    initialize_ingestion_database(db_path)
    # The journal, worker assignment and marker describe the same exact scope.
    pending_accounts, seen_accounts = [], set()
    for account in accounts:
        identity_key = normalize_riot_id(account) or str(account).strip().casefold()
        if identity_key and identity_key not in seen_accounts:
            pending_accounts.append(str(account).strip())
            seen_accounts.add(identity_key)
    accounts = tuple(pending_accounts)
    storage = SQLiteStorage(db_path, SCHEMA_PATH)
    marker = SyncActivityMarker(db_path, len(accounts))
    marker.start()
    try:
        with metrics_scope("sync.historical", run_id=marker.run_id), SyncRun(
            storage, "historical", accounts, run_id=marker.run_id,
        ) as run:
            record_metric("sync_accounts", len(accounts))
            return _sync(api_key, db_path, accounts, run=run)
    finally:
        marker.close()


def main() -> None:
    configure_logging()
    parser = argparse.ArgumentParser(description="Importa le partite Riot di Summoner's Rift nel database Champion Fit")
    parser.add_argument("--api-key", default=os.environ.get("RIOT_API_KEY"), help="Riot API key; preferibile RIOT_API_KEY")
    parser.add_argument("--api-keys", default=os.environ.get("RIOT_API_KEYS"), help="Più chiavi separate da virgola o punto e virgola")
    parser.add_argument("--db", type=Path, default=DB_PATH)
    parser.add_argument("--account", action="append", help="Controlla solo questo Riot ID; ripetibile")
    parser.add_argument("--reprocess-raw", action="store_true", help="Analizza tutti i dettagli Riot già presenti localmente")
    parser.add_argument("--dry-run", action="store_true", help="Con --reprocess-raw, calcola soltanto l'impatto in sola lettura")
    args = parser.parse_args()
    if args.reprocess_raw:
        operation = audit_raw_materialization if args.dry_run else reprocess_raw_matches
        print(json.dumps(operation(args.db), ensure_ascii=False))
        return
    if args.dry_run:
        raise SystemExit("--dry-run richiede --reprocess-raw")
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
