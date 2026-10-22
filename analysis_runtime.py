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
UTC_ORDER_COLUMN = "_analysis_utc_order"
_MINIMUM_UTC = datetime.min.replace(tzinfo=timezone.utc)
_CALENDAR_SPAN = datetime.max - datetime.min


class AnalysisConnection:
    def __init__(self, connection, context, evidence, source_columns):
        self.base = connection
        self.context = context
        self.evidence = evidence
        self.source_columns = tuple(source_columns)

    def execute(self, sql, values=()):
        # Only this read boundary is wrapped; mutation/import connections never
        # pass through the projection. Table names cannot come from user input.
        return self.base.execute(re.sub(r"\bmatch_quality\b", "analysis_match_quality", sql), values)

    def __getattr__(self, name):
        return getattr(self.base, name)


def recent_match_sql(connection, alias="m"):
    """Select archived fields and an explicit UTC value without leaking sort metadata."""
    if isinstance(connection, AnalysisConnection):
        columns = ",".join(f"{alias}.{column}" for column in connection.source_columns)
        utc_date = f"{alias}.{UTC_ORDER_COLUMN}"
        return columns, utc_date, utc_date
    # Private raw readers retain their existing ordering. They cannot promise a
    # normalized UTC representation without preparing an analysis projection.
    return f"{alias}.*", "NULL", f"{alias}.date"


def parse_time(value):
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed.astimezone(timezone.utc)
    except (TypeError, ValueError, OverflowError):
        return None


def subtract_days_clamped(value: datetime, days: int) -> datetime:
    """Keep exact UTC lookbacks within the earliest representable instant."""
    interval = timedelta(days=days)
    if interval > _CALENDAR_SPAN:
        raise OverflowError("day interval exceeds the supported calendar")
    return _MINIMUM_UTC if interval > value - _MINIMUM_UTC else value - interval


def _source_filters(connection, *, targets, params, suspended, queue, cutoff, now, account_filter,
                    companion_filter, queue_aliases):
    """Build a SQL superset of the exact request context.

    ``match_quality.date`` is TEXT in both storage engines. Native date checks
    handle ordinary extended ISO 8601 timestamps. Other stored formats must
    reach ``parse_time`` below: Python accepts compact dates, week dates and
    offsets that the database engines reject or interpret differently. Invalid
    legacy text also reaches that final guard without aborting a SQL query.
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
    # Padding makes these TEXT bounds safe for native-compatible extended dates.
    date_checks = []
    date_values = []
    if cutoff is not None:
        date_checks.append("m.date>=?")
        date_values.append(subtract_days_clamped(cutoff, 1).date().isoformat())
    date_checks.append("m.date<?")
    try:
        date_values.append((now.date() + timedelta(days=2)).isoformat())
    except OverflowError:
        # A synthetic validator can choose datetime.max; this sentinel remains
        # above every supported four-digit extended ISO date.
        date_values.append("9999-12-32")
    if isinstance(connection, sqlite3.Connection):
        date_glob = "[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]"
        second_glob = date_glob + "[T ][0-9][0-9]:[0-9][0-9]:[0-9][0-9]"
        # Restrict the fast path to common isoformat() representations. In
        # particular, SQL rounding must never reject a timestamp whose fraction
        # Python truncates after six digits. Other valid forms use the fallback.
        common_globs = [date_glob, *(
            second_glob + fraction + offset
            for fraction in ("", ".[0-9][0-9][0-9]", ".[0-9][0-9][0-9][0-9][0-9][0-9]")
            for offset in ("", "Z", "[+-][0-9][0-9]:[0-9][0-9]")
        )]
        native_date = (
            "(" + " OR ".join(f"m.date GLOB '{pattern}'" for pattern in common_globs) + ")"
            " AND julianday(m.date) IS NOT NULL"
        )
        if cutoff is not None:
            date_checks.append("julianday(m.date)>=julianday(?)")
            date_values.append(cutoff.isoformat())
        # SQLite can round datetime.max's fraction beyond its calendar and
        # return NULL. Keep this SQL prefilter conservative; Python below
        # always applies the exact upper bound to every retained row.
        date_checks.append("COALESCE(julianday(m.date)<=julianday(?),1)")
        date_values.append(now.isoformat())
    else:
        # PostgreSQL 16's input validator lets the CASE avoid raising on an
        # invalid legacy value.  Naive stored timestamps retain parse_time's UTC
        # interpretation instead of depending on the database session timezone.
        # Restrict native parsing to unambiguous ISO syntax. For example, +02
        # and +0200 are valid Python offsets but the naive branch below would
        # otherwise discard their zone. Avoid '?' in this literal regex because
        # the PostgreSQL adapter replaces SQL parameter markers textually.
        native_date = (
            "m.date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}"
            "([T ][0-9]{2}:[0-9]{2}(:[0-9]{2}([.][0-9]{1,6}){0,1}){0,1}"
            "(Z|[+-][0-9]{2}:[0-9]{2}){0,1}){0,1}$' "
            "AND pg_input_is_valid(m.date,'timestamp with time zone')"
        )
        postgres_date = (
            "(CASE WHEN pg_input_is_valid(m.date,'timestamp with time zone') THEN "
            "CASE WHEN m.date ~ '(Z|[+-][0-9]{2}:[0-9]{2})$' "
            "THEN CAST(m.date AS timestamp with time zone) "
            "ELSE CAST(m.date AS timestamp without time zone) AT TIME ZONE 'UTC' END END)"
        )
        if cutoff is not None:
            date_checks.append(f"{postgres_date}>=CAST(? AS timestamp with time zone)")
            date_values.append(cutoff.isoformat())
        date_checks.append(f"{postgres_date}<=CAST(? AS timestamp with time zone)")
        date_values.append(now.isoformat())
    date_sql = (
        f" AND (CASE WHEN {native_date} THEN "
        + " AND ".join(date_checks)
        + " ELSE TRUE END)"
    )

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
    # Explicit timestamps keep historical comparisons reproducible. Capture
    # one reference instant for the projection and downstream readers.
    now = parse_time(params.get("as_of", [None])[0]) or datetime.now(timezone.utc)
    cutoff = subtract_days_clamped(now, int(days)).replace(hour=0, minute=0, second=0, microsecond=0) if days != "all" else None
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
        row[UTC_ORDER_COLUMN] = when.isoformat(timespec="microseconds")
        valid.append(row)
    params.update({"queue": [queue], "days": [days], "role": [role], "as_of": [now.isoformat()]})
    # Keep original fields separate from request-only chronological metadata so
    # API readers can enumerate the archive columns without exposing it.
    cursor = connection.execute("SELECT * FROM match_quality WHERE 1=0")
    columns = [column[0] for column in cursor.description]
    projected_columns = [*columns, UTC_ORDER_COLUMN]
    temp_schema = "temp" if isinstance(connection, sqlite3.Connection) else "pg_temp"
    connection.execute(f"DROP TABLE IF EXISTS {temp_schema}.analysis_match_quality")
    connection.execute(
        f"CREATE TEMP TABLE analysis_match_quality AS "
        f"SELECT *, CAST(NULL AS TEXT) {UTC_ORDER_COLUMN} FROM match_quality WHERE 1=0"
    )
    effective = {}
    inserted = []
    for row in valid:
        key = (str(row["account"]), str(row["match_id"]))
        result = resolve_effective_evidence(row)
        effective[key] = result
        row["win_evidence_weight"] = result["effective_win_weight"]
        row["loss_attribution_weight"] = result["effective_loss_weight"]
        inserted.append(tuple(row[column] for column in projected_columns))
    if inserted:
        connection.executemany(
            "INSERT INTO analysis_match_quality (" + ",".join(projected_columns) + ") VALUES (" + ",".join("?" for _ in projected_columns) + ")",
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
    return AnalysisConnection(connection, context, effective, columns), params
