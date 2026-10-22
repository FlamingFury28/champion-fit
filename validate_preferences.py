#!/usr/bin/env python3
"""Temporal, read-only validation of observed-preference recommendations.

The replay evaluates whether a descriptive ranking reappears in the next
observed champion choice.  Reuse is only a behavioral proxy: it is neither a
satisfaction label nor evidence that following a recommendation causes value.
"""

from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import inspect
import json
import math
from pathlib import Path
import sqlite3
import sys
from typing import Any

from champion_taxonomy import canonical_champion, champion_entry
from validate_algorithm_settings import _utc_sort_value


PROTOCOL_VERSION = "observed-preference-next-choice-v2"
PREFIXES = (3, 5, 10, 20)
TOP_K = 3
SUPPORTED_QUEUES = frozenset({"400", "420", "430", "440", "480", "490", "700"})
VALID_ROLES = frozenset({"TOP", "JUNGLE", "MIDDLE", "BOTTOM", "SUPPORT"})
QUEUE_ALIASES = {
    "NORMALDRAFT": "400", "DRAFTPICK": "400",
    "RANKEDSOLO": "420", "RANKEDSOLO/DUO": "420",
    "NORMALBLIND": "430", "BLINDPICK": "430",
    "RANKEDFLEX": "440", "SWIFTPLAY": "480",
    "QUICKPLAY": "490", "NORMALQUICKPLAY": "490", "CLASH": "700",
}


@dataclass(frozen=True)
class Observation:
    account: str
    identity_group: str
    match_id: str
    occurred_at: datetime
    patch: str
    queue: str
    champion: str
    role: str
    duration_minutes: float | None
    win: int

    def engine_row(self) -> dict[str, object]:
        return {
            "account": self.account,
            "match_id": self.match_id,
            "date": self.occurred_at.isoformat(),
            "patch": self.patch,
            "queue": self.queue,
            "champion": self.champion,
            "role": self.role,
            "duration_minutes": self.duration_minutes,
            "win": self.win,
        }


def _utc(value: object) -> datetime:
    text = str(value or "").strip()
    parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _identity_key(value: object) -> str:
    return "".join(character for character in str(value or "").casefold() if character.isalnum())


def _queue(value: object) -> str:
    key = str(value or "").strip().upper().replace(" ", "")
    return QUEUE_ALIASES.get(key, key[5:] if key.startswith("QUEUE") else key)


def _table_exists(connection: sqlite3.Connection, name: str) -> bool:
    return connection.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)
    ).fetchone() is not None


def load_observations(db_path: Path) -> tuple[list[Observation], dict[str, object]]:
    """Load normalized match facts only, using a read-only SQLite snapshot."""
    path = Path(db_path).expanduser().resolve(strict=True)
    connection = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    try:
        connection.execute("PRAGMA query_only=ON")
        connection.execute("BEGIN")
        connection.create_function(
            "validation_utc", 1,
            lambda value: _utc_sort_value(str(value or "").strip()), deterministic=True,
        )
        identity_account: dict[str, str] = {}
        direct_identity: dict[str, str] = {}
        puuid_identity: dict[str, str] = {}
        if _table_exists(connection, "riot_account_identities"):
            for row in connection.execute(
                "SELECT identity_id,account FROM riot_account_identities"
            ):
                identity_account[str(row["identity_id"])] = str(row["account"])
                direct_identity[str(row["account"])] = str(row["identity_id"])
        if _table_exists(connection, "riot_identity_puuids"):
            puuid_identity = {
                str(row["puuid"]): str(row["identity_id"])
                for row in connection.execute(
                    "SELECT puuid,identity_id FROM riot_identity_puuids"
                )
            }
        alias_candidates: dict[str, set[str]] = defaultdict(set)
        if _table_exists(connection, "riot_account_aliases"):
            for row in connection.execute(
                "SELECT account,display_riot_id,normalized_riot_id,puuid "
                "FROM riot_account_aliases"
            ):
                identity = puuid_identity.get(str(row["puuid"]))
                if not identity:
                    continue
                for label in (
                    row["account"], row["display_riot_id"], row["normalized_riot_id"]
                ):
                    key = _identity_key(label)
                    if key:
                        alias_candidates[key].add(identity)
        unique_aliases = {
            key: next(iter(values))
            for key, values in alias_candidates.items()
            if len(values) == 1
        }
        exceptions: set[str] = set()
        if _table_exists(connection, "riot_identity_policy"):
            exceptions = {
                str(row["identity_id"])
                for row in connection.execute(
                    "SELECT DISTINCT identity_id FROM riot_identity_policy "
                    "WHERE state='exception'"
                )
            }

        rows = connection.execute(
            """WITH global_match_time AS (
                   SELECT match_id,MIN(validation_utc(date)) occurred_at
                   FROM match_quality GROUP BY match_id
               )
               SELECT m.account,m.match_id,m.date,t.occurred_at,m.patch,m.queue,
                      m.champion,m.role,m.duration_minutes,m.win
               FROM match_quality m
               JOIN global_match_time t ON t.match_id=m.match_id
               ORDER BY t.occurred_at,m.match_id,m.account,m.id"""
        )
        candidates: dict[tuple[str, str], Observation] = {}
        conflicts: set[tuple[str, str]] = set()
        excluded_exceptions = 0
        excluded_context = 0
        registered = 0
        duplicate_rows = 0
        for row in rows:
            queue = _queue(row["queue"])
            role = str(row["role"] or "").strip().upper()
            role = {"UTILITY": "SUPPORT", "MID": "MIDDLE", "ADC": "BOTTOM"}.get(role, role)
            if queue not in SUPPORTED_QUEUES or role not in VALID_ROLES:
                excluded_context += 1
                continue
            saved_account = str(row["account"])
            identity = direct_identity.get(saved_account)
            if identity is None:
                identity = unique_aliases.get(_identity_key(saved_account))
            if identity in exceptions:
                excluded_exceptions += 1
                continue
            if identity is None:
                canonical_account = saved_account
                identity_group = "unregistered:" + hashlib.sha256(
                    _identity_key(saved_account).encode("utf-8")
                ).hexdigest()
            else:
                registered += 1
                canonical_account = identity_account.get(identity, saved_account)
                identity_group = identity
            try:
                win = int(row["win"])
                # One malformed source must not erase another account's valid
                # observation of the same match, nor inherit its timestamp.
                _utc(row["date"])
                occurred_at = _utc(row["occurred_at"])
            except (TypeError, ValueError, OverflowError):
                excluded_context += 1
                continue
            if win not in {0, 1}:
                excluded_context += 1
                continue
            duration = row["duration_minutes"]
            item = Observation(
                account=canonical_account,
                identity_group=identity_group,
                match_id=str(row["match_id"]),
                occurred_at=occurred_at,
                patch=str(row["patch"] or ""),
                queue=queue,
                champion=canonical_champion(row["champion"]),
                role=role,
                duration_minutes=float(duration) if duration is not None else None,
                win=win,
            )
            key = (identity_group, item.match_id)
            previous = candidates.get(key)
            if previous is None:
                candidates[key] = item
            elif previous == item:
                duplicate_rows += 1
            else:
                conflicts.add(key)
        for key in conflicts:
            candidates.pop(key, None)
        observations = sorted(
            candidates.values(),
            key=lambda item: (
                item.occurred_at, item.match_id, item.identity_group,
                item.role, item.queue,
            ),
        )
        digest = hashlib.sha256()
        for item in observations:
            digest.update(
                repr((
                    item.identity_group, item.match_id, item.occurred_at.isoformat(),
                    item.patch, item.queue, item.champion, item.role,
                    item.duration_minutes, item.win,
                )).encode("utf-8")
            )
        connection.rollback()
        return observations, {
            "database": str(path),
            "logical_input_sha256": digest.hexdigest(),
            "observations": len(observations),
            "unique_matches": len({item.match_id for item in observations}),
            "canonical_accounts": len({item.identity_group for item in observations}),
            "registered_source_rows": registered,
            "unregistered_observations": sum(
                item.identity_group.startswith("unregistered:") for item in observations
            ),
            "duplicate_source_rows_collapsed": duplicate_rows,
            "conflicting_account_match_groups_excluded": len(conflicts),
            "exception_source_rows_excluded": excluded_exceptions,
            "unsupported_context_rows_excluded": excluded_context,
            "raw_json_tables_read": False,
            "sqlite_open_mode": "ro",
        }
    finally:
        connection.close()


def group_strata(observations: Iterable[Observation]) -> dict[tuple[str, str, str], list[Observation]]:
    groups: dict[tuple[str, str, str], list[Observation]] = defaultdict(list)
    for item in observations:
        groups[(item.identity_group, item.role, item.queue)].append(item)
    for rows in groups.values():
        rows.sort(key=lambda item: (item.occurred_at, item.match_id))
    return dict(groups)


def _section_items(section: object) -> list[Mapping[str, Any]]:
    if isinstance(section, list):
        return [item for item in section if isinstance(item, Mapping)]
    if isinstance(section, Mapping):
        for key in ("items", "recommendations", "champions", "results"):
            value = section.get(key)
            if isinstance(value, list):
                return [item for item in value if isinstance(item, Mapping)]
    return []


def _champions(section: object) -> list[str]:
    result = []
    for item in _section_items(section):
        value = item.get("champion", item.get("id", item.get("name", "")))
        champion = canonical_champion(value)
        if champion and champion not in result:
            result.append(champion)
    return result


def _trial_items(result: Mapping[str, Any]) -> tuple[int, list[Mapping[str, Any]]]:
    section = result.get("trial_plan")
    if not isinstance(section, Mapping):
        return 0, []
    try:
        budget = int(section.get("budget", 0))
    except (TypeError, ValueError):
        budget = -1
    return budget, _section_items(section)


def _frequency_top(rows: Sequence[Observation], limit: int) -> list[str]:
    counts = Counter(item.champion for item in rows if item.champion)
    return [champion for champion, _ in sorted(counts.items(), key=lambda item: (-item[1], item[0]))[:limit]]


def _jaccard(left: Sequence[str], right: Sequence[str]) -> float | None:
    left_set, right_set = set(left), set(right)
    union = left_set | right_set
    return len(left_set & right_set) / len(union) if union else None


def _call_builder(
    builder: Callable[..., Mapping[str, Any]],
    rows: Sequence[dict[str, object]],
    lifetime_rows: Sequence[dict[str, object]],
    account: str,
    role: str,
    *,
    limit: int,
    recent_games: int,
    trial_budget: int,
) -> tuple[Mapping[str, Any], bool]:
    kwargs = {
        "feedback": None,
        "limit": limit,
        "recent_games": recent_games,
        "trial_budget": trial_budget,
        "catalog": None,
    }
    performance_disabled = "include_performance" in inspect.signature(builder).parameters
    if performance_disabled:
        kwargs["include_performance"] = False
    result = builder(rows, lifetime_rows, [account], role, **kwargs)
    if not isinstance(result, Mapping):
        raise ValueError("build_recommendations must return a mapping")
    return result, performance_disabled


def replay_preferences(
    observations: Sequence[Observation],
    *,
    builder: Callable[..., Mapping[str, Any]],
    prefixes: Sequence[int] = PREFIXES,
    limit: int = 6,
    recent_games: int = 20,
    trial_budget: int = 3,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    if any(prefix < 1 for prefix in prefixes):
        raise ValueError("prefixes must be positive")
    events: list[dict[str, Any]] = []
    contract_errors: Counter[str] = Counter()
    skipped_same_timestamp = 0
    skipped_unknown_target = 0
    eligible_by_prefix = Counter()
    performance_disabled_calls = 0
    groups = group_strata(observations)
    by_identity: dict[str, list[Observation]] = defaultdict(list)
    for item in observations:
        by_identity[item.identity_group].append(item)
    for rows in by_identity.values():
        rows.sort(key=lambda item: (item.occurred_at, item.match_id, item.role, item.queue))
    for (identity_group, role, queue), group in sorted(groups.items()):
        previous_known: list[str] | None = None
        previous_discover: list[str] | None = None
        previous_combined: list[str] | None = None
        for prefix in sorted(set(prefixes)):
            if len(group) <= prefix:
                continue
            train, target = group[:prefix], group[prefix]
            if target.occurred_at <= train[-1].occurred_at:
                skipped_same_timestamp += 1
                continue
            cutoff = train[-1].occurred_at
            lifetime_train = [
                item for item in by_identity[identity_group]
                if item.occurred_at <= cutoff
            ]
            context_champions = {item.champion for item in train}
            lifetime_champions = {item.champion for item in lifetime_train}
            familiar = target.champion in context_champions
            tried_other_context = not familiar and target.champion in lifetime_champions
            genuinely_novel = target.champion not in lifetime_champions
            if champion_entry(target.champion) is None and genuinely_novel:
                skipped_unknown_target += 1
                continue
            eligible_by_prefix[prefix] += 1
            engine_rows = [item.engine_row() for item in train]
            lifetime_engine_rows = [item.engine_row() for item in lifetime_train]
            result, performance_disabled = _call_builder(
                builder,
                engine_rows,
                lifetime_engine_rows,
                train[0].account,
                role,
                limit=limit,
                recent_games=recent_games,
                trial_budget=trial_budget,
            )
            performance_disabled_calls += int(performance_disabled)
            known = _champions(result.get("known"))
            discover = _champions(result.get("discover"))
            profile = _section_items(result.get("profile"))
            frequency_top = _frequency_top(train, TOP_K)
            last_champion = train[-1].champion
            combined_signature = known[:TOP_K] + discover[:TOP_K]
            full_union = set(known) | set(discover)

            overlap = set(known) & set(discover)
            if overlap:
                contract_errors["known_discover_overlap"] += 1
            if len(known) > limit or len(discover) > limit:
                contract_errors["section_exceeds_limit"] += 1
            known_items = _section_items(result.get("known"))
            if any("performance" not in item for item in known_items):
                contract_errors["known_missing_separate_performance_field"] += 1
            if performance_disabled and any(item.get("performance") is not None for item in known_items):
                contract_errors["performance_not_disabled"] += 1
            declared_budget, trial_items = _trial_items(result)
            trial_champions = _champions(trial_items)
            if declared_budget < 0 or declared_budget > trial_budget or len(trial_items) > trial_budget:
                contract_errors["trial_budget_exceeded"] += 1
            if len(trial_champions) != len(trial_items):
                contract_errors["trial_item_missing_or_duplicate_champion"] += 1
            if not set(trial_champions).issubset(full_union):
                contract_errors["trial_item_outside_recommendations"] += 1
            if not isinstance(result.get("trial_plan"), Mapping):
                contract_errors["trial_plan_missing"] += 1
            if not isinstance(result.get("profile"), list):
                contract_errors["profile_not_list"] += 1

            events.append({
                "identity_group": identity_group,
                "stratum": (identity_group, role, queue),
                "prefix": prefix,
                "target_match_id": target.match_id,
                "target_time": target.occurred_at.isoformat(),
                "target_patch": target.patch,
                "familiar_target": familiar,
                "familiar_in_context": familiar,
                "tried_other_context": tried_other_context,
                "genuinely_novel": genuinely_novel,
                "known_hit_1": familiar and target.champion in known[:1],
                "known_hit_3": familiar and target.champion in known[:TOP_K],
                "discover_hit_3": genuinely_novel and target.champion in discover[:TOP_K],
                "engine_any_hit_3": (
                    target.champion in known[:TOP_K] if familiar
                    else target.champion in discover[:TOP_K] if genuinely_novel
                    else False
                ),
                "frequency_hit_3": target.champion in frequency_top,
                "last_choice_hit_1": target.champion == last_champion,
                "missing_from_full_output": target.champion not in full_union,
                "distinct_context_champions": len(context_champions),
                "known_hit_3_mechanical": familiar and len(context_champions) <= TOP_K,
                "known_stability_jaccard": _jaccard(previous_known, known[:TOP_K]) if previous_known is not None else None,
                "discover_stability_jaccard": _jaccard(previous_discover, discover[:TOP_K]) if previous_discover is not None else None,
                "combined_stability_jaccard": _jaccard(previous_combined, combined_signature) if previous_combined is not None else None,
                "known_count": len(known),
                "discover_count": len(discover),
                "profile_count": len(profile),
                "trial_count": len(trial_items),
            })
            previous_known = known[:TOP_K]
            previous_discover = discover[:TOP_K]
            previous_combined = combined_signature
    target_match_counts = Counter(str(event["target_match_id"]) for event in events)
    events_per_account = Counter(str(event["identity_group"]) for event in events)
    target_matches_by_prefix: dict[str, int] = {}
    for prefix in sorted(set(prefixes)):
        target_matches_by_prefix[str(prefix)] = len({
            str(event["target_match_id"])
            for event in events if event["prefix"] == prefix
        })
    return events, {
        "total_strata": len(groups),
        "eligible_strata_by_prefix": {
            str(prefix): eligible_by_prefix[prefix] for prefix in sorted(set(prefixes))
        },
        "skipped_non_strict_timestamp_targets": skipped_same_timestamp,
        "skipped_unseen_catalog_unknown_targets": skipped_unknown_target,
        "contract_errors": dict(sorted(contract_errors.items())),
        "performance_disabled_calls": performance_disabled_calls,
        "unique_target_matches": len(target_match_counts),
        "unique_target_matches_by_prefix": target_matches_by_prefix,
        "shared_target_matches": sum(count > 1 for count in target_match_counts.values()),
        "events_on_shared_target_matches": sum(
            count for count in target_match_counts.values() if count > 1
        ),
        "maximum_target_match_multiplicity": max(target_match_counts.values(), default=0),
        "events_per_account": dict(sorted(events_per_account.items())),
    }


def _wilson(successes: int, total: int) -> list[float] | None:
    if total == 0:
        return None
    z = 1.959963984540054
    estimate = successes / total
    denominator = 1 + z * z / total
    center = (estimate + z * z / (2 * total)) / denominator
    radius = z * math.sqrt(estimate * (1 - estimate) / total + z * z / (4 * total * total)) / denominator
    return [round(max(0.0, center - radius), 10), round(min(1.0, center + radius), 10)]


def _rate(events: Sequence[Mapping[str, Any]], field: str, *, subset: str | None = None) -> dict[str, Any]:
    selected = [event for event in events if subset is None or bool(event[subset])]
    successes = sum(bool(event[field]) for event in selected)
    return {
        "successes": successes,
        "eligible": len(selected),
        "rate": round(successes / len(selected), 10) if selected else None,
        "wilson_ci95": _wilson(successes, len(selected)),
    }


def _mean(events: Sequence[Mapping[str, Any]], field: str) -> dict[str, Any]:
    values = [float(event[field]) for event in events if event[field] is not None]
    return {
        "values": len(values),
        "mean": round(sum(values) / len(values), 10) if values else None,
    }


def summarize_events(events: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    familiar = [
        event for event in events
        if bool(event.get("familiar_in_context", event["familiar_target"]))
    ]
    tried_other_context = [
        event for event in events if bool(event.get("tried_other_context", False))
    ]
    genuinely_novel = [
        event for event in events
        if bool(event.get(
            "genuinely_novel",
            not event["familiar_target"] and not event.get("tried_other_context", False),
        ))
    ]
    per_account: dict[str, list[Mapping[str, Any]]] = defaultdict(list)
    for event in events:
        per_account[str(event["identity_group"])].append(event)
    equal_account_known_rates = []
    for account_events in per_account.values():
        account_familiar = [event for event in account_events if event["familiar_target"]]
        if account_familiar:
            equal_account_known_rates.append(
                sum(bool(event["known_hit_3"]) for event in account_familiar) / len(account_familiar)
            )
    engine_only = sum(
        bool(event["known_hit_3"]) and not bool(event["frequency_hit_3"])
        for event in familiar
    )
    frequency_only = sum(
        bool(event["frequency_hit_3"]) and not bool(event["known_hit_3"])
        for event in familiar
    )
    discovery_coverage = _rate(genuinely_novel, "discover_hit_3")
    return {
        "next_choice_events": len(events),
        "accounts": len(per_account),
        "strata": len({tuple(event["stratum"]) for event in events}),
        "observed_reuse": _rate(events, "familiar_target"),
        "target_categories": {
            "familiar_in_context": len(familiar),
            "tried_other_context": len(tried_other_context),
            "genuinely_novel": len(genuinely_novel),
            "tried_other_context_missing_from_output": _rate(
                tried_other_context, "missing_from_full_output"
            ),
        },
        "known": {
            "hit_at_1_familiar": _rate(events, "known_hit_1", subset="familiar_target"),
            "hit_at_3_familiar": _rate(events, "known_hit_3", subset="familiar_target"),
            "mechanically_covered_at_3": _rate(
                [event for event in familiar if "known_hit_3_mechanical" in event],
                "known_hit_3_mechanical",
            ),
            "equal_account_hit_at_3": {
                "accounts": len(equal_account_known_rates),
                "mean": round(sum(equal_account_known_rates) / len(equal_account_known_rates), 10)
                if equal_account_known_rates else None,
            },
        },
        "discover": {
            "coverage_at_3_genuinely_novel": discovery_coverage,
            "coverage_at_3_unseen": discovery_coverage,
        },
        "next_choice": {
            "engine_any_hit_at_3": _rate(events, "engine_any_hit_3"),
            "missing_from_full_output": _rate(events, "missing_from_full_output"),
        },
        "baselines": {
            "raw_frequency_hit_at_3_familiar": _rate(familiar, "frequency_hit_3"),
            "last_champion_hit_at_1": _rate(events, "last_choice_hit_1"),
            "paired_known_vs_frequency": {
                "engine_only_successes": engine_only,
                "frequency_only_successes": frequency_only,
                "net_successes": engine_only - frequency_only,
                "claim": "descriptive paired count; no weights or thresholds are selected from it",
            },
        },
        "stability": {
            "known_top3_jaccard": _mean(events, "known_stability_jaccard"),
            "discover_top3_jaccard": _mean(events, "discover_stability_jaccard"),
            "combined_top3_jaccard": _mean(events, "combined_stability_jaccard"),
        },
        "mean_output_size": {
            field: _mean(events, field)
            for field in ("known_count", "discover_count", "profile_count", "trial_count")
        },
    }


def build_report(
    db_path: Path,
    *,
    builder: Callable[..., Mapping[str, Any]] | None = None,
    limit: int = 6,
    recent_games: int = 20,
    trial_budget: int = 3,
) -> dict[str, Any]:
    if builder is None:
        from preference_recommendations import MODEL_VERSION, build_recommendations

        builder = build_recommendations
        engine_version = MODEL_VERSION
    else:
        engine_version = getattr(builder, "model_version", getattr(builder, "__name__", "injected"))
    observations, input_metadata = load_observations(db_path)
    events, replay_metadata = replay_preferences(
        observations,
        builder=builder,
        limit=limit,
        recent_games=recent_games,
        trial_budget=trial_budget,
    )
    metrics_by_prefix = {
        str(prefix): summarize_events([event for event in events if event["prefix"] == prefix])
        for prefix in PREFIXES
    }
    contract_errors = replay_metadata["contract_errors"]
    return {
        "protocol": {
            "version": PROTOCOL_VERSION,
            "engine_version": engine_version,
            "estimand": "next observed champion reuse within one account, role and concrete queue",
            "unit": "one account-stratum at one frozen history prefix",
            "prefix_games": list(PREFIXES),
            "top_k": TOP_K,
            "recommendation_limit": limit,
            "recent_games": recent_games,
            "trial_budget": trial_budget,
            "sampling": "all eligible account x role x queue strata; no arbitrary account cap",
            "target": "the immediately following strictly later match in the same stratum",
            "history": (
                "rows stop at the account-role-queue prefix; lifetime_rows contain all "
                "observations for that account at or before the prefix cutoff; feedback is None"
            ),
            "selection": "most-played frequency, recent observations and profiles use training rows only",
            "baselines": ["raw training frequency top-3", "immediately previous champion"],
            "performance_used_for_validation": False,
            "weights_or_thresholds_tuned_on_replay": False,
            "raw_json_tables_read": False,
        },
        "created_utc": datetime.now(timezone.utc).isoformat(),
        "input": input_metadata,
        "eligibility": replay_metadata,
        "metrics_by_prefix": metrics_by_prefix,
        "metrics_overall": summarize_events(events),
        "decision": {
            "structural_contract_pass": not contract_errors,
            "predictive_performance_certified": False,
            "preference_satisfaction_validated": False,
            "causal_benefit_validated": False,
            "interpretation": (
                "Next-choice reuse is a low-data behavioral diagnostic. It does not measure "
                "satisfaction, counterfactual ranking quality, or the effect of following advice."
            ),
        },
        "limits": [
            "Champion choice is observational and depends on ownership, bans, autofill, patch, teammates, opponents and player intent.",
            "The next observed choice is a reuse proxy, not a satisfaction or preference label.",
            "Each prefix contributes at most one next match per account-role-queue stratum; Wilson intervals ignore session dependence.",
            "Wilson intervals are event-level diagnostics and do not adjust for repeated accounts or target matches shared across accounts.",
            "At prefix 3, familiar hit@3 is mechanical whenever the context contains at most three distinct champions.",
            "Discovery coverage only evaluates an unseen champion when the player later selected it; it does not evaluate unchosen alternatives.",
            "A champion tried previously in another role or queue is neither context-familiar nor genuinely novel and is reported separately.",
            "Current feedback is withheld because applying it to earlier prefixes would leak future information.",
            "The replay does not tune recommendation weights and cannot certify causal or universal superiority over simple baselines.",
        ],
    }


def parse_args(argv: Iterable[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, required=True)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--limit", type=int, default=6)
    parser.add_argument("--recent-games", type=int, default=20)
    parser.add_argument("--trial-budget", type=int, default=3)
    args = parser.parse_args(argv)
    for field in ("limit", "recent_games", "trial_budget"):
        if getattr(args, field) < 0:
            parser.error(f"--{field.replace('_', '-')} must be non-negative")
    return args


def main(argv: Iterable[str] | None = None) -> int:
    args = parse_args(argv)
    report = build_report(
        args.db,
        limit=args.limit,
        recent_games=args.recent_games,
        trial_budget=args.trial_budget,
    )
    rendered = json.dumps(report, indent=2, sort_keys=True) + "\n"
    if args.output:
        output = args.output.expanduser().resolve()
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(rendered, encoding="utf-8")
        print(json.dumps({"output": str(output), "decision": report["decision"]}, sort_keys=True))
    else:
        print(rendered, end="")
    return 0 if report["decision"]["structural_contract_pass"] else 1


if __name__ == "__main__":
    sys.exit(main())
