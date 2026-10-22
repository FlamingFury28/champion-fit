"""Immutable chosen plans and progress from the local archive. No network I/O."""
from __future__ import annotations

from collections import Counter
from datetime import datetime, timezone
from hashlib import sha256
import json
from uuid import UUID

from analysis_runtime import parse_time
from playstyle_analysis import canonical_queue


def plan_fingerprint(plan, params):
    # Include the effective context and allocation the user actually reviewed.
    value = {"budget": plan["budget_total"], "context": plan["context"],
             "revision": plan["algorithm_revision"],
             "companions": params.get("companion_account", []),
             "companion_mode": params.get("companion_mode", []),
             "allocations": [(item["champion"], item["role"], item["account_allocations"])
                             for item in plan["items"]]}
    return sha256(json.dumps(value, sort_keys=True, ensure_ascii=True).encode()).hexdigest()


def valid_plan_id(value):
    if not isinstance(value, str):
        raise ValueError("Identificativo del piano non valido")
    try:
        if str(UUID(value)) != value:
            raise ValueError()
    except (ValueError, AttributeError):
        raise ValueError("Identificativo del piano non valido") from None
    return value


def load_plan(connection, plan_id):
    row = connection.execute("SELECT snapshot_json FROM training_plan_runs WHERE id=?",
                             (valid_plan_id(plan_id),)).fetchone()
    return json.loads(row["snapshot_json"]) if row else None


def pin_account(connection, account):
    row = connection.execute("SELECT identity_id FROM riot_account_identities WHERE account=?",
                             (account,)).fetchone()
    return {"account": account, "identity_id": row["identity_id"] if row else None}


def resolve_account(connection, pin):
    if not pin["identity_id"]:
        return pin["account"]
    row = connection.execute("SELECT account FROM riot_account_identities WHERE identity_id=?",
                             (pin["identity_id"],)).fetchone()
    return row["account"] if row else None


def save_plan(connection, plan_id, plan, params, *, now=None):
    """Caller owns the transaction and ensures the preview fingerprint matches."""
    started = now or datetime.now(timezone.utc)
    accounts = list(plan["context"]["accounts"])
    pins = {name: pin_account(connection, name) for name in accounts}
    items = [{"champion": item["champion"], "role": item["role"],
              "accounts": [{**pins[entry["account"]], "planned": entry["games"]}
                           for entry in item["account_allocations"] if entry["games"] > 0]}
             for item in plan["items"] if item["allocation_games"] > 0]
    if not items:
        raise ValueError("Il piano non contiene partite assegnate")
    baseline = {name: [] for name in accounts}
    for row in connection.execute("SELECT account,match_id FROM match_quality"):
        if row["account"] in baseline:
            baseline[row["account"]].append(row["match_id"])
    snapshot = {"id": valid_plan_id(plan_id), "started_at": started.isoformat(),
                "fingerprint": plan["plan_fingerprint"], "context": plan["context"],
                "budget_total": plan["budget_total"], "items": items, "baseline": baseline,
                "companions": [pin_account(connection, name) for name in params.get("companion_account", [])]
                              if plan["context"]["companion_filter_active"] else [],
                "companion_mode": params.get("companion_mode", [""])[0]}
    connection.execute("INSERT INTO training_plan_runs(id,started_at,snapshot_json) VALUES(?,?,?)",
                       (plan_id, snapshot["started_at"], json.dumps(snapshot, ensure_ascii=True)))
    return snapshot


def progress(connection, snapshot, *, companion_filter, now=None):
    """Count each account/match once; old backfills and reimports never advance a plan."""
    now = now or datetime.now(timezone.utc)
    start = parse_time(snapshot["started_at"])
    pins = {entry["account"]: entry for item in snapshot["items"] for entry in item["accounts"]}
    resolved = {name: resolve_account(connection, pin) for name, pin in pins.items()}
    companions = [resolve_account(connection, pin) for pin in snapshot["companions"]]
    suspended = {row["account"] for row in connection.execute(
        "SELECT i.account FROM riot_account_identities i JOIN riot_identity_policy p "
        "ON p.identity_id=i.identity_id WHERE p.state='exception' UNION "
        "SELECT m.account FROM riot_match_materialization m JOIN riot_identity_policy p "
        "ON p.puuid=m.participant_puuid WHERE p.state='exception'")}
    unavailable = [name for name, current in resolved.items() if not current or current in suspended]
    companion_unavailable = any(not name or name in suspended for name in companions)
    names = sorted({name for name in resolved.values() if name and name not in suspended})
    counts = Counter()
    if names and not companion_unavailable:
        params = {"account": names, "companion_account": companions,
                  "companion_mode": [snapshot["companion_mode"]]}
        extra_sql, values = companion_filter(params, "m.match_id")
        placeholders = ','.join('?' for _ in names)
        baseline = {resolved[name]: set(ids) for name, ids in snapshot["baseline"].items() if name in resolved}
        seen = set()
        for row in connection.execute(
            f"SELECT m.account,m.match_id,m.date,m.champion,m.role,m.queue FROM match_quality m "
            f"WHERE m.account IN ({placeholders})" + extra_sql, [*names, *values],
        ):
            key = (row["account"], row["match_id"])
            when = parse_time(row["date"])
            if key in seen or row["match_id"] in baseline.get(row["account"], set()):
                continue
            if not when or not start < when <= now:
                continue
            if snapshot["context"]["queue"] != "all" and canonical_queue(row["queue"]) != snapshot["context"]["queue"]:
                continue
            seen.add(key)
            role = "SUPPORT" if row["role"] == "UTILITY" else row["role"]
            counts[(row["account"], row["champion"], role)] += 1
    items = []
    for item in snapshot["items"]:
        entries = []
        for entry in item["accounts"]:
            played = counts[(resolved[entry["account"]], item["champion"], item["role"])]
            completed = min(entry["planned"], played)
            entries.append({"account": resolved[entry["account"]] or entry["account"],
                            "planned": entry["planned"], "completed": completed,
                            "remaining": entry["planned"] - completed, "extra": played - completed})
        items.append({"champion": item["champion"], "role": item["role"], "accounts": entries,
                      **{key: sum(entry[key] for entry in entries) for key in ("planned", "completed", "remaining", "extra")}})
    return {"id": snapshot["id"], "started_at": snapshot["started_at"],
            "fingerprint": snapshot["fingerprint"], "budget_total": snapshot["budget_total"],
            "queue": snapshot["context"]["queue"], "accounts": names,
            "companions": [name for name in companions if name], "companion_mode": snapshot["companion_mode"],
            "unavailable_accounts": unavailable, "companion_unavailable": companion_unavailable,
            "items": items, **{key: sum(item[key] for item in items) for key in ("planned", "completed", "remaining", "extra")}}
