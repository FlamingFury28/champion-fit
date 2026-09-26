#!/usr/bin/env python3
"""Inspect identity assumptions and reversibly suspend an individual link.

Excluding one PUUID blocks future reconciliation of its entire identity group.
It preserves matches, aliases, overrides and ownership links already stored;
it does not automatically separate or reattribute ambiguous historical matches.
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from pathlib import Path

from account_identity import _key, canonical_account_name, record_identity_policy


def identity_groups(connection, account: str | None = None) -> list[dict]:
    """Read explicit policies, with inherited registry policy clearly marked."""
    rows = list(connection.execute(
        "SELECT i.account,r.identity_id,r.puuid,p.state,p.resume_state,p.source,p.note,p.updated_at,p.history_json "
        "FROM riot_identity_puuids r JOIN riot_account_identities i ON i.identity_id=r.identity_id "
        "LEFT JOIN riot_identity_policy p ON p.puuid=r.puuid ORDER BY i.account,r.puuid"
    ))
    groups = {}
    for row in rows:
        group = groups.setdefault(str(row["identity_id"]), {
            "identity_id": str(row["identity_id"]), "account": str(row["account"]), "puuids": [],
        })
        member = dict(row)
        member.pop("identity_id"); member.pop("account")
        member["explicit_policy"] = member["state"] is not None
        member["history"] = json.loads(member.pop("history_json") or "[]")
        group["puuids"].append(member)
    canonical = canonical_account_name(connection, account) if account else None
    result = []
    for group in groups.values():
        if canonical and _key(group["account"]) != _key(canonical):
            continue
        members = group["puuids"]
        assumed = any(member["state"] == "assumed" or member["resume_state"] == "assumed" for member in members)
        group["reconciliation_blocked"] = any(member["state"] == "exception" for member in members)
        group["state"] = "exception" if group["reconciliation_blocked"] else ("assumed" if assumed else "verified")
        for member in members:
            if not member["explicit_policy"]:
                member.update(state="assumed" if assumed else "verified", source="registry_inherited", note="",
                              resume_state="", updated_at=None)
        result.append(group)
    return result


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, default=Path(__file__).with_name("champion_fit.db"))
    commands = parser.add_subparsers(dest="command", required=True)
    listing = commands.add_parser("list", help="Elenca gruppi, assunzioni ed eccezioni")
    listing.add_argument("--account", help="Riot ID attuale o alias storico")
    showing = commands.add_parser("show", help="Mostra il gruppo e la cronologia di un PUUID")
    showing.add_argument("puuid")
    for command, aliases, help_text in (
        ("exclude", ["suspend"], "Sospende il gruppo senza separare automaticamente lo storico"),
        ("restore", ["clear"], "Revoca la sospensione e ripristina lo stato precedente"),
    ):
        action = commands.add_parser(command, aliases=aliases, help=help_text)
        action.add_argument("puuid")
        action.add_argument("--reason", required=True, help="Motivo conservato nella cronologia")
    args = parser.parse_args(argv)
    mutation = args.command in {"exclude", "suspend", "restore", "clear"}
    connection = None
    try:
        # mode=rw avoids silently creating a new database on a mistyped path.
        uri = args.db.resolve().as_uri() + ("?mode=rw" if mutation else "?mode=ro")
        connection = sqlite3.connect(uri, uri=True)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys=ON")
        if mutation:
            if not args.reason.strip():
                raise ValueError("Il motivo non può essere vuoto")
            connection.execute("BEGIN IMMEDIATE")
            current = connection.execute("SELECT * FROM riot_identity_policy WHERE puuid=?", (args.puuid,)).fetchone()
            if args.command in {"restore", "clear"}:
                if not current or current["state"] != "exception":
                    raise ValueError("Il PUUID non ha una sospensione da ripristinare")
                state = current["resume_state"]
                if state not in {"assumed", "verified"}:
                    raise ValueError("Stato precedente non valido; nessuna modifica applicata")
            else:
                state = "exception"
            source = current["source"] if current else "manual_registry_exception"
            record_identity_policy(connection, args.puuid, state, source, args.reason)
        groups = identity_groups(connection, getattr(args, "account", None))
        if args.command != "list":
            groups = [group for group in groups if any(member["puuid"] == args.puuid for member in group["puuids"])]
            if not groups:
                raise ValueError(f"PUUID non presente nel registro: {args.puuid}")
        payload = {"groups": groups}
        if mutation:
            payload["message"] = (
                "Collegamento sospeso per il gruppo; storico conservato senza separazione automatica."
                if args.command in {"exclude", "suspend"} else
                "Sospensione revocata; stato precedente ripristinato. Eventuali altre eccezioni restano attive."
            )
        rendered = json.dumps(payload, ensure_ascii=True, indent=2)
        if mutation:
            connection.commit()
        print(rendered)
        return 0
    except (sqlite3.Error, ValueError) as error:
        if connection is not None and connection.in_transaction:
            connection.rollback()
        print(f"Errore: {error}", file=sys.stderr)
        return 1
    finally:
        if connection is not None:
            connection.close()


if __name__ == "__main__":
    raise SystemExit(main())
