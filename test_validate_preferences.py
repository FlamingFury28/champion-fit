import sqlite3
from dataclasses import replace
from datetime import datetime, timedelta, timezone

from validate_preferences import (
    Observation,
    build_report,
    load_observations,
    replay_preferences,
    summarize_events,
)


def observation(index, champion, *, account="Player#EUW", identity="identity-1",
                role="MIDDLE", queue="420", at=None):
    return Observation(
        account=account,
        identity_group=identity,
        match_id=f"EUW1_{index}",
        occurred_at=at or datetime(2026, 1, 1, tzinfo=timezone.utc) + timedelta(days=index),
        patch="16.1",
        queue=queue,
        champion=champion,
        role=role,
        duration_minutes=30.0,
        win=index % 2,
    )


def frequency_builder(calls):
    def builder(rows, lifetime_rows, accounts, role, *, feedback=None, limit=6,
                recent_games=20, catalog=None, trial_budget=3,
                include_performance=True):
        calls.append({
            "rows": [dict(row) for row in rows],
            "lifetime_rows": [dict(row) for row in lifetime_rows],
            "accounts": list(accounts),
            "role": role,
            "feedback": feedback,
            "include_performance": include_performance,
        })
        counts = {}
        for row in rows:
            counts[row["champion"]] = counts.get(row["champion"], 0) + 1
        ranked = sorted(counts, key=lambda champion: (-counts[champion], champion))[:limit]
        known = [{"champion": champion, "performance": None} for champion in ranked]
        discover = [{"champion": "Aatrox", "performance": None}]
        items = ([{"champion": ranked[0]}] if ranked and trial_budget else [])
        return {
            "profile": [],
            "known": known,
            "discover": discover,
            "trial_plan": {"budget": len(items), "items": items},
        }
    return builder


def make_database(path, champions):
    connection = sqlite3.connect(path)
    connection.executescript(
        """
        CREATE TABLE match_quality(
          id INTEGER PRIMARY KEY, account TEXT, match_id TEXT, date TEXT,
          patch TEXT, queue TEXT, champion TEXT, role TEXT,
          duration_minutes REAL, win INTEGER
        );
        CREATE TABLE riot_match_raw(match_id TEXT, payload_json TEXT);
        """
    )
    for index, champion in enumerate(champions, 1):
        connection.execute(
            "INSERT INTO match_quality VALUES(?,?,?,?,?,?,?,?,?,?)",
            (index, "Player#EUW", f"EUW1_{index}",
             f"2026-01-{index:02d}T12:00:00+00:00", "16.1", "420",
             champion, "MIDDLE", 30, index % 2),
        )
    connection.execute(
        "INSERT INTO riot_match_raw VALUES(?,?)", ("EUW1_secret", '{"sensitive":true}')
    )
    connection.commit()
    connection.close()


def test_replay_uses_only_each_frozen_prefix_and_disables_current_feedback():
    champions = ["Ahri", "Lux", "Ahri", "Syndra", "Ahri", "Lux"] + ["Ahri"] * 15
    rows = [observation(index, champion) for index, champion in enumerate(champions, 1)]
    calls = []

    events, metadata = replay_preferences(rows, builder=frequency_builder(calls))

    assert [len(call["rows"]) for call in calls] == [3, 5, 10, 20]
    assert [len(call["lifetime_rows"]) for call in calls] == [3, 5, 10, 20]
    assert all(call["rows"] == call["lifetime_rows"] for call in calls)
    assert all(call["feedback"] is None for call in calls)
    assert all(call["include_performance"] is False for call in calls)
    assert all(max(row["date"] for row in call["rows"]) < rows[event["prefix"]].occurred_at.isoformat()
               for call, event in zip(calls, events))
    assert [event["prefix"] for event in events] == [3, 5, 10, 20]
    assert metadata["contract_errors"] == {}
    assert metadata["performance_disabled_calls"] == 4


def test_account_role_queue_strata_are_replayed_separately_without_cap():
    rows = []
    for account_number in range(3):
        for queue in ("420", "440"):
            rows.extend(
                observation(
                    index + account_number * 100 + int(queue),
                    "Ahri" if index % 2 else "Lux",
                    account=f"Player{account_number}#EUW",
                    identity=f"identity-{account_number}",
                    queue=queue,
                )
                for index in range(1, 5)
            )
    calls = []

    events, metadata = replay_preferences(
        rows, builder=frequency_builder(calls), prefixes=(3,)
    )

    assert len(events) == 6
    assert len({event["stratum"] for event in events}) == 6
    assert metadata["eligible_strata_by_prefix"] == {"3": 6}
    assert {call["accounts"][0] for call in calls} == {
        "Player0#EUW", "Player1#EUW", "Player2#EUW"
    }
    assert all({row["queue"] for row in call["rows"]} in ({"420"}, {"440"}) for call in calls)


def test_non_strict_time_and_unknown_catalog_target_are_not_scored():
    same_time = datetime(2026, 1, 1, tzinfo=timezone.utc)
    rows = [observation(index, "Ahri", at=same_time) for index in range(1, 5)]
    rows.extend(observation(index + 10, champion, queue="440") for index, champion in enumerate(
        ["Ahri", "Lux", "Ahri", "DefinitelyNotAChampion"], 1
    ))

    events, metadata = replay_preferences(
        rows, builder=frequency_builder([]), prefixes=(3,)
    )

    assert events == []
    assert metadata["skipped_non_strict_timestamp_targets"] == 1
    assert metadata["skipped_unseen_catalog_unknown_targets"] == 1


def test_observed_off_catalog_target_remains_valid_familiar_reuse():
    rows = [
        observation(1, "LocalFutureChampion"), observation(2, "Ahri"),
        observation(3, "LocalFutureChampion"), observation(4, "LocalFutureChampion"),
    ]

    events, metadata = replay_preferences(
        rows, builder=frequency_builder([]), prefixes=(3,)
    )

    assert len(events) == 1
    assert events[0]["familiar_target"] is True
    assert events[0]["known_hit_3"] is True
    assert metadata["skipped_unseen_catalog_unknown_targets"] == 0


def test_controlled_metrics_keep_reuse_discovery_and_baselines_distinct():
    events = [
        {
            "identity_group": "a", "stratum": ("a", "MIDDLE", "420"), "prefix": 3,
            "familiar_target": True, "known_hit_1": True, "known_hit_3": True,
            "discover_hit_3": False, "engine_any_hit_3": True,
            "frequency_hit_3": False, "last_choice_hit_1": True,
            "missing_from_full_output": False, "known_stability_jaccard": None,
            "discover_stability_jaccard": None, "combined_stability_jaccard": None,
            "known_count": 2, "discover_count": 2, "profile_count": 1, "trial_count": 2,
        },
        {
            "identity_group": "b", "stratum": ("b", "TOP", "440"), "prefix": 3,
            "familiar_target": False, "known_hit_1": False, "known_hit_3": False,
            "discover_hit_3": True, "engine_any_hit_3": True,
            "frequency_hit_3": False, "last_choice_hit_1": False,
            "missing_from_full_output": False, "known_stability_jaccard": 0.5,
            "discover_stability_jaccard": 0.25, "combined_stability_jaccard": 1 / 3,
            "known_count": 1, "discover_count": 3, "profile_count": 2, "trial_count": 3,
        },
    ]

    result = summarize_events(events)

    assert result["observed_reuse"]["rate"] == 0.5
    assert result["known"]["hit_at_3_familiar"]["rate"] == 1.0
    assert result["discover"]["coverage_at_3_unseen"]["rate"] == 1.0
    assert result["baselines"]["raw_frequency_hit_at_3_familiar"]["rate"] == 0.0
    assert result["baselines"]["paired_known_vs_frequency"]["net_successes"] == 1
    assert result["next_choice"]["missing_from_full_output"]["rate"] == 0.0


def test_structural_contract_rejects_budget_overlap_and_performance_leak():
    def broken(rows, lifetime_rows, accounts, role, *, feedback=None, limit=6,
               recent_games=20, catalog=None, trial_budget=3,
               include_performance=True):
        item = {"champion": "Ahri", "performance": {"wins": 1}}
        return {
            "known": [item], "discover": [item], "profile": [],
            "trial_plan": {"budget": 4, "items": [
                {"champion": "Ahri"}, {"champion": "Lux"},
                {"champion": "Syndra"}, {"champion": "Orianna"},
            ]},
        }
    rows = [observation(index, "Ahri") for index in range(1, 5)]

    _, metadata = replay_preferences(rows, builder=broken, prefixes=(3,))

    assert metadata["contract_errors"] == {
        "known_discover_overlap": 1,
        "performance_not_disabled": 1,
        "trial_budget_exceeded": 1,
        "trial_item_outside_recommendations": 1,
    }


def test_read_only_loader_deduplicates_canonical_identity_and_never_reads_raw(tmp_path):
    path = tmp_path / "preferences.db"
    connection = sqlite3.connect(path)
    connection.executescript(
        """
        CREATE TABLE match_quality(
          id INTEGER PRIMARY KEY, account TEXT, match_id TEXT, date TEXT,
          patch TEXT, queue TEXT, champion TEXT, role TEXT,
          duration_minutes REAL, win INTEGER
        );
        CREATE TABLE riot_account_identities(identity_id TEXT, account TEXT);
        CREATE TABLE riot_identity_puuids(puuid TEXT, identity_id TEXT);
        CREATE TABLE riot_account_aliases(
          account TEXT, display_riot_id TEXT, normalized_riot_id TEXT, puuid TEXT
        );
        CREATE TABLE riot_match_raw(match_id TEXT, payload_json TEXT);
        """
    )
    connection.execute("INSERT INTO riot_account_identities VALUES('i1','New#EUW')")
    connection.execute("INSERT INTO riot_identity_puuids VALUES('p1','i1')")
    connection.execute("INSERT INTO riot_account_aliases VALUES('Old#EUW','Old#EUW','old#euw','p1')")
    common = ("EUW1_1", "2026-01-01T12:00:00Z", "16.1", "420", "Ahri", "MIDDLE", 30, 1)
    connection.execute("INSERT INTO match_quality VALUES(1,'New#EUW',?,?,?,?,?,?,?,?)", common)
    alias_common = (*common[:3], "Ranked Solo/Duo", *common[4:])
    connection.execute("INSERT INTO match_quality VALUES(2,'Old#EUW',?,?,?,?,?,?,?,?)", alias_common)
    connection.execute("INSERT INTO riot_match_raw VALUES('EUW1_1','secret-payload')")
    connection.commit()
    before = connection.total_changes
    connection.close()

    rows, metadata = load_observations(path)

    assert len(rows) == 1
    assert rows[0].account == "New#EUW"
    assert metadata["duplicate_source_rows_collapsed"] == 1
    assert metadata["raw_json_tables_read"] is False
    reopened = sqlite3.connect(path)
    assert reopened.execute("SELECT payload_json FROM riot_match_raw").fetchone()[0] == "secret-payload"
    assert reopened.total_changes == 0
    reopened.close()
    assert before > 0


def test_actual_engine_low_data_replay_is_structural_not_predictive_certification(tmp_path):
    path = tmp_path / "preferences.db"
    champions = ["Ahri", "Lux", "Ahri", "Syndra", "Ahri", "Lux"] + ["Ahri"] * 15
    make_database(path, champions)

    report = build_report(path)

    assert report["eligibility"]["eligible_strata_by_prefix"] == {
        "3": 1, "5": 1, "10": 1, "20": 1
    }
    assert report["eligibility"]["contract_errors"] == {}
    assert report["decision"]["structural_contract_pass"] is True
    assert report["decision"]["predictive_performance_certified"] is False
    assert report["decision"]["preference_satisfaction_validated"] is False
    assert report["decision"]["causal_benefit_validated"] is False
    assert report["protocol"]["performance_used_for_validation"] is False
    assert report["input"]["raw_json_tables_read"] is False


def test_actual_preference_replay_is_independent_of_raw_outcomes():
    from preference_recommendations import build_recommendations

    champions = ["Ahri", "Lux", "Ahri", "Syndra", "Ahri", "Lux"] + ["Ahri"] * 15
    rows = [observation(index, champion) for index, champion in enumerate(champions, 1)]
    inverted = [replace(row, win=1 - row.win) for row in rows]

    original_events, original_metadata = replay_preferences(rows, builder=build_recommendations)
    inverted_events, inverted_metadata = replay_preferences(inverted, builder=build_recommendations)

    visible_fields = {
        "prefix", "familiar_target", "known_hit_1", "known_hit_3",
        "discover_hit_3", "engine_any_hit_3", "missing_from_full_output",
        "known_count", "discover_count", "profile_count", "trial_count",
    }
    assert [{key: event[key] for key in visible_fields} for event in original_events] == [
        {key: event[key] for key in visible_fields} for event in inverted_events
    ]
    assert original_metadata["contract_errors"] == {}
    assert inverted_metadata["contract_errors"] == {}
