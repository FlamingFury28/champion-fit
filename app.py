#!/usr/bin/env python3
"""Local database-backed dashboard for the Champion Fit analysis."""

from __future__ import annotations

import argparse
import csv
import json
import math
import os
import sqlite3
from datetime import date, datetime
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

from match_scoring import LOSS_WEIGHT_MODEL_VERSION, loss_attribution_weight
from storage import build_storage
from queue_rules import is_supported_queue


APP_ROOT = Path(__file__).resolve().parent
WEB_ROOT = APP_ROOT / "web"
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


def friend_min_shared_games(params: dict[str, list[str]]) -> int:
    """Return the validated minimum number of games required for Friends."""
    raw_value = params.get("min_shared_games", [str(DEFAULT_FRIEND_MIN_SHARED_GAMES)])[0]
    try:
        value = int(raw_value)
    except (TypeError, ValueError):
        return DEFAULT_FRIEND_MIN_SHARED_GAMES
    return max(1, min(value, 10000))


def friend_name_filter(params: dict[str, list[str]]) -> str:
    """Return the case-insensitive Friends name/Riot ID filter."""
    return params.get("friend_q", [""])[0].strip().casefold()[:120]


def friend_last_game_from(params: dict[str, list[str]]) -> str:
    """Return a validated ISO date used as the minimum last-game date."""
    value = params.get("last_game_from", [""])[0].strip()
    try:
        date.fromisoformat(value)
    except ValueError:
        return ""
    return value


def friend_games_from(params: dict[str, list[str]]) -> str:
    """Return the date from which shared games should be counted."""
    value = params.get("games_from", [""])[0].strip()
    try:
        date.fromisoformat(value)
    except ValueError:
        return ""
    return value


def friend_result_limit(params: dict[str, list[str]]) -> int:
    """Return a larger result window when Friends filters are active."""
    return 10000 if friend_name_filter(params) or friend_last_game_from(params) or friend_games_from(params) else 100


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
    """Replace the old 45%/95% Riot defaults with duration-based weights."""
    stored = connection.execute(
        "SELECT value FROM source_metadata WHERE key='loss_weight_model_version'"
    ).fetchone()
    if stored and stored[0] == LOSS_WEIGHT_MODEL_VERSION:
        return 0

    rows = connection.execute(
        """SELECT id, duration_minutes, anomaly_flags, explicit_afk,
                  suspected_quasi_afk, early_surrender
           FROM match_quality
           WHERE identity_resolution='riot_api'
             AND reason='Imported from Riot Match-V5'"""
    ).fetchall()
    updates = [
        (
            loss_attribution_weight(
                row["duration_minutes"], row["anomaly_flags"],
                bool(row["explicit_afk"]), bool(row["suspected_quasi_afk"]),
                bool(row["early_surrender"]),
            ),
            row["id"],
        )
        for row in rows
    ]
    if updates:
        connection.executemany(
            "UPDATE match_quality SET loss_attribution_weight=? WHERE id=?",
            updates,
        )
        connection.execute(
            "UPDATE match_quality SET reason='Imported from Riot Match-V5; duration model v2' "
            "WHERE identity_resolution='riot_api' "
            "AND reason='Imported from Riot Match-V5'"
        )
    connection.execute(
        "INSERT INTO source_metadata(key,value) VALUES(?,?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        ("loss_weight_model_version", LOSS_WEIGHT_MODEL_VERSION),
    )
    connection.commit()
    return len(updates)


def csv_rows(source: Path, name: str) -> list[dict[str, str]]:
    with (source / name).open(encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def as_int(value: str) -> int:
    return int(float(value or 0))


def as_float(value: str) -> float:
    return float(value or 0)


def clean_anomaly_flags(value: str) -> str:
    retired = {"strong_personal_loss", "weak_personal_performance"}
    flags = [flag for flag in str(value or "none").split(";") if flag and flag not in retired]
    return ";".join(flags) or "none"


def recommendation_role_priors(rows: list[dict]) -> dict[str, tuple[float, float]]:
    """Estimate empirical-Bayes Beta priors from weighted champion-role evidence."""
    grouped: dict[str, list[tuple[float, float]]] = {}
    for row in rows:
        positive = float(row["positive_evidence"] or 0)
        negative = float(row["negative_evidence"] or 0)
        evidence = positive + negative
        if evidence > 0:
            grouped.setdefault(row["role"], []).append((positive / evidence, evidence))

    priors = {}
    for role, observations in grouped.items():
        total = sum(weight for _, weight in observations)
        mean = sum(rate * weight for rate, weight in observations) / total
        observed_variance = sum(weight * (rate - mean) ** 2 for rate, weight in observations) / total
        sampling_variance = sum(
            weight * (mean * (1 - mean) / max(weight, 1.0))
            for _, weight in observations
        ) / total
        between_variance = max(observed_variance - sampling_variance, 1e-6)
        concentration = (mean * (1 - mean) / between_variance) - 1
        priors[role] = (min(max(mean, 0.05), 0.95), min(max(concentration, 2.0), 50.0))
    return priors


def rank_recommendations(candidates: list[dict], limit: int = 3) -> list[dict]:
    """Rank distinct champions by their conservative 90% posterior fit bound."""
    priors = recommendation_role_priors(candidates)
    role_totals: dict[str, list[float]] = {}
    for item in candidates:
        totals = role_totals.setdefault(item["role"], [0.0, 0.0])
        totals[0] += float(item["positive_evidence"] or 0)
        totals[1] += float(item["negative_evidence"] or 0)

    ranked = []
    z_90 = 1.6448536269514722
    for item in candidates:
        games = int(item["games"] or 0)
        if games < 3:
            continue
        positive = float(item["positive_evidence"] or 0)
        negative = float(item["negative_evidence"] or 0)
        local_evidence = positive + negative
        role_mean, concentration = priors.get(item["role"], (0.5, 2.0))
        role_positive, role_negative = role_totals[item["role"]]
        other_positive = max(role_positive - positive, 0.0)
        other_negative = max(role_negative - negative, 0.0)
        baseline_alpha = role_mean * concentration + other_positive
        baseline_beta = (1 - role_mean) * concentration + other_negative
        role_baseline = baseline_alpha / (baseline_alpha + baseline_beta)
        # Other champions shape the leave-one-out role baseline; only the
        # current champion's evidence is added to its posterior.
        alpha = role_baseline * concentration + positive
        beta = (1 - role_baseline) * concentration + negative
        posterior = alpha / (alpha + beta)
        deviation = math.sqrt(alpha * beta / ((alpha + beta) ** 2 * (alpha + beta + 1)))
        lower = max(0.0, posterior - z_90 * deviation)
        upper = min(1.0, posterior + z_90 * deviation)
        interval_width = upper - lower
        ranked.append({
            "champion": item["champion"],
            "role": item["role"],
            "score": round(lower * 100, 1),
            "games": games,
            "posterior_fit": round(posterior * 100, 1),
            "credible_lower_90": round(lower * 100, 1),
            "credible_upper_90": round(upper * 100, 1),
            "effective_evidence": round(local_evidence, 2),
            "reason": (f"{games} game in {item['role']} · fit stimato {posterior * 100:.1f}% · "
                       f"intervallo 90% {lower * 100:.1f}–{upper * 100:.1f}% · evidenza effettiva {local_evidence:.1f}."),
            "confidence": "sufficiente" if interval_width <= 0.30 else "da confermare",
        })

    ranked.sort(key=lambda item: (
        -item["score"], -item["posterior_fit"], -item["effective_evidence"],
        -item["games"], item["champion"], item["role"],
    ))
    chosen = []
    seen = set()
    for item in ranked:
        if item["champion"] in seen:
            continue
        seen.add(item["champion"])
        chosen.append(item)
        if len(chosen) == limit:
            break
    return chosen


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


def selected_accounts(params: dict[str, list[str]]) -> list[str]:
    """Read optional account filters without coupling the UI to the data source."""
    values = params.get("account", [])
    accounts = []
    for value in values:
        accounts.extend(part.strip() for part in value.split(",") if part.strip())
    return list(dict.fromkeys(accounts))


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


def selected_blacklist(connection: sqlite3.Connection, accounts: list[str], params: dict[str, list[str]] | None = None) -> list[dict]:
    """Return blacklist decisions for the active account scope."""
    if not accounts:
        return rows_to_dicts(connection.execute(
            "SELECT role, champion, tier, reason FROM blacklist"
        ))

    account_sql, account_values = account_filter(accounts, "m.account")
    companion_sql, companion_values = companion_filter(params or {}, "m.match_id")
    rows = rows_to_dicts(connection.execute(
        f"""SELECT m.role, m.champion, COUNT(*) games_observed,
                  SUM(m.win) wins, COUNT(*)-SUM(m.win) losses,
                  ROUND(AVG(m.win)*100,1) account_adjusted_fit_score,
                  ROUND(SUM(CASE WHEN m.win=0 THEN
                      CASE WHEN COALESCE(a.invincible,0)=1
                                OR COALESCE(a.afk_player,0)=1
                                OR COALESCE(a.griefer,0)=1
                           THEN 0 ELSE m.loss_attribution_weight END
                      ELSE 0 END),2) informative_losses_equivalent,
                  c.icon_url
           FROM match_quality m
           JOIN champions c ON c.champion=m.champion
           LEFT JOIN match_annotations a ON a.match_id=m.match_id
           WHERE 1=1{account_sql}{companion_sql}
           GROUP BY m.role, m.champion, c.icon_url""", [*account_values, *companion_values]
    ))
    items = []
    for item in rows:
        games = int(item["games_observed"] or 0)
        win_rate = float(item["account_adjusted_fit_score"] or 0)
        informative = float(item["informative_losses_equivalent"] or 0)
        if games >= 12 and win_rate < 45 and informative >= 2.0:
            tier = "strong"
            reason = "Evidenza negativa ripetuta nel perimetro selezionato"
        elif games >= 8 and win_rate < 50 and informative >= 1.5:
            tier = "provisional"
            reason = "Segnale negativo nel perimetro selezionato; da rivalutare"
        else:
            continue
        item.update({"tier": tier, "reason": reason})
        items.append(item)
    return sorted(items, key=lambda item: (
        0 if item["tier"] == "strong" else 1,
        float(item["account_adjusted_fit_score"]),
    ))


def load_match_participants(source: Path, connection) -> int:
    """Import the participant roster used by the Friends view, if available."""
    details_path = next((candidate for candidate in (source / "match_details.jsonl", source.parent / "match_details.jsonl") if candidate.exists()), None)
    if details_path is None:
        return 0
    loaded = 0
    with details_path.open(encoding="utf-8") as handle:
        for line in handle:
            try:
                payload = json.loads(line)
            except json.JSONDecodeError:
                continue
            match_id = str(payload.get("metadata", {}).get("matchId", "")).strip()
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
                if puuid and riot_id:
                    rows.append((match_id, puuid, riot_id, as_int(str(participant.get("teamId", 0))), as_bool(str(participant.get("win", False)))))
            if rows:
                connection.executemany(
                    "INSERT OR IGNORE INTO match_participants(match_id,puuid,riot_id,team_id,win) VALUES(?,?,?,?,?)",
                    rows,
                )
                loaded += len(rows)
    connection.commit()
    return loaded


def load_tracked_account_puuids(source: Path, connection) -> int:
    """Load current and historical PUUIDs so renamed own accounts are excluded."""
    accounts_path = next((candidate for candidate in (source / "accounts.json", source.parent / "accounts.json") if candidate.exists()), None)
    payload = json.loads(accounts_path.read_text(encoding="utf-8")) if accounts_path else {}
    rows = []
    for account, value in payload.items():
        if not isinstance(value, dict):
            continue
        puuids = set(value.get("puuid_history", []))
        if value.get("puuid"):
            puuids.add(value["puuid"])
        rows.extend((str(puuid), str(account)) for puuid in puuids if puuid)
    # Keep the existing mapping as a seed when the original accounts export is
    # unavailable; this is common for an already-built local database.
    rows.extend(
        (str(row["puuid"]), str(row["account"]))
        for row in connection.execute("SELECT puuid, account FROM tracked_account_puuids")
    )
    # Some historical exports contain only the latest account PUUID. Infer
    # renamed identities from the participant that appears in nearly every
    # match recorded for that tracked account (friends do not have that shape).
    accounts = [row["account"] for row in connection.execute("SELECT DISTINCT account FROM match_quality")]
    for account in accounts:
        total = connection.execute("SELECT COUNT(DISTINCT match_id) value FROM match_quality WHERE account=?", (account,)).fetchone()["value"]
        candidates = connection.execute(
            """SELECT p.puuid, COUNT(DISTINCT p.match_id) games
               FROM match_participants p JOIN match_quality m ON m.match_id=p.match_id
               WHERE m.account=? GROUP BY p.puuid""", (account,)
        )
        for candidate in candidates:
            if candidate["games"] >= max(20, total * 0.7):
                rows.append((candidate["puuid"], account))
    # A renamed account can have several PUUIDs for the same historical Riot
    # ID. Once one of those PUUIDs is known to belong to a tracked account,
    # propagate ownership to every participant row carrying that same Riot ID.
    # Without this closure, old aliases of a selected account were returned as
    # friends of that account.
    ownership = {}
    for puuid, account in rows:
        ownership.setdefault(str(account), set()).add(str(puuid))
    changed = True
    while changed:
        changed = False
        for account, puuids in ownership.items():
            riot_ids = {
                row["riot_id"] for row in connection.execute(
                    "SELECT DISTINCT riot_id FROM match_participants WHERE puuid IN ({})".format(
                        ",".join("?" for _ in puuids)
                    ), tuple(puuids)
                ) if row["riot_id"]
            } if puuids else set()
            if not riot_ids:
                continue
            placeholders = ",".join("?" for _ in riot_ids)
            for row in connection.execute(
                f"SELECT DISTINCT puuid FROM match_participants WHERE riot_id IN ({placeholders})",
                tuple(riot_ids),
            ):
                if row["puuid"] not in puuids:
                    puuids.add(row["puuid"])
                    rows.append((row["puuid"], account))
                    changed = True
    connection.executemany(
        "INSERT INTO tracked_account_puuids(puuid,account) VALUES(?,?) ON CONFLICT(puuid) DO UPDATE SET account=excluded.account",
        rows,
    )
    connection.commit()
    return len(rows)


def database(source: Path, rebuild: bool) -> None:
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
            purge_urf_matches(connection)
            migrate_riot_loss_weights(connection)
        finally:
            connection.close()
        return
    if DB_PATH.exists() and not rebuild:
        connection = STORAGE.connect()
        try:
            STORAGE.initialize()
            migrate_remove_personal_performance(connection)
            load_match_participants(source, connection)
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
        return

    missing = [name for name in required if not (source / name).exists()]
    if missing:
        raise SystemExit(f"Missing analysis files in {source}: {', '.join(missing)}")

    connection = STORAGE.connect()
    try:
        STORAGE.initialize()
        for table in (
            "source_metadata", "test_plan", "blacklist", "screening_candidates",
            "match_annotations", "match_quality", "match_participants",
            "tracked_account_puuids", "riot_match_list_raw", "riot_match_raw",
            "riot_accounts_raw", "champion_fit", "champions",
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
        load_match_participants(source, connection)
        load_tracked_account_puuids(source, connection)
        payload = json.loads((source / "champion_fit.json").read_text(encoding="utf-8"))
        metadata = {
            "generated_at_utc": payload.get("generated_at_utc", "unknown"),
            "scope": payload.get("scope", "unknown"),
            "source_path": str(source),
            "ddragon_version": DDRAGON_VERSION,
            "icon_policy": "Remote Data Dragon URLs only; no champion icon binary is stored locally.",
        }
        connection.executemany("INSERT INTO source_metadata VALUES (?, ?)", metadata.items())
        connection.commit()
    finally:
        connection.close()


def query_database(path: str, params: dict[str, list[str]]) -> tuple[int, dict]:
    connection = STORAGE.connect()
    connection.row_factory = sqlite3.Row
    try:
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
                f"SELECT COUNT(*) contaminated_losses FROM match_quality m WHERE m.win=0 AND m.loss_attribution_weight < 0.45{account_sql}{companion_sql}",
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
            search = params.get("q", [""])[0].strip().lower()
            where, values = ("WHERE LOWER(accounts.account) LIKE ?", [f"%{search}%"]) if search else ("", [])
            account_rows = rows_to_dicts(connection.execute(
                f"""SELECT accounts.account,
                          COALESCE(stats.games, 0) analyzed_games,
                          COALESCE(stats.wins, 0) wins,
                          stats.first_game,
                          stats.last_game
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
                       SELECT account, COUNT(*) games, SUM(win) wins, MIN(date) first_game, MAX(date) last_game
                       FROM match_quality GROUP BY account
                   ) stats ON stats.account = accounts.account
                   {where}
                   ORDER BY accounts.account""", values
            ))
            # The raw Riot match list is the source of truth for games already
            # fetched. match_quality is a derived table and can legitimately be
            # empty while match details/performance analysis is still pending.
            raw_rows = connection.execute(
                "SELECT account, match_ids_json FROM riot_match_list_raw"
            ).fetchall()
            raw_games = {}
            for row in raw_rows:
                try:
                    raw_games[row["account"]] = len(json.loads(row["match_ids_json"]))
                except (TypeError, ValueError, json.JSONDecodeError):
                    raw_games[row["account"]] = 0
            for item in account_rows:
                item["games"] = max(int(raw_games.get(item["account"], 0)), int(item.get("analyzed_games") or 0))
            return HTTPStatus.OK, {"items": account_rows}

        if path == "/api/friends":
            accounts = selected_accounts(params)
            account_sql, account_values = account_filter(accounts, "mine.account")
            companion_sql, companion_values = companion_filter(params, "mine.match_id")
            # A Friends view is scoped to the active profile.  Do not remove
            # every tracked account globally: an account from another saved
            # profile is a valid friend when it appears in this profile's
            # matches.  With no explicit scope, preserve the global view and
            # exclude all tracked accounts.
            owned_account_sql, owned_account_values = account_filter(accounts, "tracked.account")
            owned_match_sql, owned_match_values = account_filter(accounts, "owned.account")
            tracked_scope = f"""
                AND p.puuid NOT IN (
                    SELECT tracked.puuid FROM tracked_account_puuids tracked
                    WHERE 1=1{owned_account_sql}
                )
                AND p.riot_id NOT IN (
                    SELECT owned.account FROM (
                        SELECT account FROM match_quality
                        UNION
                        SELECT account FROM riot_accounts_raw
                    ) owned
                    WHERE 1=1{owned_match_sql}
                )
            """ if accounts else """
                AND p.puuid NOT IN (SELECT puuid FROM tracked_account_puuids)
                AND p.riot_id NOT IN (
                    SELECT account FROM match_quality
                    UNION
                    SELECT account FROM riot_accounts_raw
                )
            """
            tracked_values = [*owned_account_values, *owned_match_values]
            min_shared_games = friend_min_shared_games(params)
            friend_query = friend_name_filter(params)
            last_game_from = friend_last_game_from(params)
            games_from = friend_games_from(params)
            result_limit = friend_result_limit(params)
            sort_options = friend_sort_options(params)
            # PUUID is normally the canonical identity, but historical data can
            # contain two PUUIDs for one person. Merge PUUIDs when they share an
            # exact Riot ID, including transitive overlaps (A shares a name with
            # B, B shares another name with C). This keeps different tags apart.
            participant_rows = rows_to_dicts(connection.execute(
                f"""SELECT DISTINCT p.puuid, p.riot_id, p.match_id,
                                      mine.account, mine.date, mine.win
                   FROM match_participants p
                   JOIN match_quality mine ON mine.match_id=p.match_id
                   WHERE 1=1{tracked_scope}{account_sql}{companion_sql}""", [*tracked_values, *account_values, *companion_values]
            ))
            if games_from:
                participant_rows = [row for row in participant_rows if str(row["date"])[:10] >= games_from]

            parent = {}
            name_owner = {}

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
                puuid, riot_id = row["puuid"], row["riot_id"]
                find(puuid)
                if riot_id and riot_id in name_owner:
                    union(puuid, name_owner[riot_id])
                elif riot_id:
                    name_owner[riot_id] = puuid

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
            for row in participant_rows:
                node = manual_alias_nodes.get(str(row["riot_id"]).casefold())
                if node:
                    union(node, row["puuid"])

            grouped = {}
            for row in participant_rows:
                group_key = find(row["puuid"])
                group = grouped.setdefault(group_key, {
                    "aliases": set(), "matches": set(), "accounts": set(), "results": [],
                    "dates": [],
                })
                if row["riot_id"]:
                    group["aliases"].add(row["riot_id"])
                group["matches"].add(row["match_id"])
                group["accounts"].add(row["account"])
                group["results"].append(row["win"])
                group["dates"].append(row["date"])

            for node, value in manual_nodes.items():
                root = find(node)
                if root in grouped:
                    grouped[root]["manual_name"] = value["name"]
                    if node in owned_manual_nodes:
                        grouped[root]["is_owned"] = True

            friends = []
            for friend_key, group in grouped.items():
                if group.get("is_owned"):
                    continue
                if len(group["matches"]) < min_shared_games:
                    continue
                friend_name = group.get("manual_name") or " · ".join(sorted(group["aliases"]))
                if friend_query and friend_query not in friend_name.casefold():
                    continue
                last_game = max(group["dates"])
                if last_game_from and last_game[:10] < last_game_from:
                    continue
                friends.append({
                    "friend_key": friend_key,
                    "friend": friend_name,
                    "shared_games": len(group["matches"]),
                    "accounts_played_with": len(group["accounts"]),
                    "first_game": min(group["dates"]),
                    "last_game": last_game,
                    "friend_win_rate": round(sum(100.0 if win else 0.0 for win in group["results"]) / len(group["results"]), 1),
                })
            friends.sort(key=lambda item: item["friend"])
            sort_keys = {
                "games": "shared_games",
                "winrate": "friend_win_rate",
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
                {"id": int(node.split(":", 1)[1]), "name": value["name"], "aliases": value["aliases"]}
                for node, value in manual_nodes.items()
            ]}

        if path == "/api/sync-status":
            metadata = {row["key"]: row["value"] for row in connection.execute("SELECT key, value FROM source_metadata")}
            checkpoints = sorted(APP_ROOT.glob(".champion_fit.riot-*.checkpoint.json"), key=lambda item: item.stat().st_mtime, reverse=True)
            active = bool(checkpoints)
            return HTTPStatus.OK, {
                "mode": "importing" if active else "snapshot",
                "automatic_api_calls": False,
                "checkpoint_accounts": len(checkpoints),
                "last_checkpoint_at": datetime.fromtimestamp(checkpoints[0].stat().st_mtime).isoformat() if checkpoints else None,
                "metadata": metadata,
            }

        if path == "/api/profile":
            accounts = selected_accounts(params)
            account_sql, account_values = account_filter(accounts)
            companion_sql, companion_values = companion_filter(params, "m.match_id")
            scoped_values = [*account_values, *companion_values]
            base = connection.execute(
                f"""SELECT COUNT(*) games, COALESCE(SUM(win), 0) wins,
                          ROUND(COALESCE(AVG(win), 0) * 100, 1) win_rate,
                          ROUND(COALESCE(AVG(duration_minutes), 0), 1) avg_duration,
                          COUNT(DISTINCT champion) champions_played,
                          MIN(date) first_game, MAX(date) last_game
                   FROM match_quality m WHERE 1=1{account_sql}{companion_sql}""", scoped_values
            ).fetchone()
            summary = dict(base)
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
                f"""SELECT date, account, champion, role, win, queue, duration_minutes,
                          match_quality_score, anomaly_flags
                   FROM match_quality m WHERE 1=1{account_sql}{companion_sql} ORDER BY date DESC LIMIT 20""", scoped_values
            ))
            champions = rows_to_dicts(connection.execute(
                f"""SELECT champion, COUNT(*) games, SUM(win) wins,
                          ROUND(AVG(win) * 100, 1) win_rate,
                          ROUND(AVG(duration_minutes), 1) avg_duration
                   FROM match_quality m WHERE 1=1{account_sql}{companion_sql}
                   GROUP BY champion ORDER BY games DESC, win_rate DESC LIMIT 12""", scoped_values
            ))
            recommendation_account_sql, recommendation_account_values = account_filter(accounts, "m.account")
            evidence_select = """SELECT m.role, m.champion, COUNT(*) games, SUM(m.win) wins,
                          ROUND(AVG(m.win) * 100, 1) win_rate,
                          COALESCE(SUM(CASE WHEN m.win=1 THEN m.win_evidence_weight ELSE 0 END),0) positive_evidence,
                          COALESCE(SUM(CASE WHEN m.win=0 THEN
                              CASE WHEN COALESCE(a.invincible,0)=1 OR COALESCE(a.afk_player,0)=1
                                        OR COALESCE(a.griefer,0)=1
                                   THEN 0 ELSE m.loss_attribution_weight END
                              ELSE 0 END),0) negative_evidence
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
            weekday_expression = "EXTRACT(DOW FROM date::timestamp)::integer" if STORAGE.engine == "postgres" else "CAST(strftime('%w', date) AS INTEGER)"
            weekdays = rows_to_dicts(connection.execute(
                f"""SELECT {weekday_expression} weekday, COUNT(*) games,
                          ROUND(AVG(win) * 100, 1) win_rate
                   FROM match_quality m WHERE 1=1{account_sql}{companion_sql}
                   GROUP BY weekday ORDER BY weekday""", scoped_values
            ))
            recommendations = rank_recommendations(role_champions)
            return HTTPStatus.OK, {"accounts": accounts, "summary": summary, "recent": recent, "champions": champions, "roles": roles, "weekdays": weekdays, "recommendations": recommendations[:3]}

        if path == "/api/champion":
            champion = params.get("champion", [""])[0].strip()
            role = params.get("role", [""])[0].strip()
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
            stat = connection.execute(
                f"""SELECT COUNT(*) games, COALESCE(SUM(win),0) wins,
                          ROUND(COALESCE(AVG(win),0)*100,1) win_rate,
                          ROUND(COALESCE(AVG(duration_minutes),0),1) avg_duration
                   FROM match_quality m WHERE champion=?{account_sql}{companion_sql}""", [champion, *account_values, *companion_values]
            ).fetchone()
            annotated = connection.execute(
                f"""SELECT COALESCE(SUM(a.invincible),0) invincible_games,
                          COALESCE(SUM(a.carryable_loss),0) carryable_losses,
                          COALESCE(SUM(a.afk_player),0) afk_games,
                          COALESCE(SUM(a.griefer),0) griefer_games
                   FROM match_quality m JOIN match_annotations a ON a.match_id=m.match_id
                   WHERE m.champion=?{account_sql}{companion_sql}""", [champion, *account_values, *companion_values]
            ).fetchone()
            recent = rows_to_dicts(connection.execute(
                f"""SELECT date, account, role, win, reason
                   FROM match_quality m WHERE champion=?{account_sql}{companion_sql} ORDER BY date DESC LIMIT 20""", [champion, *account_values, *companion_values]
            ))
            roles = rows_to_dicts(connection.execute("SELECT role, games_observed, account_adjusted_fit_score, credible_lower_90, credible_upper_90 FROM champion_fit WHERE champion=? ORDER BY games_observed DESC", (champion,)))
            return HTTPStatus.OK, {"champion": champion, "role": role, "accounts": accounts, "fit": dict(fit) if fit else None, "stats": dict(stat) | dict(annotated), "recent": recent, "roles": roles}

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
            role_values = [role] if role in ROLES else []
            scope = f"WHERE EXISTS (SELECT 1 FROM match_quality m WHERE m.champion=p.champion AND m.role=p.role{account_sql}{companion_sql}) AND p.role=?" if accounts and role in ROLES else ("WHERE p.role=?" if role in ROLES else (f"WHERE EXISTS (SELECT 1 FROM match_quality m WHERE m.champion=p.champion AND m.role=p.role{account_sql}{companion_sql})" if accounts else ""))
            plan_items = rows_to_dicts(connection.execute(
                f"""SELECT p.*, c.icon_url FROM test_plan p JOIN champions c ON c.champion=p.champion
                   {scope}
                   ORDER BY p.allocated_games DESC, p.base_value_of_information DESC, p.role, p.champion"""
            , [*account_values, *companion_values, *role_values]))
            requested_n = as_int(params.get("n", [""])[0]) if params.get("n", [""])[0] else 0
            source_total = sum(int(item["allocated_games"]) for item in plan_items)
            if requested_n > 0 and source_total > 0 and requested_n != source_total:
                # Scale the saved priority mix to the requested horizon while keeping
                # the total exact through a largest-remainder pass.
                scaled = []
                for index, item in enumerate(plan_items):
                    raw = int(item["allocated_games"]) * requested_n / source_total
                    floor_value = int(raw)
                    scaled.append((index, floor_value, raw - floor_value))
                    item["allocated_games"] = floor_value
                remainder = requested_n - sum(row[1] for row in scaled)
                for index, _, _ in sorted(scaled, key=lambda row: (-row[2], row[0]))[:remainder]:
                    plan_items[index]["allocated_games"] += 1
            return HTTPStatus.OK, {"items": plan_items, "requested_n": requested_n or source_total, "source_total": source_total, "role": role if role in ROLES else ""}

        if path == "/api/blacklist":
            accounts = selected_accounts(params)
            if accounts:
                return HTTPStatus.OK, {"items": selected_blacklist(connection, accounts, params), "scope_accounts": accounts}
            account_sql, account_values = account_filter(accounts, "m.account")
            scope = f"WHERE EXISTS (SELECT 1 FROM match_quality m WHERE m.champion=b.champion AND m.role=b.role{account_sql})" if accounts else ""
            return HTTPStatus.OK, {"items": rows_to_dicts(connection.execute(
                f"""SELECT b.*, f.games_observed, f.informative_losses_equivalent, f.account_adjusted_fit_score,
                          c.icon_url
                   FROM blacklist b JOIN champion_fit f ON f.role=b.role AND f.champion=b.champion
                   JOIN champions c ON c.champion=b.champion
                   {scope}
                   ORDER BY CASE b.tier WHEN 'strong' THEN 1 ELSE 2 END, f.account_adjusted_fit_score"""
            , account_values)), "scope_accounts": []}

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
                sql = f"""WITH role_stats AS (
                             SELECT m.role, AVG(m.win) role_win_rate
                             FROM match_quality m
                             WHERE 1=1{account_sql}{companion_sql}
                             GROUP BY m.role
                         )
                         SELECT s.*, c.icon_url,
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
                return HTTPStatus.OK, {"items": rows_to_dicts(connection.execute(sql, [*account_values, *companion_values, *account_values, *companion_values]))}

            return HTTPStatus.OK, {"items": rows_to_dicts(connection.execute(
                """SELECT s.*, c.icon_url, s.theoretical_fit_prior personalized_prior
                   FROM screening_candidates s JOIN champions c ON c.champion=s.champion
                   ORDER BY s.theoretical_fit_prior DESC LIMIT 40"""
            ))}

        if path == "/api/matches":
            clauses, values = ["1=1"], []
            account_sql, account_values = account_filter(selected_accounts(params))
            companion_sql, companion_values = companion_filter(params, "m.match_id")
            role = params.get("role", ["ALL"])[0]
            champion = params.get("champion", [""])[0]
            flag = params.get("flag", ["all"])[0]
            if role in ROLES:
                clauses.append("role=?"); values.append(role)
            if champion:
                clauses.append("champion=?"); values.append(champion)
            if flag == "contaminated": clauses.append("win=0 AND loss_attribution_weight < 0.45")
            if flag == "afk": clauses.append("(explicit_afk=1 OR suspected_quasi_afk=1)")
            if flag == "loss": clauses.append("win=0")
            limit = min(max(as_int(params.get("limit", ["24"])[0]), 1), 100)
            sql = f"""SELECT m.*, c.icon_url,
                       COALESCE(a.invincible, 0) annotation_invincible,
                       COALESCE(a.carryable_loss, 0) annotation_carryable_loss,
                       COALESCE(a.afk_player, 0) annotation_afk_player,
                       COALESCE(a.griefer, 0) annotation_griefer,
                       COALESCE(a.team_collapse, 0) annotation_team_collapse,
                       COALESCE(a.manual_label, '') annotation_manual_label,
                       COALESCE(a.note, '') annotation_note,
                       COALESCE(a.confidence, 1.0) annotation_confidence
                FROM match_quality m JOIN champions c ON c.champion=m.champion
                LEFT JOIN match_annotations a ON a.match_id=m.match_id
                WHERE {' AND '.join(clauses)}{account_sql}{companion_sql} ORDER BY date DESC LIMIT ?"""
            return HTTPStatus.OK, {"items": rows_to_dicts(connection.execute(sql, [*values, *account_values, *companion_values, limit]))}

        if path == "/api/annotations":
            match_id = params.get("match_id", [""])[0]
            if not match_id:
                return HTTPStatus.BAD_REQUEST, {"error": "match_id is required"}
            row = connection.execute("SELECT * FROM match_annotations WHERE match_id=?", (match_id,)).fetchone()
            return HTTPStatus.OK, {"item": dict(row) if row else None}

        return HTTPStatus.NOT_FOUND, {"error": "Endpoint not found"}
    finally:
        connection.close()


class DashboardHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(WEB_ROOT), **kwargs)

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path.startswith("/api/"):
            status, payload = query_database(parsed.path, parse_qs(parsed.query))
            data = json.dumps(payload, ensure_ascii=False, default=float).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        self.path = "/index.html" if parsed.path == "/" else parsed.path
        super().do_GET()

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
            connection = STORAGE.connect()
            try:
                if len(parts) == 3 and parts[1] == "aliases":
                    alias = unquote(parts[2]).strip()
                    cursor = connection.execute(
                        "DELETE FROM friend_group_aliases WHERE group_id=? AND lower(alias)=lower(?)",
                        (group_id, alias),
                    )
                    if cursor.rowcount == 0:
                        raise ValueError("alias not found")
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
            data = json.dumps({"ok": True, "id": group_id}).encode("utf-8")
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except (ValueError, TypeError):
            self.send_error(HTTPStatus.BAD_REQUEST, "Invalid friend group")

    def do_PATCH(self) -> None:
        parsed = urlparse(self.path)
        prefix = "/api/friend-groups/"
        if not parsed.path.startswith(prefix):
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        try:
            group_id = int(parsed.path[len(prefix):])
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            name = str(payload.get("name", "")).strip()[:80]
            if not name:
                raise ValueError("name is required")
            connection = STORAGE.connect()
            try:
                cursor = connection.execute(
                    "UPDATE friend_groups SET name=? WHERE id=?", (name, group_id)
                )
                if cursor.rowcount == 0:
                    raise ValueError("group not found")
                connection.commit()
            finally:
                connection.close()
            data = json.dumps({"ok": True, "id": group_id, "name": name}, ensure_ascii=False).encode("utf-8")
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except (ValueError, TypeError, json.JSONDecodeError, sqlite3.IntegrityError):
            self.send_error(HTTPStatus.BAD_REQUEST, "Invalid friend group name")

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path not in {"/api/annotations", "/api/friend-groups"}:
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            if parsed.path == "/api/friend-groups":
                name = str(payload.get("name", "")).strip()[:80]
                aliases = list(dict.fromkeys(str(alias).strip()[:120] for alias in payload.get("aliases", []) if str(alias).strip()))
                if not name or not aliases:
                    raise ValueError("name and at least one alias are required")
                if "#" in name and name.casefold() not in {alias.casefold() for alias in aliases}:
                    aliases.insert(0, name)
                connection = STORAGE.connect()
                try:
                    # Riot IDs are case-insensitive for grouping purposes. Reuse
                    # an existing group with the same name, or with one of the
                    # submitted aliases. The existing display name is preserved
                    # when a renamed group is saved again.
                    group = connection.execute(
                        "SELECT id FROM friend_groups WHERE lower(name)=lower(?)", (name,)
                    ).fetchone()
                    if not group:
                        placeholders = ",".join("?" for _ in aliases)
                        group = connection.execute(
                            f"SELECT group_id AS id FROM friend_group_aliases "
                            f"WHERE lower(alias) IN ({','.join('lower(?)' for _ in aliases)}) "
                            "ORDER BY group_id LIMIT 1",
                            aliases,
                        ).fetchone()
                    if group:
                        group_id = group["id"]
                    else:
                        connection.execute("INSERT INTO friend_groups(name) VALUES(?)", (name,))
                        group_id = connection.execute(
                            "SELECT id FROM friend_groups WHERE lower(name)=lower(?)", (name,)
                        ).fetchone()["id"]

                    # If an alias is already in another manual group, merge that
                    # group into the group being saved instead of returning 400.
                    # This makes it possible to extend/rename an existing group.
                    conflicting_ids = set()
                    for alias in aliases:
                        existing = connection.execute(
                            "SELECT group_id FROM friend_group_aliases WHERE lower(alias)=lower(?)",
                            (alias,),
                        ).fetchall()
                        conflicting_ids.update(row["group_id"] for row in existing if row["group_id"] != group_id)
                    for conflicting_id in conflicting_ids:
                        source_aliases = connection.execute(
                            "SELECT alias FROM friend_group_aliases WHERE group_id=?", (conflicting_id,)
                        ).fetchall()
                        for source_row in source_aliases:
                            alias = source_row["alias"]
                            already_in_target = connection.execute(
                                "SELECT 1 FROM friend_group_aliases WHERE group_id=? AND lower(alias)=lower(?)",
                                (group_id, alias),
                            ).fetchone()
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
                        existing = connection.execute(
                            "SELECT alias FROM friend_group_aliases WHERE lower(alias)=lower(?)",
                            (alias,),
                        ).fetchone()
                        if not existing:
                            connection.execute(
                                "INSERT INTO friend_group_aliases(group_id, alias) VALUES(?, ?)",
                                (group_id, alias),
                            )
                    connection.commit()
                finally:
                    connection.close()
                data = json.dumps({"ok": True, "name": name}, ensure_ascii=False).encode("utf-8")
                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return
            match_id = str(payload.get("match_id", "")).strip()
            if not match_id:
                raise ValueError("match_id is required")
            values = [
                match_id,
                as_bool(payload.get("invincible")), as_bool(payload.get("carryable_loss")),
                as_bool(payload.get("afk_player")), as_bool(payload.get("griefer")),
                as_bool(payload.get("team_collapse")), str(payload.get("manual_label", ""))[:40],
                str(payload.get("note", ""))[:1000], max(0.0, min(float(payload.get("confidence", 1)), 1.0)),
                __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat(),
            ]
            connection = STORAGE.connect()
            try:
                if not connection.execute("SELECT 1 FROM match_quality WHERE match_id=? LIMIT 1", (match_id,)).fetchone():
                    raise ValueError("unknown match_id")
                connection.execute("""INSERT INTO match_annotations
                    (match_id,invincible,carryable_loss,afk_player,griefer,team_collapse,manual_label,note,confidence,updated_at)
                    VALUES (?,?,?,?,?,?,?,?,?,?)
                    ON CONFLICT(match_id) DO UPDATE SET invincible=excluded.invincible,
                    carryable_loss=excluded.carryable_loss, afk_player=excluded.afk_player,
                    griefer=excluded.griefer, team_collapse=excluded.team_collapse,
                    manual_label=excluded.manual_label, note=excluded.note,
                    confidence=excluded.confidence, updated_at=excluded.updated_at""", values)
                connection.commit()
            finally:
                connection.close()
            data = json.dumps({"ok": True, "match_id": match_id}).encode("utf-8")
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except (ValueError, json.JSONDecodeError, TypeError) as error:
            data = json.dumps({"error": str(error)}, ensure_ascii=False).encode("utf-8")
            self.send_response(HTTPStatus.BAD_REQUEST)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

    def log_message(self, format: str, *args) -> None:
        print(f"[web] {self.address_string()} {format % args}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Serve the Champion Fit SQLite dashboard.")
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE, help="Directory containing Champion Fit CSV/JSON outputs")
    parser.add_argument("--rebuild", action="store_true", help="Re-import source outputs into champion_fit.db")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8787)
    args = parser.parse_args()
    database(args.source, args.rebuild)
    server = ThreadingHTTPServer((args.host, args.port), DashboardHandler)
    print(f"Champion Fit dashboard: http://{args.host}:{args.port}")
    print(f"Storage: {STORAGE.engine}")
    if STORAGE.engine == "sqlite":
        print(f"SQLite database: {DB_PATH}")
    server.serve_forever()


if __name__ == "__main__":
    main()
