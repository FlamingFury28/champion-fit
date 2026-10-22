#!/usr/bin/env python3
"""Local database-backed dashboard for the Champion Fit analysis."""

from __future__ import annotations

import argparse
import csv
import json
import math
import os
import socket
import sqlite3
import unicodedata
from functools import wraps
from datetime import date, datetime, timedelta, timezone
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse
from uuid import uuid4

from match_scoring import LOSS_WEIGHT_MODEL_VERSION, loss_attribution_weight
from storage import SQL_INTEGER_MAX, build_storage, postgres_table_columns
from queue_rules import is_supported_queue
from statistical_evidence import posterior_summary
from decision_models import (
    candidate_metrics, control_decisions, outcome_metrics,
    rank_recommendations as statistical_rank_recommendations,
)
from algorithm_settings import current_settings
from runtime_metrics import configure_logging, log_failure, measure, metrics_scope, record_metric


APP_ROOT = Path(__file__).resolve().parent
WEB_ROOT = APP_ROOT / "frontend" / "dist"
SPA_ENTRY = "/index.html"
LEGACY_PAGE_PATHS = frozenset({
    "/allocation.html", "/audit.html", "/blacklist.html", "/champion.html",
    "/fit.html", "/friends.html", "/index.html", "/profile.html",
    "/scout.html", "/synergy.html",
})
SCHEMA_PATH = APP_ROOT / "schema.sql"
DB_PATH = APP_ROOT / "champion_fit.db"
FALLBACK_SOURCE = APP_ROOT / "data"
DEFAULT_SOURCE = Path(os.environ.get("CHAMPION_FIT_SOURCE", str(FALLBACK_SOURCE)))
STORAGE = build_storage(DB_PATH, SCHEMA_PATH, os.environ.get("CHAMPION_FIT_DATABASE_URL"))
# Keep the icon catalog aligned with the patch used by the imported match data.
# Locke is not available in the older 15.16.1 catalog.
DDRAGON_VERSION = os.environ.get("DDRAGON_VERSION", "16.13.1")
ROLES = ("TOP", "JUNGLE", "MIDDLE", "BOTTOM", "SUPPORT")
DEFAULT_FRIEND_MIN_SHARED_GAMES = 5
MATCHUP_PRIOR_EVIDENCE = 8.0
MATCHUP_Z_90 = 1.6448536269514722
MATCHUP_MIN_DIRECTION_CONFIDENCE = 20.0
POSTERIOR_MEANINGFUL_DELTA = 0.03
POSTERIOR_ACTIONABLE_PROBABILITY = 0.975
POSTERIOR_RELIABLE_PROBABILITY = 0.975
RELIABILITY_LEVELS = ("exploratory", "weak", "indicative", "reliable")
REQUEST_BODY_TIMEOUT_SECONDS = 10
MAX_JSON_BODY_BYTES = 1024 * 1024
SYNC_HEARTBEAT_MAX_AGE_SECONDS = 15


def friend_min_shared_games(params: dict[str, list[str]]) -> int:
    """Return the validated minimum number of games required for Friends."""
    default = current_settings()["friends"]["min_shared_games"]
    raw_value = params.get("min_shared_games", [str(default)])[0]
    try:
        value = int(raw_value)
    except (TypeError, ValueError):
        return default
    return max(1, min(value, 10000))


def friend_name_filter(params: dict[str, list[str]]) -> str:
    """Return the case-insensitive Friends name/Riot ID filter."""
    return params.get("friend_q", [""])[0].strip().casefold()[:120]


def friend_last_game_from(params: dict[str, list[str]]) -> str:
    """Return a validated ISO date used as the minimum last-game date."""
    value = params.get("last_game_from", [""])[0].strip()
    try:
        return date.fromisoformat(value).isoformat()
    except ValueError:
        return ""


def friend_games_from(params: dict[str, list[str]]) -> str:
    """Return the date from which shared games should be counted."""
    value = params.get("games_from", [""])[0].strip()
    try:
        return date.fromisoformat(value).isoformat()
    except ValueError:
        return ""


def friend_result_limit(params: dict[str, list[str]]) -> int:
    """Return a larger result window when Friends filters are active."""
    return 10000 if friend_name_filter(params) or friend_last_game_from(params) or friend_games_from(params) else 100


def friend_group_json_id(group_id: int) -> int | str:
    """Preserve exact group IDs through browser JSON while ordinary IDs stay numeric."""
    return str(group_id) if group_id > (2**53 - 1) else group_id


def is_database_integrity_error(error: Exception) -> bool:
    """Recognize constraint violations from either supported database driver."""
    if isinstance(error, sqlite3.IntegrityError):
        return True
    try:
        import psycopg
    except ImportError:
        return False
    return isinstance(error, psycopg.IntegrityError)


def backend_error_status(error: Exception) -> HTTPStatus:
    """Only transient driver failures are retryable; query/schema bugs are 500."""
    if isinstance(error, TimeoutError):
        return HTTPStatus.SERVICE_UNAVAILABLE
    if isinstance(error, sqlite3.DatabaseError):
        code = getattr(error, "sqlite_errorcode", None)
        if code is not None and (code & 0xff) in {
            sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED, sqlite3.SQLITE_CANTOPEN,
            sqlite3.SQLITE_IOERR, sqlite3.SQLITE_FULL, sqlite3.SQLITE_INTERRUPT,
        }:
            return HTTPStatus.SERVICE_UNAVAILABLE
        if code is None and str(error).lower() in {
            "database is locked", "database table is locked", "database is busy",
            "unable to open database file",
        }:
            return HTTPStatus.SERVICE_UNAVAILABLE
        return HTTPStatus.INTERNAL_SERVER_ERROR
    try:
        import psycopg
    except ImportError:
        return HTTPStatus.INTERNAL_SERVER_ERROR
    if isinstance(error, getattr(psycopg, "Error", ())):
        state = getattr(error, "sqlstate", None)
        if ((state and (state.startswith(("08", "53")) or state in {
            "40001", "40P01", "55P03", "57014", "57P01", "57P02", "57P03",
        })) or (state is None and isinstance(error, getattr(psycopg, "OperationalError", ())))):
            return HTTPStatus.SERVICE_UNAVAILABLE
    return HTTPStatus.INTERNAL_SERVER_ERROR


def api_operation(method):
    """Contain API failures before headers, preserving existing domain responses."""
    @wraps(method)
    def guarded(self):
        path = urlparse(self.path).path
        if not path.startswith("/api/"):
            return method(self)
        self._response_status = None
        self._request_id = uuid4().hex
        resource = path.split("/")[2]
        endpoint = f"/api/{resource}" if resource in {
            "accounts", "algorithm-settings", "recommendation-feedback", "annotations",
            "friend-groups", "sync-status", "overview", "profile", "champions", "champion",
            "matches", "matchups", "synergy", "friends", "blacklist", "playstyles",
            "playstyle-evidence", "training-plan", "training-progress", "exploration", "recommendations",
            "recommendation-evidence", "plan", "screen",
        } else "/api/unknown"
        client_disconnected = False
        with metrics_scope("http_api", request_id=self._request_id,
                           method=self.command, endpoint=endpoint):
            try:
                return method(self)
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                client_disconnected = True
                record_metric("client_disconnect")
                self.close_connection = True
                return
            except Exception as error:
                log_failure(error, request_id=self._request_id, method=self.command, endpoint=endpoint)
                if self._response_status is not None:
                    self.close_connection = True
                    return
                self.close_connection = True
                status = backend_error_status(error)
                message = ("Servizio temporaneamente non disponibile. Riprova tra poco."
                           if status == HTTPStatus.SERVICE_UNAVAILABLE else "Errore interno del servizio.")
                try:
                    self._send_json_error(status, message)
                except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                    # The original server error was already logged above.
                    record_metric("client_disconnect")
                    self.close_connection = True
                except OSError as transport_error:
                    # Do not let a disconnected client trigger a server traceback
                    # containing the original driver's potentially sensitive text.
                    log_failure(transport_error, request_id=self._request_id,
                                method=self.command, endpoint=endpoint)
                    self.close_connection = True
            finally:
                if self._response_status is not None:
                    record_metric("http_status", self._response_status)
                elif not client_disconnected:
                    record_metric("http_status", 500)
    return guarded


def friend_sort_options(params: dict[str, list[str]]) -> list[tuple[str, bool]]:
    """Return validated Friends sort fields in priority order."""
    allowed = {"games", "winrate", "last_game"}
    raw_sort = params.get("sort", [""])[0]
    options = []
    for item in raw_sort.split(","):
        parts = item.split(":", 1)
        if len(parts) == 2 and parts[0] in allowed and parts[1].lower() in {"asc", "desc"}:
            field = parts[0]
            if field not in {option[0] for option in options}:
                options.append((field, parts[1].lower() == "asc"))
    if options:
        return options
    sort_by = params.get("sort_by", ["games"])[0]
    if sort_by not in allowed:
        sort_by = "games"
    sort_dir = params.get("sort_dir", ["desc"])[0].lower()
    return [(sort_by, sort_dir == "asc")]


def sync_is_active(now: datetime | None = None) -> bool:
    """Return true only for a valid, fresh cross-process sync heartbeat."""
    observed_at = now or datetime.now(timezone.utc)
    pattern = f".{DB_PATH.stem}.riot-sync-*.active.json"
    for marker in DB_PATH.parent.glob(pattern):
        try:
            payload = json.loads(marker.read_text(encoding="utf-8"))
            if not isinstance(payload, dict) or payload.get("version") != 1:
                continue
            raw_heartbeat = payload.get("heartbeat_at")
            if not isinstance(raw_heartbeat, str):
                continue
            heartbeat = datetime.fromisoformat(raw_heartbeat.replace("Z", "+00:00"))
            if heartbeat.utcoffset() is None:
                continue
            age = (observed_at - heartbeat.astimezone(timezone.utc)).total_seconds()
            if -SYNC_HEARTBEAT_MAX_AGE_SECONDS <= age <= SYNC_HEARTBEAT_MAX_AGE_SECONDS:
                return True
        except (OSError, UnicodeDecodeError, ValueError, json.JSONDecodeError):
            continue
    return False


def normalize_role(role: str) -> str:
    """Use the current League role name while accepting legacy snapshots."""
    return "SUPPORT" if str(role).strip().upper() == "UTILITY" else str(role).strip().upper()


def purge_urf_matches(connection) -> int:
    """Remove every queue outside the fixed project policy."""
    rows = connection.execute(
        "SELECT DISTINCT match_id, queue FROM match_quality"
    ).fetchall()
    match_ids = [row["match_id"] for row in rows if not is_supported_queue(row["queue"])]
    if not match_ids:
        return 0
    placeholders = ",".join("?" for _ in match_ids)
    connection.execute(f"DELETE FROM match_annotations WHERE match_id IN ({placeholders})", match_ids)
    connection.execute(f"DELETE FROM match_quality WHERE match_id IN ({placeholders})", match_ids)
    connection.execute(
        "DELETE FROM match_participants WHERE match_id NOT IN (SELECT DISTINCT match_id FROM match_quality)"
    )
    connection.commit()
    return len(match_ids)


def migrate_legacy_roles(connection: sqlite3.Connection) -> None:
    """Rename the old UTILITY role in existing databases without losing data."""
    tables = ("test_plan", "blacklist", "champion_fit", "screening_candidates", "match_quality")
    if STORAGE.engine == "sqlite":
        connection.execute("PRAGMA foreign_keys = OFF")
    try:
        for table in tables:
            connection.execute(f"UPDATE {table} SET role='SUPPORT' WHERE role='UTILITY'")
        connection.commit()
    finally:
        if STORAGE.engine == "sqlite":
            connection.execute("PRAGMA foreign_keys = ON")


def migrate_remove_personal_performance(connection) -> None:
    """Remove retired personal-performance columns from existing databases."""
    if STORAGE.engine == "sqlite":
        connection.execute("PRAGMA foreign_keys = OFF")
    try:
        for table, column in (("match_quality", "personal_performance_score"),
                              ("champion_fit", "mean_loss_personal_performance")):
            columns = {row[1] for row in connection.execute(f"PRAGMA table_info({table})")}
            if column in columns:
                connection.execute(f"ALTER TABLE {table} DROP COLUMN {column}")
        connection.commit()
    finally:
        if STORAGE.engine == "sqlite":
            connection.execute("PRAGMA foreign_keys = ON")


def migrate_riot_loss_weights(connection) -> int:
    """Reconcile identifiable legacy defaults while preserving imported overrides."""
    from loss_weight_migration import migrate_riot_loss_weights as reconcile_weights

    return reconcile_weights(connection)


def csv_rows(source: Path, name: str) -> list[dict[str, str]]:
    with (source / name).open(encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def as_int(value: str) -> int:
    number = float(value or 0)
    if not math.isfinite(number):
        raise ValueError("integer value must be finite")
    return int(number)


def as_float(value: str) -> float:
    return float(value or 0)


def clean_anomaly_flags(value: str) -> str:
    retired = {"strong_personal_loss", "weak_personal_performance"}
    flags = [flag for flag in str(value or "none").split(";") if flag and flag not in retired]
    return ";".join(flags) or "none"


def recommendation_role_priors(rows: list[dict]) -> dict[str, tuple[float, float]]:
    """Independent neutral prior; never infer its precision from these rows."""
    return {row["role"]: (0.5, 8.0) for row in rows}


def recommendation_explanation(
    item: dict, positive: float, negative: float, prior_fit: float,
    prior_evidence: float, lower: float, upper: float,
) -> dict:
    """Explain the existing posterior without treating a strong prior as personal proof."""
    evidence = positive + negative
    prior_share = prior_evidence / (prior_evidence + evidence)
    width = upper - lower
    if evidence < 8 or prior_share >= 0.75 or width > 0.40:
        uncertainty = "high"
    elif evidence < 20 or prior_share >= 0.50 or width > 0.30:
        uncertainty = "medium"
    else:
        uncertainty = "low"

    reasons = []
    if evidence < 8:
        reasons.append(f"Poca evidenza personale: {evidence:.2f} partite equivalenti, meno di 8.")
    elif evidence < 20:
        reasons.append(f"Campione personale ancora limitato: {evidence:.2f} partite equivalenti, meno di 20.")
    if prior_share >= 0.50:
        reasons.append(
            f"Il riferimento del ruolo pesa per il {prior_share * 100:.1f}% della stima; "
            "un intervallo stretto non basta a confermare il champion con pochi dati personali."
        )
    if width > 0.30:
        reasons.append(f"Intervallo 90% ampio: {width * 100:.1f} punti percentuali.")
    discounted = int(item.get("discounted_games") or 0)
    excluded = int(item.get("excluded_games") or 0)
    if discounted or excluded:
        reasons.append(
            f"Su {int(item['games'])} partite, {discounted} hanno peso ridotto e "
            f"{excluded} sono escluse dall'evidenza; il campione utile è più piccolo del totale."
        )
    if evidence < 20 or prior_share >= 0.50:
        next_step = (
            f"Raccogli altre partite con {item['champion']} in {item['role']} nel filtro attivo "
            "e ricontrolla quanto pesa l'evidenza personale."
        )
    elif width > 0.30:
        next_step = (
            f"Aggiungi partite con {item['champion']} in {item['role']} "
            "e verifica se l'intervallo 90% si restringe."
        )
    else:
        next_step = "Controlla le partite di supporto e rivaluta il consiglio dopo le prossime partite."
    return {
        "positive_evidence": round(positive, 2),
        "negative_evidence": round(negative, 2),
        "prior_fit": round(prior_fit * 100, 1),
        "prior_evidence": round(prior_evidence, 2),
        "prior_share": round(prior_share * 100, 1),
        "uncertainty_width_90": round(width * 100, 1),
        "uncertainty_level": uncertainty,
        "uncertainty_reasons": reasons,
        "summary": (
            f"Suggerito per il limite prudente del fit ({lower * 100:.1f}%), tra i migliori "
            "dei champion osservati con almeno 3 partite. La stima combina i risultati pesati "
            "di questo champion nel ruolo con il riferimento dello stesso ruolo nel filtro attivo. "
            "L'intervallo 90% è approssimato e condizionato al riferimento stimato: "
            "non include l'incertezza su quel riferimento e non garantisce vittorie."
        ),
        "next_step": next_step,
    }


def rank_recommendations(candidates: list[dict], limit: int | None = None) -> list[dict]:
    """Conservative raw-outcome ranking with disjoint baselines and family control."""
    return statistical_rank_recommendations(candidates, limit)


def normal_cdf(value: float) -> float:
    """Return the standard normal CDF without adding a scipy dependency."""
    return 0.5 * (1.0 + math.erf(value / math.sqrt(2.0)))


def reliability_level(effective_sample_size: float, direction_probability: float) -> str:
    """Map combined effective evidence to the product's reliability bands."""
    if effective_sample_size < 3.0:
        return "exploratory"
    if effective_sample_size < 8.0:
        return "weak"
    if effective_sample_size < 20.0:
        return "indicative"
    return "reliable" if direction_probability >= POSTERIOR_RELIABLE_PROBABILITY else "indicative"


def posterior_lift_metrics(
    item: dict,
    baseline_win_rate: float,
    prior: dict | None = None,
) -> dict:
    """Infer actual outcome probabilities; attributed weights remain descriptive."""
    metrics = outcome_metrics(item, baseline_win_rate)
    control_decisions([metrics], attribution_gate=True)
    return metrics


def matchup_metrics(
    item: dict,
    baseline_win_rate: float,
    total_games_with_opponents: int,
    prior: dict | None = None,
) -> dict:
    """Score one opponent by posterior disadvantage and encounter frequency."""
    metrics = posterior_lift_metrics(item, baseline_win_rate, prior)
    games = int(item.get("games") or 0)
    recent_share = min(max(float(item.get("recent_games") or 0), 0) / max(games, 1), 1)
    exposure_rate = games / max(total_games_with_opponents, 1)
    delta = abs(float(metrics["posterior_lift_pp"])) / 100.0
    meaningful_probability = (
        float(metrics["probability_meaningful_disadvantage"])
        if metrics["recommendation"] == "loses_to"
        else float(metrics["probability_meaningful_advantage"])
    ) / 100.0
    # A ban is chosen before the enemy pick is known. Expected utility must
    # therefore include encounter frequency instead of allowing a rare 0-2
    # to outrank a stable, commonly observed disadvantage.
    score = delta * meaningful_probability * min(max(exposure_rate, 0.0), 1.0)
    recency_weight = current_settings()["matchup"]["recent_weight"]
    score *= 1 - recency_weight + recency_weight * recent_share

    metrics.update({
        "recent_90d_games": int(item.get("recent_games") or 0),
        "exposure_rate": round(exposure_rate * 100.0, 2),
        "matchup_score": round(score * 10000.0, 2),
    })
    return metrics


def evidence_effective_sample(item: dict) -> float:
    """Return Kish-style effective sample size for weighted match evidence."""
    positive = max(float(item.get("positive_evidence") or 0), 0.0)
    negative = max(float(item.get("negative_evidence") or 0), 0.0)
    square = max(float(item.get("evidence_square") or 0), 0.0)
    total = positive + negative
    return total * total / square if total and square else 0.0


def subtract_evidence(context: dict, local: dict) -> dict:
    """Remove local evidence from a broader context without producing negatives."""
    return {
        "games": max(int(context.get("games") or 0) - int(local.get("games") or 0), 0),
        "positive_evidence": max(
            float(context.get("positive_evidence") or 0) - float(local.get("positive_evidence") or 0), 0.0
        ),
        "negative_evidence": max(
            float(context.get("negative_evidence") or 0) - float(local.get("negative_evidence") or 0), 0.0
        ),
        "evidence_square": max(
            float(context.get("evidence_square") or 0) - float(local.get("evidence_square") or 0), 0.0
        ),
    }


def empirical_context_prior(
    context_item: dict | None,
    context_baseline: float,
    local_baseline: float,
    source: str,
) -> dict | None:
    """Translate a broader-context champion effect into a bounded local prior."""
    if not context_item:
        return None
    context_ess = evidence_effective_sample(context_item)
    if context_ess < 3.0:
        return None
    positive = max(float(context_item.get("positive_evidence") or 0), 0.0)
    negative = max(float(context_item.get("negative_evidence") or 0), 0.0)
    evidence = positive + negative
    context_baseline = min(max(context_baseline, 0.05), 0.95)
    context_posterior = (
        context_baseline * MATCHUP_PRIOR_EVIDENCE + positive
    ) / max(MATCHUP_PRIOR_EVIDENCE + evidence, 1e-9)
    transported_mean = min(max(local_baseline + context_posterior - context_baseline, 0.05), 0.95)
    # The borrowed context can stabilize a sparse pair but cannot overwhelm a
    # mature personal sample. Its contribution is explicitly capped at 20 ESS.
    borrowed_support = min(context_ess, 20.0)
    return {
        "mean": transported_mean,
        "strength": min(max(4.0 + math.sqrt(context_ess), 4.0), 20.0),
        "effective_sample_size": borrowed_support,
        "games": int(context_item.get("games") or 0),
        "source": source,
    }


def as_bool(value: str) -> int:
    return int(str(value).strip().lower() in {"1", "true", "yes", "win", "won"})


def champion_asset_id(champion: str) -> str:
    aliases = {
        "FiddleSticks": "Fiddlesticks",
        "Wukong": "MonkeyKing",
    }
    return aliases.get(champion, champion)


def icon_url(champion: str) -> str:
    asset_id = champion_asset_id(champion)
    return f"https://ddragon.leagueoflegends.com/cdn/{DDRAGON_VERSION}/img/champion/{asset_id}.png"


def rows_to_dicts(cursor: sqlite3.Cursor) -> list[dict]:
    return [dict(row) for row in cursor.fetchall()]


def _finite_duration_average(connection, average, where_sql, values):
    """Recover overflow represented as infinity, NULL, or a coalesced zero."""
    if average is not None and math.isfinite(average) and average != 0:
        return average
    scale = connection.execute(
        f"SELECT MAX(m.duration_minutes) value FROM match_quality m WHERE {where_sql}", values,
    ).fetchone()["value"]
    # SQLite versions differ in their overflow result. A NULL average may
    # also mean an empty population; a real zero mean has a zero maximum.
    if scale is None or scale == 0:
        return average
    normalized = connection.execute(
        f"SELECT AVG(m.duration_minutes / ?) value FROM match_quality m WHERE {where_sql}",
        [scale, *values],
    ).fetchone()["value"]
    return round(scale * normalized, 1)


def selected_accounts(params: dict[str, list[str]]) -> list[str]:
    """Read optional account filters without coupling the UI to the data source."""
    values = params.get("account", [])
    accounts = []
    for value in values:
        accounts.extend(part.strip() for part in value.split(",") if part.strip())
    return list(dict.fromkeys(accounts))


def canonical_account_params(connection, params: dict[str, list[str]]) -> dict[str, list[str]]:
    """Keep saved account and companion filters valid after a verified rename."""
    from account_identity import canonical_account_name

    if any("\x00" in value for key in ("account", "companion_account")
           for value in params.get(key, [])):
        raise ValueError("Il filtro account contiene un carattere non valido")
    result = dict(params)
    for key in ("account", "companion_account"):
        if key in params:
            result[key] = list(dict.fromkeys(
                canonical_account_name(connection, account.strip())
                for value in params[key] for account in value.split(",") if account.strip()
            ))
    return result


def account_filter(accounts: list[str], column: str = "account") -> tuple[str, list[str]]:
    if not accounts:
        return "", []
    return f" AND {column} IN ({','.join('?' for _ in accounts)})", accounts


def companion_filter(params: dict[str, list[str]], match_column: str = "m.match_id") -> tuple[str, list[str]]:
    """Filter matches by the presence of one saved group of owned accounts."""
    accounts = []
    for value in params.get("companion_account", []):
        accounts.extend(part.strip() for part in value.split(",") if part.strip())
    accounts = list(dict.fromkeys(accounts))
    selected = selected_accounts(params)
    mode = params.get("companion_mode", [""])[0].strip().lower()
    if not accounts or mode not in {"exclude", "only"}:
        return "", []
    # A companion profile must be different from the profile being analysed.
    # Otherwise "exclude" would remove the user's own matches (for example
    # selecting Kite while excluding the Kite profile), and "only" would make
    # the scope ambiguous. Treat the overlap as no presence filter instead of
    # returning an apparently valid but empty dataset.
    selected_keys = {account.casefold() for account in selected}
    accounts = [account for account in accounts if account.casefold() not in selected_keys]
    if not accounts:
        return "", []
    placeholders = ",".join("?" for _ in accounts)
    present = (
        "EXISTS (SELECT 1 FROM match_participants cp "
        "LEFT JOIN tracked_account_puuids ctp ON ctp.puuid=cp.puuid "
        f"WHERE cp.match_id={match_column} AND (ctp.account IN ({placeholders}) OR cp.riot_id IN ({placeholders})))"
    )
    if mode == "exclude":
        return f" AND NOT ({present})", [*accounts, *accounts]
    allowed_accounts = list(dict.fromkeys([*accounts, *selected]))
    allowed_placeholders = ",".join("?" for _ in allowed_accounts)
    other = (
        "EXISTS (SELECT 1 FROM match_participants op "
        "LEFT JOIN tracked_account_puuids otp ON otp.puuid=op.puuid "
        f"WHERE op.match_id={match_column} AND (otp.account NOT IN ({allowed_placeholders}) "
        "OR (otp.account IS NULL AND op.riot_id IN (SELECT account FROM match_quality UNION SELECT account FROM riot_accounts_raw) "
        f"AND op.riot_id NOT IN ({allowed_placeholders}))))"
    )
    return f" AND ({present}) AND NOT ({other})", [*accounts, *accounts, *allowed_accounts, *allowed_accounts]


def recommendation_evidence_expressions() -> tuple[str, str, str]:
    """Keep recommendation totals and their supporting rows on identical stored weights."""
    positive = "CASE WHEN m.win=1 THEN COALESCE(m.win_evidence_weight,0) ELSE 0 END"
    negative = """CASE WHEN m.win=0 THEN
        CASE WHEN COALESCE(a.invincible,0)=1 OR COALESCE(a.afk_player,0)=1
                   OR COALESCE(a.griefer,0)=1
             THEN 0 ELSE COALESCE(m.loss_attribution_weight,0) END
        ELSE 0 END"""
    return positive, negative, f"(({positive}) + ({negative}))"


def recommendation_weight_reason(item: dict) -> str:
    """Describe saved evidence and explicit overrides without inventing historical causes."""
    weight = float(item["evidence_weight"])
    if not item["win"]:
        annotations = [
            label for field, label in (
                ("annotation_afk", "AFK"), ("annotation_griefer", "griefer"),
                ("annotation_invincible", "invincibile"),
            ) if item[field]
        ]
        if annotations:
            return "Sconfitta esclusa: annotazione manuale " + ", ".join(annotations) + "; peso 0."
    result = "Vittoria" if item["win"] else "Sconfitta"
    source = "evidenza positiva" if item["win"] else "attribuzione della sconfitta"
    if weight <= 0:
        return f"{result} esclusa: peso di {source} salvato pari a 0."
    contribution = "contributo ridotto" if weight < 1 else "contributo pieno"
    return f"{result}: peso di {source} salvato {weight:g}; {contribution}."


def recommendation_evidence_data(
    connection, params: dict[str, list[str]], champion: str, role: str,
    limit: int, offset: int,
) -> dict:
    """Return the actual scoped observations used by a champion-role recommendation."""
    from analysis_runtime import recent_match_sql
    _, date_utc_sql, date_order_sql = recent_match_sql(connection)
    account_sql, account_values = account_filter(selected_accounts(params), "m.account")
    companion_sql, companion_values = companion_filter(params, "m.match_id")
    positive_sql, negative_sql, weight_sql = recommendation_evidence_expressions()
    from_where = f"""FROM match_quality m
        LEFT JOIN match_annotations a ON a.match_id=m.match_id
        WHERE m.champion=? AND m.role=?{account_sql}{companion_sql}"""
    values = [champion, role, *account_values, *companion_values]
    summary = dict(connection.execute(
        f"""SELECT COUNT(*) games, COALESCE(SUM(m.win),0) wins,
            COUNT(*)-COALESCE(SUM(m.win),0) losses,
            COALESCE(SUM({positive_sql}),0) positive_evidence,
            COALESCE(SUM({negative_sql}),0) negative_evidence,
            COALESCE(SUM(CASE WHEN ({weight_sql})>0 AND ({weight_sql})<1 THEN 1 ELSE 0 END),0) discounted_games,
            COALESCE(SUM(CASE WHEN ({weight_sql})=0 THEN 1 ELSE 0 END),0) excluded_games
            {from_where}""", values,
    ).fetchone())
    summary["positive_evidence"] = round(float(summary["positive_evidence"]), 2)
    summary["negative_evidence"] = round(float(summary["negative_evidence"]), 2)
    rows = rows_to_dicts(connection.execute(
        f"""SELECT m.match_id, m.account, m.date, {date_utc_sql} date_utc, m.champion, m.role, m.win,
            m.queue, m.duration_minutes, {weight_sql} evidence_weight,
            COALESCE(a.afk_player,0) annotation_afk,
            COALESCE(a.griefer,0) annotation_griefer,
            COALESCE(a.invincible,0) annotation_invincible
            {from_where}
            ORDER BY {date_order_sql} DESC, m.match_id ASC, m.account ASC LIMIT ? OFFSET ?""",
        [*values, limit, offset],
    ))
    for item in rows:
        item["evidence_weight"] = float(item["evidence_weight"])
        item["contribution"] = (
            "excluded" if item["evidence_weight"] <= 0 else "positive" if item["win"] else "negative"
        )
        item["weight_reason"] = recommendation_weight_reason(item)
        effective = getattr(connection, "evidence", {}).get((item["account"], item["match_id"]))
        if effective:
            item.update({key: effective[key] for key in ("attribution_source", "stored_win_weight", "stored_loss_weight")})
            item["attribution_reason"] = effective["attribution_reason"]
        for field in ("annotation_afk", "annotation_griefer", "annotation_invincible"):
            del item[field]
    return {
        "champion": champion, "role": role, "total": summary["games"],
        "limit": limit, "offset": offset, "summary": summary, "items": rows,
    }


def scoped_champion_evidence(connection, params: dict[str, list[str]]) -> list[dict]:
    """Account/match observations and unique support remain distinct quantities."""
    from stratified_evidence import aggregate_stratified_candidates
    rows = fetch_outcome_rows(connection, params)
    grouped = aggregate_stratified_candidates(rows)
    targets = sorted(selected_accounts(params))
    for key, candidate in grouped.items():
        local = [r for r in rows if (r["role"], r["champion"]) == key]
        candidate.update({
            "positive_evidence": sum(r["positive_evidence"] for r in local),
            "negative_evidence": sum(r["negative_evidence"] for r in local),
            "discounted_games": sum(0 < r["positive_evidence"] + r["negative_evidence"] < 1 for r in local),
            "excluded_games": sum(r["positive_evidence"] + r["negative_evidence"] == 0 for r in local),
        })
        if targets:
            candidate["accounts"] = targets
    return list(grouped.values())


def selected_blacklist(connection: sqlite3.Connection, accounts: list[str], params: dict[str, list[str]] | None = None) -> list[dict]:
    """Negative outcome evidence with a disjoint role baseline and family control."""
    scope = dict(params or {})
    if accounts:
        scope["account"] = accounts
    evaluated = candidate_metrics(scoped_champion_evidence(connection, scope))
    control_decisions(evaluated, "disadvantage_probability", attribution_gate=True)
    items = []
    for item in evaluated:
        if ((current_settings()["attribution"]["negative_veto"] and item["negative_evidence"] <= 0)
                or item.get("unique_games", item["games"]) < current_settings()["evidence"]["min_games"]):
            continue
        if item["actionable"]:
            tier = "strong"
            probability_label = "Limite inferiore della probabilità" if item["probabilities_are_lower_bounds"] else "Probabilità"
            reason = (
                f"{probability_label} di svantaggio di almeno {current_settings()['evidence']['meaningful_delta'] * 100:g} punti {item['probability_meaningful_disadvantage']:.1f}%; "
                f"soglia corretta per {item['family_size']} confronti {item['decision_threshold']:.2f}%."
            )
        elif item["disadvantage_probability"] >= .95:
            tier = "provisional"
            reason = "Segnale negativo da verificare: non supera il controllo dei confronti multipli."
        else:
            continue
        item.update({
            "tier": tier, "reason": reason, "games_observed": item["games"],
            "informative_losses_equivalent": item["negative_evidence"],
            "account_adjusted_fit_score": item["raw_win_rate"],
            "icon_url": icon_url(item["champion"]),
        })
        item.pop("account_cells", None)
        items.append(item)
    return sorted(items, key=lambda item: (
        not item["actionable"], -item["disadvantage_probability"], -item["games"], item["champion"],
    ))


def normalize_riot_id_key(value: str) -> str:
    """Return the conservative exact-match key used for a Riot ID."""
    game_name, separator, tag_line = str(value or "").partition("#")
    if not separator:
        return ""
    game_name = unicodedata.normalize("NFKC", game_name).strip().casefold()
    tag_line = unicodedata.normalize("NFKC", tag_line).strip().casefold()
    return f"{game_name}#{tag_line}" if game_name and tag_line else ""


def incomplete_roster_match_ids(connection) -> set[str]:
    """Return analyzed matches without a canonical ten-champion roster."""
    return {
        str(row["match_id"])
        for row in connection.execute(
            """SELECT matches.match_id
               FROM (SELECT DISTINCT match_id FROM match_quality) matches
               LEFT JOIN match_participants p ON p.match_id=matches.match_id
               GROUP BY matches.match_id
               HAVING COUNT(CASE WHEN COALESCE(p.champion,'')<>''
                                 THEN 1 END) < 10"""
        )
    }


def load_match_participants(
    source: Path,
    connection,
    needed_match_ids: set[str] | None = None,
    *,
    commit: bool = True,
) -> int:
    """Import complete local rosters, optionally only for missing matches."""
    candidate_paths = [source / "match_details.jsonl", source.parent / "match_details.jsonl"]
    stored_source = connection.execute(
        "SELECT value FROM source_metadata WHERE key='source_path'"
    ).fetchone()
    if stored_source and str(stored_source["value"]).strip():
        historical_source = Path(str(stored_source["value"]))
        candidate_paths.extend([
            historical_source / "match_details.jsonl",
            historical_source.parent / "match_details.jsonl",
        ])
    details_path = next((candidate for candidate in dict.fromkeys(candidate_paths) if candidate.exists()), None)
    if details_path is None:
        return 0
    if needed_match_ids is not None and not needed_match_ids:
        return 0
    loaded = 0
    with details_path.open(encoding="utf-8") as handle:
        for line in handle:
            try:
                payload = json.loads(line)
            except json.JSONDecodeError:
                continue
            match_id = str(payload.get("metadata", {}).get("matchId", "")).strip()
            if needed_match_ids is not None and match_id not in needed_match_ids:
                continue
            queue_id = payload.get("info", {}).get("queueId")
            if not is_supported_queue(queue_id):
                continue
            participants = payload.get("info", {}).get("participants", [])
            if not match_id or not isinstance(participants, list):
                continue
            rows = []
            for participant in participants:
                if not isinstance(participant, dict):
                    continue
                puuid = str(participant.get("puuid", "")).strip()
                game_name = str(participant.get("riotIdGameName", "")).strip()
                tag_line = str(participant.get("riotIdTagline", "")).strip()
                riot_id = f"{game_name}#{tag_line}" if game_name and tag_line else game_name
                if puuid:
                    rows.append((
                        match_id, puuid, riot_id,
                        as_int(str(participant.get("teamId", 0))),
                        as_bool(str(participant.get("win", False))),
                        str(participant.get("championName", "")).strip(),
                        as_int(str(participant.get("participantId", 0))),
                        normalize_riot_id_key(riot_id),
                    ))
            if rows:
                # A targeted match is known to have an incomplete legacy
                # roster. Replace it atomically with the complete canonical
                # payload so slot/identity uniqueness cannot retain stale rows.
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
                         participant_id=excluded.participant_id,
                         normalized_riot_id=excluded.normalized_riot_id""",
                    rows,
                )
                loaded += len(rows)
    if commit:
        connection.commit()
    return loaded


def migrate_match_participant_champions(connection, *, commit: bool = True) -> int:
    """Add canonical roster fields and backfill them from retained Riot payloads."""
    if STORAGE.engine == "postgres":
        columns = postgres_table_columns(connection, "match_participants")
    else:
        columns = {
            row["name"] for row in connection.execute("PRAGMA table_info(match_participants)")
        }
    required_columns = {
        "champion": "TEXT NOT NULL DEFAULT ''",
        "participant_id": "INTEGER NOT NULL DEFAULT 0",
        "normalized_riot_id": "TEXT NOT NULL DEFAULT ''",
    }
    for column, declaration in required_columns.items():
        if column not in columns:
            connection.execute(
                f"ALTER TABLE match_participants ADD COLUMN {column} {declaration}"
            )

    # The participant table predates matchup analysis in some local snapshots.
    # Only inspect raw payloads for matches that do not yet have a complete
    # standard five-versus-five roster, so normal server starts stay cheap.
    raw_rows = connection.execute(
        """SELECT r.match_id, r.payload_json
           FROM riot_match_raw r
           WHERE EXISTS (SELECT 1 FROM match_quality mq WHERE mq.match_id=r.match_id)
             AND (SELECT COUNT(*) FROM match_participants p
                  WHERE p.match_id=r.match_id AND COALESCE(p.champion, '') <> '') < 10"""
    )
    participant_rows = []
    opponent_champions = set()
    updated = 0

    def flush_rows() -> None:
        nonlocal participant_rows
        if not participant_rows:
            return
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
                 participant_id=CASE WHEN excluded.participant_id>0 THEN excluded.participant_id
                                     ELSE match_participants.participant_id END,
                 normalized_riot_id=CASE WHEN excluded.normalized_riot_id<>''
                                         THEN excluded.normalized_riot_id
                                         ELSE match_participants.normalized_riot_id END""",
            participant_rows,
        )
        participant_rows = []

    for raw in raw_rows:
        try:
            payload = json.loads(raw["payload_json"])
        except (TypeError, ValueError, json.JSONDecodeError):
            continue
        info = payload.get("info", {})
        if not is_supported_queue(info.get("queueId")):
            continue
        participants = info.get("participants", [])
        if not isinstance(participants, list):
            continue
        for participant in participants:
            if not isinstance(participant, dict):
                continue
            puuid = str(participant.get("puuid", "")).strip()
            if not puuid:
                continue
            game_name = str(participant.get("riotIdGameName", "")).strip()
            tag_line = str(participant.get("riotIdTagline", "")).strip()
            riot_id = f"{game_name}#{tag_line}" if game_name and tag_line else game_name
            champion = str(participant.get("championName", "")).strip()
            if not riot_id or not champion:
                continue
            participant_rows.append((
                str(raw["match_id"]), puuid, riot_id,
                as_int(str(participant.get("teamId", 0))),
                as_bool(str(participant.get("win", False))), champion,
                as_int(str(participant.get("participantId", 0))),
                normalize_riot_id_key(riot_id),
            ))
            opponent_champions.add(champion)
            updated += 1
            if len(participant_rows) >= 2000:
                flush_rows()
    flush_rows()

    if opponent_champions:
        connection.executemany(
            """INSERT INTO champions(champion,asset_id,icon_url) VALUES(?,?,?)
               ON CONFLICT(champion) DO NOTHING""",
            [
                (champion, champion_asset_id(champion), icon_url(champion))
                for champion in sorted(opponent_champions)
            ],
        )
    if commit:
        connection.commit()
    return updated


def load_tracked_account_puuids(
    source: Path,
    connection,
    *,
    accounts_payload: dict | None = None,
    commit: bool = True,
) -> int:
    """Reconcile ownership from identity evidence, never from playing together.

    Legacy rows have no provenance. Keep an unverified historical identity
    unless the personal match records place it in a different roster slot;
    explicit imports and verified Riot identities always remain authoritative.
    """
    from account_identity import canonical_account_name

    canonical_names = {}

    def account_name(account: str) -> str:
        if account not in canonical_names:
            canonical_names[account] = canonical_account_name(connection, account)
        return canonical_names[account]

    accounts_path = next((candidate for candidate in (source / "accounts.json", source.parent / "accounts.json") if candidate.exists()), None)
    payload = (
        accounts_payload
        if accounts_payload is not None
        else json.loads(accounts_path.read_text(encoding="utf-8")) if accounts_path else {}
    )
    if not isinstance(payload, dict):
        raise ValueError("accounts.json must contain an object")
    imported = []
    for account, value in payload.items():
        if not isinstance(value, dict):
            continue
        puuids = set(value.get("puuid_history", []))
        if value.get("puuid"):
            puuids.add(value["puuid"])
        canonical = account_name(str(account))
        imported.extend((str(puuid), canonical, str(account)) for puuid in puuids if puuid)

    # Retain the explicit export's provenance when that file is unavailable on
    # subsequent starts. Do not replace a stronger Riot verification source.
    connection.executemany(
        """INSERT INTO riot_account_aliases
           (account,normalized_riot_id,display_riot_id,puuid,verification_source,verified_at)
           VALUES(?,?,?,?,?,?)
           ON CONFLICT(account,normalized_riot_id,puuid) DO NOTHING""",
        [(account, normalize_riot_id_key(display), display, puuid,
          "imported_accounts_json", datetime.now().isoformat())
         for puuid, account, display in imported if normalize_riot_id_key(display)],
    )
    verified: dict[str, set[str]] = {}
    for row in connection.execute(
        """SELECT puuid,account FROM riot_accounts_raw
           UNION SELECT puuid,account FROM riot_match_list_raw
           UNION SELECT puuid,account FROM riot_account_aliases
                 WHERE verification_source <> ''
           UNION SELECT participant_puuid puuid,account FROM riot_match_materialization
                 WHERE status='materialized'
                   AND identity_resolution IN ('puuid_exact','verified_riot_id_exact')
           UNION SELECT p.puuid,i.account FROM riot_identity_puuids p
                 JOIN riot_account_identities i ON i.identity_id=p.identity_id"""
    ):
        if row["puuid"]:
            verified.setdefault(str(row["puuid"]), set()).add(
                account_name(str(row["account"]))
            )
    for puuid, account, _display in imported:
        verified.setdefault(puuid, set()).add(account)

    # A frequent duo is contradicted by the roster: its champion/result never
    # identifies the imported account's own slot. A genuine historical owner
    # with any matching slot is retained, even if older rows are incomplete.
    contradicted = set()
    for row in connection.execute(
        """SELECT p.puuid,m.account,
                  SUM(CASE WHEN p.champion=m.champion AND p.win=m.win THEN 1 ELSE 0 END) own_slots
           FROM match_participants p JOIN match_quality m ON m.match_id=p.match_id
           WHERE COALESCE(p.champion,'') <> ''
           GROUP BY p.puuid,m.account"""
    ):
        if not int(row["own_slots"]):
            contradicted.add((str(row["puuid"]), account_name(str(row["account"]))))

    ownership = {}
    for row in list(connection.execute("SELECT puuid,account FROM tracked_account_puuids")):
        puuid = str(row["puuid"])
        account = account_name(str(row["account"]))
        if puuid not in verified and (puuid, account) in contradicted:
            connection.execute("DELETE FROM tracked_account_puuids WHERE puuid=?", (puuid,))
        else:
            ownership[puuid] = account
    for puuid, accounts in verified.items():
        if len(accounts) == 1:
            ownership[puuid] = next(iter(accounts))
        # Conflicting explicit imports are not resolved by whichever row
        # happened to be visited last; preserve the existing mapping instead.

    rows = sorted(ownership.items())
    connection.executemany(
        "INSERT INTO tracked_account_puuids(puuid,account) VALUES(?,?) ON CONFLICT(puuid) DO UPDATE SET account=excluded.account",
        rows,
    )
    if commit:
        connection.commit()
    return len(rows)


def database(source: Path, rebuild: bool) -> None:
    # Imported lazily because riot_sync reuses a few app-level constants. At
    # runtime app.py is already initialized, so this keeps one canonical
    # migration implementation without a module-import cycle.
    from riot_sync import migrate_ingestion_schema

    required = [
        "champion_fit.csv",
        "next_400_games.csv",
        "blacklist.csv",
        "match_quality.csv",
        "new_champions_to_screen.csv",
        "champion_fit.json",
    ]
    if STORAGE.engine == "postgres":
        STORAGE.initialize()
        connection = STORAGE.connect()
        try:
            migrate_ingestion_schema(connection)
            migrate_match_participant_champions(connection)
            load_match_participants(source, connection, incomplete_roster_match_ids(connection))
            load_tracked_account_puuids(source, connection)
            purge_urf_matches(connection)
            migrate_riot_loss_weights(connection)
        finally:
            connection.close()
        return
    if DB_PATH.exists() and not rebuild:
        connection = STORAGE.connect()
        try:
            STORAGE.initialize()
            migrate_ingestion_schema(connection)
            migrate_remove_personal_performance(connection)
            migrate_match_participant_champions(connection)
            load_match_participants(source, connection, incomplete_roster_match_ids(connection))
            load_tracked_account_puuids(source, connection)
            migrate_legacy_roles(connection)
            purge_urf_matches(connection)
            migrate_riot_loss_weights(connection)
            stored_version = connection.execute(
                "SELECT value FROM source_metadata WHERE key='ddragon_version'"
            ).fetchone()
            if stored_version and stored_version[0] == DDRAGON_VERSION:
                return

            # Refresh only the remote icon references when the app's catalog
            # version changes; rebuilding the analysis data is unnecessary.
            champions = connection.execute("SELECT champion FROM champions").fetchall()
            connection.executemany(
                "UPDATE champions SET asset_id=?, icon_url=? WHERE champion=?",
                [(champion_asset_id(row["champion"]), icon_url(row["champion"]), row["champion"]) for row in champions],
            )
            connection.execute(
                "INSERT INTO source_metadata(key, value) VALUES('ddragon_version', ?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (DDRAGON_VERSION,),
            )
            connection.commit()
        finally:
            connection.close()
        return

    if not DB_PATH.exists() and not rebuild:
        STORAGE.initialize()
        connection = STORAGE.connect()
        try:
            migrate_ingestion_schema(connection)
        finally:
            connection.close()
        return

    missing = [name for name in required if not (source / name).exists()]
    if missing:
        raise SystemExit(f"Missing analysis files in {source}: {', '.join(missing)}")

    # Parse every required JSON document before touching the current dataset.
    # In particular, ownership loading used to commit the table deletions before
    # champion_fit.json was read, so one malformed export could empty the DB.
    payload = json.loads((source / "champion_fit.json").read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("champion_fit.json must contain an object")
    accounts_path = next(
        (candidate for candidate in (source / "accounts.json", source.parent / "accounts.json") if candidate.exists()),
        None,
    )
    accounts_payload = json.loads(accounts_path.read_text(encoding="utf-8")) if accounts_path else {}
    if not isinstance(accounts_payload, dict):
        raise ValueError("accounts.json must contain an object")

    connection = STORAGE.connect()
    try:
        STORAGE.initialize()
        migrate_ingestion_schema(connection)
        connection.execute("BEGIN IMMEDIATE")
        for table in (
            "source_metadata", "test_plan", "blacklist", "screening_candidates",
            "match_annotations", "match_quality", "match_participants",
            "tracked_account_puuids", "riot_account_aliases", "riot_match_materialization",
            "match_import_provenance", "riot_identity_policy", "riot_identity_puuids", "riot_account_identities",
            "riot_match_list_raw", "riot_match_raw", "riot_accounts_raw",
            "champion_fit", "champions",
        ):
            connection.execute(f"DELETE FROM {table}")

        fit_rows = csv_rows(source, "champion_fit.csv")
        plan_rows = csv_rows(source, "next_400_games.csv")
        blacklist_rows = csv_rows(source, "blacklist.csv")
        screen_rows = csv_rows(source, "new_champions_to_screen.csv")
        quality_rows = csv_rows(source, "match_quality.csv")
        quality_rows = [row for row in quality_rows if is_supported_queue(row.get("queue"))]
        champion_names = {row["champion"] for row in fit_rows + plan_rows + screen_rows + quality_rows}
        connection.executemany(
            "INSERT INTO champions (champion, asset_id, icon_url) VALUES (?, ?, ?)",
            [(name, champion_asset_id(name), icon_url(name)) for name in sorted(champion_names)],
        )
        connection.executemany(
            """INSERT INTO champion_fit VALUES
            (:scope,:role,:champion,:games_observed,:wins,:losses,:raw_win_rate,:positive_evidence,
             :informative_losses_equivalent,:effective_sample_size,:account_adjusted_fit_score,
             :fit_delta_vs_account_baseline_pp,:posterior_fit_probability,:credible_lower_90,
             :credible_upper_90,:uncertainty_width_90,:probability_above_high_fit_threshold,
             :accounts_played,:accounts,:recent_90d_games,
             :validated_positive,:blacklist_strong,:blacklist_provisional,:blacklist_tier,
             :blacklist_reason,:value_of_information)""",
            [{
                **row, "role": normalize_role(row["role"]),
                "games_observed": as_int(row["games_observed"]), "wins": as_int(row["wins"]),
                "losses": as_int(row["losses"]), "raw_win_rate": as_float(row["raw_win_rate"]),
                "positive_evidence": as_float(row["positive_evidence"]),
                "informative_losses_equivalent": as_float(row["informative_losses_equivalent"]),
                "effective_sample_size": as_float(row["effective_sample_size"]),
                "account_adjusted_fit_score": as_float(row["account_adjusted_fit_score"]),
                "fit_delta_vs_account_baseline_pp": as_float(row["fit_delta_vs_account_baseline_pp"]),
                "posterior_fit_probability": as_float(row["posterior_fit_probability"]),
                "credible_lower_90": as_float(row["credible_lower_90"]),
                "credible_upper_90": as_float(row["credible_upper_90"]),
                "uncertainty_width_90": as_float(row["uncertainty_width_90"]),
                "probability_above_high_fit_threshold": as_float(row["probability_above_high_fit_threshold"]),
                "accounts_played": as_int(row["accounts_played"]),
                "recent_90d_games": as_int(row["recent_90d_games"]),
                "validated_positive": as_bool(row["validated_positive"]),
                "blacklist_strong": as_bool(row["blacklist_strong"]),
                "blacklist_provisional": as_bool(row["blacklist_provisional"]),
                "value_of_information": as_float(row["value_of_information"]),
            } for row in fit_rows],
        )
        connection.executemany(
            """INSERT INTO test_plan VALUES
            (:role,:champion,:allocated_games,:candidate_type,:starting_effective_sample_size,
             :account_adjusted_fit_score,:probability_high_fit,:base_value_of_information,:quantitative_rationale)""",
            [{
                **row, "role": normalize_role(row["role"]), "allocated_games": as_int(row["allocated_games"]),
                "starting_effective_sample_size": as_float(row["starting_effective_sample_size"]),
                "account_adjusted_fit_score": as_float(row["account_adjusted_fit_score"]),
                "probability_high_fit": as_float(row["probability_high_fit"]),
                "base_value_of_information": as_float(row["base_value_of_information"]),
            } for row in plan_rows],
        )
        connection.executemany(
            "INSERT INTO blacklist VALUES (?, ?, ?, ?)",
            [(normalize_role(row["role"]), row["champion"], row["blacklist_tier"], row["blacklist_reason"]) for row in blacklist_rows],
        )
        connection.executemany(
            "INSERT INTO screening_candidates VALUES (:role,:champion,:observed_role_games,:matched_tags,:theoretical_fit_prior,:profile_tag_signal,:classification,:reason)",
            [{
                **row, "role": normalize_role(row["role"]), "observed_role_games": as_int(row["observed_role_games"]),
                "theoretical_fit_prior": as_float(row["theoretical_fit_prior"]),
                "profile_tag_signal": as_float(row["profile_tag_signal"]),
            } for row in screen_rows],
        )
        connection.executemany(
            """INSERT INTO match_quality
            (account,match_id,date,patch,queue,champion,role,identity_resolution,duration_minutes,win,
             explicit_afk,suspected_quasi_afk,early_surrender,anomaly_flags,match_quality_score,
             loss_attribution_weight,win_evidence_weight,reason)
            VALUES
            (:account,:match_id,:date,:patch,:queue,:champion,:role,:identity_resolution,:duration_minutes,:win,
             :explicit_afk,:suspected_quasi_afk,:early_surrender,:anomaly_flags,:match_quality_score,
             :loss_attribution_weight,:win_evidence_weight,:reason)""",
            [{
                **row, "role": normalize_role(row["role"]), "anomaly_flags": clean_anomaly_flags(row["anomaly_flags"]), "duration_minutes": as_float(row["duration_minutes"]), "win": as_bool(row["win"]),
                "explicit_afk": as_bool(row["explicit_afk"]), "suspected_quasi_afk": as_bool(row["suspected_quasi_afk"]),
                "early_surrender": as_bool(row["early_surrender"]), "match_quality_score": as_float(row["match_quality_score"]),
                "loss_attribution_weight": as_float(row["loss_attribution_weight"]),
                "win_evidence_weight": as_float(row["win_evidence_weight"]),
            } for row in quality_rows],
        )
        load_match_participants(source, connection, commit=False)
        migrate_match_participant_champions(connection, commit=False)
        load_tracked_account_puuids(
            source, connection, accounts_payload=accounts_payload, commit=False,
        )
        metadata = {
            "generated_at_utc": payload.get("generated_at_utc", "unknown"),
            "scope": payload.get("scope", "unknown"),
            "source_path": str(source),
            "ddragon_version": DDRAGON_VERSION,
            "icon_policy": "Remote Data Dragon URLs only; no champion icon binary is stored locally.",
        }
        connection.executemany("INSERT INTO source_metadata VALUES (?, ?)", metadata.items())
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def distinct_outcomes(rows: list[dict]) -> list[dict]:
    """Collapse aliased/shared matches; exclude contradictory perspectives."""
    groups = {}
    for row in rows:
        groups.setdefault(str(row["match_id"]), []).append(row)
    result = []
    for group in groups.values():
        if len({int(row["win"]) for row in group}) != 1:
            continue
        item = dict(group[0])
        for field in ("positive_evidence", "negative_evidence"):
            item[field] = sum(float(row.get(field) or 0) for row in group) / len(group)
        result.append(item)
    return result


def fetch_outcome_rows(connection, params, champion="", role=""):
    account_sql, account_values = account_filter(selected_accounts(params), "m.account")
    companion_sql, companion_values = companion_filter(params, "m.match_id")
    positive, negative, _ = recommendation_evidence_expressions()
    extra, values = "", [*account_values, *companion_values]
    if champion:
        extra += " AND m.champion=?"
        values.append(champion)
    if role in ROLES:
        extra += " AND m.role=?"
        values.append(role)
    return rows_to_dicts(connection.execute(
        f"""SELECT m.id, m.account, m.match_id, m.champion, m.role, m.win, m.date,
                   m.patch, m.queue,
                   {positive} positive_evidence, {negative} negative_evidence
            FROM match_quality m LEFT JOIN match_annotations a ON a.match_id=m.match_id
            WHERE m.role != 'INVALID'{account_sql}{companion_sql}{extra}
            ORDER BY m.id""", values,
    ))


def participant_rosters(connection, match_ids):
    rosters = {}
    ids = list(dict.fromkeys(match_ids))
    for offset in range(0, len(ids), 500):
        batch = ids[offset:offset + 500]
        rows = connection.execute(
            f"""SELECT match_id, team_id, win, champion FROM match_participants
                WHERE match_id IN ({','.join('?' for _ in batch)})
                  AND COALESCE(champion,'') <> ''
                GROUP BY match_id, team_id, win, champion""", batch,
        )
        for row in rows:
            rosters.setdefault(str(row["match_id"]), []).append(dict(row))
    return rosters


def observed_champions(rows):
    by_champion = {}
    for row in rows:
        by_champion.setdefault(row["champion"], set()).add(row["match_id"])
    return [{"champion": name, "games": len(ids), "icon_url": icon_url(name)}
            for name, ids in sorted(by_champion.items())]


def normalize_global_fit(item):
    """CSV posterior intervals are proportions; JSON display fields use percent."""
    for field in ("credible_lower_90", "credible_upper_90", "uncertainty_width_90", "raw_win_rate"):
        if item.get(field) is not None:
            item[field] = float(item[field]) * 100
    return item


def append_match_evidence(stats, match):
    stats["games"] = stats.get("games", 0) + 1
    stats["wins"] = stats.get("wins", 0) + int(match["win"])
    stats["losses"] = stats["games"] - stats["wins"]
    for key in ("positive_evidence", "negative_evidence"):
        stats[key] = stats.get(key, 0) + float(match.get(key) or 0)


def matchup_data(connection, params: dict[str, list[str]], champion: str, role: str = "") -> dict:
    from contextual_comparisons import encounter_data
    rows = fetch_outcome_rows(connection, params, role=role)
    context = getattr(connection, "context", {})
    return encounter_data(rows, participant_rosters(connection, [r["match_id"] for r in rows]),
                          selected_accounts(params), relation="enemy", champion=champion,
                          role=role or "ALL", icon_fn=icon_url,
                          as_of=context.get("as_of"))


def account_coverage_by_account(connection, accounts: list[str] | None = None) -> dict[str, dict]:
    """Return the raw -> eligible -> analyzed funnel for each account.

    Eligibility comes from the durable materialization state, rather than
    being inferred from ``match_quality``.  In particular, a supported match
    whose historical identity is still unresolved is eligible even though it
    cannot yet have an analyzed row.
    """
    connection = getattr(connection, "base", connection)
    selected = set(accounts or [])
    raw_by_account: dict[str, set[str]] = {}
    for row in connection.execute("SELECT account, match_ids_json FROM riot_match_list_raw"):
        account = str(row["account"])
        if selected and account not in selected:
            continue
        try:
            match_ids = json.loads(row["match_ids_json"])
        except (TypeError, ValueError, json.JSONDecodeError):
            continue
        if isinstance(match_ids, list):
            raw_by_account.setdefault(account, set()).update(
                str(match_id) for match_id in match_ids if str(match_id).strip()
            )

    terminal_statuses = {"unsupported_map", "unsupported_queue", "invalid_payload"}
    eligible_by_account: dict[str, set[str]] = {}
    try:
        materialization_rows = connection.execute(
            "SELECT account, match_id, status FROM riot_match_materialization"
        )
        for row in materialization_rows:
            account = str(row["account"])
            match_id = str(row["match_id"])
            if selected and account not in selected:
                continue
            if match_id not in raw_by_account.get(account, set()):
                continue
            if str(row["status"]) not in terminal_statuses:
                eligible_by_account.setdefault(account, set()).add(match_id)
    except sqlite3.OperationalError:
        # Compatibility for an old database opened before the additive schema
        # migration has run. Analyzed rows are added below and remain honest.
        pass

    analyzed_by_account: dict[str, set[str]] = {}
    account_sql, account_values = account_filter(list(selected), "account")
    for row in connection.execute(
        f"SELECT DISTINCT account, match_id FROM match_quality WHERE 1=1{account_sql}",
        account_values,
    ):
        account = str(row["account"])
        analyzed_by_account.setdefault(account, set()).add(str(row["match_id"]))

    result: dict[str, dict] = {}
    all_accounts = set(raw_by_account) | set(eligible_by_account) | set(analyzed_by_account)
    for account in all_accounts:
        analyzed = analyzed_by_account.get(account, set())
        eligible = eligible_by_account.get(account, set()) | analyzed
        # Legacy CSV imports may predate raw Riot retention. Treat their
        # already-analyzed IDs as known raw inputs so the funnel is monotonic.
        raw = raw_by_account.get(account, set()) | eligible
        result[account] = {
            "raw_games": len(raw),
            "eligible_games": len(eligible),
            "analyzed_games": len(analyzed),
        }
    return result


def account_coverage_counts(connection, accounts: list[str]) -> dict:
    """Return aggregate explicit raw/eligible/analyzed coverage counts."""
    coverage = account_coverage_by_account(connection, accounts)
    return {
        key: sum(int(item[key]) for item in coverage.values())
        for key in ("raw_games", "eligible_games", "analyzed_games")
    }


def synergy_data(connection, params: dict[str, list[str]]) -> dict:
    from contextual_comparisons import encounter_data
    rows = fetch_outcome_rows(connection, params)
    minimum = params.get("min_reliability", ["exploratory"])[0]
    if minimum not in RELIABILITY_LEVELS:
        minimum = "exploratory"
    try:
        min_games = max(1, min(int(params.get("min_games", ["1"])[0]), 100))
    except (ValueError, TypeError):
        min_games = 1
    include = params.get("include_exploratory", ["true"])[0].lower() in {"true", "1", "yes", "on"}
    data = encounter_data(rows, participant_rosters(connection, [r["match_id"] for r in rows]),
                          selected_accounts(params), relation="ally", champion=params.get("champion", ["ALL"])[0],
                          role=params.get("role", ["ALL"])[0] or "ALL", icon_fn=icon_url,
                          min_games=min_games, min_reliability=minimum, include_exploratory=include,
                          as_of=getattr(connection, "context", {}).get("as_of"))
    data.update({"companion_filter_active": bool(companion_filter(params)[1]), "min_games": min_games,
                 "min_reliability": minimum, "include_exploratory": include})
    data["coverage"].update(account_coverage_counts(connection, selected_accounts(params)))
    data["context"] = getattr(connection, "context", {})
    return data


ANALYTICAL_ENDPOINTS = {
    "/api/overview", "/api/profile", "/api/friends", "/api/champions", "/api/champion",
    "/api/matchups", "/api/synergy", "/api/blacklist", "/api/recommendation-evidence",
    "/api/matches", "/api/playstyles", "/api/playstyle-evidence", "/api/training-plan", "/api/exploration",
    "/api/recommendations",
}


def live_champion_items(connection, params):
    """Current personal results, with legacy-compatible display units."""
    from live_recommendations import training_plan
    candidates = scoped_champion_evidence(connection, params)
    positives = control_decisions(candidate_metrics(candidates), "advantage_probability")
    negatives = control_decisions(candidate_metrics(candidates), "disadvantage_probability", attribution_gate=True)
    negative_map = {(r["role"], r["champion"]): r for r in negatives}
    plan = training_plan(candidates, selected_accounts(params))
    allocations = {(r["role"], r["champion"]): r for r in plan["items"]}
    results = []
    for row in positives:
        item = {key: value for key, value in row.items() if key not in {"account_cells", "accounts"}}
        negative = negative_map[(row["role"], row["champion"])]
        allocation = allocations.get((row["role"], row["champion"]), {})
        tier = "strong" if negative["actionable"] else "provisional" if negative["disadvantage_probability"] >= .95 else "none"
        item.update({
            "scope": "selected_accounts", "games_observed": row["games"],
            "account_adjusted_fit_score": row["posterior_win_rate"],
            "posterior_fit_probability": row["posterior_win_rate"] / 100,
            "informative_losses_equivalent": row["negative_evidence"],
            "accounts_played": row.get("observed_account_count", 0),
            "accounts": ",".join(row.get("accounts", selected_accounts(params))),
            "fit_delta_vs_account_baseline_pp": row["posterior_lift_pp"],
            "uncertainty_width_90": row["credible_upper_90"] - row["credible_lower_90"],
            "uncertainty_width": row.get("credible_upper", row["credible_upper_90"]) - row.get("credible_lower", row["credible_lower_90"]),
            "probability_above_high_fit_threshold": None,
            "validated_positive": int(row["actionable"]),
            "blacklist_strong": int(tier == "strong"), "blacklist_provisional": int(tier == "provisional"),
            "blacklist_tier": tier, "blacklist_reason": "Segnale storico negativo" if tier != "none" else "",
            "value_of_information": allocation.get("expected_variance_reduction", 0),
            "allocated_games": allocation.get("allocation_games", 0),
            "icon_url": icon_url(row["champion"]), "record_kind": "account", "theoretical_fit_prior": None,
            "quantitative_rationale": "Stima personale ricalcolata con la configurazione attiva.",
        })
        results.append(item)
    return sorted(results, key=lambda r: (-int(r["actionable"]), -r.get("credible_lower", r["credible_lower_90"]),
                                          -r["posterior_win_rate"], -r["unique_games"], r["champion"], r["role"]))


def live_hierarchical_champions(connection, params):
    """Account-standardized historical ranking with explicit model status."""
    from hierarchical_champion_model import analyze
    return analyze(fetch_outcome_rows(connection, params), selected_accounts(params))


def _query_with_settings(connection, path, params, snapshot):
    from algorithm_settings import settings_context
    from analysis_runtime import prepare_analysis
    with settings_context(snapshot["settings"], snapshot["revision"], snapshot["fingerprint"]):
        if path == "/api/recommendations":
            from recommendation_runtime import recommendation_data
            payload = recommendation_data(connection, canonical_account_params(connection, params),
                account_filter=account_filter, companion_filter=companion_filter)
            payload.update({"algorithm_revision": snapshot["revision"], "algorithm_fingerprint": snapshot["fingerprint"]})
            return HTTPStatus.OK, payload
        analysis_params = canonical_account_params(connection, params)
        if path in {
            "/api/friends", "/api/matches", "/api/synergy", "/api/blacklist",
        }:
            # Start from the full history; explicit page filters can narrow it.
            analysis_params.setdefault("queue", ["all"])
            analysis_params.setdefault("days", ["all"])
            analysis_params.setdefault("role", ["ALL"])
        elif path in {"/api/playstyles", "/api/playstyle-evidence"}:
            # Playstyles aggregate roles, but keep the configured queue and
            # period defaults so the descriptive view shares the user's scope.
            analysis_params.setdefault("role", ["ALL"])
        with measure("analysis_projection"):
            scoped, normalized = prepare_analysis(
                connection, analysis_params,
                account_filter=account_filter, companion_filter=companion_filter,
                allow_all_queues=path in {
                    "/api/matchups", "/api/friends", "/api/profile", "/api/matches", "/api/synergy",
                    "/api/playstyles", "/api/playstyle-evidence", "/api/blacklist", "/api/champions",
                    "/api/training-plan",
                },
            )
        record_metric("analysis_observations", scoped.context["observations"])
        if path == "/api/training-plan":
            from hierarchical_champion_model import analyze, training_candidates
            from live_recommendations import competitive_training_plan
            raw_budget = normalized.get("budget", normalized.get("n", [None]))[0]
            budget = raw_budget if raw_budget is not None else None
            accounts = selected_accounts(normalized)
            analysis = analyze(fetch_outcome_rows(scoped, normalized), accounts)
            candidates = training_candidates(
                analysis, accounts, int(current_settings()["training"]["max_candidates"]),
            )
            payload = competitive_training_plan(candidates, accounts, budget)
            payload["model"] = analysis["validation"]
            status = HTTPStatus.OK
        elif path == "/api/champions":
            analysis = live_hierarchical_champions(scoped, normalized)
            items = analysis["items"]
            search = normalized.get("search", [""])[0].casefold()
            state = normalized.get("status", ["ALL"])[0]
            predicates = {
                "supported": lambda r: r["historical_supported"],
                "promising": lambda r: r["classification"] == "promising",
                "validated": lambda r: r["actionable"],
                "testing": lambda r: False,
                "strong": lambda r: False,
                "provisional": lambda r: False,
                "screen": lambda r: False,
            }
            # Fit the complete family before applying search/status display filters.
            payload = {"items": [r for r in items if (not search or search in r["champion"].casefold())
                                 and (state not in predicates or predicates[state](r))],
                       "model": analysis["validation"]}
            status = HTTPStatus.OK
        elif path == "/api/exploration":
            from live_recommendations import exploration
            status, styles = _query_database_raw("/api/playstyles", normalized, connection)
            payload = exploration(styles) if status == HTTPStatus.OK else styles
        else:
            # Playstyle lifetime checks and metric cells require the original
            # facts; analyze() applies the same explicit normalized context.
            view = connection if path in {"/api/playstyles", "/api/playstyle-evidence"} else scoped
            status, payload = _query_database_raw(path, normalized, view)
            if status == HTTPStatus.OK and path == "/api/champion":
                rows = [r for r in live_hierarchical_champions(scoped, normalized)["items"]
                        if r["champion"] == payload["champion"]]
                payload["roles"] = rows
                payload["fit"] = rows[0] if len(rows) == 1 else None
            if status == HTTPStatus.OK and path == "/api/overview":
                from live_recommendations import training_plan
                candidates = scoped_champion_evidence(scoped, normalized)
                plan = training_plan(candidates, selected_accounts(normalized))
                negative = selected_blacklist(scoped, selected_accounts(normalized), normalized)
                payload["summary"].update({"champion_role_pairs": len(candidates), "planned_games": plan["budget_assigned"],
                    "strong_blacklist": sum(r["tier"] == "strong" for r in negative),
                    "provisional_blacklist": sum(r["tier"] == "provisional" for r in negative),
                    "average_fit": payload["summary"].get("win_rate")})
                for role in payload["roles"]:
                    role["planned_games"] = sum(r["allocation_games"] for r in plan["items"] if r["role"] == role["role"])
            if status == HTTPStatus.OK and path == "/api/matches":
                for item in payload["items"]:
                    item.update(scoped.evidence.get((item["account"], item["match_id"]), {}))
        if status == HTTPStatus.OK:
            payload.update({"algorithm_revision": snapshot["revision"], "algorithm_fingerprint": snapshot["fingerprint"],
                            "context": scoped.context})
            if path == "/api/training-plan":
                from training_progress import plan_fingerprint
                payload["plan_fingerprint"] = plan_fingerprint(payload, analysis_params)
        return status, payload


def query_database(path: str, params: dict[str, list[str]]) -> tuple[int, dict]:
    from algorithm_settings import get_settings_snapshot
    connection = STORAGE.connect()
    try:
        if (path in {"/api/champion", "/api/profile", "/api/matches", "/api/recommendation-evidence"}
                and any("\x00" in value for value in params.get("champion", []))):
            return HTTPStatus.BAD_REQUEST, {"error": "Il filtro campione contiene un carattere non valido"}
        if STORAGE.engine == "sqlite":
            connection.execute("BEGIN")
        else:
            connection.execute("BEGIN ISOLATION LEVEL REPEATABLE READ")
        if path == "/api/algorithm-settings":
            return HTTPStatus.OK, get_settings_snapshot(connection)
        if path == "/api/training-progress":
            from training_progress import load_plan, progress
            plan = load_plan(connection, params.get("id", [""])[0])
            if plan is None:
                return HTTPStatus.NOT_FOUND, {"error": "Piano salvato non trovato"}
            return HTTPStatus.OK, progress(connection, plan, companion_filter=companion_filter)
        if path not in ANALYTICAL_ENDPOINTS:
            return _query_database_raw(path, params, connection)
        if path == "/api/recommendation-evidence" and normalize_role(params.get("role", [""])[0]) not in ROLES:
            return HTTPStatus.BAD_REQUEST, {"error": "a valid role is required"}
        snapshot = get_settings_snapshot(connection)
        expected = params.get("algorithm_revision", [str(snapshot["revision"])])[0]
        if str(expected) != str(snapshot["revision"]):
            return HTTPStatus.CONFLICT, {"error": "La configurazione è cambiata: aggiorna i risultati.",
                                         "algorithm_revision": snapshot["revision"]}
        # Pin source facts as well as settings for this request. TEMP writes do
        # not alter archived data and disappear when the connection closes.
        if STORAGE.engine == "sqlite" and not connection.in_transaction:
            connection.execute("BEGIN")
        return _query_with_settings(connection, path, params, snapshot)
    except (ValueError, TypeError, OverflowError) as error:
        return HTTPStatus.BAD_REQUEST, {"error": str(error)}
    finally:
        connection.close()


def preview_algorithm_settings(body):
    from algorithm_settings import get_settings_snapshot, validate_settings, fingerprint_settings
    proposed = validate_settings(body.get("settings"))
    connection = STORAGE.connect()
    try:
        if STORAGE.engine == "sqlite":
            connection.execute("BEGIN")
        else:
            connection.execute("BEGIN ISOLATION LEVEL REPEATABLE READ")
        active = get_settings_snapshot(connection)
        if body.get("expected_revision") != active["revision"]:
            return HTTPStatus.CONFLICT, {"error": "La configurazione è cambiata", "snapshot": active}
        if STORAGE.engine == "sqlite" and not connection.in_transaction:
            connection.execute("BEGIN")
        params = {}
        for source in (body.get("scope", {}), body.get("filters", {})):
            if not isinstance(source, dict):
                raise ValueError("scope e filters devono essere oggetti")
            for key, value in source.items():
                if key not in {"account", "companion_account", "companion_mode", "role", "queue", "days"}:
                    continue
                if value is not None and value != "":
                    params[key] = [str(v) for v in value] if isinstance(value, list) else [str(value)]
        params["as_of"] = [datetime.now().astimezone().isoformat()]
        candidate = {"revision": active["revision"], "fingerprint": fingerprint_settings(proposed), "settings": proposed}
        def summarize(snapshot, include_algorithms=False):
            from algorithm_settings import settings_context
            from analysis_runtime import prepare_analysis
            with settings_context(snapshot["settings"], snapshot["revision"], snapshot["fingerprint"]):
                from recommendation_runtime import recommendation_data
                preference_params = canonical_account_params(connection, params)
                # The archived comparison supports cross-queue scopes; the
                # current recommender always chooses one concrete context.
                if preference_params.get("queue") == ["all"]:
                    preference_params = {k: v for k, v in preference_params.items() if k != "queue"}
                preferences = recommendation_data(connection, preference_params,
                    account_filter=account_filter, companion_filter=companion_filter)
                view, normalized = prepare_analysis(connection, canonical_account_params(connection, params),
                                                    account_filter=account_filter, companion_filter=companion_filter)
                candidates = scoped_champion_evidence(view, normalized)
                evaluated = control_decisions(candidate_metrics(candidates), "advantage_probability")
                ranks = rank_recommendations(candidates)
                result = {
                    "preferences": preferences,
                    "context": view.context,
                    "champions": [{"id": r["role"] + ":" + r["champion"], "estimate": r["posterior_win_rate"],
                                   "lower": r.get("credible_lower", r["credible_lower_90"]),
                                   "upper": r.get("credible_upper", r["credible_upper_90"]),
                                   "actionable": r["actionable"], "games": r["games"],
                                   "unique_games": r.get("unique_games", r["games"])} for r in evaluated],
                    "ranking": [r["role"] + ":" + r["champion"] for r in ranks],
                    "supported": sum(r["actionable"] for r in evaluated),
                    "attribution": {"positive": sum(r["positive_evidence"] for r in candidates),
                                    "negative": sum(r["negative_evidence"] for r in candidates)},
                }
                if include_algorithms:
                    from live_recommendations import training_plan, exploration
                    result["training"] = training_plan(candidates, selected_accounts(normalized))
                    opponents = matchup_data(view, normalized, "ALL", normalized["role"][0])
                    allies = synergy_data(view, normalized)
                    _, friends = _query_database_raw("/api/friends", normalized, view)
                    def concise(items):
                        return [{"champion": r.get("champion", r.get("friend")),
                                 "estimate": r.get("posterior_win_rate"), "actionable": r.get("actionable"),
                                 "unique_games": r.get("unique_games"), "score": r.get("matchup_score")} for r in items]
                    result["matchups"] = {"family_size": opponents["family_size"],
                        "items": concise(opponents["beats"] + opponents["loses_to"])}
                    result["synergy"] = {"family_size": allies["family_size"],
                        "items": concise(allies["better_with"] + allies["worse_with"])}
                    result["friends"] = {"items": concise(friends.get("items", []))}
                    result["blacklist"] = {"items": concise(selected_blacklist(view, selected_accounts(normalized), normalized))}
                    code, styles = _query_database_raw("/api/playstyles", normalized, connection)
                    if code == HTTPStatus.OK:
                        result["playstyles"] = {"summary": styles["summary"], "behavior": styles["behavior"],
                            "categories": [{k: r.get(k) for k in ("id", "supported", "games", "observations", "lift", "mean", "lower", "upper", "sensitivity")}
                                           for r in styles["categories"]]}
                        result["exploration"] = exploration(styles)
                    else:
                        result["playstyles"] = styles
                        result["exploration"] = {"items": [], "note": "Seleziona un singolo ruolo per esplorare gli stili."}
                return result
        before, after = summarize(active, True), summarize(candidate, True)
        # Sensitivity holds every parameter and filter fixed except attribution.
        import copy
        sensitivity = []
        for label, weights in (("Pesi pieni", [1] * (len(proposed["attribution"]["duration_bounds"]) + 1)),
                               ("Fasce storiche", [0, .04, .15, .35, .60, .88])):
            variant = copy.deepcopy(proposed)
            variant["attribution"]["loss_weights"] = weights
            if label == "Pesi pieni":
                variant["attribution"].update({"win_short_weight": 1, "win_long_weight": 1,
                    "quasi_afk_multiplier": 1, "early_surrender_multiplier": 1,
                    "team_collapse_multiplier": 1, "surrender_multiplier": 1, "kill_deficit_multiplier": 1})
            else:
                variant["attribution"].update({"duration_bounds": [10, 15, 20, 23, 27],
                    "quasi_afk_multiplier": .35, "early_surrender_multiplier": .55,
                    "team_collapse_multiplier": .65, "surrender_multiplier": .85, "kill_deficit_multiplier": .85})
            result = summarize({**candidate, "settings": variant, "fingerprint": fingerprint_settings(variant)})
            sensitivity.append({"label": label, **result})
        changed = [f"{group}.{key}" for group, values in proposed.items() for key, value in values.items()
                   if value != active["settings"].get(group, {}).get(key)]
        comparisons = [{"algorithm": "Campioni e attribuzione", "before": {k: before[k] for k in ("champions", "ranking", "supported", "attribution")},
                        "after": {k: after[k] for k in ("champions", "ranking", "supported", "attribution")}}]
        comparisons.extend({"algorithm": name, "before": before[key], "after": after[key]} for key, name in (
            ("matchups", "Avversari"), ("synergy", "Sinergie"), ("friends", "Compagni"), ("blacklist", "Segnali negativi"),
            ("playstyles", "Stili e comportamenti"), ("training", "Piano di prove"), ("exploration", "Esplorazione")))
        comparisons.append({"algorithm": "Preferenze e prove personali", "before": before["preferences"], "after": after["preferences"]})
        return HTTPStatus.OK, {"base_revision": active["revision"], "proposed_fingerprint": candidate["fingerprint"],
            "changed_paths": changed, "comparisons": comparisons,
            "sensitivity": sensitivity, "context": after["context"],
            "notes": ["L'anteprima non salva modifiche. Preferenze e prove personali mostra il motore usato dalle raccomandazioni attuali.",
                      "Le altre analisi conservano contratti distinti; le soglie si applicano all'intera famiglia.",
                      "I pesi delle sconfitte non entrano nel profilo delle preferenze o nei risultati grezzi."]}
    finally:
        connection.close()


def _query_database_raw(path: str, params: dict[str, list[str]], connection=None) -> tuple[int, dict]:
    owns_connection = connection is None
    if owns_connection:
        connection = STORAGE.connect()
    try:
        if path == "/api/recommendation-feedback":
            from recommendation_feedback import _validated_accounts
            _validated_accounts(selected_accounts(params))
        params = canonical_account_params(connection, params)
        if path == "/api/recommendation-feedback":
            from recommendation_feedback import feedback_library
            return HTTPStatus.OK, feedback_library(connection, selected_accounts(params))
        if path in {"/api/playstyles", "/api/playstyle-evidence"}:
            from playstyle_analysis import analyze, evidence
            from playstyle_metrics import fetch_metrics
            accounts = selected_accounts(params)
            account_sql, account_values = account_filter(accounts, "m.account")
            companion_sql, companion_values = companion_filter(params, "m.match_id")
            columns = "m.account,m.match_id,m.champion,m.role,m.queue,m.date,m.win,m.duration_minutes,COALESCE(a.note,'') note"
            source = f"SELECT {columns} FROM match_quality m LEFT JOIN match_annotations a ON a.match_id=m.match_id WHERE 1=1{account_sql}"
            rows = rows_to_dicts(connection.execute(source + companion_sql + " ORDER BY m.id", [*account_values, *companion_values]))
            # Lifetime play history ignores period, role, mode AND companion filters.
            lifetime = rows_to_dicts(connection.execute(source + " ORDER BY m.id", account_values)) if companion_sql else rows
            target = accounts or sorted({r["account"] for r in lifetime})
            suspended = {r["account"] for r in connection.execute(
                "SELECT i.account FROM riot_account_identities i JOIN riot_identity_policy p "
                "ON p.identity_id=i.identity_id WHERE p.state='exception' "
                "UNION SELECT mm.account FROM riot_match_materialization mm JOIN riot_identity_policy p "
                "ON p.puuid=mm.participant_puuid WHERE p.state='exception'")} & set(target)
            # A suspended identity stays in the target population, so it vetoes
            # supported relative claims. Retain its lifetime play list only to
            # avoid labelling a historically linked champion as never tried.
            rows = [r for r in rows if r["account"] not in suspended]
            try:
                payload = evidence(rows, params) if path.endswith("-evidence") else analyze(
                    rows, lifetime, target, params, metrics_fetcher=lambda items: fetch_metrics(connection, items))
                if suspended and path == "/api/playstyles":
                    payload["notes"].append("Identità sospesa: storico escluso dal confronto per " + ", ".join(sorted(suspended)) + ". Nessuna conclusione relativa può essere sostenuta per l’intera selezione.")
            except (ValueError, TypeError) as error:
                return HTTPStatus.BAD_REQUEST, {"error": str(error)}
            return HTTPStatus.OK, payload
        recent_expression = "m.date::timestamp >= CURRENT_TIMESTAMP - INTERVAL '90 days'" if STORAGE.engine == "postgres" else "m.date >= datetime('now','-90 day')"
        if path == "/api/overview":
            metadata = {row["key"]: row["value"] for row in connection.execute("SELECT key, value FROM source_metadata")}
            accounts = selected_accounts(params)
            account_sql, account_values = account_filter(accounts)
            companion_sql, companion_values = companion_filter(params, "m.match_id")
            summary = dict(connection.execute(
                "SELECT COUNT(*) champion_role_pairs, SUM(games_observed) observed_games, ROUND(AVG(account_adjusted_fit_score),1) average_fit FROM champion_fit"
            ).fetchone())
            if accounts:
                summary = dict(connection.execute(
                    f"SELECT COUNT(*) observed_games, SUM(win) wins, ROUND(AVG(win) * 100, 1) win_rate FROM match_quality m WHERE 1=1{account_sql}{companion_sql}", [*account_values, *companion_values]
                ).fetchone()) | {"champion_role_pairs": summary["champion_role_pairs"], "average_fit": summary["average_fit"]}
            summary["planned_games"] = connection.execute("SELECT COALESCE(SUM(allocated_games), 0) planned_games FROM test_plan").fetchone()["planned_games"]
            summary["strong_blacklist"] = connection.execute("SELECT COUNT(*) strong_blacklist FROM blacklist WHERE tier='strong'").fetchone()["strong_blacklist"]
            summary["provisional_blacklist"] = connection.execute("SELECT COUNT(*) provisional_blacklist FROM blacklist WHERE tier='provisional'").fetchone()["provisional_blacklist"]
            summary["contaminated_losses"] = connection.execute(
                f"SELECT COUNT(*) contaminated_losses FROM match_quality m WHERE m.win=0 AND m.loss_attribution_weight < {current_settings()['attribution']['contaminated_threshold']}{account_sql}{companion_sql}",
                [*account_values, *companion_values],
            ).fetchone()["contaminated_losses"]
            if accounts:
                roles = rows_to_dicts(connection.execute(
                    f"""SELECT m.role, COUNT(DISTINCT m.champion) champion_role_pairs,
                              COUNT(*) observed_games, ROUND(AVG(m.win) * 100, 1) average_fit,
                              COALESCE((SELECT SUM(p.allocated_games) FROM test_plan p WHERE p.role=m.role), 0) planned_games
                       FROM match_quality m
                       WHERE m.role IN ({','.join('?' for _ in ROLES)}){account_filter(accounts, 'm.account')[0]}{companion_sql}
                       GROUP BY m.role
                       ORDER BY CASE m.role WHEN 'TOP' THEN 1 WHEN 'JUNGLE' THEN 2 WHEN 'MIDDLE' THEN 3 WHEN 'BOTTOM' THEN 4 ELSE 5 END""",
                    [*ROLES, *account_values, *companion_values],
                ))
            else:
                roles = rows_to_dicts(connection.execute(
                    """SELECT f.role, COUNT(*) champion_role_pairs, SUM(f.games_observed) observed_games,
                           ROUND(AVG(f.account_adjusted_fit_score), 1) average_fit,
                           COALESCE((SELECT SUM(p.allocated_games) FROM test_plan p WHERE p.role=f.role), 0) planned_games
                       FROM champion_fit f GROUP BY f.role
                       ORDER BY CASE f.role WHEN 'TOP' THEN 1 WHEN 'JUNGLE' THEN 2 WHEN 'MIDDLE' THEN 3 WHEN 'BOTTOM' THEN 4 ELSE 5 END"""
                ))
            return HTTPStatus.OK, {"metadata": metadata, "summary": summary, "roles": roles}

        if path == "/api/accounts":
            from analysis_runtime import parse_time
            search = params.get("q", [""])[0].strip().casefold()
            account_rows = rows_to_dicts(connection.execute(
                """SELECT accounts.account,
                          COALESCE(stats.games, 0) analyzed_games,
                          COALESCE(stats.wins, 0) wins
                   FROM (
                       SELECT account FROM tracked_account_puuids GROUP BY account
                       UNION
                       SELECT account FROM riot_accounts_raw GROUP BY account
                       UNION
                       SELECT account FROM riot_match_list_raw GROUP BY account
                       UNION
                       SELECT account FROM match_quality GROUP BY account
                   ) accounts
                   LEFT JOIN (
                       SELECT account, COUNT(*) games, SUM(win) wins
                       FROM match_quality GROUP BY account
                   ) stats ON stats.account = accounts.account
                   ORDER BY accounts.account"""
            ))
            # Raw account coverage includes malformed dates, invalid roles, and
            # future observations. Only the date extrema need UTC parsing; keep
            # literal account labels and all existing counts independent of it.
            date_extrema: dict[str, tuple[datetime, datetime]] = {}
            for observation in connection.execute("SELECT account,date FROM match_quality"):
                when = parse_time(observation["date"])
                if when is None:
                    continue
                account = observation["account"]
                bounds = date_extrema.get(account)
                date_extrema[account] = (min(bounds[0], when), max(bounds[1], when)) if bounds else (when, when)
            # Saved browser profiles use display names. Expose only aliases
            # with one verified owner so a rename cannot widen the selection.
            alias_owners: dict[str, set[str]] = {}
            alias_displays: dict[str, set[str]] = {}
            current_names = {
                normalize_riot_id_key(item["account"]): item["account"]
                for item in account_rows
            }
            for alias in connection.execute(
                """SELECT i.account,a.normalized_riot_id,a.display_riot_id
                   FROM riot_account_aliases a
                   JOIN riot_identity_puuids p ON p.puuid=a.puuid
                   JOIN riot_account_identities i ON i.identity_id=p.identity_id
                   WHERE a.verification_source <> ''"""
            ):
                key = normalize_riot_id_key(alias["normalized_riot_id"])
                if key:
                    alias_owners.setdefault(key, set()).add(str(alias["account"]))
                    alias_displays.setdefault(key, set()).add(str(alias["display_riot_id"]))
            aliases_by_account: dict[str, set[str]] = {}
            for key, owners in alias_owners.items():
                if len(owners) != 1:
                    continue
                owner = next(iter(owners))
                if key in current_names and current_names[key] != owner:
                    continue
                aliases_by_account.setdefault(owner, set()).update(alias_displays[key])
            coverage = account_coverage_by_account(connection)
            for item in account_rows:
                bounds = date_extrema.get(item["account"])
                item["first_game"] = bounds[0].isoformat(timespec="microseconds") if bounds else None
                item["last_game"] = bounds[1].isoformat(timespec="microseconds") if bounds else None
                item["aliases"] = sorted(aliases_by_account.get(item["account"], set()) - {item["account"], ""})
                item.update(coverage.get(item["account"], {
                    "raw_games": int(item.get("analyzed_games") or 0),
                    "eligible_games": int(item.get("analyzed_games") or 0),
                    "analyzed_games": int(item.get("analyzed_games") or 0),
                }))
                # Compatibility for clients that still read the old aggregate.
                item["games"] = item["raw_games"]
            if search:
                account_rows = [item for item in account_rows if any(
                    search in name.casefold() for name in [item["account"], *item["aliases"]]
                )]
            return HTTPStatus.OK, {"items": account_rows}

        if path == "/api/friends":
            from analysis_runtime import parse_time, recent_match_sql
            _, participant_utc_sql, _ = recent_match_sql(connection, "mine")
            accounts = selected_accounts(params)
            account_sql, account_values = account_filter(accounts, "mine.account")
            companion_sql, companion_values = companion_filter(params, "mine.match_id")
            # A Friends view is scoped to the active profile.  Do not remove
            # every tracked account globally: an account from another saved
            # profile is a valid friend when it appears in this profile's
            # matches.  With no explicit scope, preserve the global view and
            # exclude all tracked accounts.
            owned_account_sql, owned_account_values = account_filter(accounts, "tracked.account")
            owned_raw_sql, owned_raw_values = account_filter(accounts, "raw.account")
            tracked_scope = f"""
                AND p.puuid NOT IN (
                    SELECT tracked.puuid FROM tracked_account_puuids tracked
                    WHERE 1=1{owned_account_sql}
                )
                AND p.puuid NOT IN (
                    SELECT raw.puuid FROM riot_accounts_raw raw
                    WHERE 1=1{owned_raw_sql}
                )
            """ if accounts else """
                AND p.puuid NOT IN (SELECT puuid FROM tracked_account_puuids)
                AND p.puuid NOT IN (SELECT puuid FROM riot_accounts_raw)
            """
            tracked_values = [*owned_account_values, *owned_raw_values]
            min_shared_games = friend_min_shared_games(params)
            friend_query = friend_name_filter(params)
            last_game_from = friend_last_game_from(params)
            games_from = friend_games_from(params)
            result_limit = friend_result_limit(params)
            sort_options = friend_sort_options(params)
            # PUUID is the stable identity. A Riot ID is a display name and can
            # be reused, so equal names alone must never merge distinct PUUIDs.
            participant_rows = rows_to_dicts(connection.execute(
                f"""SELECT DISTINCT p.puuid, p.riot_id, p.match_id,
                                      mine.account, mine.date, {participant_utc_sql} date_utc, p.win friend_win
                   FROM match_participants p
                   JOIN match_quality mine ON mine.match_id=p.match_id
                   WHERE p.win=mine.win
                     AND EXISTS (
                         SELECT 1
                         FROM match_participants own
                         LEFT JOIN tracked_account_puuids tracked_owner ON tracked_owner.puuid=own.puuid
                         LEFT JOIN riot_accounts_raw raw_owner ON raw_owner.puuid=own.puuid
                         WHERE own.match_id=mine.match_id
                           AND own.team_id=p.team_id
                           AND (
                               tracked_owner.account=mine.account
                               OR raw_owner.account=mine.account
                               OR LOWER(own.riot_id)=LOWER(mine.account)
                           )
                     ){tracked_scope}{account_sql}{companion_sql}""", [*tracked_values, *account_values, *companion_values]
            ))
            for row in participant_rows:
                # The projection already provides this value. Private raw
                # callers normalize their archived spelling at this boundary.
                if row["date_utc"] is None:
                    occurred_at = parse_time(row["date"])
                    row["date_utc"] = occurred_at.isoformat(timespec="microseconds") if occurred_at else None
            participant_rows = [row for row in participant_rows if row["date_utc"]
                                and (not games_from or row["date_utc"][:10] >= games_from)]

            parent = {}
            puuids_by_name = {}

            for row in participant_rows:
                riot_id = str(row["riot_id"] or "").strip().casefold()
                if riot_id:
                    puuids_by_name.setdefault(riot_id, set()).add(row["puuid"])

            def find(puuid):
                parent.setdefault(puuid, puuid)
                while parent[puuid] != puuid:
                    parent[puuid] = parent[parent[puuid]]
                    puuid = parent[puuid]
                return puuid

            def union(left, right):
                left, right = find(left), find(right)
                if left != right:
                    parent[right] = left

            for row in participant_rows:
                find(row["puuid"])

            manual_groups = rows_to_dicts(connection.execute(
                "SELECT g.id, g.name, a.alias FROM friend_groups g "
                "LEFT JOIN friend_group_aliases a ON a.group_id=g.id ORDER BY g.name, a.alias"
            ))
            manual_nodes = {}
            for row in manual_groups:
                node = f"manual:{row['id']}"
                manual_nodes.setdefault(node, {"name": row["name"], "aliases": []})
                if row["alias"]:
                    manual_nodes[node]["aliases"].append(row["alias"])
                    union(node, row["alias"])
            owned_names = {
                str(row["account"]).casefold()
                for row in connection.execute(
                    ("SELECT account FROM match_quality WHERE 1=1" + account_filter(accounts, "account")[0] +
                     " UNION SELECT account FROM riot_accounts_raw WHERE 1=1" + account_filter(accounts, "account")[0])
                    if accounts else
                    "SELECT account FROM match_quality UNION SELECT account FROM riot_accounts_raw",
                    ([*accounts, *accounts] if accounts else []),
                )
                if row["account"]
            }
            owned_manual_nodes = {
                node for node, value in manual_nodes.items()
                if any(str(alias).casefold() in owned_names for alias in value["aliases"])
            }
            manual_alias_nodes = {
                alias.casefold(): node for node, value in manual_nodes.items() for alias in value["aliases"]
            }
            for alias, node in manual_alias_nodes.items():
                puuids = puuids_by_name.get(alias, set())
                # A manual alias can bridge historical PUUIDs only when it
                # identifies exactly one current PUUID in this result set.
                # Reused names stay separate until the user can identify them
                # by a stable identity rather than an ambiguous display name.
                if len(puuids) == 1:
                    union(node, next(iter(puuids)))

            grouped = {}
            for row in participant_rows:
                group_key = find(row["puuid"])
                group = grouped.setdefault(group_key, {
                    "aliases": set(), "matches": set(), "accounts": set(), "results": {},
                    "dates": [], "observations": {},
                })
                if row["riot_id"]:
                    group["aliases"].add(row["riot_id"])
                group["matches"].add(row["match_id"])
                group["accounts"].add(row["account"])
                # Multiple selected accounts or historical aliases can expose
                # the same friend in the same game. Count that outcome once,
                # from the friend's team rather than the selected profile.
                group["results"][row["match_id"]] = row["friend_win"]
                group["observations"][(row["account"], row["match_id"])] = {
                    "account": row["account"], "match_id": row["match_id"], "win": row["friend_win"]}
                group["dates"].append(row["date_utc"])

            for node, value in manual_nodes.items():
                root = find(node)
                if root in grouped:
                    grouped[root]["manual_name"] = value["name"]
                    grouped[root]["manual_aliases"] = list(value["aliases"])
                    if node in owned_manual_nodes:
                        grouped[root]["is_owned"] = True

            friends = []
            for friend_key, group in grouped.items():
                if group.get("is_owned"):
                    continue
                friend_name = group.get("manual_name") or " · ".join(sorted(group["aliases"]))
                last_game = max(group["dates"])
                friends.append({
                    "friend_key": friend_key,
                    "friend": friend_name,
                    "shared_games": len(group["matches"]),
                    "accounts_played_with": len(group["accounts"]),
                    "first_game": min(group["dates"]),
                    "last_game": last_game,
                    "friend_win_rate": round(sum(100.0 if win else 0.0 for win in group["results"].values()) / len(group["results"]), 1),
                    "_outcomes": dict(group["results"]),
                    "_observations": list(group["observations"].values()),
                    "_search_names": [friend_name, *group.get("manual_aliases", [])],
                })
            from contextual_comparisons import build_contrast
            reference = fetch_outcome_rows(connection, params)
            if games_from:
                cutoff = parse_time(games_from)
                reference = [row for row in reference
                             if (occurred_at := parse_time(row["date"])) is not None and occurred_at >= cutoff]
            for item in friends:
                item.pop("_outcomes")
                contrast = build_contrast(reference, item.pop("_observations"), accounts)
                item.update(contrast)
                item.update(outcome_metrics(contrast))
            evidence_settings = current_settings()["evidence"]
            control_decisions(friends, "signal_probability")
            for item in friends:
                role_reasons = []
                if item.get("mixed_role_context"):
                    role_reasons.append("Le partite con questo compagno includono più ruoli; scegli un ruolo per un confronto omogeneo.")
                if item.get("missing_role_baselines"):
                    role_reasons.append("Manca un riferimento nello stesso ruolo per almeno un account selezionato.")
                if role_reasons:
                    item.update(actionable=False, statistical_actionable=False, relative_actionable=False,
                                decision_reason=" ".join(role_reasons))
                if not item.get("actionable"):
                    decision_games = int(item.get("unique_games", item["shared_games"]) or 0)
                    item["reliability"] = (
                        "exploratory" if decision_games < float(evidence_settings["display_min_games"])
                        else "weak" if decision_games < float(evidence_settings["indicative_games"])
                        else "indicative"
                    )
                item.pop("account_cells", None)
            friends = [item for item in friends if item["shared_games"] >= min_shared_games
                       and (not friend_query or any(
                           friend_query in name.casefold() for name in item["_search_names"]
                       ))
                       and (not last_game_from or item["last_game"][:10] >= last_game_from)]
            for item in friends:
                item.pop("_search_names", None)
            friends.sort(key=lambda item: item["friend"])
            sort_keys = {
                "games": "shared_games",
                "winrate": "credible_lower",
                "last_game": "last_game",
            }
            for sort_by, sort_ascending in reversed(sort_options):
                friends.sort(key=lambda item: item[sort_keys[sort_by]], reverse=not sort_ascending)
            friend_count = len(friends)
            friends = friends[:result_limit]
            summary = {
                "tracked_accounts": len(accounts) if accounts else connection.execute("SELECT COUNT(DISTINCT account) value FROM match_quality").fetchone()["value"],
                "matches_with_participants": connection.execute(f"SELECT COUNT(DISTINCT p.match_id) value FROM match_participants p JOIN match_quality m ON m.match_id=p.match_id WHERE 1=1{account_filter(accounts, 'm.account')[0]}{companion_filter(params, 'm.match_id')[0]}", [*account_filter(accounts, 'm.account')[1], *companion_filter(params, 'm.match_id')[1]]).fetchone()["value"],
                "friends_found": friend_count,
                "min_shared_games": min_shared_games,
                "accounts": accounts,
            }
            return HTTPStatus.OK, {"items": friends, "summary": summary, "manual_groups": [
                {"id": friend_group_json_id(int(node.split(":", 1)[1])), "name": value["name"], "aliases": value["aliases"]}
                for node, value in manual_nodes.items()
            ]}

        if path == "/api/sync-status":
            from sync_runs import recent_runs
            metadata = {row["key"]: row["value"] for row in connection.execute("SELECT key, value FROM source_metadata")}
            checkpoints = sorted(APP_ROOT.glob(".champion_fit.riot-*.checkpoint.json"), key=lambda item: item.stat().st_mtime, reverse=True)
            active = sync_is_active()
            return HTTPStatus.OK, {
                "mode": "importing" if active else "snapshot",
                "sync_active": active,
                "automatic_api_calls": False,
                "checkpoint_accounts": len(checkpoints),
                "last_checkpoint_at": datetime.fromtimestamp(checkpoints[0].stat().st_mtime).isoformat() if checkpoints else None,
                "last_completed_at": metadata.get("last_sync_at"),
                "metadata": metadata,
                "recent_runs": recent_runs(connection),
            }

        if path == "/api/recommendation-evidence":
            champion = params.get("champion", [""])[0].strip()
            role = normalize_role(params.get("role", [""])[0])
            if not champion:
                return HTTPStatus.BAD_REQUEST, {"error": "champion is required"}
            if role not in ROLES:
                return HTTPStatus.BAD_REQUEST, {"error": "a valid role is required"}
            try:
                limit = int(params.get("limit", ["20"])[0])
                offset = int(params.get("offset", ["0"])[0])
            except (TypeError, ValueError):
                return HTTPStatus.BAD_REQUEST, {"error": "limit and offset must be integers"}
            if limit < 1 or offset < 0:
                return HTTPStatus.BAD_REQUEST, {"error": "limit must be positive and offset non-negative"}
            if offset > SQL_INTEGER_MAX:
                return HTTPStatus.BAD_REQUEST, {"error": "offset is too large"}
            return HTTPStatus.OK, recommendation_evidence_data(
                connection, params, champion, role, min(limit, 100), offset,
            )

        if path == "/api/profile":
            from analysis_runtime import recent_match_sql
            _, date_utc_sql, date_order_sql = recent_match_sql(connection)
            accounts = selected_accounts(params)
            account_sql, account_values = account_filter(accounts)
            companion_sql, companion_values = companion_filter(params, "m.match_id")
            champion_options = [row["champion"] for row in connection.execute(
                f"SELECT DISTINCT m.champion FROM match_quality m WHERE 1=1{account_sql}{companion_sql} ORDER BY m.champion",
                [*account_values, *companion_values],
            )]
            champion = params.get("champion", [""])[0]
            if champion:
                account_sql += " AND m.champion=?"
                account_values = [*account_values, champion]
            scoped_values = [*account_values, *companion_values]
            base = connection.execute(
                f"""SELECT COUNT(*) games, COALESCE(SUM(win), 0) wins,
                          ROUND(COALESCE(AVG(win), 0) * 100, 1) win_rate,
                          ROUND(COALESCE(AVG(duration_minutes), 0), 1) avg_duration,
                          COUNT(DISTINCT champion) champions_played,
                          MIN({date_order_sql}) first_game, MAX({date_order_sql}) last_game
                   FROM match_quality m WHERE 1=1{account_sql}{companion_sql}""", scoped_values
            ).fetchone()
            summary = dict(base)
            summary["avg_duration"] = _finite_duration_average(
                connection, summary["avg_duration"], f"1=1{account_sql}{companion_sql}", scoped_values,
            )
            summary["losses"] = summary["games"] - summary["wins"]
            annotation_summary = connection.execute(
                f"""SELECT COALESCE(SUM(invincible), 0) invincible_games,
                          COALESCE(SUM(carryable_loss), 0) carryable_losses,
                          COALESCE(SUM(afk_player), 0) afk_games,
                          COALESCE(SUM(griefer), 0) griefer_games
                   FROM match_annotations a JOIN match_quality m ON m.match_id=a.match_id
                   WHERE 1=1{account_sql}{companion_sql}""", scoped_values
            ).fetchone()
            summary.update(dict(annotation_summary))
            recent = rows_to_dicts(connection.execute(
                f"""SELECT match_id, date, {date_utc_sql} date_utc, account, champion, role, win, queue, duration_minutes,
                          match_quality_score, anomaly_flags
                   FROM match_quality m WHERE 1=1{account_sql}{companion_sql}
                   ORDER BY {date_order_sql} DESC, m.match_id ASC, m.account ASC LIMIT 20""", scoped_values
            ))
            champions = rows_to_dicts(connection.execute(
                f"""SELECT champion, COUNT(*) games, SUM(win) wins,
                          ROUND(AVG(win) * 100, 1) win_rate,
                          ROUND(AVG(duration_minutes), 1) avg_duration
                   FROM match_quality m WHERE 1=1{account_sql}{companion_sql}
                   GROUP BY champion ORDER BY games DESC, win_rate DESC LIMIT 12""", scoped_values
            ))
            for item in champions:
                item["avg_duration"] = _finite_duration_average(
                    connection, item["avg_duration"], f"m.champion=?{account_sql}{companion_sql}",
                    [item["champion"], *scoped_values],
                )
            recommendation_account_sql, recommendation_account_values = account_filter(accounts, "m.account")
            positive_sql, negative_sql, weight_sql = recommendation_evidence_expressions()
            evidence_select = f"""SELECT m.role, m.champion, COUNT(*) games, SUM(m.win) wins,
                          ROUND(AVG(m.win) * 100, 1) win_rate,
                          COALESCE(SUM({positive_sql}),0) positive_evidence,
                          COALESCE(SUM({negative_sql}),0) negative_evidence,
                          COALESCE(SUM(CASE WHEN ({weight_sql})>0 AND ({weight_sql})<1 THEN 1 ELSE 0 END),0) discounted_games,
                          COALESCE(SUM(CASE WHEN ({weight_sql})=0 THEN 1 ELSE 0 END),0) excluded_games
                   FROM match_quality m
                   LEFT JOIN match_annotations a ON a.match_id=m.match_id
                   WHERE m.role != 'INVALID'"""
            role_champions = rows_to_dicts(connection.execute(
                f"""{evidence_select}{recommendation_account_sql}
                   {companion_sql} GROUP BY m.role, m.champion""", [*recommendation_account_values, *companion_values]
            ))
            roles = rows_to_dicts(connection.execute(
                f"""SELECT role, COUNT(*) games, SUM(win) wins,
                           ROUND(AVG(win) * 100, 1) win_rate
                    FROM match_quality m WHERE role != 'INVALID' AND 1=1{account_sql}{companion_sql}
                   GROUP BY role ORDER BY games DESC""", scoped_values
            ))
            weekday_expression = (f"EXTRACT(DOW FROM {date_order_sql}::timestamp)::integer" if STORAGE.engine == "postgres"
                                  else f"CAST(strftime('%w', {date_order_sql}) AS INTEGER)")
            weekdays = rows_to_dicts(connection.execute(
                f"""SELECT {weekday_expression} weekday, COUNT(*) games,
                          ROUND(AVG(win) * 100, 1) win_rate
                   FROM match_quality m WHERE 1=1{account_sql}{companion_sql}
                   GROUP BY weekday ORDER BY weekday""", scoped_values
            ))
            recommendations = rank_recommendations([
                item for item in scoped_champion_evidence(connection, params)
                if not champion or item["champion"] == champion
            ])
            return HTTPStatus.OK, {"accounts": accounts, "summary": summary, "recent": recent, "champions": champions, "champion_options": champion_options, "roles": roles, "weekdays": weekdays, "recommendations": recommendations}

        if path == "/api/champion":
            from analysis_runtime import recent_match_sql
            _, date_utc_sql, date_order_sql = recent_match_sql(connection)
            champion = params.get("champion", [""])[0].strip()
            role = normalize_role(params.get("role", [""])[0])
            if role not in ROLES:
                role = ""
            if not champion:
                return HTTPStatus.BAD_REQUEST, {"error": "champion is required"}
            accounts = selected_accounts(params)
            account_sql, account_values = account_filter(accounts)
            companion_sql, companion_values = companion_filter(params, "m.match_id")
            fit_values = [champion] + ([role] if role else [])
            fit_where = "champion=?" + (" AND role=?" if role else "")
            fit_rows = rows_to_dicts(connection.execute(
                f"SELECT * FROM champion_fit WHERE {fit_where} ORDER BY games_observed DESC",
                fit_values,
            ))
            if role:
                fit = fit_rows[0] if fit_rows else None
            elif fit_rows:
                total_games = sum(int(row["games_observed"] or 0) for row in fit_rows)
                weighted = lambda field: round(sum(float(row[field] or 0) * int(row["games_observed"] or 0) for row in fit_rows) / max(total_games, 1), 6)
                fit = dict(fit_rows[0])
                fit.update({
                    "role": "ALL",
                    "games_observed": total_games,
                    "wins": sum(int(row["wins"] or 0) for row in fit_rows),
                    "losses": sum(int(row["losses"] or 0) for row in fit_rows),
                    "account_adjusted_fit_score": weighted("account_adjusted_fit_score"),
                    # Role-specific posterior intervals cannot be averaged
                    # into a valid interval for the combined population.
                    "posterior_fit_probability": None,
                    "credible_lower_90": None,
                    "credible_upper_90": None,
                    "uncertainty_width_90": None,
                    "probability_above_high_fit_threshold": None,
                })
            else:
                fit = None
            detail_role_sql = " AND m.role=?" if role else ""
            detail_role_values = [role] if role else []
            scoped_detail_values = [champion, *detail_role_values, *account_values, *companion_values]
            stat = connection.execute(
                f"""SELECT COUNT(*) games, COALESCE(SUM(win),0) wins,
                          ROUND(COALESCE(AVG(win),0)*100,1) win_rate,
                          ROUND(COALESCE(AVG(duration_minutes),0),1) avg_duration
                   FROM match_quality m WHERE champion=?{detail_role_sql}{account_sql}{companion_sql}""", scoped_detail_values
            ).fetchone()
            stat = dict(stat)
            stat["avg_duration"] = _finite_duration_average(
                connection, stat["avg_duration"], f"m.champion=?{detail_role_sql}{account_sql}{companion_sql}",
                scoped_detail_values,
            )
            annotated = connection.execute(
                f"""SELECT COALESCE(SUM(a.invincible),0) invincible_games,
                          COALESCE(SUM(a.carryable_loss),0) carryable_losses,
                          COALESCE(SUM(a.afk_player),0) afk_games,
                          COALESCE(SUM(a.griefer),0) griefer_games
                   FROM match_quality m JOIN match_annotations a ON a.match_id=m.match_id
                   WHERE m.champion=?{detail_role_sql}{account_sql}{companion_sql}""", scoped_detail_values
            ).fetchone()
            recent = rows_to_dicts(connection.execute(
                f"""SELECT date, {date_utc_sql} date_utc, account, role, win, reason
                   FROM match_quality m WHERE champion=?{detail_role_sql}{account_sql}{companion_sql}
                   ORDER BY {date_order_sql} DESC, m.match_id ASC, m.account ASC LIMIT 20""", scoped_detail_values
            ))
            roles = rows_to_dicts(connection.execute("SELECT role, games_observed, account_adjusted_fit_score, credible_lower_90, credible_upper_90 FROM champion_fit WHERE champion=? ORDER BY games_observed DESC", (champion,)))
            for item in roles:
                normalize_global_fit(item)
            if fit:
                normalize_global_fit(fit)
            matchups = matchup_data(connection, params, champion, role)
            return HTTPStatus.OK, {"champion": champion, "role": role, "accounts": accounts, "fit": dict(fit) if fit else None, "stats": dict(stat) | dict(annotated), "recent": recent, "roles": roles, "matchups": matchups}

        if path == "/api/matchups":
            champion = params.get("champion", ["ALL"])[0].strip() or "ALL"
            role = params.get("role", [""])[0].strip()
            return HTTPStatus.OK, matchup_data(connection, params, champion, role)

        if path == "/api/synergy":
            return HTTPStatus.OK, synergy_data(connection, params)

        if path == "/api/champions":
            clauses, values = ["1=1"], []
            accounts = selected_accounts(params)
            account_sql, account_values = account_filter(accounts, "m.account")
            companion_sql, companion_values = companion_filter(params, "m.match_id")
            role = params.get("role", ["ALL"])[0]
            status = params.get("status", ["ALL"])[0]
            search = params.get("search", [""])[0].strip()
            if role in ROLES:
                clauses.append(("m.role" if accounts else "f.role") + "=?"); values.append(role)
            status_sql = {
                "validated": "f.validated_positive=1",
                "testing": "p.allocated_games IS NOT NULL",
                "strong": "f.blacklist_strong=1",
                "provisional": "f.blacklist_provisional=1",
            }
            if status in status_sql:
                if accounts:
                    # The account-scoped query is aggregated from match_quality,
                    # so filter the row by the corresponding global champion fit.
                    # Previously status was silently ignored whenever accounts
                    # were selected, making the dropdown appear non-functional.
                    account_status_sql = {
                        "validated": "EXISTS (SELECT 1 FROM champion_fit sf WHERE sf.champion=m.champion AND sf.role=m.role AND sf.validated_positive=1)",
                        "testing": "EXISTS (SELECT 1 FROM test_plan sp WHERE sp.champion=m.champion AND sp.role=m.role AND sp.allocated_games IS NOT NULL)",
                        "strong": "EXISTS (SELECT 1 FROM champion_fit sf WHERE sf.champion=m.champion AND sf.role=m.role AND sf.blacklist_strong=1)",
                        "provisional": "EXISTS (SELECT 1 FROM champion_fit sf WHERE sf.champion=m.champion AND sf.role=m.role AND sf.blacklist_provisional=1)",
                    }
                    clauses.append(account_status_sql[status])
                else:
                    clauses.append(status_sql[status])
            if search:
                clauses.append(("LOWER(m.champion)" if accounts else "LOWER(f.champion)") + " LIKE ?"); values.append(f"%{search.lower()}%")
            if accounts:
                if status == "screen":
                    return HTTPStatus.OK, {"items": []}
                sql = f"""SELECT '' scope, m.role, m.champion,
                              COUNT(*) games_observed, SUM(m.win) wins, COUNT(*)-SUM(m.win) losses,
                              ROUND(AVG(m.win),4) raw_win_rate, ROUND(AVG(m.win)*100,1) account_adjusted_fit_score,
                              ROUND(SUM(CASE WHEN m.win=0 THEN CASE WHEN COALESCE(a.invincible,0)=1 OR COALESCE(a.afk_player,0)=1 OR COALESCE(a.griefer,0)=1 THEN 0 ELSE m.loss_attribution_weight END ELSE 0 END),2) informative_losses_equivalent,
                              COUNT(*) effective_sample_size, NULL fit_delta_vs_account_baseline_pp,
                              NULL posterior_fit_probability, NULL credible_lower_90, NULL credible_upper_90,
                              NULL uncertainty_width_90, NULL probability_above_high_fit_threshold,
                              COUNT(DISTINCT m.account) accounts_played, {"STRING_AGG(DISTINCT m.account, ','::text)" if STORAGE.engine == "postgres" else "GROUP_CONCAT(DISTINCT m.account)"} accounts,
                              SUM(CASE WHEN {recent_expression} THEN 1 ELSE 0 END) recent_90d_games,
                              COALESCE((SELECT sf.positive_evidence FROM champion_fit sf WHERE sf.champion=m.champion AND sf.role=m.role), 0) positive_evidence,
                              COALESCE((SELECT sf.validated_positive FROM champion_fit sf WHERE sf.champion=m.champion AND sf.role=m.role), 0) validated_positive,
                              COALESCE((SELECT sf.blacklist_strong FROM champion_fit sf WHERE sf.champion=m.champion AND sf.role=m.role), 0) blacklist_strong,
                              COALESCE((SELECT sf.blacklist_provisional FROM champion_fit sf WHERE sf.champion=m.champion AND sf.role=m.role), 0) blacklist_provisional,
                              COALESCE((SELECT sf.blacklist_tier FROM champion_fit sf WHERE sf.champion=m.champion AND sf.role=m.role), 'none') blacklist_tier,
                              COALESCE((SELECT sf.blacklist_reason FROM champion_fit sf WHERE sf.champion=m.champion AND sf.role=m.role), '') blacklist_reason,
                              COALESCE((SELECT sf.value_of_information FROM champion_fit sf WHERE sf.champion=m.champion AND sf.role=m.role), 0) value_of_information,
                              c.icon_url,
                              COALESCE((SELECT sp.allocated_games FROM test_plan sp WHERE sp.champion=m.champion AND sp.role=m.role), 0) allocated_games,
                              'account' record_kind, NULL theoretical_fit_prior, '' quantitative_rationale
                       FROM match_quality m JOIN champions c ON c.champion=m.champion
                       LEFT JOIN match_annotations a ON a.match_id=m.match_id
                       WHERE {' AND '.join(clauses)}{account_sql}{companion_sql}
                       GROUP BY m.role, m.champion, c.icon_url
                       ORDER BY account_adjusted_fit_score DESC, games_observed DESC"""
                observed = rows_to_dicts(connection.execute(sql, [*values, *account_values, *companion_values]))
                evaluated = control_decisions(candidate_metrics(scoped_champion_evidence(connection, params)), "advantage_probability")
                metrics = {(item["role"], item["champion"]): item for item in evaluated}
                for item in observed:
                    evidence = metrics.get((item["role"], item["champion"]))
                    if evidence:
                        item.update({key: value for key, value in evidence.items() if key not in {"account_cells", "accounts"}})
                        item["games_observed"] = evidence["games"]
                        item["account_adjusted_fit_score"] = evidence["raw_win_rate"]
                        item["posterior_fit_probability"] = evidence["posterior_win_rate"] / 100
                        item["informative_losses_equivalent"] = evidence["negative_evidence"]
                observed.sort(key=lambda x: (-int(bool(x.get("actionable"))), -float(x.get("credible_lower_90") or 0), -x["games_observed"], x["champion"]))
                return HTTPStatus.OK, {"items": observed}
            sql = f"""SELECT f.*, c.icon_url, COALESCE(p.allocated_games, 0) allocated_games,
                              'observed' record_kind, NULL theoretical_fit_prior,
                              COALESCE(p.quantitative_rationale, '') quantitative_rationale
                       FROM champion_fit f
                       JOIN champions c ON c.champion=f.champion
                       LEFT JOIN test_plan p ON p.role=f.role AND p.champion=f.champion
                       WHERE {' AND '.join(clauses)}
                       ORDER BY f.account_adjusted_fit_score DESC, f.effective_sample_size DESC"""
            observed = rows_to_dicts(connection.execute(sql, values))
            for item in observed:
                normalize_global_fit(item)
            observed.sort(key=lambda x: (-float(x.get("credible_lower_90") or 0), -x["games_observed"], x["champion"]))
            screen_items = []
            if status in {"ALL", "screen"}:
                screen_clauses, screen_values = ["NOT EXISTS (SELECT 1 FROM champion_fit f WHERE f.role=s.role AND f.champion=s.champion)"], []
                if role in ROLES:
                    screen_clauses.append("s.role=?"); screen_values.append(role)
                if search:
                    screen_clauses.append("LOWER(s.champion) LIKE ?"); screen_values.append(f"%{search.lower()}%")
                screen_sql = f"""SELECT
                    '' scope, s.role, s.champion, 0 games_observed, 0 wins, 0 losses, 0 raw_win_rate,
                    0 positive_evidence, 0 informative_losses_equivalent, 0 effective_sample_size,
                    NULL account_adjusted_fit_score, 0 fit_delta_vs_account_baseline_pp,
                    NULL posterior_fit_probability, NULL credible_lower_90, NULL credible_upper_90,
                    NULL uncertainty_width_90, NULL probability_above_high_fit_threshold,
                    0 accounts_played, '' accounts, 0 recent_90d_games,
                    0 validated_positive, 0 blacklist_strong, 0 blacklist_provisional,
                    'none' blacklist_tier, '' blacklist_reason, 0 value_of_information,
                    c.icon_url, 0 allocated_games, 'screen' record_kind, s.theoretical_fit_prior,
                    s.reason quantitative_rationale
                    FROM screening_candidates s JOIN champions c ON c.champion=s.champion
                    WHERE {' AND '.join(screen_clauses)}
                    ORDER BY s.theoretical_fit_prior DESC, s.champion"""
                screen_items = rows_to_dicts(connection.execute(screen_sql, screen_values))
            return HTTPStatus.OK, {"items": observed + screen_items}

        if path == "/api/plan":
            accounts = selected_accounts(params)
            account_sql, account_values = account_filter(accounts, "m.account")
            companion_sql, companion_values = companion_filter(params, "m.match_id")
            role = normalize_role(params.get("role", ["ALL"])[0])
            scope_clauses = []
            scope_values = []
            if accounts or companion_sql:
                scope_clauses.append(
                    "EXISTS (SELECT 1 FROM match_quality m "
                    f"WHERE m.champion=p.champion AND m.role=p.role{account_sql}{companion_sql})"
                )
                scope_values.extend([*account_values, *companion_values])
            if role in ROLES:
                scope_clauses.append("p.role=?")
                scope_values.append(role)
            scope = "WHERE " + " AND ".join(scope_clauses) if scope_clauses else ""
            plan_items = rows_to_dicts(connection.execute(
                f"""SELECT p.*, c.icon_url FROM test_plan p JOIN champions c ON c.champion=p.champion
                   {scope}
                   ORDER BY p.allocated_games DESC, p.base_value_of_information DESC, p.role, p.champion"""
            , scope_values))
            requested_n = as_int(params.get("n", [""])[0]) if params.get("n", [""])[0] else 0
            source_total = sum(int(item["allocated_games"]) for item in plan_items)
            if requested_n > 0 and source_total > 0 and requested_n != source_total:
                # Scale the saved priority mix to the requested horizon while keeping
                # the total exact through a largest-remainder pass.
                scaled = []
                for index, item in enumerate(plan_items):
                    numerator = int(item["allocated_games"]) * requested_n
                    floor_value, fraction_numerator = divmod(abs(numerator), source_total)
                    if numerator < 0:
                        floor_value, fraction_numerator = -floor_value, -fraction_numerator
                    scaled.append((index, floor_value, fraction_numerator))
                    item["allocated_games"] = floor_value
                remainder = requested_n - sum(row[1] for row in scaled)
                for index, _, _ in sorted(scaled, key=lambda row: (-row[2], row[0]))[:remainder]:
                    plan_items[index]["allocated_games"] += 1
            return HTTPStatus.OK, {"items": plan_items, "requested_n": requested_n or source_total, "source_total": source_total, "role": role if role in ROLES else ""}

        if path == "/api/blacklist":
            accounts = selected_accounts(params)
            return HTTPStatus.OK, {"items": selected_blacklist(connection, accounts, params), "scope_accounts": accounts}

        if path == "/api/screen":
            accounts = selected_accounts(params)
            if accounts:
                account_sql, account_values = account_filter(accounts, "m.account")
                companion_sql, companion_values = companion_filter(params, "m.match_id")
                # A scout candidate is account-specific: a champion already played
                # in the same role is no longer unexplored for the active profile.
                # The role baseline also changes the ordering between roles for the
                # selected accounts, instead of always returning the global prior
                # order.
                sql = f"""WITH role_matches AS (
                             SELECT m.role, m.match_id, MIN(m.win) min_win, MAX(m.win) max_win
                             FROM match_quality m
                             WHERE 1=1{account_sql}{companion_sql}
                             GROUP BY m.role, m.match_id
                         ), role_stats AS (
                             SELECT role, SUM(CASE WHEN min_win=max_win THEN 1 ELSE 0 END) role_games,
                                    SUM(CASE WHEN min_win=max_win THEN max_win ELSE 0 END) role_wins,
                                    SUM(CASE WHEN min_win!=max_win THEN 1 ELSE 0 END) role_ambiguous_games,
                                    (4.0 + SUM(CASE WHEN min_win=max_win THEN max_win ELSE 0 END)) /
                                    (8.0 + SUM(CASE WHEN min_win=max_win THEN 1 ELSE 0 END)) role_win_rate
                             FROM role_matches GROUP BY role
                         )
                         SELECT s.*, c.icon_url, COALESCE(rs.role_games,0) role_games,
                                COALESCE(rs.role_wins,0) role_wins,
                                COALESCE(rs.role_ambiguous_games,0) role_ambiguous_games,
                                ROUND((s.theoretical_fit_prior * 0.7 +
                                       COALESCE(rs.role_win_rate, 0.5) * 0.3), 6) personalized_prior
                         FROM screening_candidates s
                         JOIN champions c ON c.champion=s.champion
                         LEFT JOIN role_stats rs ON rs.role=s.role
                         WHERE NOT EXISTS (
                             SELECT 1 FROM match_quality m
                             WHERE m.champion=s.champion AND m.role=s.role{account_sql}{companion_sql}
                         )
                         ORDER BY personalized_prior DESC, s.theoretical_fit_prior DESC, s.champion
                         LIMIT 40"""
                items = rows_to_dicts(connection.execute(sql, [*account_values, *companion_values, *account_values, *companion_values]))
                for item in items:
                    estimate = posterior_summary(item["role_wins"], item["role_games"] - item["role_wins"])
                    item.update({
                        "role_posterior_win_rate": round(estimate["mean"] * 100, 1),
                        "role_credible_lower_90": round(estimate["lower_90"] * 100, 1),
                        "role_credible_upper_90": round(estimate["upper_90"] * 100, 1),
                    })
                return HTTPStatus.OK, {"items": items}

            return HTTPStatus.OK, {"items": rows_to_dicts(connection.execute(
                """SELECT s.*, c.icon_url, s.theoretical_fit_prior personalized_prior
                   FROM screening_candidates s JOIN champions c ON c.champion=s.champion
                   ORDER BY s.theoretical_fit_prior DESC LIMIT 40"""
            ))}

        if path == "/api/matches":
            from analysis_runtime import recent_match_sql
            source_columns_sql, date_utc_sql, date_order_sql = recent_match_sql(connection)
            clauses, values = ["1=1"], []
            account_sql, account_values = account_filter(selected_accounts(params))
            companion_sql, companion_values = companion_filter(params, "m.match_id")
            role = params.get("role", ["ALL"])[0]
            champion = params.get("champion", [""])[0]
            flag = params.get("flag", ["all"])[0]
            if role in ROLES:
                clauses.append("m.role=?"); values.append(role)
            if champion:
                clauses.append("m.champion=?"); values.append(champion)
            if flag == "contaminated": clauses.append(f"win=0 AND loss_attribution_weight < {current_settings()['attribution']['contaminated_threshold']}")
            if flag == "afk": clauses.append("(explicit_afk=1 OR suspected_quasi_afk=1)")
            if flag == "loss": clauses.append("win=0")
            limit = min(max(as_int(params.get("limit", ["24"])[0]), 1), 100)
            try:
                offset = int(params.get("offset", ["0"])[0])
            except (TypeError, ValueError):
                return HTTPStatus.BAD_REQUEST, {"error": "offset must be an integer"}
            if offset < 0 or offset > SQL_INTEGER_MAX:
                return HTTPStatus.BAD_REQUEST, {"error": "offset is outside the supported range"}
            filtered_values = [*values, *account_values, *companion_values]
            total = connection.execute(
                f"SELECT COUNT(*) total FROM match_quality m WHERE {' AND '.join(clauses)}{account_sql}{companion_sql}",
                filtered_values,
            ).fetchone()["total"]
            sql = f"""SELECT {source_columns_sql}, {date_utc_sql} date_utc, c.icon_url,
                       COALESCE(a.invincible, 0) annotation_invincible,
                       COALESCE(a.carryable_loss, 0) annotation_carryable_loss,
                       COALESCE(a.afk_player, 0) annotation_afk_player,
                       COALESCE(a.griefer, 0) annotation_griefer,
                       COALESCE(a.team_collapse, 0) annotation_team_collapse,
                       COALESCE(a.manual_label, '') annotation_manual_label,
                       COALESCE(a.note, '') annotation_note,
                       COALESCE(a.confidence, 1.0) annotation_confidence
                FROM match_quality m LEFT JOIN champions c ON c.champion=m.champion
                LEFT JOIN match_annotations a ON a.match_id=m.match_id
                WHERE {' AND '.join(clauses)}{account_sql}{companion_sql}
                ORDER BY {date_order_sql} DESC, m.match_id ASC, m.account ASC LIMIT ? OFFSET ?"""
            items = rows_to_dicts(connection.execute(sql, [*filtered_values, limit, offset]))
            next_offset = offset + len(items)
            return HTTPStatus.OK, {"items": items, "total": total, "limit": limit, "offset": offset,
                                   "next_offset": next_offset if next_offset < total else None}

        if path == "/api/annotations":
            match_id = params.get("match_id", [""])[0]
            if not match_id:
                return HTTPStatus.BAD_REQUEST, {"error": "match_id is required"}
            if "\x00" in match_id:
                return HTTPStatus.BAD_REQUEST, {"error": "Identificativo della partita non valido"}
            row = connection.execute("SELECT * FROM match_annotations WHERE match_id=?", (match_id,)).fetchone()
            return HTTPStatus.OK, {
                "item": dict(row) if row else None,
                "revision": row["updated_at"] if row else None,
            }

        return HTTPStatus.NOT_FOUND, {"error": "Endpoint not found"}
    finally:
        if owns_connection:
            connection.close()


class AnnotationConflictError(RuntimeError):
    """The annotation changed after the client read its revision."""


class FriendGroupConflictError(RuntimeError):
    """A friend-group name is already owned by another group."""


def lock_friend_aliases(connection) -> None:
    """Serialize alias ownership before reads, including Unicode variants.

    SQLite callers already hold BEGIN IMMEDIATE. PostgreSQL's text UNIQUE
    constraint cannot enforce Python casefold semantics, so all friend-group
    mutations share a transaction lock before inspecting or changing aliases.
    """
    if STORAGE.engine == "postgres":
        connection.execute(
            "SELECT pg_advisory_xact_lock(hashtext(?))",
            ("champion_fit.friend_group_aliases",),
        ).fetchone()


def matching_friend_aliases(connection, aliases):
    """Use the same Unicode identity comparison as the Friends reader.

    SQLite lower() only handles ASCII and PostgreSQL lower() is locale-aware;
    neither matches casefold (for example, Straße and STRASSE). Manual aliases
    are a small user-managed collection, so compare them portably in Python.
    """
    keys = {alias.casefold() for alias in aliases}
    return [row for row in connection.execute(
        "SELECT group_id,alias FROM friend_group_aliases ORDER BY group_id,alias"
    ) if row["alias"].casefold() in keys]


def lock_friend_group_name(connection, name: str):
    """Serialize mutations and match every owner using portable Unicode semantics."""
    connection.execute("BEGIN IMMEDIATE" if STORAGE.engine == "sqlite" else "BEGIN")
    lock_friend_aliases(connection)
    key = name.casefold()
    matches = [row for row in connection.execute("SELECT id,name FROM friend_groups ORDER BY id")
               if row["name"].casefold() == key]
    if len(matches) > 1:
        raise FriendGroupConflictError("multiple friend groups use this name")
    return matches


class BodyReadTimeout(TimeoutError):
    """Distinguish an incomplete request body from a database operation timeout."""


class DashboardHandler(SimpleHTTPRequestHandler):
    def handle(self) -> None:
        try:
            super().handle()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            # Navigation and full refresh can cancel a static asset download.
            self.close_connection = True

    def setup(self) -> None:
        super().setup()
        self.connection.settimeout(REQUEST_BODY_TIMEOUT_SECONDS)

    def __init__(self, *args, directory=None, **kwargs):
        self._response_status = None
        self._request_id = None
        super().__init__(*args, directory=str(directory or WEB_ROOT), **kwargs)

    @staticmethod
    def _is_spa_path(path: str) -> bool:
        return path in {"/", "/app"} or path.startswith("/app/") or path in LEGACY_PAGE_PATHS

    def _prepare_static_path(self, path: str) -> None:
        if path == "/":
            self.path = SPA_ENTRY
            return

        # Real files always win over the SPA fallback. This keeps broken asset
        # references observable as 404s instead of returning index.html.
        static_file = Path(self.translate_path(path))
        self.path = (
            SPA_ENTRY
            if self._is_spa_path(path) and not static_file.is_file()
            else path
        )

    def _serve_api(self, path: str, query: str, *, head_only: bool = False) -> None:
        status, payload = query_database(path, parse_qs(query))
        data = json.dumps(payload, ensure_ascii=False, default=float).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        if not head_only:
            self.wfile.write(data)

    def _send_json_error(self, status: HTTPStatus, message: str) -> None:
        data = json.dumps({"error": message}, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        if status == HTTPStatus.SERVICE_UNAVAILABLE:
            self.send_header("Retry-After", "1")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def send_response(self, code, message=None) -> None:
        self._response_status = int(code)
        super().send_response(code, message)

    def end_headers(self) -> None:
        path = urlparse(self.path).path
        if path.startswith("/api/") and self._request_id:
            self.send_header("X-Request-ID", self._request_id)
        if path == SPA_ENTRY:
            self.send_header("Cache-Control", "no-cache, must-revalidate")
            self.send_header("Pragma", "no-cache")
        elif path.startswith("/assets/") and self._response_status in {
            HTTPStatus.OK,
            HTTPStatus.NOT_MODIFIED,
        }:
            self.send_header("Cache-Control", "public, max-age=31536000, immutable")
        super().end_headers()

    @api_operation
    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path.startswith("/api/"):
            self._serve_api(parsed.path, parsed.query)
            return

        self._prepare_static_path(parsed.path)
        super().do_GET()

    @api_operation
    def do_HEAD(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path.startswith("/api/"):
            self._serve_api(parsed.path, parsed.query, head_only=True)
            return

        self._prepare_static_path(parsed.path)
        super().do_HEAD()

    def _settings_request(self, preview=False) -> None:
        from algorithm_settings import save_settings, SettingsConflictError
        try:
            body = self._read_json_body(131072)
            if preview:
                status, payload = preview_algorithm_settings(body)
            else:
                connection = STORAGE.connect()
                try:
                    payload = save_settings(connection, body.get("expected_revision"), body.get("settings"))
                    status = HTTPStatus.OK
                finally:
                    connection.close()
        except SettingsConflictError as error:
            status, payload = HTTPStatus.CONFLICT, {"error": str(error), "snapshot": error.snapshot}
        except BodyReadTimeout:
            status, payload = HTTPStatus.REQUEST_TIMEOUT, {"error": "JSON body read timed out"}
        except (ValueError, TypeError, json.JSONDecodeError) as error:
            status, payload = HTTPStatus.BAD_REQUEST, {"error": str(error)}
        data = json.dumps(payload, ensure_ascii=False, default=float).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _training_progress_request(self) -> None:
        import re
        from algorithm_settings import get_settings_snapshot
        from training_progress import load_plan, save_plan, progress, valid_plan_id
        connection = None
        try:
            body = self._read_json_body(32768)
            if set(body) != {"id", "fingerprint", "params"}:
                raise ValueError("Specifica identificativo, piano e contesto")
            valid_plan_id(body["id"])
            if not isinstance(body["fingerprint"], str) or not re.fullmatch(r"[a-f0-9]{64}", body["fingerprint"]):
                raise ValueError("Piano non valido: aggiorna l’anteprima")
            params = body["params"]
            allowed = {"account", "companion_account", "companion_mode", "role", "queue", "days", "budget", "algorithm_revision"}
            if not isinstance(params, dict) or set(params) - allowed or any(
                not isinstance(values, list) or not values or any(not isinstance(value, str) for value in values)
                for values in params.values()
            ):
                raise ValueError("Contesto del piano non valido")
            connection = STORAGE.connect()
            for attempt in range(3):
                try:
                    connection.execute("BEGIN IMMEDIATE" if STORAGE.engine == "sqlite" else "BEGIN ISOLATION LEVEL SERIALIZABLE")
                    existing = load_plan(connection, body["id"])
                    if existing:
                        if existing["fingerprint"] != body["fingerprint"]:
                            status, payload = HTTPStatus.CONFLICT, {"error": "Identificativo già usato per un altro piano"}
                        else:
                            status, payload = HTTPStatus.OK, progress(connection, existing, companion_filter=companion_filter)
                    else:
                        settings = get_settings_snapshot(connection)
                        effective_params = canonical_account_params(connection, params)
                        status, plan = _query_with_settings(connection, "/api/training-plan", effective_params, settings)
                        if plan.get("plan_fingerprint") != body["fingerprint"]:
                            status, payload = HTTPStatus.CONFLICT, {"error": "Il piano è cambiato. Aggiorna l’anteprima prima di seguirlo."}
                        else:
                            snapshot = save_plan(connection, body["id"], plan, effective_params)
                            payload = progress(connection, snapshot, companion_filter=companion_filter)
                    connection.commit()
                    break
                except Exception as error:
                    sqlstate = getattr(error, "sqlstate", None)
                    same_plan_race = (sqlstate == "23505"
                                      and getattr(getattr(error, "diag", None), "table_name", None) == "training_plan_runs")
                    if (STORAGE.engine != "postgres" or attempt == 2
                            or not (sqlstate in {"40001", "40P01"} or same_plan_race)):
                        raise
                    # A concurrent start or import can invalidate a serializable
                    # snapshot. Re-read the winner and revalidate the preview in
                    # a fresh transaction; never overwrite an existing choice.
                    connection.rollback()
        except BodyReadTimeout:
            status, payload = HTTPStatus.REQUEST_TIMEOUT, {"error": "JSON body read timed out"}
        except (ValueError, TypeError, OverflowError) as error:
            status, payload = HTTPStatus.BAD_REQUEST, {"error": str(error)}
        finally:
            if connection is not None:
                connection.close()
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _recommendation_feedback_request(self) -> None:
        from recommendation_feedback import save_feedback, FeedbackConflictError
        connection = None
        try:
            body = self._read_json_body(32768)
            allowed = {"accounts", "champion", "role", "preference", "expected_revision"}
            if set(body) != allowed:
                raise ValueError("Specifica account, campione, ruolo, preferenza e revisione")
            connection = STORAGE.connect()
            connection.execute("BEGIN IMMEDIATE" if STORAGE.engine == "sqlite" else "BEGIN")
            payload = save_feedback(connection, body["accounts"], body["champion"], body["role"],
                                    body["preference"], body["expected_revision"])
            connection.commit()
            status = HTTPStatus.OK
        except FeedbackConflictError as error:
            if connection is not None:
                connection.execute("ROLLBACK")
            status, payload = HTTPStatus.CONFLICT, {"error": str(error), "snapshot": error.snapshot}
        except BodyReadTimeout:
            if connection is not None:
                connection.execute("ROLLBACK")
            status, payload = HTTPStatus.REQUEST_TIMEOUT, {"error": "JSON body read timed out"}
        except (ValueError, TypeError, json.JSONDecodeError) as error:
            if connection is not None:
                connection.execute("ROLLBACK")
            status, payload = HTTPStatus.BAD_REQUEST, {"error": str(error)}
        finally:
            if connection is not None:
                connection.close()
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _read_json_body(self, max_bytes: int = MAX_JSON_BODY_BYTES):
        raw_length = self.headers.get("Content-Length")
        if raw_length is None:
            self.close_connection = True
            raise ValueError("Content-Length is required")
        try:
            length = int(raw_length)
        except (TypeError, ValueError) as error:
            self.close_connection = True
            raise ValueError("Content-Length is invalid") from error
        if length <= 0:
            self.close_connection = True
            raise ValueError("JSON body is required")
        if length > max_bytes:
            self.close_connection = True
            raise ValueError("JSON body is too large")
        try:
            data = self.rfile.read(length)
        except (socket.timeout, TimeoutError) as error:
            self.close_connection = True
            raise BodyReadTimeout("JSON body read timed out") from error
        if len(data) != length:
            self.close_connection = True
            raise ValueError("JSON body is incomplete")
        try:
            body = json.loads(data)
        except RecursionError as error:
            raise ValueError("JSON body is too deeply nested") from error
        if not isinstance(body, dict):
            raise ValueError("È richiesto un oggetto JSON")
        return body

    @api_operation
    def do_PUT(self) -> None:
        if urlparse(self.path).path == "/api/algorithm-settings":
            self._settings_request()
            return
        self._send_json_error(HTTPStatus.NOT_FOUND, "Endpoint not found")

    @api_operation
    def do_DELETE(self) -> None:
        parsed = urlparse(self.path)
        prefix = "/api/friend-groups/"
        if not parsed.path.startswith(prefix):
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        try:
            resource = parsed.path[len(prefix):]
            parts = resource.split("/", 2)
            group_id = int(parts[0])
            if not 1 <= group_id <= SQL_INTEGER_MAX:
                raise ValueError("Invalid friend group ID")
            connection = STORAGE.connect()
            try:
                connection.execute("BEGIN IMMEDIATE" if STORAGE.engine == "sqlite" else "BEGIN")
                lock_friend_aliases(connection)
                if len(parts) == 3 and parts[1] == "aliases":
                    alias = unquote(parts[2]).strip()
                    aliases = [row["alias"] for row in matching_friend_aliases(connection, [alias])
                               if row["group_id"] == group_id]
                    if not aliases:
                        raise ValueError("alias not found")
                    connection.executemany(
                        "DELETE FROM friend_group_aliases WHERE group_id=? AND alias=?",
                        [(group_id, stored_alias) for stored_alias in aliases],
                    )
                    remaining = connection.execute(
                        "SELECT COUNT(*) AS count FROM friend_group_aliases WHERE group_id=?",
                        (group_id,),
                    ).fetchone()["count"]
                    if remaining == 0:
                        connection.execute("DELETE FROM friend_groups WHERE id=?", (group_id,))
                elif len(parts) == 1:
                    cursor = connection.execute("DELETE FROM friend_groups WHERE id=?", (group_id,))
                    if cursor.rowcount == 0:
                        raise ValueError("group not found")
                else:
                    raise ValueError("invalid friend group resource")
                connection.commit()
            finally:
                connection.close()
            data = json.dumps({"ok": True, "id": friend_group_json_id(group_id)}).encode("utf-8")
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except (ValueError, TypeError):
            self.send_error(HTTPStatus.BAD_REQUEST, "Invalid friend group")
        except Exception as error:
            if not is_database_integrity_error(error):
                raise
            self._send_json_error(HTTPStatus.CONFLICT, "Friend group conflicts with existing data")

    @api_operation
    def do_PATCH(self) -> None:
        parsed = urlparse(self.path)
        prefix = "/api/friend-groups/"
        if not parsed.path.startswith(prefix):
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        try:
            group_id = int(parsed.path[len(prefix):])
            if not 1 <= group_id <= SQL_INTEGER_MAX:
                raise ValueError("Invalid friend group ID")
            payload = self._read_json_body(16384)
            if set(payload) != {"name"} or not isinstance(payload.get("name"), str):
                raise ValueError("name must be a string")
            name = payload["name"].strip()
            if "\x00" in name:
                raise ValueError("name must not contain NUL")
            if not name:
                raise ValueError("name is required")
            if len(name) > 80:
                raise ValueError("name is too long")
            connection = STORAGE.connect()
            try:
                matches = lock_friend_group_name(connection, name)
                if matches and matches[0]["id"] != group_id:
                    raise FriendGroupConflictError("friend group name already exists")
                cursor = connection.execute(
                    "UPDATE friend_groups SET name=? WHERE id=?", (name, group_id)
                )
                if cursor.rowcount == 0:
                    raise ValueError("group not found")
                connection.commit()
            except Exception:
                connection.rollback()
                raise
            finally:
                connection.close()
            data = json.dumps({"ok": True, "id": friend_group_json_id(group_id), "name": name}, ensure_ascii=False).encode("utf-8")
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except FriendGroupConflictError as error:
            self._send_json_error(HTTPStatus.CONFLICT, str(error))
        except BodyReadTimeout:
            self._send_json_error(HTTPStatus.REQUEST_TIMEOUT, "JSON body read timed out")
        except (ValueError, TypeError, json.JSONDecodeError):
            self._send_json_error(HTTPStatus.BAD_REQUEST, "Invalid friend group name")
        except Exception as error:
            if not is_database_integrity_error(error):
                raise
            self._send_json_error(HTTPStatus.CONFLICT, "Friend group conflicts with existing data")

    @api_operation
    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        path_parts = parsed.path.strip("/").split("/")
        is_group_alias_route = (
            len(path_parts) == 4
            and path_parts[:2] == ["api", "friend-groups"]
            and path_parts[3] == "aliases"
        )
        if parsed.path == "/api/recommendation-feedback":
            self._recommendation_feedback_request()
            return
        if parsed.path == "/api/training-progress":
            self._training_progress_request()
            return
        if parsed.path == "/api/algorithm-settings/preview":
            self._settings_request(preview=True)
            return
        if parsed.path not in {"/api/annotations", "/api/friend-groups"} and not is_group_alias_route:
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        try:
            if is_group_alias_route:
                try:
                    group_id = int(path_parts[2])
                except ValueError as error:
                    raise ValueError("ID del gruppo non valido") from error
                if not 1 <= group_id <= SQL_INTEGER_MAX:
                    raise ValueError("ID del gruppo non valido")
                payload = self._read_json_body()
                if set(payload) != {"aliases"}:
                    raise ValueError("aliases è obbligatorio")
                raw_aliases = payload.get("aliases")
                if not isinstance(raw_aliases, list) or any(not isinstance(alias, str) for alias in raw_aliases):
                    raise ValueError("aliases deve essere una lista di Riot ID")
                if any("\x00" in alias for alias in raw_aliases):
                    raise ValueError("I Riot ID non possono contenere il carattere NUL")
                aliases = []
                seen_aliases = set()
                for raw_alias in raw_aliases:
                    alias = raw_alias.strip()
                    key = alias.casefold()
                    if alias and key not in seen_aliases:
                        aliases.append(alias)
                        seen_aliases.add(key)
                if not aliases:
                    raise ValueError("Inserisci almeno un Riot ID")
                if any(len(alias) > 120 for alias in aliases):
                    raise ValueError("Un Riot ID supera il limite di 120 caratteri")

                connection = STORAGE.connect()
                try:
                    connection.execute("BEGIN IMMEDIATE" if STORAGE.engine == "sqlite" else "BEGIN")
                    lock_friend_aliases(connection)
                    group_query = "SELECT id FROM friend_groups WHERE id=?"
                    if STORAGE.engine == "postgres":
                        group_query += " FOR UPDATE"
                    group = connection.execute(group_query, (group_id,)).fetchone()
                    if not group:
                        raise ValueError("Gruppo non trovato")

                    added_aliases = []
                    for alias in aliases:
                        existing = matching_friend_aliases(connection, [alias])
                        if existing:
                            if any(int(row["group_id"]) != group_id for row in existing):
                                raise FriendGroupConflictError(
                                    f"Il Riot ID {alias} appartiene già a un altro gruppo."
                                )
                            continue
                        connection.execute(
                            "INSERT INTO friend_group_aliases(group_id, alias) VALUES(?, ?)",
                            (group_id, alias),
                        )
                        added_aliases.append(alias)
                    connection.commit()
                except Exception:
                    connection.rollback()
                    raise
                finally:
                    connection.close()

                data = json.dumps(
                    {"ok": True, "id": friend_group_json_id(group_id), "added_aliases": added_aliases},
                    ensure_ascii=False,
                ).encode("utf-8")
                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return

            payload = self._read_json_body()
            if parsed.path == "/api/friend-groups":
                if set(payload) != {"name", "aliases"}:
                    raise ValueError("name and aliases are required")
                if not isinstance(payload.get("name"), str):
                    raise ValueError("name must be a string")
                raw_aliases = payload.get("aliases")
                if not isinstance(raw_aliases, list) or any(not isinstance(alias, str) for alias in raw_aliases):
                    raise ValueError("aliases must be a list of strings")
                name = payload["name"].strip()
                if "\x00" in name or any("\x00" in alias for alias in raw_aliases):
                    raise ValueError("friend group name and aliases must not contain NUL")
                aliases = list(dict.fromkeys(alias.strip() for alias in raw_aliases if alias.strip()))
                if len(name) > 80 or any(len(alias) > 120 for alias in aliases):
                    raise ValueError("friend group name or alias is too long")
                if not name or not aliases:
                    raise ValueError("name and at least one alias are required")
                if "#" in name and name.casefold() not in {alias.casefold() for alias in aliases}:
                    aliases.insert(0, name)
                connection = STORAGE.connect()
                try:
                    matches = lock_friend_group_name(connection, name)
                    # Riot IDs are case-insensitive for grouping purposes. Reuse
                    # an existing group with the same name, or with one of the
                    # submitted aliases. The existing display name is preserved
                    # when a renamed group is saved again.
                    group = matches[0] if matches else None
                    if not group:
                        existing = matching_friend_aliases(connection, aliases)
                        group = {"id": existing[0]["group_id"]} if existing else None
                    if group:
                        group_id = group["id"]
                    else:
                        group_id = connection.execute(
                            "INSERT INTO friend_groups(name) VALUES(?) RETURNING id", (name,)
                        ).fetchone()["id"]

                    # If an alias is already in another manual group, merge that
                    # group into the group being saved instead of returning 400.
                    # This makes it possible to extend/rename an existing group.
                    conflicting_ids = set()
                    for alias in aliases:
                        existing = matching_friend_aliases(connection, [alias])
                        conflicting_ids.update(row["group_id"] for row in existing if row["group_id"] != group_id)
                    for conflicting_id in sorted(conflicting_ids):
                        source_aliases = connection.execute(
                            "SELECT alias FROM friend_group_aliases WHERE group_id=? ORDER BY alias", (conflicting_id,)
                        ).fetchall()
                        for source_row in source_aliases:
                            alias = source_row["alias"]
                            already_in_target = any(
                                row["group_id"] == group_id
                                for row in matching_friend_aliases(connection, [alias])
                            )
                            if already_in_target:
                                connection.execute(
                                    "DELETE FROM friend_group_aliases WHERE group_id=? AND alias=?",
                                    (conflicting_id, alias),
                                )
                            else:
                                connection.execute(
                                    "UPDATE friend_group_aliases SET group_id=? WHERE group_id=? AND alias=?",
                                    (group_id, conflicting_id, alias),
                                )
                        connection.execute("DELETE FROM friend_groups WHERE id=?", (conflicting_id,))
                    for alias in aliases:
                        existing = matching_friend_aliases(connection, [alias])
                        if not existing:
                            connection.execute(
                                "INSERT INTO friend_group_aliases(group_id, alias) VALUES(?, ?)",
                                (group_id, alias),
                            )
                    connection.commit()
                except Exception:
                    connection.rollback()
                    raise
                finally:
                    connection.close()
                data = json.dumps({"ok": True, "name": name}, ensure_ascii=False).encode("utf-8")
                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return
            if not isinstance(payload, dict):
                raise ValueError("È richiesto un oggetto JSON")
            required_fields = {
                "match_id", "invincible", "carryable_loss", "afk_player", "griefer",
                "team_collapse", "manual_label", "note", "confidence", "expected_revision",
            }
            if set(payload) != required_fields:
                raise ValueError("Specifica tutti i campi dell'annotazione e la revisione attesa")
            if not isinstance(payload["match_id"], str):
                raise ValueError("match_id non valido")
            match_id = payload["match_id"].strip()
            if not match_id:
                raise ValueError("match_id is required")
            flag_fields = ("invincible", "carryable_loss", "afk_player", "griefer", "team_collapse")
            if any(type(payload[field]) is not bool for field in flag_fields):
                raise ValueError("Gli indicatori dell'annotazione devono essere booleani")
            if not isinstance(payload["manual_label"], str) or len(payload["manual_label"]) > 40:
                raise ValueError("L'etichetta manuale deve contenere al massimo 40 caratteri")
            if not isinstance(payload["note"], str) or len(payload["note"]) > 1000:
                raise ValueError("La nota deve contenere al massimo 1000 caratteri")
            if any("\x00" in value for value in (match_id, payload["manual_label"], payload["note"])):
                raise ValueError("I testi dell'annotazione non possono contenere il carattere NUL")
            if (isinstance(payload["confidence"], bool)
                    or not isinstance(payload["confidence"], (int, float))
                    or not 0 <= payload["confidence"] <= 1
                    or not math.isfinite(float(payload["confidence"]))):
                raise ValueError("La sicurezza deve essere un numero tra 0 e 1")
            expected_revision = payload["expected_revision"]
            if expected_revision is not None and (
                    not isinstance(expected_revision, str) or not expected_revision):
                raise ValueError("La revisione attesa non è valida")
            revision_time = datetime.now(timezone.utc)
            new_revision = revision_time.isoformat()
            if new_revision == expected_revision:
                new_revision = (revision_time + timedelta(microseconds=1)).isoformat()
            values = [
                match_id,
                *[int(payload[field]) for field in flag_fields],
                payload["manual_label"], payload["note"], float(payload["confidence"]), new_revision,
            ]
            connection = STORAGE.connect()
            try:
                connection.execute("BEGIN IMMEDIATE" if STORAGE.engine == "sqlite" else "BEGIN")
                if not connection.execute("SELECT 1 FROM match_quality WHERE match_id=? LIMIT 1", (match_id,)).fetchone():
                    raise ValueError("unknown match_id")
                current = connection.execute(
                    "SELECT updated_at FROM match_annotations WHERE match_id=?", (match_id,)
                ).fetchone()
                if current:
                    if expected_revision != current["updated_at"]:
                        raise AnnotationConflictError
                    cursor = connection.execute("""UPDATE match_annotations SET
                        invincible=?, carryable_loss=?, afk_player=?, griefer=?, team_collapse=?,
                        manual_label=?, note=?, confidence=?, updated_at=?
                        WHERE match_id=? AND updated_at=?""", [*values[1:], match_id, expected_revision])
                else:
                    if expected_revision is not None:
                        raise AnnotationConflictError
                    cursor = connection.execute("""INSERT INTO match_annotations
                        (match_id,invincible,carryable_loss,afk_player,griefer,team_collapse,manual_label,note,confidence,updated_at)
                        VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(match_id) DO NOTHING""", values)
                if cursor.rowcount != 1:
                    raise AnnotationConflictError
                connection.commit()
            finally:
                connection.close()
            data = json.dumps({"ok": True, "match_id": match_id, "revision": new_revision}).encode("utf-8")
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except AnnotationConflictError:
            self._send_json_error(
                HTTPStatus.CONFLICT,
                "L'annotazione è cambiata dopo il caricamento. Ricarica i dati e riprova.",
            )
        except FriendGroupConflictError as error:
            self._send_json_error(HTTPStatus.CONFLICT, str(error))
        except BodyReadTimeout:
            self._send_json_error(HTTPStatus.REQUEST_TIMEOUT, "JSON body read timed out")
        except (ValueError, json.JSONDecodeError, TypeError) as error:
            data = json.dumps({"error": str(error)}, ensure_ascii=False).encode("utf-8")
            self.send_response(HTTPStatus.BAD_REQUEST)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except Exception as error:
            if (parsed.path != "/api/friend-groups" and not is_group_alias_route) or not is_database_integrity_error(error):
                raise
            self._send_json_error(HTTPStatus.CONFLICT, "Friend group conflicts with existing data")

    def log_message(self, format: str, *args) -> None:
        if urlparse(self.path).path.startswith("/api/"):
            return  # Structured API logs omit query strings and IDs.
        print(f"[web] {self.command} {urlparse(self.path).path} {self._response_status or '-'}")


def bootstrap_algorithm_settings() -> None:
    """Run settings bootstrap with an explicit persistence boundary."""
    from algorithm_settings import ensure_settings, migrate_recommendation_settings

    connection = STORAGE.connect()
    try:
        ensure_settings(connection)
        migrate_recommendation_settings(connection)
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def main() -> None:
    configure_logging()
    parser = argparse.ArgumentParser(description="Serve the Champion Fit SQLite dashboard.")
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE, help="Directory containing Champion Fit CSV/JSON outputs")
    parser.add_argument("--rebuild", action="store_true", help="Re-import source outputs into champion_fit.db")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8787)
    args = parser.parse_args()
    database(args.source, args.rebuild)
    bootstrap_algorithm_settings()
    if not (WEB_ROOT / "index.html").is_file():
        print(
            f"[web] WARNING: frontend build missing at {WEB_ROOT}. "
            "Run `npm --prefix frontend run build`."
        )
    server = ThreadingHTTPServer((args.host, args.port), DashboardHandler)
    print(f"Champion Fit dashboard: http://{args.host}:{args.port}")
    print(f"Storage: {STORAGE.engine}")
    if STORAGE.engine == "sqlite":
        print(f"SQLite database: {DB_PATH}")
    server.serve_forever()


if __name__ == "__main__":
    main()
