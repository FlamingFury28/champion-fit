#!/usr/bin/env python3
"""Serve the production build against a disposable synthetic SQLite fixture."""

from __future__ import annotations

import sqlite3
import os
import sys
import tempfile
from functools import partial
from http.server import ThreadingHTTPServer
from pathlib import Path


FRONTEND_ROOT = Path(__file__).resolve().parents[1]
PROJECT_ROOT = FRONTEND_ROOT.parent
sys.path.insert(0, str(PROJECT_ROOT))

import app  # noqa: E402
from storage import SQLiteStorage  # noqa: E402


CHAMPIONS = {
    "Ahri": "https://ddragon.leagueoflegends.com/cdn/16.13.1/img/champion/Ahri.png",
    "Garen": "https://ddragon.leagueoflegends.com/cdn/16.13.1/img/champion/Garen.png",
    "Lux": "https://ddragon.leagueoflegends.com/cdn/16.13.1/img/champion/Lux.png",
    "Annie": "https://ddragon.leagueoflegends.com/cdn/16.13.1/img/champion/Annie.png",
    "Zed": "https://ddragon.leagueoflegends.com/cdn/16.13.1/img/champion/Zed.png",
}


def seed(database_path: Path) -> SQLiteStorage:
    storage = SQLiteStorage(database_path, PROJECT_ROOT / "schema.sql")
    storage.initialize()
    connection = sqlite3.connect(database_path)
    try:
        connection.execute("PRAGMA foreign_keys=ON")
        connection.executemany(
            "INSERT INTO champions(champion,asset_id,icon_url) VALUES(?,?,?)",
            [(name, name, url) for name, url in CHAMPIONS.items()],
        )
        connection.executemany(
            "INSERT INTO source_metadata(key,value) VALUES(?,?)",
            [("window", "fixture E2E · 2026-08-24"), ("source", "synthetic")],
        )
        fit_rows = [
            ("global", "MIDDLE", "Ahri", 24, 15, 9, .625, 14.2, 7.1, 21.3, 68.4, 12.3, .684, .53, .81, .28, .82, 2, "Alpha#EUW,Beta#EUW", 10, 1, 0, 0, "none", "", .62),
            ("global", "TOP", "Garen", 20, 7, 13, .35, 6.5, 11.8, 18.3, 39.2, -9.4, .392, .27, .52, .25, .18, 1, "Beta#EUW", 8, 0, 1, 0, "strong", "Fit conservativo sotto soglia.", .31),
            ("global", "SUPPORT", "Lux", 12, 6, 6, .5, 5.8, 5.2, 11.0, 52.1, 1.8, .521, .36, .68, .32, .55, 1, "Alpha#EUW", 4, 0, 0, 1, "provisional", "Evidenza ancora instabile.", .78),
        ]
        connection.executemany(
            """INSERT INTO champion_fit(scope,role,champion,games_observed,wins,losses,raw_win_rate,
            positive_evidence,informative_losses_equivalent,effective_sample_size,account_adjusted_fit_score,
            fit_delta_vs_account_baseline_pp,posterior_fit_probability,credible_lower_90,credible_upper_90,
            uncertainty_width_90,probability_above_high_fit_threshold,accounts_played,accounts,recent_90d_games,
            validated_positive,blacklist_strong,blacklist_provisional,blacklist_tier,blacklist_reason,value_of_information)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            fit_rows,
        )
        connection.executemany(
            """INSERT INTO test_plan(role,champion,allocated_games,candidate_type,starting_effective_sample_size,
            account_adjusted_fit_score,probability_high_fit,base_value_of_information,quantitative_rationale)
            VALUES(?,?,?,?,?,?,?,?,?)""",
            [
                ("MIDDLE", "Ahri", 220, "validated", 21.3, 68.4, .82, .62, "Confermare il segnale su più patch."),
                ("SUPPORT", "Lux", 180, "uncertain", 11, 52.1, .55, .78, "Ridurre l’ampiezza dell’intervallo."),
            ],
        )
        connection.executemany(
            "INSERT INTO blacklist(role,champion,tier,reason) VALUES(?,?,?,?)",
            [("TOP", "Garen", "strong", "Fit conservativo sotto soglia."), ("SUPPORT", "Lux", "provisional", "Evidenza ancora instabile.")],
        )
        connection.executemany(
            """INSERT INTO screening_candidates(role,champion,observed_role_games,matched_tags,theoretical_fit_prior,
            profile_tag_signal,classification,reason) VALUES(?,?,?,?,?,?,?,?)""",
            [
                ("MIDDLE", "Annie", 0, "burst, controllo", .71, .66, "high-prior", "Profilo coerente con controllo e burst."),
                ("MIDDLE", "Zed", 0, "assassin, mobilità", .58, .49, "explore", "Prior teorico da verificare."),
            ],
        )
        connection.executemany(
            "INSERT INTO tracked_account_puuids(puuid,account) VALUES(?,?)",
            [("puuid-alpha", "Alpha#EUW"), ("puuid-beta", "Beta#EUW")],
        )
        matches = [
            ("Alpha#EUW", "EUW1-001", "2026-08-22T20:00:00Z", "16.16", "RANKED_SOLO_5x5", "Ahri", "MIDDLE", "puuid", 31.4, 1, 0, 0, 0, "", .94, .88, 1.0, "Partita standard."),
            ("Alpha#EUW", "EUW1-002", "2026-08-21T20:00:00Z", "16.16", "RANKED_SOLO_5x5", "Ahri", "MIDDLE", "puuid", 18.2, 0, 1, 0, 1, "early_surrender,afk", .31, .08, 0.0, "AFK esplicito e resa anticipata."),
            ("Alpha#EUW", "EUW1-003", "2026-08-20T20:00:00Z", "16.16", "RANKED_SOLO_5x5", "Lux", "SUPPORT", "puuid", 29.8, 1, 0, 0, 0, "", .86, .82, 1.0, "Partita standard."),
            ("Alpha#EUW", "EUW1-004", "2026-08-19T20:00:00Z", "16.16", "RANKED_SOLO_5x5", "Ahri", "MIDDLE", "puuid", 27.4, 1, 0, 0, 0, "", .81, .75, 1.0, "Vittoria ad alta qualità."),
            ("Beta#EUW", "EUW1-005", "2026-08-18T20:00:00Z", "16.16", "RANKED_FLEX_SR", "Garen", "TOP", "puuid", 33.0, 0, 0, 0, 0, "", .72, .66, 0.0, "Loss attribuibile."),
            ("Beta#EUW", "EUW1-006", "2026-08-17T20:00:00Z", "16.16", "RANKED_FLEX_SR", "Ahri", "MIDDLE", "puuid", 30.0, 1, 0, 0, 0, "", .89, .84, 1.0, "Vittoria standard."),
        ]
        connection.executemany(
            """INSERT INTO match_quality(account,match_id,date,patch,queue,champion,role,identity_resolution,
            duration_minutes,win,explicit_afk,suspected_quasi_afk,early_surrender,anomaly_flags,
            match_quality_score,loss_attribution_weight,win_evidence_weight,reason)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            matches,
        )
        participants = []
        for index, match in enumerate(matches, start=1):
            account, match_id, *_ = match
            owner = "puuid-alpha" if account == "Alpha#EUW" else "puuid-beta"
            participants.extend([
                (match_id, owner, account, 100, int(match[9]), match[5]),
                (match_id, f"friend-{index}", "DuoFriend#EUW", 100, int(match[9]), "Lux"),
                (match_id, f"opponent-{index}", f"Opponent{index}#EUW", 200, int(not match[9]), "Annie" if index % 2 else "Zed"),
            ])
        participants.append(("EUW1-001", "puuid-beta", "Beta#EUW", 100, 1, "Garen"))
        connection.executemany(
            "INSERT INTO match_participants(match_id,puuid,riot_id,team_id,win,champion) VALUES(?,?,?,?,?,?)",
            participants,
        )
        connection.execute(
            """INSERT INTO match_annotations(match_id,invincible,carryable_loss,afk_player,griefer,
            team_collapse,manual_label,note,confidence,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)""",
            ("EUW1-002", 0, 1, 1, 0, 1, "team issue", "Fixture annotation", .8, "2026-08-22T10:00:00Z"),
        )
        connection.execute("INSERT INTO friend_groups(name) VALUES(?)", ("Duo storico",))
        group_id = connection.execute("SELECT id FROM friend_groups WHERE name=?", ("Duo storico",)).fetchone()[0]
        connection.execute("INSERT INTO friend_group_aliases(group_id,alias) VALUES(?,?)", (group_id, "DuoFriend#EUW"))
        connection.commit()
    finally:
        connection.close()
    return storage


def main() -> None:
    dist = Path(os.environ.get("CHAMPION_FIT_E2E_DIST", str(FRONTEND_ROOT / "dist"))).resolve()
    if not (dist / "index.html").is_file():
        raise SystemExit("frontend/dist mancante: esegui npm run build")
    with tempfile.TemporaryDirectory(prefix="champion-fit-e2e-") as temp:
        temp_path = Path(temp)
        app.STORAGE = seed(temp_path / "fixture.db")
        app.DB_PATH = temp_path / "fixture.db"
        app.APP_ROOT = temp_path
        handler = partial(app.DashboardHandler, directory=dist)
        port = int(os.environ.get("CHAMPION_FIT_E2E_PORT", "18787"))
        host = os.environ.get("CHAMPION_FIT_E2E_HOST", "127.0.0.1")
        server = ThreadingHTTPServer((host, port), handler)
        print(f"Champion Fit E2E: http://{host}:{port}", flush=True)
        try:
            server.serve_forever()
        finally:
            server.server_close()


if __name__ == "__main__":
    main()
