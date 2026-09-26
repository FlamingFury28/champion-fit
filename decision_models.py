"""Outcome inference kept separate from subjective match attribution weights.

Every displayed win probability uses the configured independent Beta prior. Context is a
disjoint comparison sample, never pseudo-observations added to the candidate.
Family decisions use unrounded probabilities before display filtering.
"""

from algorithm_settings import current_settings, current_snapshot
from statistical_evidence import apply_family_control, compare_posteriors
from stratified_evidence import stratified_gate_bound, stratified_summary


def raw_counts(item):
    games = max(int(item.get("games", item.get("games_observed", 0)) or 0), 0)
    wins = item.get("wins", item.get("wins_against"))
    if wins is None:
        # Compatibility for callers supplying aggregate evidence only. The
        # production queries always supply actual binary outcome counts.
        wins = item.get("positive_evidence", 0)
    wins = min(max(float(wins or 0), 0.0), games)
    return games, wins, games - wins


def outcome_metrics(item, baseline_rate=.5, *, settings=None):
    settings = current_settings() if settings is None else settings
    evidence_settings = settings["evidence"]
    prior_mean = float(evidence_settings["prior_mean"])
    prior_strength = float(evidence_settings["prior_strength"])
    credible_mass = float(evidence_settings["credible_mass"])
    meaningful_delta = float(evidence_settings["meaningful_delta"])
    games, wins, losses = raw_counts(item)
    baseline_wins = item.get("baseline_wins")
    baseline_losses = item.get("baseline_losses")
    # A zero-size reference cannot establish the player's baseline: use the
    # explicit neutral null, rather than an unobserved Beta as personal data.
    if baseline_wins is not None and baseline_wins + baseline_losses <= 0:
        baseline_wins = baseline_losses = None
        baseline_rate = .5
    if item.get("account_cells") and item.get("accounts"):
        estimate = stratified_summary(
            item["account_cells"], item["accounts"], delta=meaningful_delta,
            prior_mean=prior_mean, prior_strength=prior_strength,
            credible_mass=credible_mass,
        )
        baseline_wins = sum(cell.get("baseline_wins", 0) or 0 for cell in item["account_cells"].values())
        baseline_losses = sum(cell.get("baseline_losses", 0) or 0 for cell in item["account_cells"].values())
    else:
        estimate = compare_posteriors(
            wins, losses, baseline_wins, baseline_losses, delta=meaningful_delta,
            baseline_rate=baseline_rate, prior_mean=prior_mean,
            prior_strength=prior_strength, credible_mass=credible_mass,
        )
    positive = max(float(item.get("positive_evidence") or 0), 0)
    negative = max(float(item.get("negative_evidence") or 0), 0)
    evidence = positive + negative
    direction = "beats" if estimate["mean"] > estimate["baseline_mean"] else (
        "loses_to" if estimate["mean"] < estimate["baseline_mean"] else "neutral"
    )
    snapshot = current_snapshot()
    unique_games = max(int(item.get("unique_games", games) or 0), 0)
    return {
        "games": games, "wins": wins, "losses": losses,
        "unique_games": unique_games,
        "raw_win_rate": round(wins / games * 100, 1) if games else 0.0,
        "posterior_win_rate": round(estimate["mean"] * 100, 1),
        "credible_lower": round(estimate["lower"] * 100, 1),
        "credible_upper": round(estimate["upper"] * 100, 1),
        "credible_lower_90": round(estimate["lower_90"] * 100, 1),
        "credible_upper_90": round(estimate["upper_90"] * 100, 1),
        "credible_mass": credible_mass,
        "baseline_win_rate": round(estimate["baseline_mean"] * 100, 1),
        "baseline_credible_lower": round(estimate["baseline_lower"] * 100, 1),
        "baseline_credible_upper": round(estimate["baseline_upper"] * 100, 1),
        "baseline_credible_lower_90": round(estimate["baseline_lower_90"] * 100, 1),
        "baseline_credible_upper_90": round(estimate["baseline_upper_90"] * 100, 1),
        "baseline_games": int((baseline_wins or 0) + (baseline_losses or 0)),
        "baseline_source": "held_out_scope" if (baseline_wins or 0) + (baseline_losses or 0) > 0 else "neutral_50",
        "posterior_lift_pp": round((estimate["mean"] - estimate["baseline_mean"]) * 100, 1),
        "relative_delta_pp": round((estimate["mean"] - estimate["baseline_mean"]) * 100, 1),
        "probability_meaningful_advantage": round(estimate["prob_above"] * 100, 3),
        "probability_meaningful_disadvantage": round(estimate["prob_below"] * 100, 3),
        "probability_worse_than_baseline": round(estimate.get("prob_direction_below", 1 - estimate.get("prob_direction_above", .5)) * 100, 1),
        "direction_probability": round(estimate["direction_probability"] * 100, 1),
        "direction_confidence": round(estimate["direction_probability"] * 100, 1),
        "signal_probability": max(estimate["prob_above"], estimate["prob_below"]),
        "advantage_probability": estimate["prob_above"],
        "disadvantage_probability": estimate["prob_below"],
        "recommendation": direction,
        "personal_effective_sample_size": games,
        "effective_sample_size": games,
        "supporting_effective_sample_size": games,
        "positive_evidence": round(positive, 2), "negative_evidence": round(negative, 2),
        "effective_evidence": round(evidence, 2),
        "weighted_win_rate_against": round(positive / evidence * 100, 1) if evidence else 50.0,
        "quality_coverage": round(min(evidence / max(games, 1), 1) * 100, 1),
        "prior_source": "neutral_50" if prior_mean == .5 else "configured_prior",
        "prior_games": 0,
        "prior_mean": round(prior_mean * 100, 3), "prior_strength": prior_strength,
        "meaningful_delta": meaningful_delta,
        "actionable": False, "statistical_actionable": False,
        "attribution_conflict": False, "attribution_veto_applied": False,
        "reliability": "exploratory",
        "statistical_model": "raw_outcome_beta",
        "algorithm_revision": snapshot["revision"],
        "algorithm_fingerprint": snapshot["fingerprint"],
        "probability_method": estimate.get("probmethod", "exact_single_sample"),
        "probabilities_are_lower_bounds": estimate.get("probabilities_are_lower_bounds", False),
        "account_count": estimate.get("account_count", 1),
        "observed_account_count": estimate.get("observed_account_count", 1),
        "missing_accounts": estimate.get("missing_accounts", []),
        "missing_baseline_accounts": estimate.get("missing_baseline_accounts", []),
        "account_weighting": estimate.get("account_weighting", "single"),
    }


def control_decisions(items, probability_key="signal_probability", attribution_gate=False,
                      *, settings=None):
    settings = current_settings() if settings is None else settings
    evidence_settings = settings["evidence"]
    prior_mean = float(evidence_settings["prior_mean"])
    prior_strength = float(evidence_settings["prior_strength"])
    credible_mass = float(evidence_settings["credible_mass"])
    delta = float(evidence_settings["meaningful_delta"])
    family_alpha = float(evidence_settings["family_alpha"])
    min_games = float(evidence_settings["min_games"])
    threshold = 1 - family_alpha / (2 * max(len(items), 1))
    for item in items:
        if item.get("account_cells") and item.get("accounts") and item.get("probabilities_are_lower_bounds"):
            bound = stratified_gate_bound(
                item["account_cells"], item["accounts"], threshold, delta=delta,
                prior_mean=prior_mean, prior_strength=prior_strength,
                credible_mass=credible_mass,
            )
            item["advantage_probability"] = max(item["advantage_probability"], bound["above_probability_bound"])
            item["disadvantage_probability"] = max(item["disadvantage_probability"], bound["below_probability_bound"])
            item["signal_probability"] = max(item["advantage_probability"], item["disadvantage_probability"])
            item["probability_meaningful_advantage"] = round(item["advantage_probability"] * 100, 3)
            item["probability_meaningful_disadvantage"] = round(item["disadvantage_probability"] * 100, 3)
            item["direction_probability"] = max(item["direction_probability"], item["signal_probability"] * 100)
            item["direction_confidence"] = item["direction_probability"]
            item["probability_worse_than_baseline"] = max(item["probability_worse_than_baseline"], item["disadvantage_probability"] * 100)
    for item in items:
        item["decision_games"] = max(float(item.get("unique_games", item["games"]) or 0), 0.0)
    apply_family_control(
        items, probability_key=probability_key, output_key="statistical_actionable",
        min_games=min_games, alpha=family_alpha, games_key="decision_games",
    )
    negative_veto = bool(settings.get("attribution", {}).get("negative_veto", False))
    for item in items:
        if item.get("missing_accounts") or item.get("missing_baseline_accounts"):
            item["statistical_actionable"] = False
        item["relative_actionable"] = bool(item["statistical_actionable"])
        conflict = item["recommendation"] == "loses_to" and item["negative_evidence"] <= 0
        item["attribution_conflict"] = conflict
        item["attribution_veto_applied"] = bool(attribution_gate and negative_veto and conflict)
        item["actionable"] = bool(item["statistical_actionable"] and not item["attribution_veto_applied"])
        games = item["decision_games"]
        display_min = float(evidence_settings["display_min_games"])
        indicative = float(evidence_settings["indicative_games"])
        item["reliability"] = ("reliable" if item["actionable"] else
                               "exploratory" if games < display_min else
                               "weak" if games < indicative else "indicative")
        # Only the UI threshold is expressed as a percentage. Internal signal
        # probabilities remain unrounded fractions for reproducible decisions.
        item["decision_threshold"] *= 100
    return items


def candidate_metrics(candidates, *, settings=None):
    settings = current_settings() if settings is None else settings
    totals = {}
    for item in candidates:
        _, wins, losses = raw_counts(item)
        total = totals.setdefault(item["role"], [0.0, 0.0])
        total[0] += wins
        total[1] += losses
    evaluated = []
    for item in candidates:
        _, wins, losses = raw_counts(item)
        total = totals[item["role"]]
        evaluated.append(item | outcome_metrics(item | {
            "baseline_wins": max(total[0] - wins, 0),
            "baseline_losses": max(total[1] - losses, 0),
        }, settings=settings))
    return evaluated


def rank_recommendations(candidates, limit=None):
    settings = current_settings()
    evidence_settings = settings["evidence"]
    limit = int(evidence_settings["recommendation_limit"] if limit is None else limit)
    display_min_games = int(evidence_settings["display_min_games"])
    min_games = int(evidence_settings["min_games"])
    credible_mass = float(evidence_settings["credible_mass"])
    prior_mean = float(evidence_settings["prior_mean"])
    prior_strength = float(evidence_settings["prior_strength"])
    delta_pp = float(evidence_settings["meaningful_delta"]) * 100.0
    evaluated = control_decisions(
        candidate_metrics(candidates, settings=settings), "advantage_probability",
        settings=settings,
    )
    ranked = []
    for item in evaluated:
        games = item["decision_games"]
        if games < display_min_games:
            continue
        lower, upper = item["credible_lower"], item["credible_upper"]
        uncertainty = "low" if item["actionable"] else "high" if games < min_games else "medium"
        reasons = [] if item["actionable"] else [
            f"Evidenza insufficiente per un vantaggio di almeno {delta_pp:g} punti sul riferimento, "
            "dopo il controllo dei confronti e della numerosità personale."
        ]
        if item.get("excluded_games"):
            reasons.append(f"{item['excluded_games']} partite escluse dalla sola attribuzione pesata, presenti nei conteggi grezzi.")
        if item.get("discounted_games"):
            reasons.append(f"{item['discounted_games']} partite con peso ridotto nella sola attribuzione, presenti nei conteggi grezzi.")
        if item.get("missing_accounts"):
            reasons.append("Mancano partite di questo campione per alcuni account selezionati: la stima resta esplorativa.")
        if item.get("missing_baseline_accounts"):
            reasons.append("Manca il confronto complementare per alcuni account selezionati: la stima resta esplorativa.")
        cells = item.get("account_cells", {})
        accounts = item.get("accounts", [])
        prior_share = (sum(prior_strength / (prior_strength + sum(cells.get(account, {}).get(k, 0) for k in ("wins", "losses"))) for account in accounts)
                       / len(accounts) * 100) if cells and accounts else prior_strength / (prior_strength + games) * 100
        item.update({
            "score": lower, "posterior_fit": item["posterior_win_rate"],
            "confidence": "sufficiente" if item["actionable"] else "da confermare",
            "reason": f"{games:g} game · vittoria stimata {item['posterior_win_rate']:.1f}% · intervallo {credible_mass * 100:g}% {lower:.1f}–{upper:.1f}%.",
            "explanation": {
                "positive_evidence": item["positive_evidence"],
                "negative_evidence": item["negative_evidence"],
                "prior_fit": round(prior_mean * 100, 3), "prior_evidence": prior_strength,
                "prior_share": round(prior_share, 1),
                "uncertainty_width": round(upper - lower, 1),
                "credible_mass": credible_mass,
                "uncertainty_width_90": round(item["credible_upper_90"] - item["credible_lower_90"], 1),
                "uncertainty_level": uncertainty,
                "uncertainty_reasons": reasons,
                "summary": (
                    f"La stima usa vittorie e sconfitte osservate e un prior indipendente con media {prior_mean * 100:g}% e forza {prior_strength:g}. "
                    "Gli account selezionati hanno uguale peso, costante fra i candidati. "
                    "Il riferimento usa le altre partite dello stesso ruolo e account nel filtro attivo, con la loro incertezza; "
                    "in assenza di altre partite il riferimento è il 50%. I pesi mostrati nell'audit descrivono "
                    f"l'attribuzione e non sono conteggi di vittorie. L'intervallo {credible_mass * 100:g}% descrive la stima; "
                    "la decisione usa una soglia più severa per tutti i confronti. "
                    "Con più account, intervalli e probabilità sono limiti conservativi; "
                    "la probabilità mostrata è un limite inferiore, non una probabilità puntuale."
                ),
                "next_step": "Confronta il risultato con nuove partite dello stesso ruolo e contesto prima di cambiare il pool."
                    if not item["actionable"] else "Verifica le partite di supporto e rivaluta il vantaggio dopo il prossimo ciclo.",
            },
        })
        ranked.append(item)
    ranked.sort(key=lambda x: (-int(x["actionable"]), -x["score"], -x["posterior_fit"], -x["games"], x["champion"], x["role"]))
    chosen, seen = [], set()
    for item in ranked:
        if item["champion"] in seen:
            continue
        item.pop("account_cells", None)
        seen.add(item["champion"])
        chosen.append(item)
        if len(chosen) >= limit:
            break
    return chosen
