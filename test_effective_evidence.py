"""Focused contracts for the runtime evidence resolver."""

import json
import sqlite3

from effective_evidence import load_effective_evidence, resolve_effective_evidence


def row(**changes):
    value = {
        "account": "Player#EUW", "match_id": "M1", "win": 0, "duration_minutes": 30,
        "explicit_afk": 0, "suspected_quasi_afk": 0, "early_surrender": 0, "allflags": "none",
        "stored_loss_weight": .63, "stored_win_weight": .72,
        "provenance_classification": "known_riot_default", "provenance_overrides_json": "{}",
        "annotation_afk": 0, "annotation_griefer": 0, "annotation_invincible": 0,
    }
    value.update(changes)
    return value


def test_manual_annotations_precede_explicit_ledger_override():
    evidence = resolve_effective_evidence(row(
        annotation_griefer=1,
        provenance_overrides_json=json.dumps({"loss_attribution_weight": .9}),
    ))
    assert evidence["effective_loss_weight"] == evidence["negative_evidence"] == 0
    assert evidence["attribution_source"] == "manual_annotation"
    assert "griefer" in evidence["attribution_reason"]


def test_validated_numeric_ledger_override_preserves_user_weight():
    evidence = resolve_effective_evidence(row(
        provenance_classification="unknown",
        provenance_overrides_json=json.dumps({"loss_attribution_weight": .37}),
    ))
    assert evidence["effective_loss_weight"] == .37
    assert evidence["attribution_source"] == "ledger_override"


def test_unknown_or_malformed_ledger_uses_bounded_archived_weight():
    for provenance in (None, "[]", "not json"):
        evidence = resolve_effective_evidence(row(
            provenance_classification="unknown", provenance_overrides_json=provenance,
            stored_loss_weight=4,
        ))
        assert evidence["effective_loss_weight"] == 0
        assert evidence["attribution_source"] == "archived_fallback"


def test_zero_duration_is_valid_and_uses_current_known_default_policy():
    evidence = resolve_effective_evidence(row(duration_minutes=0, stored_loss_weight=.2))
    assert evidence["effective_loss_weight"] == 1
    assert evidence["attribution_source"] == "configured_model"


def test_model_applies_each_quality_flag_once_and_explicit_afk_sets_configured_weight():
    settings = {"attribution": {
        "duration_bounds": [10, 15], "loss_weights": [.5, .8, 1],
        "quasi_afk_multiplier": .5, "early_surrender_multiplier": .5,
        "team_collapse_multiplier": .5, "surrender_multiplier": .5,
        "kill_deficit_multiplier": .5, "explicit_afk_weight": .1,
    }}
    flagged = resolve_effective_evidence(row(
        duration_minutes=12, suspected_quasi_afk=1,
        allflags="suspected_quasi_afk_teammate;surrender;surrender;severe_kill_deficit",
    ), settings)
    assert flagged["effective_loss_weight"] == .8 * .5 * .5 * .5
    explicit = resolve_effective_evidence(row(explicit_afk=1, allflags="surrender"), settings)
    assert explicit["effective_loss_weight"] == .1


def test_known_default_wins_are_fact_invariant_by_default():
    baseline = resolve_effective_evidence(row(win=1, duration_minutes=35, stored_win_weight=.2))
    changed = resolve_effective_evidence(row(
        win=1, duration_minutes=0, explicit_afk=1, suspected_quasi_afk=1,
        early_surrender=1, allflags="griefer;surrender;severe_kill_deficit", stored_win_weight=0,
    ))
    assert baseline["positive_evidence"] == changed["positive_evidence"] == 1
    assert baseline["negative_evidence"] == changed["negative_evidence"] == 0


def test_negative_veto_is_a_decision_gate_not_an_evidence_rewrite():
    policy = {
        "duration_bounds": [10, 15, 20, 23, 27], "loss_weights": [.2] * 6,
        "contaminated_threshold": .45,
    }
    permitted = resolve_effective_evidence(row(), {"attribution": policy | {"negative_veto": False}})
    vetoed = resolve_effective_evidence(row(), {"attribution": policy | {"negative_veto": True}})
    assert permitted["effective_loss_weight"] == vetoed["effective_loss_weight"] == .2
    assert permitted["negative_evidence"] == vetoed["negative_evidence"] == .2


def test_manual_loss_annotation_does_not_relabel_a_winning_observation():
    evidence = resolve_effective_evidence(row(win=1, annotation_afk=1))
    assert evidence["positive_evidence"] == 1
    assert evidence["attribution_source"] == "configured_model"
    assert "manual annotation" not in evidence["attribution_reason"]


def test_loader_joins_facts_provenance_and_annotations_once():
    connection = sqlite3.connect(":memory:")
    connection.row_factory = sqlite3.Row
    connection.executescript("""
        CREATE TABLE match_quality(account,match_id,duration_minutes,win,explicit_afk,
            suspected_quasi_afk,early_surrender,anomaly_flags,loss_attribution_weight,win_evidence_weight);
        CREATE TABLE match_import_provenance(account,match_id,source,classification,overrides_json);
        CREATE TABLE match_annotations(match_id,afk_player,griefer,invincible);
        INSERT INTO match_quality VALUES('A','M',30,0,0,0,0,'none',.6,0);
        INSERT INTO match_import_provenance VALUES('A','M','riot','known_riot_default','{}');
        INSERT INTO match_annotations VALUES('M',1,0,0);
    """)
    evidence = load_effective_evidence(connection, "m.account=?", ("A",))
    assert evidence[("A", "M")]["attribution_source"] == "manual_annotation"
    assert evidence[("A", "M")]["negative_evidence"] == 0
