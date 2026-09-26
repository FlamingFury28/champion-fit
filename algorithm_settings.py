"""Validated, request-scoped algorithm configuration and revision storage."""

from __future__ import annotations

import hashlib
import json
import math
import sqlite3
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import datetime, timezone
from types import MappingProxyType
from typing import Any, Iterator, Mapping


class SettingsValidationError(ValueError):
    """Raised when a complete settings document violates its schema."""


class SettingsConflictError(RuntimeError):
    """Raised when an optimistic settings write used a stale revision."""

    def __init__(self, snapshot: dict[str, Any]) -> None:
        self.snapshot = snapshot
        super().__init__(
            f"settings revision conflict; current revision is {snapshot['revision']}"
        )


class _SettingsStoreUninitialized(RuntimeError):
    pass


def _plain(value: Any) -> Any:
    if isinstance(value, Mapping):
        return {key: _plain(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_plain(item) for item in value]
    return value


def _freeze(value: Any) -> Any:
    if isinstance(value, Mapping):
        return MappingProxyType({key: _freeze(item) for key, item in value.items()})
    if isinstance(value, (list, tuple)):
        return tuple(_freeze(item) for item in value)
    return value


_RECOMMENDED: Mapping[str, Any] = _freeze({
    "evidence": {
        "prior_mean": 0.5,
        "prior_strength": 8,
        "credible_mass": 0.9,
        "meaningful_delta": 0.03,
        "family_alpha": 0.05,
        "min_games": 20,
        "display_min_games": 3,
        "indicative_games": 8,
        "recommendation_limit": 3,
    },
    "context": {"queue": "420", "days": 180},
    "attribution": {
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
    },
    "matchup": {"recent_days": 90, "recent_weight": 0, "limit": 12},
    "friends": {"min_shared_games": 5},
    "playstyle": {
        "percentile_min_games": 10,
        "duration_bounds": [20, 30, 40],
        "suggestion_limit": 10,
    },
    "training": {"budget": 20, "max_candidates": 3},
    # This controls observed-preference recommendations.  It deliberately has
    # no prior: the engine ranks only evidence observed for the active scope.
    "recommendations": {
        "limit": 6,
        "trial_budget": 3,
        "period": {"value": 0, "unit": "days"},
        "queue": "all",
        "confidence": 0.9,
    },
})


def _legacy_settings() -> dict[str, Any]:
    settings = recommended_settings()
    # Revision 1 is an archived pre-recommendations document.  Keep it byte
    # compatible so its stored fingerprint remains an immutable identifier.
    settings.pop("recommendations")
    settings["context"] = {"queue": "all", "days": "all"}
    settings["attribution"].update({
        "loss_weights": [0, 0.04, 0.15, 0.35, 0.6, 0.88],
        "win_short_weight": 0.45,
        "win_long_weight": 0.95,
        "quasi_afk_multiplier": 0.35,
        "early_surrender_multiplier": 0.55,
        "team_collapse_multiplier": 0.65,
        "surrender_multiplier": 0.85,
        "kill_deficit_multiplier": 0.85,
        "negative_veto": True,
    })
    settings["matchup"]["recent_weight"] = 0.15
    settings["training"]["budget"] = 400
    return settings


def _field(
    path: str,
    label: str,
    description: str,
    field_type: str,
    group: str,
    minimum: float | int | None = None,
    maximum: float | int | None = None,
    options: list[Any] | None = None,
) -> dict[str, Any]:
    return {
        "path": path,
        "label": label,
        "description": description,
        "type": field_type,
        "min": minimum,
        "max": maximum,
        "options": options,
        "group": group,
    }


_SCHEMA = _freeze([
    _field("evidence.prior_mean", "Media del prior", "Probabilita centrale del prior Beta.", "number", "Evidenza", 0.4, 0.6),
    _field("evidence.prior_strength", "Forza del prior", "Osservazioni equivalenti del prior Beta.", "integer", "Evidenza", 2, 50),
    _field("evidence.credible_mass", "Massa credibile", "Massa dell'intervallo credibile descrittivo.", "number", "Evidenza", 0.8, 0.99),
    _field("evidence.meaningful_delta", "Differenza rilevante", "Effetto minimo pratico come quota.", "number", "Evidenza", 0.01, 0.15),
    _field("evidence.family_alpha", "Alpha della famiglia", "Rischio complessivo usato dal controllo della famiglia.", "number", "Evidenza", 0.001, 0.1),
    _field("evidence.min_games", "Partite minime", "Supporto minimo per una decisione operativa.", "integer", "Evidenza", 20, 500),
    _field("evidence.display_min_games", "Partite per visualizzare", "Supporto minimo per mostrare una stima.", "integer", "Evidenza", 1, 500),
    _field("evidence.indicative_games", "Partite indicative", "Supporto minimo per un segnale indicativo.", "integer", "Evidenza", 1, 500),
    _field("evidence.recommendation_limit", "Limite raccomandazioni", "Numero massimo di raccomandazioni mostrate.", "integer", "Evidenza", 1, 40),
    _field("context.queue", "Coda", "Coda predefinita dell'analisi.", "select", "Contesto", options=["420", "440", "400", "430", "490"]),
    _field("context.days", "Periodo", "Finestra temporale predefinita in giorni.", "select", "Contesto", options=[90, 180, 365, "all"]),
    _field("attribution.duration_bounds", "Fasce durata", "Cinque soglie crescenti che definiscono sei fasce.", "number[]", "Attribuzione", 1, 90),
    _field("attribution.loss_weights", "Pesi sconfitte", "Sei pesi non decrescenti per fascia di durata.", "number[]", "Attribuzione", 0, 1),
    _field("attribution.win_short_minutes", "Durata vittoria breve", "Soglia in minuti per distinguere le vittorie brevi.", "integer", "Attribuzione", 1, 90),
    _field("attribution.win_short_weight", "Peso vittoria breve", "Peso interpretativo delle vittorie brevi.", "number", "Attribuzione", 0, 1),
    _field("attribution.win_long_weight", "Peso vittoria lunga", "Peso interpretativo delle altre vittorie.", "number", "Attribuzione", 0, 1),
    _field("attribution.explicit_afk_weight", "Peso AFK esplicito", "Peso di una sconfitta con AFK esplicito.", "number", "Attribuzione", 0, 1),
    _field("attribution.quasi_afk_multiplier", "Moltiplicatore quasi AFK", "Moltiplicatore per sospetto quasi AFK.", "number", "Attribuzione", 0, 1),
    _field("attribution.early_surrender_multiplier", "Moltiplicatore resa precoce", "Moltiplicatore per resa precoce.", "number", "Attribuzione", 0, 1),
    _field("attribution.team_collapse_multiplier", "Moltiplicatore collasso squadra", "Moltiplicatore per collasso della squadra.", "number", "Attribuzione", 0, 1),
    _field("attribution.surrender_multiplier", "Moltiplicatore resa", "Moltiplicatore per una resa ordinaria.", "number", "Attribuzione", 0, 1),
    _field("attribution.kill_deficit_multiplier", "Moltiplicatore deficit kill", "Moltiplicatore per un forte deficit di eliminazioni.", "number", "Attribuzione", 0, 1),
    _field("attribution.contaminated_threshold", "Soglia contaminazione", "Soglia sotto cui l'evidenza negativa e contaminata.", "number", "Attribuzione", 0, 1),
    _field("attribution.negative_veto", "Veto negativo", "Richiede evidenza negativa attribuita per il segnale forte.", "boolean", "Attribuzione"),
    _field("matchup.recent_days", "Giorni recenti", "Finestra usata per il correttivo recente.", "integer", "Matchup", 7, 365),
    _field("matchup.recent_weight", "Peso recente", "Quota massima del correttivo recente.", "number", "Matchup", 0, 0.5),
    _field("matchup.limit", "Limite matchup", "Numero massimo di matchup mostrati.", "integer", "Matchup", 1, 40),
    _field("friends.min_shared_games", "Partite condivise minime", "Partite minime per mostrare un compagno.", "integer", "Compagni", 1, 100),
    _field("playstyle.percentile_min_games", "Partite per percentile", "Campione minimo per i percentili contestuali.", "integer", "Playstyle", 10, 100),
    _field("playstyle.duration_bounds", "Fasce durata playstyle", "Tre soglie crescenti per il contesto di durata.", "number[]", "Playstyle", 1, 90),
    _field("playstyle.suggestion_limit", "Limite suggerimenti", "Numero massimo di suggerimenti playstyle.", "integer", "Playstyle", 1, 40),
    _field("training.budget", "Budget allenamento", "Numero totale di partite da allocare.", "integer", "Allenamento", 1, 2000),
    _field("training.max_candidates", "Candidati allenamento", "Numero massimo di candidati nel piano.", "integer", "Allenamento", 1, 12),
    _field("recommendations.limit", "Limite raccomandazioni", "Numero massimo di campioni in ciascuna lista di familiari e scoperte.", "integer", "Raccomandazioni", 1, 40),
    _field("recommendations.trial_budget", "Budget di prova", "Massimo di partite nel ciclo breve, una per candidato familiare o da scoprire.", "integer", "Raccomandazioni", 1, 10),
    _field("recommendations.period", "Periodo", "0 usa tutto lo storico; altrimenti indica un numero di giorni o di partite per account.", "period", "Raccomandazioni", 0, 100000, options=["days", "games"]),
    _field("recommendations.queue", "Coda", "Code incluse nelle preferenze osservate.", "select", "Raccomandazioni", options=["all", "auto", "420", "440", "400", "430", "490", "480", "700"]),
    _field("recommendations.confidence", "Confidenza", "Copertura degli intervalli binomiali descrittivi (0,9 = 90%). Non cambia l'ordine delle preferenze.", "number", "Raccomandazioni", 0.8, 0.99),
])


def recommended_settings() -> dict[str, Any]:
    """Return an independent JSON-compatible copy of the accepted defaults."""
    return _plain(_RECOMMENDED)


def _require_keys(value: Any, expected: set[str], path: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise SettingsValidationError(f"{path or 'settings'} must be an object")
    actual = set(value)
    if actual != expected:
        missing = sorted(expected - actual)
        unknown = sorted(actual - expected, key=str)
        details = []
        if missing:
            details.append(f"missing keys: {', '.join(missing)}")
        if unknown:
            details.append(f"unknown keys: {', '.join(map(str, unknown))}")
        raise SettingsValidationError(f"{path or 'settings'} ({'; '.join(details)})")
    if any(not isinstance(key, str) for key in value):
        raise SettingsValidationError(f"{path or 'settings'} keys must be strings")
    return value


def _number(value: Any, path: str, minimum: float, maximum: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise SettingsValidationError(f"{path} must be a number")
    try:
        result = float(value)
    except (OverflowError, ValueError):
        raise SettingsValidationError(f"{path} must be finite") from None
    if not math.isfinite(result):
        raise SettingsValidationError(f"{path} must be finite")
    if not minimum <= result <= maximum:
        raise SettingsValidationError(f"{path} must be between {minimum} and {maximum}")
    return result


def _integer(value: Any, path: str, minimum: int, maximum: int) -> int:
    if type(value) is not int:
        raise SettingsValidationError(f"{path} must be an integer")
    if not minimum <= value <= maximum:
        raise SettingsValidationError(f"{path} must be between {minimum} and {maximum}")
    return value


def _array(
    value: Any,
    path: str,
    length: int,
    minimum: float,
    maximum: float,
    *,
    integers: bool,
) -> list[float | int]:
    if not isinstance(value, (list, tuple)) or len(value) != length:
        raise SettingsValidationError(f"{path} must contain exactly {length} values")
    if integers:
        return [_integer(item, f"{path}[{index}]", int(minimum), int(maximum)) for index, item in enumerate(value)]
    return [_number(item, f"{path}[{index}]", minimum, maximum) for index, item in enumerate(value)]


def _strictly_increasing(values: list[float | int], path: str) -> None:
    if any(left >= right for left, right in zip(values, values[1:])):
        raise SettingsValidationError(f"{path} must be strictly increasing")


def validate_settings(settings: Mapping[str, Any]) -> dict[str, Any]:
    """Validate a complete document and return normalized plain JSON data."""
    source = _require_keys(settings, set(_RECOMMENDED), "")
    result: dict[str, Any] = {}

    evidence = _require_keys(source["evidence"], set(_RECOMMENDED["evidence"]), "evidence")
    result["evidence"] = {
        "prior_mean": _number(evidence["prior_mean"], "evidence.prior_mean", 0.4, 0.6),
        "prior_strength": _integer(evidence["prior_strength"], "evidence.prior_strength", 2, 50),
        "credible_mass": _number(evidence["credible_mass"], "evidence.credible_mass", 0.8, 0.99),
        "meaningful_delta": _number(evidence["meaningful_delta"], "evidence.meaningful_delta", 0.01, 0.15),
        "family_alpha": _number(evidence["family_alpha"], "evidence.family_alpha", 0.001, 0.1),
        "min_games": _integer(evidence["min_games"], "evidence.min_games", 20, 500),
        "display_min_games": _integer(evidence["display_min_games"], "evidence.display_min_games", 1, 500),
        "indicative_games": _integer(evidence["indicative_games"], "evidence.indicative_games", 1, 500),
        "recommendation_limit": _integer(evidence["recommendation_limit"], "evidence.recommendation_limit", 1, 40),
    }
    if result["evidence"]["display_min_games"] > result["evidence"]["min_games"]:
        raise SettingsValidationError("evidence.display_min_games must not exceed evidence.min_games")
    if not result["evidence"]["display_min_games"] <= result["evidence"]["indicative_games"] <= result["evidence"]["min_games"]:
        raise SettingsValidationError("evidence.indicative_games must be between display_min_games and min_games")

    context = _require_keys(source["context"], set(_RECOMMENDED["context"]), "context")
    queue = context["queue"]
    if type(queue) is not str or queue not in {"420", "440", "400", "430", "490"}:
        raise SettingsValidationError("context.queue must be a canonical queue id")
    days = context["days"]
    if type(days) is not int and days != "all":
        raise SettingsValidationError("context.days must be 90, 180, 365, or 'all'")
    if days not in (90, 180, 365, "all"):
        raise SettingsValidationError("context.days must be 90, 180, 365, or 'all'")
    result["context"] = {"queue": queue, "days": days}

    attribution = _require_keys(source["attribution"], set(_RECOMMENDED["attribution"]), "attribution")
    duration_bounds = _array(attribution["duration_bounds"], "attribution.duration_bounds", 5, 1, 90, integers=False)
    _strictly_increasing(duration_bounds, "attribution.duration_bounds")
    loss_weights = _array(attribution["loss_weights"], "attribution.loss_weights", 6, 0, 1, integers=False)
    if any(left > right for left, right in zip(loss_weights, loss_weights[1:])):
        raise SettingsValidationError("attribution.loss_weights must be nondecreasing")
    negative_veto = attribution["negative_veto"]
    if type(negative_veto) is not bool:
        raise SettingsValidationError("attribution.negative_veto must be a boolean")
    result["attribution"] = {
        "duration_bounds": duration_bounds,
        "loss_weights": loss_weights,
        "win_short_minutes": _integer(attribution["win_short_minutes"], "attribution.win_short_minutes", 1, 90),
        "win_short_weight": _number(attribution["win_short_weight"], "attribution.win_short_weight", 0, 1),
        "win_long_weight": _number(attribution["win_long_weight"], "attribution.win_long_weight", 0, 1),
        "explicit_afk_weight": _number(attribution["explicit_afk_weight"], "attribution.explicit_afk_weight", 0, 1),
        "quasi_afk_multiplier": _number(attribution["quasi_afk_multiplier"], "attribution.quasi_afk_multiplier", 0, 1),
        "early_surrender_multiplier": _number(attribution["early_surrender_multiplier"], "attribution.early_surrender_multiplier", 0, 1),
        "team_collapse_multiplier": _number(attribution["team_collapse_multiplier"], "attribution.team_collapse_multiplier", 0, 1),
        "surrender_multiplier": _number(attribution["surrender_multiplier"], "attribution.surrender_multiplier", 0, 1),
        "kill_deficit_multiplier": _number(attribution["kill_deficit_multiplier"], "attribution.kill_deficit_multiplier", 0, 1),
        "contaminated_threshold": _number(attribution["contaminated_threshold"], "attribution.contaminated_threshold", 0, 1),
        "negative_veto": negative_veto,
    }

    matchup = _require_keys(source["matchup"], set(_RECOMMENDED["matchup"]), "matchup")
    result["matchup"] = {
        "recent_days": _integer(matchup["recent_days"], "matchup.recent_days", 7, 365),
        "recent_weight": _number(matchup["recent_weight"], "matchup.recent_weight", 0, 0.5),
        "limit": _integer(matchup["limit"], "matchup.limit", 1, 40),
    }
    friends = _require_keys(source["friends"], set(_RECOMMENDED["friends"]), "friends")
    result["friends"] = {
        "min_shared_games": _integer(friends["min_shared_games"], "friends.min_shared_games", 1, 100)
    }
    playstyle = _require_keys(source["playstyle"], set(_RECOMMENDED["playstyle"]), "playstyle")
    playstyle_bounds = _array(playstyle["duration_bounds"], "playstyle.duration_bounds", 3, 1, 90, integers=False)
    _strictly_increasing(playstyle_bounds, "playstyle.duration_bounds")
    result["playstyle"] = {
        "percentile_min_games": _integer(playstyle["percentile_min_games"], "playstyle.percentile_min_games", 10, 100),
        "duration_bounds": playstyle_bounds,
        "suggestion_limit": _integer(playstyle["suggestion_limit"], "playstyle.suggestion_limit", 1, 40),
    }
    training = _require_keys(source["training"], set(_RECOMMENDED["training"]), "training")
    result["training"] = {
        "budget": _integer(training["budget"], "training.budget", 1, 2000),
        "max_candidates": _integer(training["max_candidates"], "training.max_candidates", 1, 12),
    }
    recommendations = _require_keys(source["recommendations"], set(_RECOMMENDED["recommendations"]), "recommendations")
    period = _require_keys(recommendations["period"], {"value", "unit"}, "recommendations.period")
    period_unit = period["unit"]
    if type(period_unit) is not str or period_unit not in {"days", "games"}:
        raise SettingsValidationError("recommendations.period.unit must be 'days' or 'games'")
    normalized_period = {
        "value": _integer(period["value"], "recommendations.period.value", 0, 100000),
        "unit": period_unit,
    }
    recommendation_queue = recommendations["queue"]
    if type(recommendation_queue) is not str or recommendation_queue not in {"all", "auto", "420", "440", "400", "430", "490", "480", "700"}:
        raise SettingsValidationError("recommendations.queue must be a supported queue id")
    result["recommendations"] = {
        "limit": _integer(recommendations["limit"], "recommendations.limit", 1, 40),
        "trial_budget": _integer(recommendations["trial_budget"], "recommendations.trial_budget", 1, 10),
        "period": normalized_period,
        "queue": recommendation_queue,
        "confidence": _number(recommendations["confidence"], "recommendations.confidence", 0.8, 0.99),
    }
    return result


def fingerprint_settings(settings: Mapping[str, Any]) -> str:
    """Return the stable SHA-256 of a normalized settings document."""
    normalized = validate_settings(settings)
    payload = json.dumps(normalized, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _fingerprint_unchecked(settings: Mapping[str, Any]) -> str:
    payload = json.dumps(_plain(settings), sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _with_recommendation_defaults(settings: Mapping[str, Any]) -> tuple[dict[str, Any], bool]:
    """Upgrade only the new runtime section without rewriting an archive."""
    plain = _plain(settings)
    if not isinstance(plain, dict) or "recommendations" in plain:
        return plain, False
    plain["recommendations"] = _plain(_RECOMMENDED["recommendations"])
    return plain, True


_DEFAULT_SETTINGS = _freeze(validate_settings(_RECOMMENDED))
_DEFAULT_FINGERPRINT = fingerprint_settings(_RECOMMENDED)
_SETTINGS_CONTEXT: ContextVar[tuple[Mapping[str, Any], int, str] | None] = ContextVar(
    "algorithm_settings", default=None
)


def current_settings() -> Mapping[str, Any]:
    """Return the immutable settings bound to this execution context."""
    active = _SETTINGS_CONTEXT.get()
    return active[0] if active is not None else _DEFAULT_SETTINGS


def current_snapshot() -> dict[str, Any]:
    """Return revision metadata for the settings bound to this context."""
    active = _SETTINGS_CONTEXT.get()
    if active is None:
        return {"revision": 0, "fingerprint": _DEFAULT_FINGERPRINT}
    return {"revision": active[1], "fingerprint": active[2]}


@contextmanager
def settings_context(
    settings: Mapping[str, Any], revision: int = 0, fingerprint: str | None = None
) -> Iterator[Mapping[str, Any]]:
    """Bind validated immutable settings for one request/task and restore them."""
    if type(revision) is not int or revision < 0:
        raise ValueError("revision must be a non-negative integer")
    upgraded, historical_without_recommendations = _with_recommendation_defaults(settings)
    normalized = validate_settings(upgraded)
    calculated = fingerprint_settings(normalized)
    historical_fingerprint = _fingerprint_unchecked(settings) if historical_without_recommendations else calculated
    if fingerprint is not None and fingerprint != historical_fingerprint:
        raise ValueError("fingerprint does not match settings")
    immutable = _freeze(normalized)
    token = _SETTINGS_CONTEXT.set((immutable, revision, fingerprint or calculated))
    try:
        yield immutable
    finally:
        _SETTINGS_CONTEXT.reset(token)


def _row_value(row: Any, key: str, index: int) -> Any:
    try:
        return row[key]
    except (KeyError, TypeError, IndexError):
        return row[index]


def _commit(connection: Any) -> None:
    connection.commit()


def _rollback(connection: Any) -> None:
    rollback = getattr(connection, "rollback", None)
    if rollback is not None:
        rollback()
    else:
        connection.raw.rollback()


def ensure_settings(connection: Any) -> None:
    """Create and initialize the revision store, idempotently."""
    connection.execute(
        """CREATE TABLE IF NOT EXISTS algorithm_settings_revisions (
            revision INTEGER PRIMARY KEY,
            fingerprint TEXT NOT NULL,
            settings_json TEXT NOT NULL,
            created_at TEXT NOT NULL
        )"""
    )
    connection.execute(
        """CREATE TABLE IF NOT EXISTS algorithm_settings_state (
            singleton_id INTEGER PRIMARY KEY,
            current_revision INTEGER NOT NULL,
            FOREIGN KEY (current_revision) REFERENCES algorithm_settings_revisions(revision)
        )"""
    )
    state = connection.execute(
        "SELECT current_revision FROM algorithm_settings_state WHERE singleton_id=1"
    ).fetchone()
    if state is None:
        now = datetime.now(timezone.utc).isoformat()
        legacy = _legacy_settings()
        recommended = recommended_settings()
        connection.execute(
            """INSERT INTO algorithm_settings_revisions
            (revision,fingerprint,settings_json,created_at) VALUES(?,?,?,?)
            ON CONFLICT(revision) DO NOTHING""",
            (1, _fingerprint_unchecked(legacy), json.dumps(legacy, sort_keys=True, separators=(",", ":")), now),
        )
        connection.execute(
            """INSERT INTO algorithm_settings_revisions
            (revision,fingerprint,settings_json,created_at) VALUES(?,?,?,?)
            ON CONFLICT(revision) DO NOTHING""",
            (2, fingerprint_settings(recommended), json.dumps(recommended, sort_keys=True, separators=(",", ":")), now),
        )
        connection.execute(
            """INSERT INTO algorithm_settings_state(singleton_id,current_revision) VALUES(1,2)
            ON CONFLICT(singleton_id) DO NOTHING"""
        )
    _commit(connection)


def _snapshot(connection: Any) -> dict[str, Any]:
    row = connection.execute(
        """SELECT r.revision,r.fingerprint,r.settings_json
        FROM algorithm_settings_state s
        JOIN algorithm_settings_revisions r ON r.revision=s.current_revision
        WHERE s.singleton_id=1"""
    ).fetchone()
    if row is None:
        raise _SettingsStoreUninitialized("algorithm settings store is not initialized")
    history_rows = connection.execute(
        "SELECT revision,fingerprint,settings_json,created_at FROM algorithm_settings_revisions ORDER BY revision DESC"
    ).fetchall()
    history = [
        {
            "revision": int(_row_value(item, "revision", 0)),
            "fingerprint": _row_value(item, "fingerprint", 1),
            "settings": json.loads(_row_value(item, "settings_json", 2)),
            "created_at": _row_value(item, "created_at", 3),
        }
        for item in history_rows
    ]
    return {
        "revision": int(_row_value(row, "revision", 0)),
        "fingerprint": _row_value(row, "fingerprint", 1),
        "settings": json.loads(_row_value(row, "settings_json", 2)),
        "defaults": recommended_settings(),
        "schema": _plain(_SCHEMA),
        "history": history,
    }


def get_settings_snapshot(connection: Any) -> dict[str, Any]:
    """Load the active settings plus defaults, editor schema, and history."""
    try:
        return _snapshot(connection)
    except _SettingsStoreUninitialized:
        ensure_settings(connection)
        return _snapshot(connection)
    except Exception as error:
        message = str(error).lower()
        missing_sqlite_table = (
            isinstance(error, sqlite3.OperationalError)
            and "no such table" in message
            and "algorithm_settings" in message
        )
        missing_postgres_table = (
            getattr(error, "sqlstate", None) == "42P01"
            and "algorithm_settings" in message
        )
        if not (missing_sqlite_table or missing_postgres_table):
            raise
        # PostgreSQL leaves a transaction failed after an undefined-table
        # error. This branch is only for a genuinely new settings store.
        _rollback(connection)
        ensure_settings(connection)
        return _snapshot(connection)


def migrate_recommendation_settings(connection: Any) -> dict[str, Any]:
    """Append or upgrade the recommendations section on the active revision.

    This is intentionally startup-only.  Historical rows remain raw archival
    documents and retain their original fingerprints; only the active document
    is copied forward through the normal compare-and-swap write path.
    """
    snapshot = get_settings_snapshot(connection)
    active_settings = snapshot["settings"]
    if not isinstance(active_settings, Mapping):
        return snapshot
    upgraded, changed = _with_recommendation_defaults(active_settings)
    if not changed:
        recommendations = _plain(upgraded["recommendations"])
        if "period" not in recommendations and ("days" in recommendations or "recent_games" in recommendations):
            old_default = {
                "limit": 6, "recent_games": 20, "trial_budget": 3,
                "days": "all", "queue": "auto", "confidence": 0.9,
            }
            was_default = recommendations == old_default
            days = recommendations.pop("days", "all")
            recent_games = recommendations.pop("recent_games", 20)
            if was_default:
                period = {"value": 0, "unit": "days"}
                recommendations["queue"] = "all"
            elif days == "all":
                period = {"value": recent_games, "unit": "games"}
            else:
                period = {"value": days, "unit": "days"}
            recommendations["period"] = period
            upgraded["recommendations"] = recommendations
            changed = True
    if not changed:
        return snapshot
    try:
        return save_settings(connection, snapshot["revision"], upgraded)
    except SettingsConflictError:
        # Another startup may have observed the same legacy revision and
        # completed the append first.  Treat only that completed migration as
        # success; a different conflicting write remains actionable.
        refreshed = get_settings_snapshot(connection)
        refreshed_settings = refreshed["settings"]
        current_recommendations = refreshed_settings.get("recommendations") if isinstance(refreshed_settings, Mapping) else None
        if isinstance(current_recommendations, Mapping) and "period" in current_recommendations:
            return refreshed
        raise


def _has_active_transaction(connection: Any) -> bool:
    if isinstance(connection, sqlite3.Connection):
        return connection.in_transaction
    raw = getattr(connection, "raw", None)
    status = getattr(getattr(raw, "info", None), "transaction_status", None)
    if status is None:
        return False
    try:
        return int(status) != 0  # psycopg.pq.TransactionStatus.IDLE
    except (TypeError, ValueError):
        return not str(status).upper().endswith("IDLE")


def _begin_write(connection: Any) -> bool:
    if _has_active_transaction(connection):
        connection.execute("SAVEPOINT algorithm_settings_save")
        return False
    if isinstance(connection, sqlite3.Connection):
        connection.execute("BEGIN IMMEDIATE")
    else:
        connection.execute("BEGIN")
    return True


def _finish_write(connection: Any, owns_transaction: bool) -> None:
    if owns_transaction:
        _commit(connection)
    else:
        connection.execute("RELEASE SAVEPOINT algorithm_settings_save")


def _abort_write(connection: Any, owns_transaction: bool) -> None:
    if owns_transaction:
        _rollback(connection)
    else:
        connection.execute("ROLLBACK TO SAVEPOINT algorithm_settings_save")
        connection.execute("RELEASE SAVEPOINT algorithm_settings_save")


def save_settings(
    connection: Any, expected_revision: int, settings: Mapping[str, Any]
) -> dict[str, Any]:
    """Append and activate settings when ``expected_revision`` is current."""
    if type(expected_revision) is not int or expected_revision < 0:
        raise ValueError("expected_revision must be a non-negative integer")
    normalized = validate_settings(settings)
    fingerprint = fingerprint_settings(normalized)
    owns_transaction = _begin_write(connection)
    try:
        cursor = connection.execute(
            """UPDATE algorithm_settings_state
            SET current_revision=current_revision
            WHERE singleton_id=1 AND current_revision=?""",
            (expected_revision,),
        )
        if cursor.rowcount != 1:
            _abort_write(connection, owns_transaction)
            raise SettingsConflictError(_snapshot(connection))
        row = connection.execute(
            "SELECT COALESCE(MAX(revision),0)+1 AS revision FROM algorithm_settings_revisions"
        ).fetchone()
        revision = int(_row_value(row, "revision", 0))
        connection.execute(
            "INSERT INTO algorithm_settings_revisions(revision,fingerprint,settings_json,created_at) VALUES(?,?,?,?)",
            (
                revision,
                fingerprint,
                json.dumps(normalized, sort_keys=True, separators=(",", ":"), ensure_ascii=False),
                datetime.now(timezone.utc).isoformat(),
            ),
        )
        activated = connection.execute(
            """UPDATE algorithm_settings_state SET current_revision=?
            WHERE singleton_id=1 AND current_revision=?""",
            (revision, expected_revision),
        )
        if activated.rowcount != 1:
            raise RuntimeError("settings revision changed during save")
        _finish_write(connection, owns_transaction)
    except SettingsConflictError:
        raise
    except Exception:
        _abort_write(connection, owns_transaction)
        raise
    return _snapshot(connection)
