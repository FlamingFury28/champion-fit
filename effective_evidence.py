"""Resolve live match-attribution evidence without mutating archived imports.

The archive keeps the values that were supplied at import time.  This module
is the narrow runtime boundary that can apply the current attribution policy
to identifiable Riot defaults while preserving explicit historical judgments.
"""

from __future__ import annotations

import json
import math
from collections.abc import Mapping
from typing import Any


DEFAULT_ATTRIBUTION_SETTINGS = {
    "duration_bounds": [10, 15, 20, 23, 27],
    "loss_weights": [1, 1, 1, 1, 1, 1],
    "win_short_minutes": 20,
    "win_short_weight": 1,
    "win_long_weight": 1,
    "explicit_afk_weight": 0,
    "quasi_afk_multiplier": 1,
    "early_surrender_multiplier": 1,
    "team_collapse_multiplier": 1,
    "surrender_multiplier": 1,
    "kill_deficit_multiplier": 1,
    "contaminated_threshold": 0.45,
    "negative_veto": False,
}

_WEIGHT_FIELDS = ("loss_attribution_weight", "win_evidence_weight")


def _as_mapping(row: Mapping[str, Any] | Any) -> Mapping[str, Any]:
    """Accept dict-like rows from SQLite and PostgreSQL adapters."""
    if isinstance(row, Mapping):
        return row
    try:
        return {key: row[key] for key in row.keys()}
    except (AttributeError, TypeError):
        return {}


def _value(row: Mapping[str, Any], *names: str, default: Any = None) -> Any:
    for name in names:
        if name in row:
            return row[name]
    return default


def _truthy(value: Any) -> bool:
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on"}
    return bool(value)


def _number(value: Any, default: float = 0.0) -> float:
    """Return a bounded evidence weight; malformed values are conservative."""
    if isinstance(value, bool):
        return default
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    if not math.isfinite(number) or number < 0 or number > 1:
        return default
    return number


def _valid_number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) and 0 <= number <= 1 else None


def _duration(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) and number >= 0 else None


def _flags(value: Any) -> set[str]:
    if isinstance(value, Mapping):
        return {str(key).strip().lower() for key, enabled in value.items() if _truthy(enabled)}
    if isinstance(value, (list, tuple, set, frozenset)):
        return {str(item).strip().lower() for item in value if str(item).strip()}
    return {
        item.strip().lower()
        for item in str(value or "").replace(",", ";").split(";")
        if item.strip() and item.strip().lower() != "none"
    }


def _settings(settings: Mapping[str, Any] | None) -> dict[str, Any]:
    """Merge valid runtime settings, with no dependency on JSON SQL support."""
    supplied: Any = settings
    if supplied is None:
        try:
            from algorithm_settings import current_settings
            supplied = current_settings()
        except (ImportError, AttributeError, TypeError, ValueError):
            supplied = {}
    if isinstance(supplied, Mapping) and isinstance(supplied.get("attribution"), Mapping):
        supplied = supplied["attribution"]
    if not isinstance(supplied, Mapping):
        supplied = {}

    result = dict(DEFAULT_ATTRIBUTION_SETTINGS)
    bounds = supplied.get("duration_bounds")
    weights = supplied.get("loss_weights")
    try:
        parsed_bounds = [float(item) for item in bounds]
        parsed_weights = [float(item) for item in weights]
        valid_bands = (
            len(parsed_bounds) > 0
            and len(parsed_weights) == len(parsed_bounds) + 1
            and all(math.isfinite(item) and item >= 0 for item in parsed_bounds)
            and all(left < right for left, right in zip(parsed_bounds, parsed_bounds[1:]))
            and all(math.isfinite(item) and 0 <= item <= 1 for item in parsed_weights)
        )
    except (TypeError, ValueError):
        valid_bands = False
    if valid_bands:
        result["duration_bounds"] = parsed_bounds
        result["loss_weights"] = parsed_weights

    try:
        short_minutes = float(supplied.get("win_short_minutes"))
    except (TypeError, ValueError):
        short_minutes = None
    if short_minutes is not None and math.isfinite(short_minutes) and short_minutes >= 0:
        result["win_short_minutes"] = short_minutes

    for field in (
        "win_short_weight", "win_long_weight", "explicit_afk_weight",
        "quasi_afk_multiplier", "early_surrender_multiplier", "team_collapse_multiplier",
        "surrender_multiplier", "kill_deficit_multiplier", "contaminated_threshold",
    ):
        candidate = _valid_number(supplied.get(field))
        if candidate is not None:
            result[field] = candidate
    if "negative_veto" in supplied:
        result["negative_veto"] = _truthy(supplied["negative_veto"])
    return result


def _ledger(row: Mapping[str, Any]) -> tuple[str | None, dict[str, Any] | None]:
    classification = _value(row, "classification", "provenance_classification")
    raw = _value(row, "overrides_json", "provenance_overrides_json")
    if raw is None:
        return (str(classification) if classification is not None else None), None
    if isinstance(raw, Mapping):
        parsed = dict(raw)
    elif isinstance(raw, str):
        try:
            parsed = json.loads(raw)
        except (TypeError, ValueError, json.JSONDecodeError):
            return (str(classification) if classification is not None else None), None
    else:
        return (str(classification) if classification is not None else None), None
    if not isinstance(parsed, dict):
        return (str(classification) if classification is not None else None), None
    return (str(classification) if classification is not None else None), parsed


def _manual_exclusion(row: Mapping[str, Any]) -> list[str]:
    labels = []
    if _truthy(_value(row, "annotation_afk", "annotation_afk_player", "afk_player", default=0)):
        labels.append("afk")
    if _truthy(_value(row, "annotation_griefer", "griefer", default=0)):
        labels.append("griefer")
    if _truthy(_value(row, "annotation_invincible", "invincible", default=0)):
        labels.append("invincible")
    return labels


def _configured_weights(row: Mapping[str, Any], policy: Mapping[str, Any]) -> tuple[float, float, str] | None:
    duration = _duration(_value(row, "duration_minutes", "duration"))
    if duration is None:
        return None
    win = _truthy(_value(row, "win", default=0))
    flags = _flags(_value(row, "allflags", "anomaly_flags", "flags", default=""))
    if win:
        weight = policy["win_short_weight"] if duration < policy["win_short_minutes"] else policy["win_long_weight"]
        return weight, 0.0, "configured model for known Riot default"

    index = 0
    while index < len(policy["duration_bounds"]) and duration >= policy["duration_bounds"][index]:
        index += 1
    weight = policy["loss_weights"][index]
    explicit_afk = _truthy(_value(row, "explicit_afk", default=0)) or bool(
        {"explicit_afk_teammate", "griefer"} & flags
    )
    if explicit_afk:
        return 0.0, policy["explicit_afk_weight"], "configured model: explicit AFK or griefer"

    applied = []
    for present, multiplier, label in (
        (_truthy(_value(row, "suspected_quasi_afk", default=0)) or "suspected_quasi_afk_teammate" in flags,
         policy["quasi_afk_multiplier"], "quasi AFK"),
        (_truthy(_value(row, "early_surrender", default=0)) or "early_surrender" in flags,
         policy["early_surrender_multiplier"], "early surrender"),
        ("early_team_collapse" in flags, policy["team_collapse_multiplier"], "team collapse"),
        ("surrender" in flags, policy["surrender_multiplier"], "surrender"),
        ("severe_kill_deficit" in flags, policy["kill_deficit_multiplier"], "kill deficit"),
    ):
        if present:
            weight *= multiplier
            applied.append(label)
    suffix = " with " + ", ".join(applied) if applied else ""
    return 0.0, _number(weight), "configured model for known Riot default" + suffix


def resolve_effective_evidence(row: Mapping[str, Any] | Any, settings: Mapping[str, Any] | None = None) -> dict[str, Any]:
    """Resolve bounded positive/negative evidence for one archived match row.

    Manual exclusion annotations take precedence over all other sources.  A
    numeric value is treated as an explicit override only when the provenance
    ledger contains that exact field with a finite value in ``[0, 1]``.
    """
    facts = _as_mapping(row)
    policy = _settings(settings)
    win = _truthy(_value(facts, "win", default=0))
    stored_win = _number(_value(facts, "stored_win_weight", "win_evidence_weight"))
    stored_loss = _number(_value(facts, "stored_loss_weight", "loss_attribution_weight"))
    classification, overrides = _ledger(facts)
    relevant_field = "win_evidence_weight" if win else "loss_attribution_weight"

    source = "archived_fallback"
    reason = "archived fallback: missing, uncertain, or malformed provenance"
    effective_win, effective_loss = (stored_win, 0.0) if win else (0.0, stored_loss)

    explicit = _valid_number(overrides.get(relevant_field)) if overrides is not None and relevant_field in overrides else None
    if explicit is not None:
        source = "ledger_override"
        reason = f"validated explicit ledger override: {relevant_field}"
        effective_win, effective_loss = (explicit, 0.0) if win else (0.0, explicit)
    elif classification == "known_riot_default" and overrides is not None:
        configured = _configured_weights(facts, policy)
        if configured is not None:
            effective_win, effective_loss, reason = configured
            source = "configured_model"

    manual = _manual_exclusion(facts)
    # Annotations say why a *loss* cannot be attributed.  They must not make
    # a winning observation appear excluded or overwrite its positive source.
    if manual and not win:
        effective_loss = 0.0
        source = "manual_annotation"
        reason = "manual annotation exclusion: " + ", ".join(manual)

    return {
        "effective_win_weight": _number(effective_win),
        "effective_loss_weight": _number(effective_loss),
        "positive_evidence": _number(effective_win) if win else 0.0,
        "negative_evidence": _number(effective_loss) if not win else 0.0,
        "attribution_source": source,
        "stored_win_weight": stored_win,
        "stored_loss_weight": stored_loss,
        "attribution_reason": reason,
    }


def load_effective_evidence(connection, where_sql: str = "", params: tuple = ()) -> dict[tuple[str, str], dict[str, Any]]:
    """Load and resolve match evidence in one joined query without writes.

    ``where_sql`` may be either a full ``WHERE ...`` clause or a predicate on
    the ``m`` alias.  It is deliberately passed through because callers build
    their own parameterized scope predicates.
    """
    clause = str(where_sql or "").strip()
    if clause and not clause.lower().startswith(("where ", "order ", "limit ")):
        clause = "WHERE " + clause
    rows = connection.execute(
        """SELECT m.account, m.match_id, m.duration_minutes, m.win,
                  m.explicit_afk, m.suspected_quasi_afk, m.early_surrender,
                  m.anomaly_flags AS allflags,
                  m.loss_attribution_weight AS stored_loss_weight,
                  m.win_evidence_weight AS stored_win_weight,
                  p.classification AS provenance_classification,
                  p.source AS provenance_source,
                  p.overrides_json AS provenance_overrides_json,
                  COALESCE(a.afk_player, 0) AS annotation_afk,
                  COALESCE(a.griefer, 0) AS annotation_griefer,
                  COALESCE(a.invincible, 0) AS annotation_invincible
           FROM match_quality m
           LEFT JOIN match_import_provenance p
             ON p.account=m.account AND p.match_id=m.match_id
           LEFT JOIN match_annotations a ON a.match_id=m.match_id
           """ + clause,
        params,
    ).fetchall()
    resolved = {}
    for row in rows:
        facts = _as_mapping(row)
        resolved[(str(facts.get("account", "")), str(facts.get("match_id", "")))] = resolve_effective_evidence(facts)
    return resolved
