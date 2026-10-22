"""Pure contextual comparisons for matchup, synergy, and friend evidence.

The unit of outcome evidence is an account/match observation.  Candidate and
reference observations are kept within the same account cohort, while unique
match IDs are tracked separately for support gates.  A match used by a
candidate is excluded from every account's reference sample.
"""
from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timezone
from typing import Callable, Iterable, Mapping

from algorithm_settings import current_settings
from analysis_runtime import subtract_days_clamped
from decision_models import control_decisions, outcome_metrics


RELIABILITY_LEVELS = ("exploratory", "weak", "indicative", "reliable")


def _target_accounts(accounts: Iterable[str], rows: Iterable[Mapping]) -> list[str]:
    target = list(dict.fromkeys(str(account) for account in accounts if str(account)))
    if not target:
        target = sorted({str(row.get("account")) for row in rows if row.get("account")})
    if not target:
        raise ValueError("At least one target account is required")
    return target


def _binary_outcome(value) -> int:
    if value in (0, 1, False, True):
        return int(value)
    raise ValueError("win must be a binary raw outcome")


def _deduplicate(
    rows: Iterable[Mapping], accounts: set[str], *, compare_champion: bool = True
) -> dict[tuple[str, str], dict]:
    """Deduplicate account/match observations and reject local contradictions."""
    distinct: dict[tuple[str, str], dict] = {}
    for source in rows:
        account = str(source.get("account") or "")
        match_id = str(source.get("match_id") or "")
        if not account or not match_id:
            raise ValueError("account and match_id must be nonempty")
        if account not in accounts:
            continue
        item = dict(source)
        item["account"] = account
        item["match_id"] = match_id
        item["role"] = str(item.get("role") or "ALL").upper()
        item["champion"] = str(item.get("champion") or "")
        item["win"] = _binary_outcome(item.get("win"))
        key = account, match_id
        previous = distinct.get(key)
        if previous is not None:
            signature = item["win"], item["role"]
            old_signature = previous["win"], previous["role"]
            if compare_champion:
                signature += (item["champion"],)
                old_signature += (previous["champion"],)
            if signature != old_signature:
                raise ValueError(f"Conflicting duplicate account/match_id: {account}/{match_id}")
            continue
        distinct[key] = item
    return distinct


def build_contrast(rows: list[dict], candidate_rows: list[dict], accounts: list[str]) -> dict:
    """Build a same-cohort, globally disjoint raw-outcome contrast.

    Candidate observations are deduplicated by ``(account, match_id)``.  The
    same match may legitimately have opposite outcomes for different accounts.
    Every candidate match ID is removed from all account baselines.  Baseline
    rows are additionally matched to candidate roles, and missing baselines are
    recorded per account/role rather than hidden by another role's evidence.

    Mixed-role candidates remain useful descriptively, but callers must veto a
    relative decision because pooling does not control a changed role mixture.
    """
    all_input = [*rows, *candidate_rows]
    target = _target_accounts(accounts, all_input)
    target_set = set(target)
    scope = _deduplicate(rows, target_set)
    prepared_candidates = []
    for source in candidate_rows:
        item = dict(source)
        key = str(item.get("account") or ""), str(item.get("match_id") or "")
        scope_item = scope.get(key)
        if scope_item is not None:
            # Friend observations need only account, match, and friend-team
            # outcome; comparison context supplies the player's role/champion.
            item.setdefault("role", scope_item["role"])
            item.setdefault("champion", scope_item["champion"])
        prepared_candidates.append(item)
    local = _deduplicate(prepared_candidates, target_set, compare_champion=False)

    for key, item in local.items():
        source = scope.get(key)
        if source is None:
            raise ValueError(f"Candidate observation is outside the comparison scope: {key[0]}/{key[1]}")
        if (source["win"], source["role"]) != (item["win"], item["role"]):
            raise ValueError(f"Candidate conflicts with comparison scope: {key[0]}/{key[1]}")

    candidate_ids = {match_id for _, match_id in local}
    candidate_roles = {item["role"] for item in local.values()}
    role_cells: dict[str, dict[str, dict]] = {}
    cells: dict[str, dict] = {}
    baseline_ids: set[str] = set()
    missing_role_baselines: list[dict[str, str]] = []
    mixed_role_accounts: list[str] = []

    for account in target:
        account_local = {
            match_id: item for (owner, match_id), item in local.items() if owner == account
        }
        local_roles = {item["role"] for item in account_local.values()}
        required_roles = local_roles or candidate_roles
        if len(local_roles) > 1:
            mixed_role_accounts.append(account)
        account_baseline = {
            match_id: item
            for (owner, match_id), item in scope.items()
            if owner == account
            and match_id not in candidate_ids
            and item["role"] in required_roles
        }
        baseline_ids.update(account_baseline)
        per_role: dict[str, dict] = {}
        for current_role in sorted(required_roles):
            local_role = {
                match_id: item for match_id, item in account_local.items()
                if item["role"] == current_role
            }
            baseline_role = {
                match_id: item for match_id, item in account_baseline.items()
                if item["role"] == current_role
            }
            if local_role and not baseline_role:
                missing_role_baselines.append({"account": account, "role": current_role})
            per_role[current_role] = {
                "wins": sum(item["win"] for item in local_role.values()),
                "losses": len(local_role) - sum(item["win"] for item in local_role.values()),
                "baseline_wins": sum(item["win"] for item in baseline_role.values()),
                "baseline_losses": len(baseline_role) - sum(item["win"] for item in baseline_role.values()),
                "local_match_ids": sorted(local_role),
                "baseline_match_ids": sorted(baseline_role),
            }
        role_cells[account] = per_role
        wins = sum(item["win"] for item in account_local.values())
        baseline_wins = sum(item["win"] for item in account_baseline.values())
        cells[account] = {
            "wins": wins,
            "losses": len(account_local) - wins,
            "baseline_wins": baseline_wins,
            "baseline_losses": len(account_baseline) - baseline_wins,
            "local_match_ids": sorted(account_local),
            "baseline_match_ids": sorted(account_baseline),
        }

    observations = len(local)
    wins = sum(item["win"] for item in local.values())
    positive = sum(float(item.get("positive_evidence") or 0.0) for item in local.values())
    negative = sum(float(item.get("negative_evidence") or 0.0) for item in local.values())
    missing_baseline_accounts = sorted({entry["account"] for entry in missing_role_baselines})
    return {
        "games": observations,
        "observations": observations,
        "wins": wins,
        "losses": observations - wins,
        "unique_games": len(candidate_ids),
        "baseline_unique_games": len(baseline_ids),
        "account_cells": cells,
        "account_role_cells": role_cells,
        "accounts": target,
        "account_count": len(target),
        "observed_account_count": sum(
            1 for cell in cells.values() if cell["wins"] + cell["losses"]
        ),
        "local_match_ids": sorted(candidate_ids),
        "baseline_match_ids": sorted(baseline_ids),
        "roles": sorted(candidate_roles),
        "missing_role_baselines": missing_role_baselines,
        "missing_baseline_accounts": missing_baseline_accounts,
        "mixed_role_context": len(candidate_roles) > 1,
        "mixed_role_accounts": mixed_role_accounts,
        "positive_evidence": positive,
        "negative_evidence": negative,
    }


def _roster_map(rosters) -> dict[str, list[dict]]:
    if isinstance(rosters, Mapping):
        return {
            str(match_id): [dict(participant) for participant in participants]
            for match_id, participants in rosters.items()
        }
    result: dict[str, list[dict]] = defaultdict(list)
    for participant in rosters:
        match_id = str(participant.get("match_id") or "")
        if match_id:
            result[match_id].append(dict(participant))
    return dict(result)


def _encounters(row: Mapping, roster: list[dict], relation: str) -> set[str]:
    own_win = int(row["win"])
    participants = [item for item in roster if str(item.get("champion") or "")]
    if relation == "enemy":
        return {
            str(item["champion"]) for item in participants
            if item.get("win") in (0, 1, False, True) and int(item["win"]) != own_win
        }

    owners = [
        item for item in participants
        if str(item.get("champion") or "") == str(row.get("champion") or "")
        and item.get("win") in (0, 1, False, True)
        and int(item["win"]) == own_win
    ]
    if len(owners) != 1:
        return set()
    owner = owners[0]
    if owner.get("team_id") is not None:
        return {
            str(item["champion"]) for item in participants
            if item is not owner and item.get("team_id") == owner.get("team_id")
        }
    return {
        str(item["champion"]) for item in participants
        if item is not owner
        and item.get("win") in (0, 1, False, True)
        and int(item["win"]) == own_win
    }


def _is_recent(value, cutoff: datetime) -> bool:
    if not value:
        return False
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return False
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed >= cutoff


def _as_of(value) -> datetime:
    if value is None:
        return datetime.now(timezone.utc)
    if isinstance(value, datetime):
        parsed = value
    else:
        try:
            parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        except ValueError as error:
            raise ValueError("as_of must be an ISO-8601 timestamp") from error
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _descriptive_scope(rows: list[dict], accounts: list[str]) -> tuple[float, int, int]:
    """Equal-account posterior mean plus pooled raw counts for response metadata."""
    cells = {}
    for account in accounts:
        local = [row for row in rows if row["account"] == account]
        wins = sum(row["win"] for row in local)
        cells[account] = {"wins": wins, "losses": len(local) - wins}
    if not rows:
        return 50.0, 0, 0
    metrics = outcome_metrics({
        "games": len(rows), "wins": sum(row["win"] for row in rows),
        "unique_games": len({row["match_id"] for row in rows}),
        "account_cells": cells, "accounts": accounts,
    })
    return metrics["posterior_win_rate"], len(rows), sum(row["win"] for row in rows)


def encounter_data(
    rows: list[dict],
    rosters,
    accounts: list[str],
    relation: str = "enemy",
    champion: str = "",
    role: str = "ALL",
    icon_fn: Callable[[str], str] | None = None,
    min_games: int = 1,
    min_reliability: str = "exploratory",
    include_exploratory: bool = True,
    as_of: datetime | str | None = None,
) -> dict:
    """Return app-compatible matchup or synergy data from already-fetched rows."""
    if relation not in {"enemy", "ally"}:
        raise ValueError("relation must be 'enemy' or 'ally'")
    if isinstance(min_games, bool) or not isinstance(min_games, int) or not 1 <= min_games <= 100:
        raise ValueError("min_games must be an integer between 1 and 100")
    if min_reliability not in RELIABILITY_LEVELS:
        raise ValueError(f"min_reliability must be one of {', '.join(RELIABILITY_LEVELS)}")
    if not isinstance(include_exploratory, bool):
        raise ValueError("include_exploratory must be a boolean")
    settings = current_settings()
    matchup_settings = settings["matchup"]
    selected = str(champion or "").strip()
    if selected.upper() == "ALL":
        selected = ""
    selected_role = str(role or "ALL").strip().upper() or "ALL"
    target = _target_accounts(accounts, rows)
    target_set = set(target)
    distinct = list(_deduplicate(rows, target_set).values())
    role_scope = [
        row for row in distinct if selected_role == "ALL" or row["role"] == selected_role
    ]
    matches = [row for row in role_scope if not selected or row["champion"] == selected]
    roster_by_match = _roster_map(rosters)
    candidate_rows: dict[str, list[dict]] = defaultdict(list)
    relevant_rows: list[dict] = []
    slots_by_match: dict[str, set[str]] = defaultdict(set)
    for row in matches:
        names = _encounters(row, roster_by_match.get(row["match_id"], []), relation)
        if not names:
            continue
        relevant_rows.append(row)
        slots_by_match[row["match_id"]].update(names)
        for name in names:
            candidate_rows[name].append(row)

    family: list[dict] = []
    recent_days = int(matchup_settings["recent_days"])
    reference_time = _as_of(as_of)
    cutoff = subtract_days_clamped(reference_time, recent_days)
    cutoff_90d = subtract_days_clamped(reference_time, 90)
    scope_by_account = {
        account: len({row["match_id"] for row in relevant_rows if row["account"] == account})
        for account in target
    }
    for name, local_rows in sorted(candidate_rows.items()):
        contrast = build_contrast(relevant_rows, local_rows, target)
        metrics = outcome_metrics(contrast, settings=settings)
        # ``outcome_metrics`` can only see pooled account cells. Preserve the
        # stricter account/role missingness derived by ``build_contrast``.
        role_missing = list(contrast["missing_role_baselines"])
        if role_missing:
            metrics["missing_baseline_accounts"] = sorted({
                *metrics.get("missing_baseline_accounts", []),
                *(entry["account"] for entry in role_missing),
            })
        distinct_local = _deduplicate(local_rows, target_set).values()
        recent_games = sum(1 for row in distinct_local if _is_recent(row.get("date"), cutoff))
        recent_90d_games = sum(
            1 for row in _deduplicate(local_rows, target_set).values()
            if _is_recent(row.get("date"), cutoff_90d)
        )
        exposure = sum(
            (contrast["account_cells"][account]["wins"]
             + contrast["account_cells"][account]["losses"])
            / max(scope_by_account[account], 1)
            if scope_by_account[account] else 0.0
            for account in target
        ) / len(target)
        recent_share = recent_games / max(contrast["games"], 1)
        item = {
            **contrast,
            **metrics,
            "champion": name,
            "icon_url": icon_fn(name) if icon_fn else None,
            "recent_90d_games": recent_90d_games,
            "recent_games": recent_games,
            "recent_share": round(recent_share * 100.0, 2),
            "exposure_rate": round(exposure * 100.0, 2),
            "missing_role_baselines": role_missing,
            "mixed_role_context": contrast["mixed_role_context"],
            "mixed_role_accounts": contrast["mixed_role_accounts"],
        }
        if relation == "enemy":
            item.update({
                "wins_against": contrast["wins"],
                "losses_to": contrast["losses"],
                "win_rate_against": round(contrast["wins"] / max(contrast["games"], 1) * 100, 1),
            })
        else:
            item["win_rate"] = item["raw_win_rate"]
        family.append(item)

    control_decisions(family, attribution_gate=True, settings=settings)
    recent_weight = float(matchup_settings["recent_weight"])
    for item in family:
        reasons = []
        if item["mixed_role_context"]:
            reasons.append("Seleziona un ruolo per una conclusione relativa")
        if item["missing_role_baselines"]:
            reasons.append("Manca il confronto nello stesso ruolo per almeno un account selezionato")
        if reasons:
            item["statistical_actionable"] = False
            item["relative_actionable"] = False
            item["actionable"] = False
            games = float(item.get("decision_games", item["games"]) or 0)
            evidence_settings = settings["evidence"]
            item["reliability"] = (
                "exploratory" if games < float(evidence_settings["display_min_games"])
                else "weak" if games < float(evidence_settings["indicative_games"])
                else "indicative"
            )
        item["decision_reasons"] = reasons
        item["decision_reason"] = reasons[0] if reasons else ""
        if relation == "enemy":
            probability = (item["disadvantage_probability"] if item["recommendation"] == "loses_to"
                           else item["advantage_probability"])
            lift = abs(float(item["posterior_lift_pp"])) / 100.0
            recency_factor = 1.0 - recent_weight + recent_weight * (item["recent_share"] / 100.0)
            item["matchup_score"] = round(
                lift * probability * (item["exposure_rate"] / 100.0) * recency_factor * 10000.0,
                2,
            )

    family_size = len(family)
    visible_family = family
    if relation == "ally":
        visible_family = [
            item for item in family
            if item["games"] >= min_games
            and (
                include_exploratory
                if item["reliability"] == "exploratory"
                else RELIABILITY_LEVELS.index(item["reliability"])
                >= RELIABILITY_LEVELS.index(min_reliability)
            )
        ]
    limit = int(matchup_settings["limit"])
    if relation == "enemy":
        sort_key = lambda item: (
            -int(item["actionable"]), -item["matchup_score"],
            -item["direction_probability"], -item["games"], item["champion"],
        )
    else:
        sort_key = lambda item: (
            -int(item["actionable"]), -item["signal_probability"],
            -abs(item["posterior_lift_pp"]), -item["games"], item["champion"],
        )

    baseline, _, _ = _descriptive_scope(relevant_rows, target)
    unique_matches = {row["match_id"] for row in matches}
    relevant_matches = {row["match_id"] for row in relevant_rows}
    available = []
    for name in sorted({row["champion"] for row in role_scope}):
        ids = {row["match_id"] for row in role_scope if row["champion"] == name}
        available.append({
            "champion": name, "games": len(ids),
            "icon_url": icon_fn(name) if icon_fn else None,
        })
    common = {
        "champion": selected or "ALL",
        "role": selected_role,
        "accounts": target,
        "games": len(unique_matches),
        "observations": len(matches),
        "wins": sum(row["win"] for row in matches),
        "win_rate": round(sum(row["win"] for row in matches) / max(len(matches), 1) * 100, 1),
        "baseline_win_rate": baseline,
        "available_champions": available,
        "family_size": family_size,
    }
    if relation == "enemy":
        return common | {
            "games_with_opponents": len(relevant_matches),
            "loses_to": sorted(
                [item for item in family if item["recommendation"] == "loses_to"], key=sort_key
            )[:limit],
            "beats": sorted(
                [item for item in family if item["recommendation"] == "beats"], key=sort_key
            )[:limit],
        }
    return common | {
        "min_games": min_games,
        "min_reliability": min_reliability,
        "include_exploratory": include_exploratory,
        "games_with_teammates": len(relevant_matches),
        "allied_slots_observed": sum(len(names) for names in slots_by_match.values()),
        "coverage": {
            "games_with_roster": len(relevant_matches),
            "roster_coverage": round(len(relevant_matches) / max(len(unique_matches), 1) * 100, 1),
        },
        "better_with": sorted(
            [item for item in visible_family if item["recommendation"] == "beats"], key=sort_key
        )[:limit],
        "worse_with": sorted(
            [item for item in visible_family if item["recommendation"] == "loses_to"], key=sort_key
        )[:limit],
        "exploratory": sorted(
            [item for item in visible_family if not item["actionable"]], key=sort_key
        )[:limit],
    }
