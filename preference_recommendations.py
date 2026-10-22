"""Observed-preference recommendations, deliberately separate from outcome models."""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Iterable, Mapping
from datetime import datetime, timezone
import math
import re
from typing import Any

from champion_taxonomy import canonical_champion, load_catalog


MODEL_VERSION = "observed_preferences_v2"


def _key(value: object) -> str:
    return "".join(character for character in str(value or "").casefold() if character.isalnum())


def _role(value: object) -> str:
    value = str(value or "").strip().upper()
    return "SUPPORT" if value == "UTILITY" else value


def _date(value: object) -> tuple[datetime | None, str]:
    text = str(value or "").strip()
    return _utc_date(text), text


def _utc_date(value: object) -> datetime | None:
    """Read explanation dates without converting through platform timestamps."""
    try:
        parsed = datetime.fromisoformat(str(value or "").strip().replace("Z", "+00:00"))
        return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed.astimezone(timezone.utc)
    except (TypeError, ValueError, OverflowError):
        return None


def _as_dict(row: Mapping[str, Any] | Any) -> dict[str, Any]:
    if isinstance(row, Mapping):
        return dict(row)
    try:
        return {key: row[key] for key in row.keys()}
    except (AttributeError, TypeError):
        raise ValueError("recommendation rows must be mapping-like") from None


def _catalog_index(catalog: Mapping[str, Any] | None) -> tuple[dict[str, dict[str, Any]], dict[str, str], str]:
    source = dict(load_catalog() if catalog is None else catalog)
    entries = source.get("champions")
    if not isinstance(entries, list):
        raise ValueError("catalog.champions must be a list")
    by_id: dict[str, dict[str, Any]] = {}
    aliases: dict[str, str] = {}
    for raw in entries:
        if not isinstance(raw, Mapping) or not str(raw.get("id", "")).strip():
            raise ValueError("catalog champions require an id")
        identifier = str(raw["id"]).strip()
        entry = {
            "id": identifier,
            "name": str(raw.get("name") or identifier),
            "tags": tuple(str(item) for item in [*raw.get("classes", []), *raw.get("tags", [])]),
            "roles": tuple(_role(item) for item in raw.get("roles", [])),
            "icon_url": raw.get("icon_url"),
        }
        if identifier in by_id:
            raise ValueError(f"catalog has duplicate champion id: {identifier}")
        by_id[identifier] = entry
        for alias in (identifier, entry["name"], *raw.get("aliases", [])):
            alias_key = _key(alias)
            if alias_key:
                aliases.setdefault(alias_key, identifier)
    return by_id, aliases, str(source.get("source_version") or source.get("version") or "")


def _champion(value: object, aliases: Mapping[str, str], entries: Mapping[str, dict[str, Any]]) -> str:
    alias = aliases.get(_key(value))
    if alias:
        return alias
    canonical = canonical_champion(value)
    if canonical in entries:
        return canonical
    # A raw observed pick remains useful familiarity evidence even if the
    # pinned catalog has not classified it yet. It simply contributes no tags.
    return str(value or "").strip()


def _accounts(accounts: Iterable[object]) -> tuple[list[str], dict[str, str]]:
    result, labels = [], {}
    for raw in accounts:
        label = str(raw or "").strip()
        key = label.casefold()
        if not key or key in labels:
            continue
        labels[key] = label
        result.append(key)
    return result, labels


def _deduplicate(
    rows: Iterable[Mapping[str, Any] | Any], account_keys: set[str], account_labels, aliases, entries,
    *, requested_role: str, filter_role: bool,
) -> list[dict[str, Any]]:
    deduplicated: dict[tuple[str, str], dict[str, Any]] = {}
    for raw in rows or ():
        row = _as_dict(raw)
        account = str(row.get("account", "")).strip()
        account_key = account.casefold()
        match_id = str(row.get("match_id", "")).strip()
        champion = _champion(row.get("champion"), aliases, entries)
        row_role = _role(row.get("role"))
        if account_key not in account_keys or not account_key or not match_id or not champion:
            continue
        if filter_role and requested_role not in {"", "ALL"} and row_role != requested_role:
            continue
        normalized = row | {
            "account": account_labels[account_key], "account_key": account_key, "match_id": match_id,
            "champion": champion, "role": row_role, "date_key": _date(row.get("date")),
        }
        key = (account_key, match_id)
        previous = deduplicated.get(key)
        if previous is None:
            deduplicated[key] = normalized
            continue
        if (previous["champion"], previous["role"], previous.get("win")) != (
            normalized["champion"], normalized["role"], normalized.get("win"),
        ):
            raise ValueError(f"conflicting account/match records: {account}/{match_id}")
    return list(deduplicated.values())


def _recent(rows: list[dict[str, Any]], active_accounts: list[str], maximum: int | None) -> list[dict[str, Any]]:
    if maximum is not None and maximum < 1:
        return []
    result = []
    minimum = datetime.min.replace(tzinfo=timezone.utc)
    for account in active_accounts:
        local = [row for row in rows if row["account_key"] == account]
        local.sort(key=lambda row: (
            row["date_key"][0] is not None,
            row["date_key"][0] or minimum,
            row["match_id"],
        ), reverse=True)
        result.extend(local if maximum is None else local[:maximum])
    return result


def _jaccard(left: set[str], right: set[str]) -> tuple[float, list[str]]:
    union = left | right
    if not union:
        return 0.0, []
    matched = sorted(left & right)
    return len(matched) / len(union), matched


def _icon(entry: Mapping[str, Any], version: str) -> str:
    if entry.get("icon_url"):
        return str(entry["icon_url"])
    return f"https://ddragon.leagueoflegends.com/cdn/{version}/img/champion/{entry['id']}.png" if version else ""


def _performance(
    rows, candidate_rows, accounts, confidence, family_size, include_performance,
    meaningful_delta, family_alpha,
):
    """Use the separately owned observed-performance API without a numeric fallback."""
    if not include_performance:
        return None
    from observed_performance import observed_performance
    return observed_performance(
        rows, candidate_rows, accounts, confidence=confidence,
        family_size=family_size, meaningful_delta=meaningful_delta,
        family_alpha=family_alpha,
    )


def _feedback(feedback, account_keys, aliases, entries, observed_champions, role):
    values: dict[tuple[str, str, str], str] = {}
    for raw in feedback or ():
        if not isinstance(raw, Mapping):
            continue
        account = str(raw.get("account", "")).strip().casefold()
        champion = _champion(raw.get("champion"), aliases, entries)
        feedback_role = _role(raw.get("role"))
        preference = str(raw.get("preference", "")).strip().lower()
        if account not in account_keys or not champion or preference not in {"like", "dislike", "neutral"}:
            continue
        # A like without taxonomy is allowed only for an already observed
        # familiar pick. It must never create a synthetic discovery source.
        # A dislike can suppress an observed off-meta champion by raw id.
        if preference == "like" and champion not in entries and champion not in observed_champions:
            continue
        if role not in {"", "ALL"} and feedback_role not in {"", "ALL", role}:
            continue
        values[(account, champion, feedback_role)] = preference
    return values


def _preference(preferences, account: str, champion: str, role: str) -> str | None:
    """Resolve feedback without allowing one concrete role to leak into another."""
    for candidate_role in (role, "ALL", ""):
        value = preferences.get((account, champion, candidate_role))
        if value is not None:
            return value
    return None


def build_recommendations(
    rows, lifetime_rows, accounts, role, *, feedback=None, limit=6, recent_games=20,
    catalog=None, trial_budget=3, confidence=.9, include_performance=True,
    performance_family_size=None, meaningful_delta=.03, family_alpha=.05,
    ranking_scope_rows=None,
) -> dict[str, Any]:
    """Build a small, descriptive preference list from contextual observations.

    ``rows`` determine current preferences and displayed performance.  The
    separate ``lifetime_rows`` are used only to ensure discovery candidates
    have never been selected by any selected account.

    ``recent_games`` limits each account's preference window by exact UTC
    instant, then match ID. Undated rows follow dated rows. Original date
    text remains available for explanations.
    """
    try:
        limit = max(int(limit), 0)
        recent_games = None if recent_games is None else max(int(recent_games), 0)
        trial_budget = max(int(trial_budget), 0)
        confidence = float(confidence)
        meaningful_delta = float(meaningful_delta)
        family_alpha = float(family_alpha)
    except (TypeError, ValueError):
        raise ValueError("limit, recent_games, trial_budget, and confidence must be numeric") from None
    if not 0 < confidence < 1:
        raise ValueError("confidence must be between zero and one")
    if not math.isfinite(meaningful_delta) or not 0 <= meaningful_delta < 1:
        raise ValueError("meaningful_delta must be between zero and one")
    if not math.isfinite(family_alpha) or not 0 < family_alpha < 1:
        raise ValueError("family_alpha must be between zero and one")
    if performance_family_size is not None:
        if type(performance_family_size) is not int or performance_family_size < 1:
            raise ValueError("performance_family_size must be a positive integer")
    requested_role = _role(role)
    account_order, account_labels = _accounts(accounts or ())
    account_set = set(account_order)
    entries, aliases, version = _catalog_index(catalog)
    observed = _deduplicate(rows, account_set, account_labels, aliases, entries, requested_role=requested_role, filter_role=True)
    lifetime = _deduplicate(lifetime_rows, account_set, account_labels, aliases, entries, requested_role=requested_role, filter_role=False)
    active = [account for account in account_order if any(row["account_key"] == account for row in observed)]
    preference_rows = _recent(observed, active, recent_games)

    by_champion: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in observed:
        by_champion[row["champion"]].append(row)
    preferences = _feedback(feedback, account_set, aliases, entries, set(by_champion), requested_role)

    ranking_observed = (
        observed if ranking_scope_rows is None else
        _deduplicate(
            ranking_scope_rows, account_set, account_labels, aliases, entries,
            requested_role=requested_role, filter_role=False,
        )
    )
    ranking_active = [
        account for account in account_order
        if any(row["account_key"] == account for row in ranking_observed)
    ]
    ranking_preference_rows = _recent(ranking_observed, ranking_active, recent_games)
    if ranking_scope_rows is not None:
        ranking_window = {
            (row["account_key"], row["match_id"]) for row in ranking_preference_rows
        }
        preference_rows = [
            row for row in observed
            if (row["account_key"], row["match_id"]) in ranking_window
        ]
    ranking_preferences = (
        preferences if ranking_scope_rows is None else
        _feedback(
            feedback, account_set, aliases, entries,
            {row["champion"] for row in ranking_observed}, "ALL",
        )
    )
    ranking_affinity_counts: dict[str, int] = defaultdict(int)
    for row in ranking_preference_rows:
        if _preference(
            ranking_preferences, row["account_key"], row["champion"], row["role"]
        ) != "dislike":
            ranking_affinity_counts[row["account_key"]] += 1

    # Dislike removes only that account's implicit source signal. Archived rows
    # remain available to the known list and observed-performance description.
    affinity_rows = [
        row for row in preference_rows
        if _preference(preferences, row["account_key"], row["champion"], row["role"]) != "dislike"
    ]
    affinity_by_account_champion: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    affinity_counts: dict[str, int] = defaultdict(int)
    for row in affinity_rows:
        affinity_by_account_champion[(row["account_key"], row["champion"])].append(row)
        affinity_counts[row["account_key"]] += 1
    profile_totals: dict[str, dict[str, Any]] = defaultdict(lambda: {"games": 0, "accounts": set(), "shares": []})
    for account in active:
        local = [row for row in affinity_rows if row["account_key"] == account]
        denominator = len(local)
        tag_counts: dict[str, int] = defaultdict(int)
        for row in local:
            entry = entries.get(row["champion"])
            if entry is None:
                continue
            for tag in set(entry["tags"]):
                tag_counts[tag] += 1
        for tag, count in tag_counts.items():
            profile_totals[tag]["games"] += count
            profile_totals[tag]["accounts"].add(account)
            profile_totals[tag]["shares"].append(count / denominator)
    labels = {item["id"]: str(item.get("label") or item["id"]) for item in (catalog or load_catalog()).get("categories", [])}
    profile = [
        {"tag": tag, "label": labels.get(tag, tag), "games": data["games"],
         "accounts": len(data["accounts"]), "share": sum(data["shares"]) / len(active)}
        for tag, data in profile_totals.items()
    ]
    profile.sort(key=lambda item: (-item["share"], -item["games"], item["tag"]))

    scoped_feedback = {
        (account, champion): _preference(preferences, account, champion, requested_role)
        for account, champion, _ in preferences
    } if requested_role not in {"", "ALL"} else {}
    likes = {champion for (account, champion), state in scoped_feedback.items() if state == "like"}
    disliked = {champion for (account, champion), state in scoped_feedback.items() if state == "dislike"}
    excluded_count = (
        len({(champion, feedback_role) for (_, champion, feedback_role), state in preferences.items()
             if state == "dislike"})
        if requested_role in {"", "ALL"} else len(disliked)
    )
    observed_champions = set(by_champion)
    candidates = observed_champions | likes
    excluded = disliked

    performance_family_size = performance_family_size or max(len(observed_champions), 1)

    def familiar(champion: str) -> dict[str, Any]:
        entry = entries.get(champion, {
            "id": champion, "name": champion, "tags": (), "roles": (), "icon_url": "",
        })
        candidate_rows = by_champion.get(champion, [])
        played_accounts = {row["account_key"] for row in candidate_rows}
        scoring_accounts = ranking_active if ranking_scope_rows is not None else active
        denominators = ranking_affinity_counts if ranking_scope_rows is not None else affinity_counts
        shares = [
            len(affinity_by_account_champion[(account, champion)]) /
            max(denominators[account], 1)
            for account in scoring_accounts
        ]
        score = sum(shares) / len(scoring_accounts) if scoring_accounts else None
        recent_count = sum(len(affinity_by_account_champion[(account, champion)]) for account in active)
        dates = []
        for row in candidate_rows:
            original_date = row["date_key"][1]
            played_at = _utc_date(original_date)
            if played_at is not None:
                dates.append((played_at, original_date))
        days = {played_at.date() for played_at, _ in dates}
        day_label = "giorno giocato" if len(days) == 1 else "giorni giocati"
        reasons = []
        if champion in likes:
            reasons.append("Preferenza esplicita positiva.")
        if candidate_rows:
            reasons.extend([
                f"{recent_count} partite recenti usate per la preferenza.",
                f"{len(candidate_rows)} partite nel perimetro usate per la performance osservata.",
                f"{len(days)} {day_label} (UTC).",
                f"Ultima partita: {max(dates)[1]}." if dates else "Data dell'ultima partita non disponibile.",
            ])
        else:
            reasons.append("Ancorato a una preferenza esplicita, senza partite inventate.")
        source = [{"champion": champion, "name": entry["name"], "games": len(candidate_rows),
                   "similarity": 1.0, "matched_tags": sorted(entry["tags"]),
                   **({"source_kind": "explicit_feedback"} if champion in likes and not candidate_rows else {})}]
        return {
            "champion": champion, "name": entry["name"], "role": requested_role,
            "icon_url": _icon(entry, version), "kind": "familiar", "preference_score": score,
            "similarity": None, "games": len(candidate_rows), "account_count": len(played_accounts),
            "selected_account_count": len(account_order), "source_champions": source, "reasons": reasons,
            "performance": _performance(
                observed, candidate_rows, [account_labels[key] for key in account_order],
                confidence, performance_family_size, include_performance,
                meaningful_delta, family_alpha,
            ),
            "feedback": "like" if champion in likes else None,
        }

    known = [familiar(champion) for champion in candidates - excluded]
    known.sort(key=lambda item: (item["feedback"] != "like", -(item["preference_score"] if item["preference_score"] is not None else -1),
                                 -item["games"], item["name"].casefold(), item["champion"]))
    known = known[:limit]

    lifetime_tried = {row["champion"] for row in lifetime}
    source_by_account: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    for row in affinity_rows:
        if row["champion"] in entries:
            source_by_account[row["account_key"]][row["champion"]] += 1

    discover = []
    explicit_by_account = {
        account: sorted(champion for (owner, champion), state in scoped_feedback.items()
                        if owner == account and state == "like" and champion in entries)
        for account in account_order
    }
    affinity_accounts = [account for account in account_order if explicit_by_account[account] or source_by_account[account]]
    if affinity_accounts:
        for champion, entry in entries.items():
            if champion in lifetime_tried or champion in observed_champions or champion in likes or champion in disliked:
                continue
            if requested_role not in {"", "ALL"} and requested_role not in entry["roles"]:
                continue
            account_scores, priority_scores = [], []
            sources = defaultdict(lambda: {"games": 0, "accounts": set()})
            for account in affinity_accounts:
                explicit_sources = explicit_by_account[account]
                # Explicit feedback has priority for its account. Multiple
                # likes are equally represented signals, never pseudo-games.
                if explicit_sources:
                    local = [(source, 1 / len(explicit_sources), "explicit_feedback", 0) for source in explicit_sources]
                else:
                    observed_sources = source_by_account[account]
                    total = sum(observed_sources.values())
                    local = [(source, count / total, "observed_frequency", count)
                             for source, count in observed_sources.items()] if total else []
                if not local:
                    continue
                score = 0.0
                for source, weight, source_kind, games in local:
                    similarity, _ = _jaccard(set(entry["tags"]), set(entries[source]["tags"]))
                    score += weight * similarity
                    aggregate = sources[(source, source_kind)]
                    aggregate["games"] += games
                    aggregate["accounts"].add(account)
                account_scores.append(score)
                if ranking_scope_rows is None or explicit_sources:
                    priority_scores.append(score)
                else:
                    role_games = sum(source_by_account[account].values())
                    priority_scores.append(
                        score * role_games / max(ranking_affinity_counts[account], 1)
                    )
            similarity = sum(account_scores) / len(account_scores) if account_scores else 0.0
            if ranking_scope_rows is None:
                priority_score = similarity
            else:
                priority_accounts = set(ranking_active) | {
                    account for account, champions in explicit_by_account.items() if champions
                }
                priority_by_account = dict(zip(affinity_accounts, priority_scores))
                priority_score = (
                    sum(priority_by_account.get(account, 0.0) for account in priority_accounts) /
                    len(priority_accounts)
                    if priority_accounts else 0.0
                )
            if similarity <= 0:
                continue
            source_items = []
            for (source, source_kind), data in sorted(
                sources.items(), key=lambda item: (-item[1]["games"], entries[item[0][0]]["name"].casefold(), item[0])
            ):
                source_entry = entries[source]
                source_similarity, matched = _jaccard(set(entry["tags"]), set(source_entry["tags"]))
                source_items.append({"champion": source, "name": source_entry["name"], "games": data["games"],
                                     "similarity": source_similarity, "matched_tags": matched,
                                     "source_kind": source_kind})
            discover.append({
                "champion": champion, "name": entry["name"], "role": requested_role,
                "icon_url": _icon(entry, version), "kind": "discovery", "preference_score": None,
                "similarity": similarity,
                **({"priority_score": priority_score} if ranking_scope_rows is not None else {}),
                "games": 0, "account_count": 0,
                "selected_account_count": len(account_order), "source_champions": source_items,
                "reasons": ["Somiglianza delle caratteristiche con le scelte e le preferenze dichiarate degli account; non è una probabilità personale."],
                "performance": None, "feedback": None,
            })
    discover.sort(key=lambda item: (
        -item.get("priority_score", item["similarity"]),
        -item["similarity"], item["name"].casefold(), item["champion"],
    ))
    discover = discover[:limit]

    trial_items = []
    trial_cap = trial_budget
    if trial_cap:
        if known:
            item = known[0]
            trial_items.append({"champion": item["champion"], "role": requested_role, "games": 1,
                                "reason": "Una partita per confermare una preferenza già osservata."})
        for item in discover[:max(trial_cap - len(trial_items), 0)]:
            trial_items.append({"champion": item["champion"], "role": requested_role, "games": 1,
                                "reason": "Una partita esplorativa basata su tag condivisi."})

    coverage = {
        "selected_accounts": [account_labels[key] for key in account_order],
        "active_accounts": [account_labels[key] for key in active],
        "missing_accounts": [account_labels[key] for key in account_order if key not in active],
        "games": len({row["match_id"] for row in observed}), "observations": len(observed),
        "preference_observations": len(preference_rows),
        "unclassified_games": sum(row["champion"] not in entries for row in observed),
        "excluded_count": excluded_count,
    }
    notes = []
    if not observed and not likes:
        notes.append("Nessuna osservazione nel contesto: scegli un champion per iniziare il profilo.")
    if coverage["missing_accounts"]:
        notes.append("Gli account senza partite nel contesto non riducono le preferenze osservate.")
    if any(explicit_by_account.values()):
        notes.append("Per l'affinità, un like esplicito sostituisce le frequenze osservate dello stesso account.")
    return {
        "model_version": MODEL_VERSION, "coverage": coverage, "profile": profile,
        "known": known, "discover": discover,
        "trial_plan": {"budget": min(trial_cap, len(trial_items)), "items": trial_items},
        "notes": notes,
    }
