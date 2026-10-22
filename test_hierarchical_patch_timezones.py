"""Public Python validator dates must select patches by exact UTC instant.

These owned in-memory observations exercise aware non-UTC callers. The CLI
loader already normalizes UTC and is not the affected entry point.
"""
from copy import deepcopy
from dataclasses import asdict, replace
from datetime import datetime, timedelta, timezone
import json
import math

import pytest

from validate_algorithm_settings import Observation, validate_observations
from validate_hierarchical_champion_model import replay_fold, validate


def observations(first_at: datetime, second_at: datetime) -> list[Observation]:
    """Unequal champion sample sizes make the prediction's patch observable."""
    rows = []
    for champion, count, first_wins, second_wins in (
        ("Ahri", 2, 0, 2),
        ("Lux", 12, 12, 0),
    ):
        for instant, patch, wins in (
            (first_at, "16.1", first_wins),
            (second_at, "16.2", second_wins),
        ):
            for index in range(count):
                rows.append(Observation(
                    "A", "A", f"{champion}-{patch}-{index}", instant,
                    "MIDDLE", champion, int(index < wins), patch,
                ))
    rows.append(Observation(
        "A", "A", "holdout", datetime(first_at.year, 3, 2, tzinfo=timezone.utc),
        "MIDDLE", "Ahri", 1, "16.2",
    ))
    return rows


def raw_snapshot(rows: list[Observation]) -> list[dict]:
    # Datetime equality alone would miss an in-place rewrite of an offset.
    return [dict(asdict(row), occurred_at=row.occurred_at.isoformat()) for row in rows]


def utc_rows(rows: list[Observation]) -> list[Observation]:
    return [replace(row, occurred_at=row.occurred_at.astimezone(timezone.utc)) for row in rows]


def replay_pair(rows: list[Observation]) -> tuple[dict, dict]:
    normalized = utc_rows(rows)
    raw_before, utc_before = raw_snapshot(rows), raw_snapshot(normalized)
    validate_observations(rows)
    validate_observations(normalized)
    start = datetime(rows[-1].occurred_at.year, 3, 1, tzinfo=timezone.utc)
    end = datetime(start.year, 4, 1, tzinfo=timezone.utc)

    raw = replay_fold(rows, start, end, "owned-offset-fold")
    canonical = replay_fold(normalized, start, end, "owned-offset-fold")

    assert raw_snapshot(rows) == raw_before
    assert raw_snapshot(normalized) == utc_before
    for fold in (raw, canonical):
        assert fold["training_observations"] == fold["training_unique_matches"] == 28
        assert fold["holdout_observations"] == fold["holdout_unique_matches"] == 1
        assert fold["match_ids_separated"] is True
        assert set(fold["scores"]) == {
            "hierarchical", "current_champion_beta", "account_rate", "constant_0_5",
        }
        assert set(fold["top_picks"]) == {"hierarchical", "current_champion_beta"}
        diagnostics = fold["fit_diagnostics"]
        assert diagnostics["converged"] is True
        assert diagnostics["empty_sample"] is False
        assert 0 < diagnostics["iterations"] <= diagnostics["iteration_limit"]
        assert math.isfinite(diagnostics["gradient_max_abs"])
        json.dumps(fold, allow_nan=False)
    # A patch-selection fix must not alter held-out prediction scores or fitting.
    assert {key: value for key, value in raw.items() if key != "top_picks"} == {
        key: value for key, value in canonical.items() if key != "top_picks"
    }
    assert raw["top_picks"]["current_champion_beta"] == canonical["top_picks"]["current_champion_beta"]
    assert canonical["top_picks"]["current_champion_beta"]["coverage"] == 0
    return raw, canonical


def assert_hierarchical_selection(fold: dict, selected: bool) -> None:
    assert fold["top_picks"]["hierarchical"] == {
        "observations": int(selected),
        "unique_matches": int(selected),
        "accounts": int(selected),
        "holdout_win_rate": 1.0 if selected else None,
        "training_account_win_rate": 0.5 if selected else None,
        "coverage": float(selected),
    }


@pytest.mark.parametrize(
    "older_text,newer_text,elapsed",
    [
        pytest.param(
            "2026-02-20T14:00:00+02:00", "2026-02-20T12:30:00+00:00",
            timedelta(minutes=30), id="offset-reverses-lexical-order",
        ),
        pytest.param(
            "1600-02-20T13:00:00.000001+01:00", "1600-02-20T12:00:00.000002+00:00",
            timedelta(microseconds=1), id="past-year-one-microsecond",
        ),
        pytest.param(
            "2026-02-20T12:00:00+00:00", "2026-02-20T12:30:00+00:00",
            timedelta(minutes=30), id="ordinary-utc-control",
        ),
    ],
)
def test_replay_latest_patch_is_independent_of_offset_spelling(older_text, newer_text, elapsed):
    older, newer = datetime.fromisoformat(older_text), datetime.fromisoformat(newer_text)
    assert newer - older == elapsed
    raw, canonical = replay_pair(observations(older, newer))

    assert_hierarchical_selection(canonical, True)
    assert raw["top_picks"] == canonical["top_picks"]


@pytest.mark.parametrize("first_patch", ["16.1", "16.2"])
def test_replay_equal_instants_keep_first_input_patch_as_utc_does(first_patch):
    first = datetime.fromisoformat("2026-02-20T12:00:00+00:00")
    second = datetime.fromisoformat("2026-02-20T14:00:00+02:00")
    assert first == second
    rows = observations(first, second)
    if first_patch == "16.2":
        # Keep each match and outcome intact; only change first encounter order.
        rows = [row for row in rows[:-1] if row.patch == "16.2"] + [
            row for row in rows[:-1] if row.patch == "16.1"
        ] + rows[-1:]
    raw, canonical = replay_pair(rows)

    assert rows[0].patch == first_patch
    assert_hierarchical_selection(canonical, first_patch == "16.2")
    assert raw["top_picks"] == canonical["top_picks"]


def test_public_validate_preserves_scores_gates_and_shape_with_offset_invariant_top_picks():
    rows = observations(
        datetime.fromisoformat("2026-02-20T14:00:00+02:00"),
        datetime.fromisoformat("2026-02-20T12:30:00+00:00"),
    )
    normalized = utc_rows(rows)
    raw_before, utc_before = raw_snapshot(rows), raw_snapshot(normalized)
    arguments = dict(
        selection_start="2026-03-01", selection_end="2026-04-01",
        final_start="2026-04-01", final_end="2026-05-01",
    )
    raw = validate(rows, **arguments)
    canonical = validate(normalized, **arguments)

    assert raw_snapshot(rows) == raw_before
    assert raw_snapshot(normalized) == utc_before
    for report in (raw, canonical):
        assert set(report) == {
            "protocol", "folds", "promotion_gates", "solver_diagnostics",
            "validated", "status", "limits",
        }
        assert len(report["folds"]) == 2
        selection, final = report["folds"]
        assert selection["training_observations"] == 28
        assert selection["holdout_observations"] == 1
        assert final["training_observations"] == 29
        assert final["holdout_observations"] == 0
        assert final["skipped"] == "training or holdout is empty"
        assert report["protocol"]["causal_claim"] is False
        assert report["validated"] is False
        assert report["status"] == "exploratory"
        assert report["solver_diagnostics"]["evaluated_folds"] == 1
        assert report["solver_diagnostics"]["converged_folds"] == 1
        assert report["solver_diagnostics"]["diagnostic_only"] is True
        assert report["solver_diagnostics"]["changes_active_model_validation"] is False
        assert all(not passed for checks in report["promotion_gates"].values() for passed in checks.values())
        json.dumps(report, allow_nan=False)
    projected_raw, projected_utc = deepcopy(raw), deepcopy(canonical)
    for report in (projected_raw, projected_utc):
        for fold in report["folds"]:
            fold.pop("top_picks", None)
    assert projected_raw == projected_utc
    assert_hierarchical_selection(canonical["folds"][0], True)
    assert raw["folds"][0]["top_picks"] == canonical["folds"][0]["top_picks"]
