import contextlib
import io
import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import app
import check_new_matches
from check_new_matches import check_account
from riot_sync import (
    AccountIdentityEvidence,
    audit_raw_materialization,
    dedupe_match_ids,
    identity_evidence,
    ingest_normalized_rows,
    migrate_ingestion_schema,
    normalize_match_detail,
    normalize_riot_id,
    reprocess_raw_matches,
    resolve_tracked_participant,
)
from storage import SQLiteStorage


def match_detail(
    match_id="M1",
    player_puuid="historical-puuid",
    player_name="Player",
    player_tag="EUW",
):
    detail = {
        "metadata": {
            "matchId": match_id,
            "participants": [player_puuid, "ally-puuid"],
        },
        "info": {
            "mapId": 11,
            "queueId": 420,
            "gameStartTimestamp": 1724198400000,
            "gameDuration": 1800,
            "gameVersion": "14.16",
            "participants": [
                {
                    "participantId": 1,
                    "puuid": "legacy-info-puuid",
                    "riotIdGameName": player_name,
                    "riotIdTagline": player_tag,
                    "championName": "Vi",
                    "teamPosition": "JUNGLE",
                    "teamId": 100,
                    "win": True,
                },
                {
                    "participantId": 2,
                    "puuid": "ally-info-puuid",
                    "riotIdGameName": "Ally",
                    "riotIdTagline": "EUW",
                    "championName": "Lux",
                    "teamPosition": "MIDDLE",
                    "teamId": 100,
                    "win": True,
                },
            ],
        },
    }
    for slot in range(3, 11):
        participant_puuid = f"unrelated-{slot}"
        detail["metadata"]["participants"].append(participant_puuid)
        detail["info"]["participants"].append({
            "participantId": slot, "puuid": participant_puuid,
            "riotIdGameName": f"Unrelated {slot}", "riotIdTagline": "EUW",
            "championName": "Ashe", "teamPosition": "BOTTOM",
            "teamId": 100 if slot <= 5 else 200, "win": slot <= 5,
        })
    return detail


class RiotIdentityTests(unittest.TestCase):
    def test_riot_id_normalization_is_exact_not_fuzzy(self):
        self.assertEqual(normalize_riot_id("  ＰＬＡＹＥＲ#eUw  "), "player#euw")
        self.assertNotEqual(normalize_riot_id("Play er#EUW"), normalize_riot_id("Player#EUW"))
        self.assertNotEqual(normalize_riot_id("Player#NA"), normalize_riot_id("Player#EUW"))

    def test_resolver_reports_exact_alias_but_requires_independent_puuid_evidence(self):
        participants = match_detail()["info"]["participants"]
        evidence = AccountIdentityEvidence(
            "Current#EUW",
            frozenset({"current-puuid"}),
            frozenset({normalize_riot_id("Player#EUW")}),
        )

        resolution = resolve_tracked_participant(participants, evidence)
        self.assertEqual(resolution.method, "unverified_alias_puuid")
        self.assertIsNone(resolution.participant)
        self.assertEqual(resolution.observed_puuid, "legacy-info-puuid")

        wrong_tag = AccountIdentityEvidence(
            "Current#EUW",
            frozenset({"current-puuid"}),
            frozenset({normalize_riot_id("Player#NA")}),
        )
        self.assertEqual(
            resolve_tracked_participant(participants, wrong_tag).method,
            "identity_unresolved",
        )

    def test_metadata_puuid_is_authoritative_for_participant_resolution(self):
        detail = match_detail(player_puuid="canonical-puuid")
        evidence = AccountIdentityEvidence(
            "Current#EUW",
            frozenset({"canonical-puuid"}),
            frozenset(),
        )

        result = normalize_match_detail("Current#EUW", evidence, detail, "M1")

        self.assertEqual(result.status, "eligible")
        self.assertEqual(result.identity_resolution, "puuid_exact")
        self.assertEqual(result.observed_puuid, "canonical-puuid")
        self.assertEqual(result.participants[0]["participant_id"], 1)
        self.assertEqual(result.participants[0]["puuid"], "canonical-puuid")

    def test_match_id_lists_are_stably_deduplicated(self):
        self.assertEqual(dedupe_match_ids(["M2", "M1", "M2", "", None, "M1"]), ["M2", "M1"])

    def test_heuristic_tracked_puuid_is_not_trusted_as_identity_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "test.db"
            storage = SQLiteStorage(database, app.SCHEMA_PATH)
            storage.initialize()
            connection = storage.connect()
            connection.execute(
                "INSERT INTO tracked_account_puuids(puuid,account) VALUES(?,?)",
                ("frequent-duo-puuid", "Player#EUW"),
            )
            connection.commit()

            evidence = identity_evidence(connection, "Player#EUW", "account-v1-puuid")

            self.assertIn("account-v1-puuid", evidence.puuids)
            self.assertNotIn("frequent-duo-puuid", evidence.puuids)
            connection.close()


class RiotMaterializationTests(unittest.TestCase):
    def test_reprocess_resolves_identity_graph_to_fixed_point_in_one_run(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "test.db"
            storage = SQLiteStorage(database, app.SCHEMA_PATH)
            storage.initialize()
            details = {
                "M_ALIAS_TO_P1": match_detail(
                    match_id="M_ALIAS_TO_P1", player_puuid="p1", player_name="Current",
                ),
                "M_P1_TO_OLD_ALIAS": match_detail(
                    match_id="M_P1_TO_OLD_ALIAS", player_puuid="p1", player_name="Old Name",
                ),
                "M_OLD_ALIAS_TO_P2": match_detail(
                    match_id="M_OLD_ALIAS_TO_P2", player_puuid="p2", player_name="Old Name",
                ),
                "M_P2_WITHOUT_RIOT_ID": match_detail(
                    match_id="M_P2_WITHOUT_RIOT_ID", player_puuid="p2", player_name="",
                    player_tag="",
                ),
            }
            connection = storage.connect()
            connection.execute(
                "INSERT INTO riot_accounts_raw(puuid,account,game_name,tag_line,fetched_at,payload_json) "
                "VALUES(?,?,?,?,?,?)",
                ("p1", "Current#EUW", "Current", "EUW", "now", "{}"),
            )
            connection.execute(
                "INSERT INTO riot_match_list_raw(account,puuid,fetched_at,match_ids_json) VALUES(?,?,?,?)",
                ("Current#EUW", "p1", "now", json.dumps(list(details))),
            )
            connection.executemany(
                "INSERT INTO riot_match_raw(match_id,routing_region,fetched_at,payload_json) VALUES(?,?,?,?)",
                [
                    (match_id, "europe", "now", json.dumps(detail))
                    for match_id, detail in details.items()
                ],
            )
            connection.commit()
            connection.close()

            before = audit_raw_materialization(database)
            first = reprocess_raw_matches(database)
            after = audit_raw_materialization(database)
            second = reprocess_raw_matches(database)

            self.assertEqual(before["resolvable"], 2)
            self.assertEqual(before["would_insert"], 2)
            self.assertEqual(before["would_persist_identity_edges"], 1)
            self.assertEqual(first["inserted"], 2)
            self.assertEqual(first["identity_unresolved"], 2)
            self.assertEqual(first["identity_edges_persisted"], 1)
            self.assertEqual(after["would_insert"], 0)
            self.assertEqual(after["would_remove_stale"], 0)
            self.assertEqual(after["identity_unresolved"], 2)
            self.assertEqual(after["would_persist_identity_edges"], 0)
            self.assertEqual(after["projected_analyzed"], 2)
            self.assertEqual(second["inserted"], 0)
            self.assertEqual(second["removed_stale"], 0)
            self.assertEqual(second["identity_edges_persisted"], 0)
            connection = storage.connect()
            try:
                self.assertIsNone(connection.execute(
                    "SELECT identity_id FROM riot_identity_puuids WHERE puuid='p2'"
                ).fetchone())
            finally:
                connection.close()

    def test_reprocess_does_not_promote_unknown_puuid_from_verified_alias(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "test.db"
            storage = SQLiteStorage(database, app.SCHEMA_PATH)
            storage.initialize()
            connection = storage.connect()
            detail = match_detail(player_name="Old Player")
            connection.executemany(
                "INSERT INTO riot_accounts_raw(puuid,account,game_name,tag_line,fetched_at,payload_json) VALUES(?,?,?,?,?,?)",
                [
                    ("current-puuid", "Current#EUW", "Current", "EUW", "now", "{}"),
                    ("other-historical", "Current#EUW", "Current", "EUW", "now", "{}"),
                ],
            )
            connection.executemany(
                "INSERT INTO riot_match_list_raw(account,puuid,fetched_at,match_ids_json) VALUES(?,?,?,?)",
                [
                    ("Current#EUW", "current-puuid", "now", json.dumps(["M1", "M1"])),
                    ("Current#EUW", "other-historical", "now", json.dumps(["M1"])),
                ],
            )
            connection.execute(
                "INSERT INTO riot_match_raw(match_id,routing_region,fetched_at,payload_json) VALUES(?,?,?,?)",
                ("M1", "europe", "now", json.dumps(detail)),
            )
            connection.executemany("INSERT INTO riot_account_aliases VALUES(?,?,?,?,?,?)", [
                ("Current#EUW", "current#euw", "Current#EUW", puuid, "imported_accounts_json", "now")
                for puuid in ("current-puuid", "other-historical")
            ])
            connection.execute(
                """INSERT INTO riot_account_aliases
                   (account,normalized_riot_id,display_riot_id,puuid,verification_source,verified_at)
                   VALUES(?,?,?,?,?,?)""",
                (
                    "Current#EUW",
                    normalize_riot_id("Old Player#EUW"),
                    "Old Player#EUW",
                    "current-puuid",
                    "test_verified",
                    "now",
                ),
            )
            connection.commit()
            connection.close()

            dry_run = audit_raw_materialization(database)
            first = reprocess_raw_matches(database)
            second = reprocess_raw_matches(database)

            self.assertEqual(dry_run["raw_known"], 1)
            self.assertEqual(dry_run["eligible"], 1)
            self.assertEqual(dry_run["would_insert"], 0)
            self.assertEqual(dry_run["identity_unresolved"], 1)
            self.assertEqual(first["raw_known"], 1)
            self.assertEqual(first["normalized_rows"], 0)
            self.assertEqual(first["inserted"], 0)
            self.assertEqual(first["identity_unresolved"], 1)
            self.assertEqual(second["inserted"], 0)
            self.assertEqual(second["identity_unresolved"], 1)
            connection = storage.connect()
            try:
                self.assertEqual(
                    connection.execute("SELECT COUNT(*) value FROM match_quality").fetchone()["value"],
                    0,
                )
                state = connection.execute(
                    "SELECT status,identity_resolution,attempts FROM riot_match_materialization "
                    "WHERE account='Current#EUW' AND match_id='M1'"
                ).fetchone()
                self.assertEqual(state["status"], "identity_unresolved")
                self.assertEqual(state["identity_resolution"], "unverified_alias_puuid")
                self.assertEqual(state["attempts"], 2)
                self.assertIsNone(connection.execute(
                    "SELECT verification_source FROM riot_account_aliases "
                    "WHERE account='Current#EUW' AND puuid='historical-puuid'"
                ).fetchone())
                self.assertIsNone(connection.execute(
                    "SELECT identity_id FROM riot_identity_puuids WHERE puuid='historical-puuid'"
                ).fetchone())
                self.assertEqual(
                    connection.execute(
                        "SELECT COUNT(*) value FROM match_participants WHERE match_id='M1'"
                    ).fetchone()["value"],
                    0,
                )
            finally:
                connection.close()

    def test_reprocess_marks_current_resolution_and_removes_only_verified_stale_rows(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "test.db"
            storage = SQLiteStorage(database, app.SCHEMA_PATH)
            storage.initialize()
            stale_rows = [
                {
                    "account": "Player#EUW",
                    "match_id": match_id,
                    "date": "2026-08-21T00:00:00Z",
                    "patch": "16.16",
                    "queue": "420",
                    "champion": "Vi",
                    "role": "JUNGLE",
                    "duration_minutes": 30,
                    "win": True,
                }
                for match_id in ("M_UNRESOLVED", "M_INVALID", "M_NO_RAW")
            ]
            ingest_normalized_rows(stale_rows, database, "stale_fixture")
            connection = storage.connect()
            connection.execute(
                "INSERT INTO riot_accounts_raw(puuid,account,game_name,tag_line,fetched_at,payload_json) "
                "VALUES(?,?,?,?,?,?)",
                ("current-puuid", "Player#EUW", "Player", "EUW", "now", "{}"),
            )
            connection.execute(
                "INSERT INTO riot_match_list_raw(account,puuid,fetched_at,match_ids_json) VALUES(?,?,?,?)",
                (
                    "Player#EUW",
                    "current-puuid",
                    "now",
                    json.dumps(["M_UNRESOLVED", "M_INVALID", "M_NO_RAW"]),
                ),
            )
            unresolved_detail = match_detail(
                match_id="M_UNRESOLVED",
                player_puuid="different-puuid",
                player_name="Different Player",
            )
            invalid_detail = {"metadata": {"matchId": "M_INVALID"}, "info": {}}
            connection.executemany(
                "INSERT INTO riot_match_raw(match_id,routing_region,fetched_at,payload_json) VALUES(?,?,?,?)",
                [
                    ("M_UNRESOLVED", "europe", "now", json.dumps(unresolved_detail)),
                    ("M_INVALID", "europe", "now", json.dumps(invalid_detail)),
                ],
            )
            connection.commit()
            connection.close()

            dry_run = audit_raw_materialization(database)
            result = reprocess_raw_matches(database)

            self.assertEqual(dry_run["already_analyzed"], 3)
            self.assertEqual(dry_run["identity_unresolved"], 1)
            self.assertEqual(dry_run["would_remove_stale"], 1)
            self.assertEqual(dry_run["projected_analyzed"], 2)
            self.assertEqual(result["removed_stale"], 1)
            connection = storage.connect()
            try:
                remaining = {
                    row["match_id"]
                    for row in connection.execute(
                        "SELECT match_id FROM match_quality WHERE account='Player#EUW'"
                    )
                }
                self.assertEqual(remaining, {"M_INVALID", "M_NO_RAW"})
                statuses = {
                    row["match_id"]: row["status"]
                    for row in connection.execute(
                        "SELECT match_id,status FROM riot_match_materialization "
                        "WHERE account='Player#EUW'"
                    )
                }
                self.assertEqual(statuses["M_UNRESOLVED"], "identity_unresolved")
                self.assertEqual(statuses["M_INVALID"], "invalid_payload")
            finally:
                connection.close()

    def test_quick_check_retries_known_raw_when_analysis_row_is_missing(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "test.db"
            storage = SQLiteStorage(database, app.SCHEMA_PATH)
            storage.initialize()
            connection = storage.connect()
            connection.execute(
                "INSERT INTO riot_match_list_raw(account,puuid,fetched_at,match_ids_json) VALUES(?,?,?,?)",
                ("Player#EUW", "current-puuid", "now", json.dumps(["M1", "M1"])),
            )
            connection.execute(
                "INSERT INTO riot_match_raw(match_id,routing_region,fetched_at,payload_json) VALUES(?,?,?,?)",
                ("M1", "europe", "now", json.dumps(match_detail(
                    player_puuid="current-puuid", player_name="Player",
                ))),
            )
            connection.commit()
            connection.close()

            requested_paths = []

            def fake_riot_get(path, _key):
                requested_paths.append(path)
                if path.startswith("/riot/account/"):
                    return {"puuid": "current-puuid", "gameName": "Player", "tagLine": "EUW"}
                if path.endswith("/ids?start=0&count=100"):
                    return ["M1", "M1"]
                raise AssertionError(f"Il detail raw noto non deve essere riscaricato: {path}")

            with patch("check_new_matches.riot_get", side_effect=fake_riot_get):
                result = check_account("Player#EUW", "secret", database)

            self.assertEqual(result["recent_ids"], 1)
            self.assertEqual(result["new_ids"], 0)
            self.assertEqual(result["retried_raw"], 1)
            self.assertEqual(result["inserted"], 1)
            self.assertFalse(any("/matches/M1" in path for path in requested_paths))

    def test_quick_check_recovers_eligible_state_without_refetching_valid_raw(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "test.db"
            storage = SQLiteStorage(database, app.SCHEMA_PATH)
            storage.initialize()
            connection = storage.connect()
            connection.execute(
                "INSERT INTO riot_match_list_raw VALUES(?,?,?,?)",
                ("Player#EUW", "current-puuid", "now", json.dumps(["M1"])),
            )
            connection.execute(
                "INSERT INTO riot_match_raw VALUES(?,?,?,?)",
                ("M1", "europe", "now", json.dumps(match_detail(
                    player_puuid="current-puuid", player_name="Player",
                ))),
            )
            connection.execute(
                "INSERT INTO riot_match_materialization VALUES(?,?,?,?,?,?,?,?)",
                ("Player#EUW", "M1", "eligible", "interrupted before ingest", "puuid_exact", "current-puuid", 1, "now"),
            )
            connection.commit()
            connection.close()

            requested_paths = []

            def fake_riot_get(path, _key):
                requested_paths.append(path)
                if path.startswith("/riot/account/"):
                    return {"puuid": "current-puuid", "gameName": "Player", "tagLine": "EUW"}
                if "/ids?" in path:
                    return ["M1"]
                raise AssertionError(f"Il raw eligible valido non deve essere riscaricato: {path}")

            with patch("check_new_matches.riot_get", side_effect=fake_riot_get):
                result = check_account("Player#EUW", "secret", database)

            self.assertEqual(result["retried_raw"], 1)
            self.assertEqual(result["inserted"], 1)
            self.assertFalse(any("/matches/M1" in path for path in requested_paths))

    def test_retry_queue_uses_only_the_selected_accounts_materialization_state(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "test.db"
            storage = SQLiteStorage(database, app.SCHEMA_PATH)
            storage.initialize()
            connection = storage.connect()
            connection.executemany(
                "INSERT INTO riot_account_identities VALUES(?,?)",
                [("identity-player", "Player#EUW"), ("identity-other", "Other#EUW")],
            )
            connection.executemany(
                "INSERT INTO riot_identity_puuids VALUES(?,?)",
                [("p1", "identity-player"), ("p2", "identity-other")],
            )
            connection.execute(
                "INSERT INTO riot_match_raw VALUES(?,?,?,?)",
                ("M1", "europe", "now", json.dumps(match_detail(player_puuid="p1"))),
            )
            connection.execute(
                "INSERT INTO riot_match_list_raw VALUES(?,?,?,?)",
                ("Player#EUW", "p1", "now", json.dumps(["M1"])),
            )
            connection.executemany(
                "INSERT INTO riot_match_materialization VALUES(?,?,?,?,?,?,?,?)",
                [
                    ("Player#EUW", "M1", "unsupported_queue", "terminal", "", "", 1, "now"),
                    ("Other#EUW", "M1", "invalid_payload", "retry", "", "", 1, "now"),
                ],
            )

            self.assertEqual(
                check_new_matches._retry_detail_ids(
                    connection, {"M1"}, "Player#EUW", "p1",
                ),
                ([], []),
            )
            self.assertEqual(
                check_new_matches._retry_detail_ids(
                    connection, {"M1"}, "Other#EUW", "p2",
                ),
                (["M1"], ["M1"]),
            )
            connection.commit()
            connection.close()

            requested_paths = []

            def fake_riot_get(path, _key):
                requested_paths.append(path)
                if path.startswith("/riot/account/"):
                    return {"puuid": "p1", "gameName": "Player", "tagLine": "EUW"}
                if "/ids?" in path:
                    return ["M1"]
                raise AssertionError(f"Lo stato invalido dell'altro account non deve forzare refetch: {path}")

            with patch("check_new_matches.riot_get", side_effect=fake_riot_get):
                result = check_account("Player#EUW", "secret", database)
            self.assertEqual(result["retried_raw"], 0)
            self.assertFalse(any("/matches/M1" in path for path in requested_paths))

    def test_incremental_main_marker_covers_pool_and_cleans_success_or_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "incremental.db"
            marker_glob = f".{database.stem}.riot-sync-*.active.json"
            observed = []

            def result_or_failure(_account, _key, _database):
                markers = list(database.parent.glob(marker_glob))
                self.assertEqual(len(markers), 1)
                observed.append(json.loads(markers[0].read_text(encoding="utf-8")))
                if len(observed) == 2:
                    raise RuntimeError("injected incremental failure")
                return {
                    "new_ids": 0, "retried_raw": 0, "pending_details": 0,
                    "inserted": 0, "removed_stale": 0,
                    "identity_edges_persisted": 0,
                }

            arguments = [
                "check_new_matches.py", "--api-keys", "secret", "--db", str(database),
                "--account", "Player#EUW",
            ]
            with patch.object(sys, "argv", arguments), patch(
                "check_new_matches.check_account", side_effect=result_or_failure,
            ), contextlib.redirect_stdout(io.StringIO()):
                check_new_matches.main()
            self.assertEqual(list(database.parent.glob(marker_glob)), [])
            self.assertEqual(observed[0]["version"], 1)
            self.assertEqual(observed[0]["account_count"], 1)

            with patch.object(sys, "argv", arguments), patch(
                "check_new_matches.check_account", side_effect=result_or_failure,
            ), contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaisesRegex(RuntimeError, "injected incremental failure"):
                    check_new_matches.main()
            self.assertEqual(list(database.parent.glob(marker_glob)), [])

    def test_legacy_migration_enforces_unique_match_and_logical_participant(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "legacy.db"
            connection = sqlite3.connect(database)
            connection.row_factory = sqlite3.Row
            connection.executescript("""
                CREATE TABLE source_metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE riot_match_raw(
                    match_id TEXT PRIMARY KEY, routing_region TEXT NOT NULL,
                    fetched_at TEXT NOT NULL, payload_json TEXT NOT NULL
                );
                CREATE TABLE match_quality(
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    account TEXT NOT NULL, match_id TEXT NOT NULL
                );
                CREATE TABLE match_participants(
                    match_id TEXT NOT NULL, puuid TEXT NOT NULL, riot_id TEXT NOT NULL,
                    team_id INTEGER NOT NULL DEFAULT 0, win INTEGER NOT NULL DEFAULT 0,
                    champion TEXT NOT NULL DEFAULT '', PRIMARY KEY(match_id,puuid)
                );
            """)
            connection.executemany(
                "INSERT INTO match_quality(account,match_id) VALUES(?,?)",
                [("Player#EUW", "M1"), ("Player#EUW", "M1")],
            )
            connection.executemany(
                "INSERT INTO match_participants(match_id,puuid,riot_id,team_id,win,champion) VALUES(?,?,?,?,?,?)",
                [
                    ("M1", "old-puuid", "Player#EUW", 100, 1, "Vi"),
                    ("M1", "new-puuid", "Ｐｌａｙｅｒ#euw", 100, 1, "Vi"),
                ],
            )
            connection.commit()

            migrated = migrate_ingestion_schema(connection)

            self.assertEqual(migrated["deduplicated_matches"], 1)
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM match_quality").fetchone()[0], 1)
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM match_participants").fetchone()[0], 1)
            columns = {row["name"] for row in connection.execute("PRAGMA table_info(match_participants)")}
            self.assertIn("participant_id", columns)
            self.assertIn("normalized_riot_id", columns)
            with self.assertRaises(sqlite3.IntegrityError):
                connection.execute(
                    "INSERT INTO match_quality(account,match_id) VALUES(?,?)",
                    ("Player#EUW", "M1"),
                )
            connection.close()


if __name__ == "__main__":
    unittest.main()
