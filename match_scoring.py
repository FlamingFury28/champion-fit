"""Shared match-evidence scoring rules.

The loss weight is an attribution prior, not a literal probability that a
teammate was AFK.  A short loss is weak evidence against the champion because
the game may have ended before the champion had enough time to influence it.
Explicit match signals then reduce that duration prior further.
"""

from __future__ import annotations


LOSS_WEIGHT_MODEL_VERSION = "duration_bands_v2"

# These are the calibrated duration bands used by the previous Champion Fit
# analysis.  They are deliberately much less aggressive than treating every
# match below/above 20 minutes as the same class.  The bands also match the
# duration histogram supplied with the project: the bulk of games is around
# 25-35 minutes, while sub-15 minute games are a small tail.
DURATION_LOSS_WEIGHTS = (
    (10.0, 0.00),
    (15.0, 0.04),
    (20.0, 0.15),
    (23.0, 0.35),
    (27.0, 0.60),
)
LONG_GAME_LOSS_WEIGHT = 0.88


def duration_loss_weight(duration_minutes: float) -> float:
    """Return the baseline loss attribution for a match duration.

    The value is intentionally stepwise: it is easier to audit than a black
    box fitted curve and preserves the empirically calibrated historical
    policy.  A match shorter than ten minutes is treated as non-informative;
    exactly ten minutes enters the first low-information band.
    """
    try:
        duration = max(float(duration_minutes), 0.0)
    except (TypeError, ValueError):
        duration = 0.0
    for upper_bound, weight in DURATION_LOSS_WEIGHTS:
        if duration < upper_bound:
            return weight
    return LONG_GAME_LOSS_WEIGHT


def loss_attribution_weight(
    duration_minutes: float,
    anomaly_flags: object = "none",
    explicit_afk: bool = False,
    suspected_quasi_afk: bool = False,
    early_surrender: bool = False,
) -> float:
    """Combine the duration prior with observable external-match signals.

    Explicit AFK/griefer evidence removes the loss from champion attribution.
    Weaker signals reduce, rather than erase, the evidence because a surrender
    or team collapse can still follow a genuinely poor champion performance.
    """
    weight = duration_loss_weight(duration_minutes)
    flags = {flag.strip().lower() for flag in str(anomaly_flags or "none").split(";") if flag.strip()}

    if explicit_afk or "explicit_afk_teammate" in flags or "griefer" in flags:
        return 0.0
    if suspected_quasi_afk or "suspected_quasi_afk_teammate" in flags:
        weight *= 0.35
    if early_surrender or "early_surrender" in flags:
        weight *= 0.55
    if "early_team_collapse" in flags:
        weight *= 0.65
    if "surrender" in flags:
        weight *= 0.85
    if "severe_kill_deficit" in flags:
        weight *= 0.85

    return round(max(0.0, min(weight, 1.0)), 3)
