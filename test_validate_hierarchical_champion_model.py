import math
from datetime import datetime, timedelta, timezone

from validate_algorithm_settings import Observation
from validate_hierarchical_champion_model import validate


def _observations():
    rows = []
    start = datetime(2025, 12, 1, tzinfo=timezone.utc)
    index = 0
    for day in range(140):
        for account_index, account in enumerate(("A", "B")):
            for pick in range(2):
                index += 1
                champion = "Ahri" if pick == 0 else "Lux"
                win = int((day + account_index + pick) % 3 != 0)
                rows.append(Observation(
                    account, account, f"M{index}", start + timedelta(days=day),
                    "MIDDLE", champion, win, "16.1" if day < 90 else "16.2",
                ))
    return rows


def test_temporal_validation_groups_matches_and_reports_every_required_metric():
    report = validate(
        _observations(), selection_start="2026-03-01", selection_end="2026-04-01",
        final_start="2026-04-01", final_end="2026-05-01",
    )

    assert len(report["folds"]) == 2
    for fold in report["folds"]:
        assert fold["match_ids_separated"]
        assert fold["holdout_unique_matches"] > 0
        assert set(fold["scores"]) == {"hierarchical", "current_champion_beta", "account_rate", "constant_0_5"}
        for model in fold["scores"].values():
            assert math.isfinite(model["match_equal"]["log_loss"])
            assert math.isfinite(model["account_equal"]["brier"])
            assert "calibration_bins" in model
        assert "hierarchical" in fold["top_picks"]
        assert fold["top_picks"]["hierarchical"]["unique_matches"] >= 0
        assert "converged" in fold["fit_diagnostics"]
        assert math.isfinite(fold["fit_diagnostics"]["gradient_max_abs"])
    assert report["protocol"]["shared_match_split"]
    assert report["status"] in {"validated", "exploratory"}
    assert report["solver_diagnostics"]["diagnostic_only"]
    assert not report["solver_diagnostics"]["changes_active_model_validation"]
