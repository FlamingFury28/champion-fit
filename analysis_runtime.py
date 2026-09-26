"""Request-local analysis projection; archived facts and weights never change.

The temporary table lets every existing SQL consumer see the same context and
effective attribution. Its lifetime is one connection, so imports, annotations
and a concurrent settings change cannot leave a process cache stale.
"""
from __future__ import annotations

import re
import sqlite3
from collections import Counter
from datetime import datetime, timedelta, timezone

from algorithm_settings import current_settings


VALID_ROLES = ("TOP", "JUNGLE", "MIDDLE", "BOTTOM", "SUPPORT")


class AnalysisConnection:
    def __init__(self, connection, context, evidence):
        self.base = connection
        self.context = context
        self.evidence = evidence

    def execute(self, sql, values=()):
        # Only this read boundary is wrapped; mutation/import connections never
        # pass through the projection. Table names cannot come from user input.
        return self.base.execute(re.sub(r"\bmatch_quality\b", "analysis_match_quality", sql), values)

    def __getattr__(self, name):
        return getattr(self.base, name)


def parse_time(value):
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed.astimezone(timezone.utc)
    except (TypeError, ValueError):
        return None


def _source_filters(connection, *, targets, params, suspended, queue, cutoff, now, account_filter,
                    companion_filter, queue_aliases):
    """Build an index-friendly superset of the exact request context.

    ``match_quality.date`` is TEXT in both storage engines.  The direct bounds
    use its stored extended ISO 8601 representation and the date index.  The
    engine-specific expression then checks the exact instant without allowing
    arbitrary legacy text to abort a PostgreSQL query.  ``parse_time`` below is
    retained as the final semantic guard for formats the engines parse more
    permissively than Python.
    """
    scope_sql, scope_values = account_filter(targets, "m.account")
    companion_sql, companion_values = companion_filter(params, "m.match_id")
    suspended_accounts = sorted(suspended & set(targets))
    suspended_sql = ""
    suspended_values = []
    if suspended_accounts:
        suspended_sql = " AND m.account NOT IN (" + ",".join("?" for _ in suspended_accounts) + ")"
        suspended_values = suspended_accounts

    queue_key = "UPPER(REPLACE(TRIM(COALESCE(m.queue,'')), ' ', ''))"
    accepted_queue_keys = sorted({
        queue,
        f"QUEUE{queue}",
        *(alias for alias, canonical in queue_aliases.items() if canonical == queue),
    }) if queue != "all" else []
    queue_sql = (
        f" AND {queue_key} IN ({','.join('?' for _ in accepted_queue_keys)})"
        if accepted_queue_keys else ""
    )

    # UTC instants can be at most one local calendar day away from their UTC
    # date because datetime.fromisoformat rejects offsets of 24 hours or more.
    # Padding therefore makes these index-friendly TEXT bounds a safe prefilter.
    date_sql = ""
    date_values = []
    if cutoff is not None:
        date_sql += " AND m.date>=?"
        date_values.append((cutoff.date() - timedelta(days=1)).isoformat())
    date_sql += " AND m.date<?"
    try:
        date_values.append((now.date() + timedelta(days=2)).isoformat())
    except OverflowError:
        # A synthetic validator can choose datetime.max; this sentinel remains
        # above every supported four-digit extended ISO date.
        date_values.append("9999-12-32")
    if isinstance(connection, sqlite3.Connection):
        date_sql += " AND julianday(m.date) IS NOT NULL"
        if cutoff is not None:
            date_sql += " AND julianday(m.date)>=julianday(?)"
            date_values.append(cutoff.isoformat())
        date_sql += " AND julianday(m.date)<=julianday(?)"
        date_values.append(now.isoformat())
    else:
        # PostgreSQL 16's input validator lets the CASE avoid raising on an
        # invalid legacy value.  Naive stored timestamps retain parse_time's UTC
        # interpretation instead of depending on the database session timezone.
        postgres_date = (
            "(CASE WHEN pg_input_is_valid(m.date,'timestamp with time zone') THEN "
            "CASE WHEN m.date ~ '(Z|[+-][0-9]{2}:[0-9]{2})$' "
            "THEN CAST(m.date AS timestamp with time zone) "
            "ELSE CAST(m.date AS timestamp without time zone) AT TIME ZONE 'UTC' END END)"
        )
        date_sql += f" AND {postgres_date} IS NOT NULL"
        if cutoff is not None:
            date_sql += f" AND {postgres_date}>=CAST(? AS timestamp with time zone)"
            date_values.append(cutoff.isoformat())
        date_sql += f" AND {postgres_date}<=CAST(? AS timestamp with time zone)"
        date_values.append(now.isoformat())

    role_sql = " AND m.role IN (" + ",".join("?" for _ in VALID_ROLES) + ")"
    sql = scope_sql + companion_sql + suspended_sql + role_sql + queue_sql + date_sql
    values = [
        *scope_values,
        *companion_values,
        *suspended_values,
        *VALID_ROLES,
        *accepted_queue_keys,
        *date_values,
    ]
    return sql, values, bool(companion_values)


def prepare_analysis(connection, params, *, account_filter, companion_filter, allow_all_queues=False):
    from effective_evidence import resolve_effective_evidence
    from playstyle_analysis import QUEUE_ALIASES, canonical_queue

    settings = current_settings()
    params = {key: list(value) for key, value in params.items()}
    targets = sorted(set(params.get("account", [])))
    if not targets:
        targets = [r["account"] for r in connection.execute("SELECT DISTINCT account FROM match_quality ORDER BY account")]
    params["account"] = targets
    queue = str(params.get("queue", [settings["context"]["queue"]])[0])
    days = str(params.get("days", [settings["context"]["days"]])[0])
    if days not in {"90", "180", "365", "all"}:
        raise ValueError("days deve essere 90, 180, 365 oppure all")
    if queue == "all":
        if not allow_all_queues:
            raise ValueError("Scegli una modalità per il confronto; le modalità non vengono mescolate")
    else:
        queue = canonical_queue(queue)
        if not queue.isdigit() or not 0 < int(queue) <= 9999:
            raise ValueError("Modalità non valida")
    # as_of is server-generated in HTTP requests; offline validators may pass
    # an explicit timestamp directly for reproducible historical comparisons.
    now = parse_time(params.get("as_of", [None])[0]) or datetime.now(timezone.utc)
    cutoff = (now - timedelta(days=int(days))).replace(hour=0, minute=0, second=0, microsecond=0) if days != "all" else None
    role = params.get("role", [""])[0].strip().upper()
    if role == "UTILITY":
        role = "SUPPORT"
    if role not in {"", "ALL", *VALID_ROLES}:
        raise ValueError("Ruolo non valido")
    suspended = {r["account"] for r in connection.execute(
        "SELECT i.account FROM riot_account_identities i JOIN riot_identity_policy p "
        "ON p.identity_id=i.identity_id WHERE p.state='exception' UNION "
        "SELECT m.account FROM riot_match_materialization m JOIN riot_identity_policy p "
        "ON p.puuid=m.participant_puuid WHERE p.state='exception'")}
    source_sql, source_values, companion_filter_active = _source_filters(
        connection, targets=targets, params=params, suspended=suspended, queue=queue,
        cutoff=cutoff, now=now, account_filter=account_filter, companion_filter=companion_filter,
        queue_aliases=QUEUE_ALIASES,
    )
    if not role:
        counts = Counter()
        candidates = connection.execute(
            "SELECT m.role,m.queue,m.date FROM match_quality m WHERE 1=1" + source_sql,
            source_values,
        )
        for candidate in candidates:
            when = parse_time(candidate["date"])
            queue_matches = queue == "all" or canonical_queue(candidate["queue"]) == queue
            if (queue_matches and when is not None
                    and when <= now and (cutoff is None or when >= cutoff)):
                counts[candidate["role"]] += 1
        role = min(counts, key=lambda key: (-counts[key], key)) if counts else ""

    selected_role_sql = "" if role == "ALL" else " AND m.role=?"
    selected_role_values = [] if role == "ALL" else [role]
    rows = [dict(r) for r in connection.execute(
        "SELECT m.*,p.classification,p.source provenance_source,p.overrides_json,"
        "COALESCE(a.afk_player,0) annotation_afk,COALESCE(a.griefer,0) annotation_griefer,"
        "COALESCE(a.invincible,0) annotation_invincible FROM match_quality m "
        "LEFT JOIN match_import_provenance p ON p.account=m.account AND p.match_id=m.match_id "
        "LEFT JOIN match_annotations a ON a.match_id=m.match_id WHERE 1=1"
        + source_sql + selected_role_sql,
        [*source_values, *selected_role_values],
    )]
    valid = []
    for row in rows:
        when = parse_time(row["date"])
        if row["account"] in suspended or row["role"] not in VALID_ROLES:
            continue
        if queue != "all" and canonical_queue(row["queue"]) != queue:
            continue
        if when is None or when > now or (cutoff is not None and when < cutoff):
            continue
        if role != "ALL" and row["role"] != role:
            continue
        valid.append(row)
    params.update({"queue": [queue], "days": [days], "role": [role]})
    # Retain every source column for compatibility with existing SELECT m.*.
    cursor = connection.execute("SELECT * FROM match_quality WHERE 1=0")
    columns = [column[0] for column in cursor.description]
    temp_schema = "temp" if isinstance(connection, sqlite3.Connection) else "pg_temp"
    connection.execute(f"DROP TABLE IF EXISTS {temp_schema}.analysis_match_quality")
    connection.execute("CREATE TEMP TABLE analysis_match_quality AS SELECT * FROM match_quality WHERE 1=0")
    effective = {}
    inserted = []
    for row in valid:
        key = (str(row["account"]), str(row["match_id"]))
        result = resolve_effective_evidence(row)
        effective[key] = result
        row["win_evidence_weight"] = result["effective_win_weight"]
        row["loss_attribution_weight"] = result["effective_loss_weight"]
        inserted.append(tuple(row[column] for column in columns))
    if inserted:
        connection.executemany(
            "INSERT INTO analysis_match_quality (" + ",".join(columns) + ") VALUES (" + ",".join("?" for _ in columns) + ")",
            inserted,
        )
    connection.execute("CREATE INDEX analysis_match_scope ON analysis_match_quality(account,match_id)")
    context = {
        "accounts": targets, "role": role, "queue": queue, "days": days,
        "as_of": now.date().isoformat(), "observations": len(valid),
        "unique_games": len({r["match_id"] for r in valid}),
        "suspended_accounts": sorted(suspended & set(targets)),
        "companion_filter_active": companion_filter_active,
    }
    return AnalysisConnection(connection, context, effective), params
