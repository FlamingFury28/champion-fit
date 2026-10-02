"""Read-only request context for observed preferences, independent of Beta models."""
from __future__ import annotations

from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone

from algorithm_settings import current_settings
from analysis_runtime import parse_time
from champion_taxonomy import canonical_champion, champion_entry, load_catalog
from playstyle_analysis import canonical_queue

ROLES = {"TOP", "JUNGLE", "MIDDLE", "BOTTOM", "SUPPORT"}


def _latest_matches_per_account(rows, maximum):
    grouped = defaultdict(list)
    for row in rows:
        played_at = parse_time(row["date"])
        grouped[row["account"]].append((
            (played_at.timestamp() if played_at else float("-inf"), str(row["match_id"])), row,
        ))
    return [
        row
        for account_rows in grouped.values()
        for _, row in sorted(account_rows, key=lambda item: item[0], reverse=True)[:maximum]
    ]


def _candidate_for_role(
    payload, champion_id, rows, lifetime_rows, accounts, feedback_items,
    settings, role, *, family_size, meaningful_delta, family_alpha,
):
    candidate = next((item for item in [*payload["known"], *payload["discover"]]
                      if item["champion"] == champion_id), None)
    if candidate is not None:
        return candidate
    entry = champion_entry(champion_id)
    observed = [row for row in rows if row["champion"] == champion_id]
    historical = [row for row in lifetime_rows if row["champion"] == champion_id]
    if entry is None and not historical:
        return None
    votes = [item["preference"] for item in feedback_items
             if item["champion"] == champion_id and item["role"] == role]
    from observed_performance import observed_performance
    return {
        "champion": champion_id, "name": entry["name"] if entry else champion_id,
        "role": role, "icon_url": f"https://ddragon.leagueoflegends.com/cdn/{load_catalog()['source_version']}/img/champion/{champion_id}.png" if entry else None,
        "kind": "familiar" if historical else "discovery", "preference_score": None, "similarity": None,
        "games": len({row["match_id"] for row in observed}), "account_count": len({row["account"] for row in observed}),
        "selected_account_count": len(accounts), "source_champions": [],
        "reasons": ["Escluso dalle proposte per una preferenza dichiarata." if "dislike" in votes else
                    "Già giocato nello storico selezionato, ma non nel contesto corrente." if historical else
                    "Nessuna affinità sufficiente per proporlo dal profilo attuale."],
        "feedback": "dislike" if "dislike" in votes else "like" if "like" in votes else None,
        "performance": observed_performance(rows, observed, accounts,
            confidence=float(settings["confidence"]), family_size=family_size,
            meaningful_delta=meaningful_delta, family_alpha=family_alpha),
    }


def _trial_plan(known, discover, budget):
    items = []
    if budget and known:
        item = known[0]
        items.append({"champion": item["champion"], "role": item["role"], "games": 1,
                      "reason": "Una partita per confermare una preferenza già osservata."})
    remaining = max(int(budget) - len(items), 0)
    for item in discover[:remaining]:
        items.append({"champion": item["champion"], "role": item["role"], "games": 1,
                      "reason": "Una partita esplorativa basata su tag condivisi."})
    return {"budget": min(int(budget), len(items)), "items": items}


def recommendation_data(connection, params, *, account_filter, companion_filter):
    """Select an explicit context once, retaining lifetime history for novelty checks."""
    from preference_recommendations import build_recommendations
    from account_identity import canonical_account_name
    from recommendation_feedback import (
        all_scoped_accounts, read_feedback, resolved_scoped_accounts,
    )
    configured = current_settings()
    settings = configured["recommendations"]
    evidence_settings = configured["evidence"]
    meaningful_delta = float(evidence_settings["meaningful_delta"])
    family_alpha = float(evidence_settings["family_alpha"])
    canonical_names = {}

    def canonical_account(value):
        account = str(value or "").strip()
        if account not in canonical_names:
            canonical_names[account] = canonical_account_name(connection, account)
        return canonical_names[account]

    requested_accounts = params.get("account", [])
    account_candidates = requested_accounts or all_scoped_accounts(connection)
    accounts_by_key = {}
    for account in account_candidates:
        canonical = canonical_account(account)
        if canonical:
            accounts_by_key.setdefault(canonical.casefold(), canonical)
    accounts = sorted(accounts_by_key.values(), key=str.casefold)
    resolved_accounts = (
        resolved_scoped_accounts(connection, requested_accounts)
        if requested_accounts else accounts
    )
    resolved_account_keys = {account.casefold() for account in resolved_accounts}
    unresolved_accounts = [
        account for account in accounts
        if account.casefold() not in resolved_account_keys
    ]
    raw_accounts = [str(row["account"]) for row in connection.execute(
        "SELECT DISTINCT account FROM match_quality ORDER BY account"
    )]
    raw_owners = [
        account for account in raw_accounts
        if canonical_account(account).casefold() in resolved_account_keys
    ]
    sql, values = account_filter(raw_owners, "m.account")
    if not raw_owners:
        sql, values = " AND 1=0", []
    # One compact fact read; no raw payload, timeline or attributed outcome.
    lifetime = [dict(row) for row in connection.execute(
        "SELECT m.account,m.match_id,m.champion,m.role,m.queue,m.date,m.win,m.duration_minutes "
        "FROM match_quality m WHERE 1=1" + sql, values)]
    suspended = {canonical_account(r["account"]) for r in connection.execute(
        "SELECT i.account FROM riot_account_identities i JOIN riot_identity_policy p "
        "ON p.identity_id=i.identity_id WHERE p.state='exception' UNION "
        "SELECT m.account FROM riot_match_materialization m JOIN riot_identity_policy p "
        "ON p.puuid=m.participant_puuid WHERE p.state='exception'")}
    now = parse_time(params.get("as_of", [None])[0]) or datetime.now(timezone.utc)
    requested_days = params.get("days", [None])[0]
    if requested_days is not None:
        days = str(requested_days)
        if days == "0":
            days = "all"
        if days not in {"90", "180", "365", "all"}:
            raise ValueError("Periodo non valido: scegli 90, 180, 365 giorni o tutto lo storico")
        period = {"value": 0 if days == "all" else int(days), "unit": "days"}
    else:
        configured_period = settings["period"]
        period = {"value": int(configured_period["value"]), "unit": configured_period["unit"]}
        days = str(period["value"]) if period["unit"] == "days" and period["value"] else "all"
    cutoff = (
        now.replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(days=period["value"])
        if period["unit"] == "days" and period["value"] > 0 else None
    )
    # Future facts are never allowed to inform either preferences or novelty.
    for row in lifetime:
        row["account"] = accounts_by_key[canonical_account(row["account"]).casefold()]
    lifetime = [r for r in lifetime if r["account"] not in suspended
                and (parse_time(r["date"]) is None or parse_time(r["date"]) <= now)]
    for row in lifetime:
        row["champion"] = canonical_champion(row["champion"])
        row["queue"] = canonical_queue(row["queue"])
        row["role"] = {"UTILITY": "SUPPORT", "MID": "MIDDLE", "ADC": "BOTTOM"}.get(row["role"], row["role"])
    unique = {}
    for row in lifetime:
        key = (row["account"], row["match_id"])
        if key in unique and row != unique[key]:
            raise ValueError("Osservazioni duplicate incompatibili per account e partita")
        unique[key] = row
    lifetime = list(unique.values())
    eligible = [r for r in lifetime if not cutoff or (parse_time(r["date"]) is not None and parse_time(r["date"]) >= cutoff)]
    companion_sql, companion_values = companion_filter(params, "m.match_id")
    if companion_sql:
        allowed = {r["match_id"] for r in connection.execute(
            "SELECT DISTINCT m.match_id FROM match_quality m WHERE 1=1" + sql + companion_sql,
            [*values, *companion_values])}
        eligible = [r for r in eligible if r["match_id"] in allowed]
    role = str(params.get("role", [""])[0]).strip().upper()
    role = {"UTILITY": "SUPPORT", "MID": "MIDDLE", "ADC": "BOTTOM"}.get(role, role)
    all_roles = role in {"", "ALL"}
    automatic_role = role == "AUTO"
    if not all_roles and not automatic_role and role not in ROLES:
        raise ValueError("Ruolo non valido")
    queue = str(params.get("queue", [settings["queue"]])[0])
    queue_mode = queue.strip().lower()
    automatic_queue = queue_mode in {"", "auto"}
    all_queues = queue_mode == "all"
    if not automatic_queue and not all_queues:
        queue = canonical_queue(queue)
        if not queue.isdigit() or not 0 < int(queue) <= 9999:
            raise ValueError("Scegli una modalità concreta")
    matching = [r for r in eligible if r["role"] in ROLES
                and (all_roles or automatic_role or r["role"] == role)
                and (automatic_queue or all_queues or r["queue"] == queue)]
    pairs = Counter((r["queue"], r["role"]) for r in matching)
    chosen = min(pairs, key=lambda pair: (-pairs[pair], pair)) if pairs else None
    feedback = read_feedback(connection, accounts)
    if automatic_role:
        positive_roles = Counter(r["role"] for r in feedback["items"] if r["preference"] == "like")
        observed_roles = Counter(r["role"] for r in matching)
        observed_role = (
            chosen[1] if automatic_queue and chosen
            else min(observed_roles, key=lambda r: (-observed_roles[r], r)) if observed_roles
            else None
        )
        role = observed_role or (min(positive_roles, key=lambda r: (-positive_roles[r], r)) if positive_roles else "MIDDLE")
    if automatic_queue:
        queue = chosen[0] if chosen else "420"
    context_rows = [
        r for r in matching
        if (all_queues or r["queue"] == queue)
        and (all_roles or r["role"] == role)
    ]
    if period["unit"] == "games" and period["value"] > 0:
        context_rows = _latest_matches_per_account(context_rows, period["value"])
    limit = int(settings["limit"])
    candidate_id = canonical_champion(params.get("champion", [""])[0])
    trial_budget = int(settings["trial_budget"])
    if all_roles:
        performance_family_size = max(
            1, len({(row["champion"], row["role"]) for row in context_rows})
        )
        role_payloads = {}
        for selected_role in sorted(ROLES):
            role_rows = [row for row in context_rows if row["role"] == selected_role]
            role_payloads[selected_role] = build_recommendations(
                role_rows, lifetime, accounts, selected_role, feedback=feedback["items"],
                limit=len(load_catalog()["champions"]), recent_games=None,
                trial_budget=0, confidence=float(settings["confidence"]),
                performance_family_size=performance_family_size,
                meaningful_delta=meaningful_delta, family_alpha=family_alpha,
                ranking_scope_rows=context_rows,
            )
        payload = build_recommendations(
            context_rows, lifetime, accounts, "ALL", feedback=feedback["items"], limit=0,
            recent_games=None, trial_budget=0, confidence=float(settings["confidence"]),
            include_performance=False, meaningful_delta=meaningful_delta,
            family_alpha=family_alpha,
        )
        known = [item for role_payload in role_payloads.values() for item in role_payload["known"]]
        discover = [item for role_payload in role_payloads.values() for item in role_payload["discover"]]
        known.sort(key=lambda item: (
            item["feedback"] != "like",
            -(item["preference_score"] if item["preference_score"] is not None else -1),
            -item["games"], item["name"].casefold(), item["champion"], item["role"],
        ))
        discover.sort(key=lambda item: (
            -item.get("priority_score", item["similarity"]), -item["similarity"],
            item["name"].casefold(), item["champion"], item["role"],
        ))
        payload["known"] = known[:limit]
        payload["discover"] = discover[:limit]
        payload["trial_plan"] = _trial_plan(payload["known"], payload["discover"], trial_budget)
        if candidate_id:
            entry = champion_entry(candidate_id)
            candidate_roles = set(entry.get("roles", [])) if entry else set()
            candidate_roles.update(row["role"] for row in context_rows if row["champion"] == candidate_id)
            candidate_roles.update(row["role"] for row in lifetime if row["champion"] == candidate_id)
            candidate_roles.update(item["role"] for item in feedback["items"] if item["champion"] == candidate_id)
            candidates = []
            for selected_role in sorted(candidate_roles & ROLES):
                role_rows = [row for row in context_rows if row["role"] == selected_role]
                candidate = _candidate_for_role(
                    role_payloads[selected_role], candidate_id, role_rows, lifetime,
                    accounts, feedback["items"], settings, selected_role,
                    family_size=performance_family_size,
                    meaningful_delta=meaningful_delta, family_alpha=family_alpha,
                )
                if candidate is not None:
                    candidates.append(candidate)
            if not candidates and entry is None:
                raise ValueError("Campione non presente nel catalogo o nello storico")
            payload["candidate"] = None
            payload["candidates"] = candidates
    else:
        rows = context_rows
        performance_family_size = max(1, len({row["champion"] for row in rows}))
        payload = build_recommendations(rows, lifetime, accounts, role, feedback=feedback["items"],
            limit=len(load_catalog()["champions"]), recent_games=None,
            trial_budget=trial_budget, confidence=float(settings["confidence"]),
            performance_family_size=performance_family_size,
            meaningful_delta=meaningful_delta, family_alpha=family_alpha)
        if candidate_id:
            payload["candidate"] = _candidate_for_role(
                payload, candidate_id, rows, lifetime, accounts, feedback["items"],
                settings, role, family_size=performance_family_size,
                meaningful_delta=meaningful_delta, family_alpha=family_alpha,
            )
            if payload["candidate"] is None:
                raise ValueError("Campione non presente nel catalogo o nello storico")
        payload["known"] = payload["known"][:limit]
        payload["discover"] = payload["discover"][:limit]

    payload["feedback_revision"] = feedback["revision"]
    payload["context"] = {"accounts": accounts, "role": "ALL" if all_roles else role, "queue": queue, "days": days, "period": period,
        "as_of": now.date().isoformat(), "automatic_role": automatic_role, "automatic_queue": automatic_queue,
        "all_roles": all_roles, "all_queues": all_queues, "context_observed": bool(chosen),
        "recent_games": period["value"] if period["unit"] == "games" else 0,
        "suspended_accounts": sorted(set(accounts) & suspended), "companion_filter_active": bool(companion_sql),
        "unresolved_accounts": unresolved_accounts,
        "observations": len(context_rows), "unique_games": len({r["match_id"] for r in context_rows})}
    if not context_rows:
        payload["notes"].append("Nessuna partita nel contesto indicato: i filtri restano invariati. Una preferenza dichiarata può avviare il profilo.")
    return payload
