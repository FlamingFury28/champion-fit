"""Descriptive playstyle associations. Raw outcomes; fixed, equal account weights.

Taxonomy families overlap, so every contrast is built from match IDs instead of
subtracting summed tag totals. Search and display order never enter inference.
"""
from __future__ import annotations

from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
import math

from algorithm_settings import current_settings
from champion_taxonomy import canonical_champion, champion_categories, champion_entry, load_catalog
from observed_performance import observed_performance

VERSION = "playstyles_raw_binomial_configurable_v3"
ROLES = ("TOP", "JUNGLE", "MIDDLE", "BOTTOM", "SUPPORT")
QUEUE_LABELS = {"400": "Normale Draft", "420": "Classificata Solo/Duo", "430": "Normale Blind",
                "440": "Classificata Flex", "480": "Swiftplay", "490": "Quickplay", "700": "Clash"}
QUEUE_ALIASES = {"NORMALDRAFT": "400", "NORMAL_DRAFT": "400", "DRAFTPICK": "400",
                 "RANKEDSOLO": "420", "RANKEDSOLO/DUO": "420", "RANKED_SOLO_5X5": "420",
                 "RANKEDFLEX": "440", "RANKED_FLEX_SR": "440", "NORMALBLIND": "430",
                 "NORMAL_BLIND": "430", "NORMAL_BLIND_PICK": "430", "BLINDPICK": "430",
                 "QUICKPLAY": "490", "NORMALQUICKPLAY": "490", "NORMAL_QUICKPLAY": "490"}
METRICS = (("farm", "Farm", "CS/min"), ("vision", "Visione", "punti/min"),
           ("participation", "Partecipazione", "% kill squadra"), ("turrets", "Danni alle torri", "danni/min"))


def canonical_queue(value):
    key = str(value or "").strip().upper().replace(" ", "")
    return QUEUE_ALIASES.get(key, key[5:] if key.startswith("QUEUE") else key)


def deduplicate(rows):
    """Stable account/match deduplication; aliases share champion identity."""
    result = {}
    for source in rows:
        row = dict(source)
        key = (str(row["account"]), str(row["match_id"]))
        row.update(account=key[0], match_id=key[1], champion=canonical_champion(row["champion"]),
                   queue=canonical_queue(row.get("queue")))
        if key in result:
            conflict_fields = (
                "win", "champion", "role", "queue", "date", "duration_minutes",
                "metrics_duration_minutes", *(metric for metric, _, _ in METRICS),
            )
            conflicts = [field for field in conflict_fields if result[key].get(field) != row.get(field)]
            if conflicts:
                raise ValueError(
                    f"Duplicato account/partita in conflitto: {key[0]}/{key[1]} "
                    f"({', '.join(conflicts)})."
                )
            continue
        result[key] = row
    return list(result.values())


def resolve_filters(rows, params, now=None):
    settings = current_settings()
    default_days = str(settings["context"]["days"])
    default_queue = canonical_queue(settings["context"]["queue"])
    days = str(params.get("days", [default_days])[0]).strip().lower()
    if days != "all":
        try:
            numeric_days = int(days)
        except (TypeError, ValueError) as error:
            raise ValueError("Periodo non valido: usa un numero positivo di giorni oppure all.") from error
        if numeric_days < 1:
            raise ValueError("Periodo non valido: usa un numero positivo di giorni oppure all.")
        days = str(numeric_days)
    role = str(params.get("role", [""])[0]).strip().upper()
    raw_queue = str(params.get("queue", [default_queue])[0]).strip()
    queue = "all" if raw_queue.casefold() == "all" else canonical_queue(raw_queue)
    if role and role not in {"ALL", *ROLES}:
        raise ValueError("Ruolo non valido.")
    now = now or datetime.now(timezone.utc)
    cutoff = None if days == "all" else (now - timedelta(days=int(days))).date().isoformat()
    # Queue and period defaults come from the algorithm configuration. An
    # omitted or blank role aggregates every role; an explicit role or queue is
    # retained even when it produces an empty scope.
    pairs = Counter((row["role"], row["queue"]) for row in rows if row["role"] in ROLES)
    filters = {"role": role or "ALL", "queue": queue, "days": days}
    scoped = [row for row in rows if (filters["role"] == "ALL" or row["role"] == filters["role"])
              and (filters["queue"] == "all" or row["queue"] == filters["queue"])
              and (cutoff is None or str(row.get("date") or "")[:10] >= cutoff)]
    return filters, {"roles": list(ROLES),
                     "queues": [{"id": key, "label": QUEUE_LABELS.get(key, key)}
                                for key in sorted(set(QUEUE_LABELS) | {r["queue"] for r in rows})],
                     "pairs": [{"role": pair[0], "queue": pair[1], "games": count}
                               for pair, count in sorted(pairs.items(), key=lambda x: (-x[1], x[0]))]}, scoped


def contrast(rows, candidate, accounts, family_size, settings=None):
    active_settings = settings or current_settings()
    evidence_settings = active_settings["evidence"]
    confidence = float(evidence_settings["credible_mass"])
    delta = float(evidence_settings["meaningful_delta"])
    family_alpha = float(evidence_settings["family_alpha"])
    if not accounts:
        return {
            **{key: None for key in (
                "mean", "lower", "upper", "lower_90", "upper_90", "baseline_mean",
                "baseline_lower", "baseline_upper", "baseline_lower_90", "baseline_upper_90",
            )},
            "credible_mass": confidence, "lift": None, "games": 0, "observations": 0,
            "wins": 0, "losses": 0, "baseline_games": 0, "supported": False,
            "status": "Da confermare", "reasons": ["Nessun account disponibile."],
            "account_count": 0, "comparable_accounts": 0, "missing_accounts": [],
            "missing_baseline_accounts": [], "support_per_account": {}, "prior_share": 0,
            "threshold": (1 - family_alpha / (2 * max(1, family_size))) * 100,
            "family_size": family_size,
            "min_games": 0, "meaningful_delta": delta * 100, "probability": None,
            "probability_method": "exact_binomial_clopper_pearson", "method": "exact_binomial",
        }
    estimate = observed_performance(
        rows, candidate, accounts, confidence=confidence, family_size=family_size,
        meaningful_delta=delta, family_alpha=family_alpha,
    )
    exact_90 = estimate if confidence == .9 else observed_performance(
        rows, candidate, accounts, confidence=.9, family_size=family_size,
        meaningful_delta=delta, family_alpha=family_alpha,
    )
    reasons = []
    if estimate["missing_accounts"]:
        reasons.append("Esposizione assente per alcuni account selezionati.")
    if estimate["missing_baseline_accounts"]:
        reasons.append("Confronto complementare assente per alcuni account selezionati.")
    if estimate["lift_pp"] is not None and abs(estimate["lift_pp"]) < delta * 100:
        reasons.append(f"Differenza osservata inferiore a {delta * 100:g} punti percentuali.")
    elif not estimate["supported"] and not reasons:
        reasons.append("Gli intervalli esatti non separano le scelte alla soglia corretta per la famiglia.")
    support = {
        account: {
            **cell,
            "local_missing": cell["games"] == 0,
            "baseline_missing": cell["baseline_games"] == 0,
        }
        for account, cell in estimate["per_account"].items()
    }
    rates = {
        "mean": estimate["win_rate"],
        "lower": estimate["interval_low"],
        "upper": estimate["interval_high"],
        "lower_90": exact_90["interval_low"],
        "upper_90": exact_90["interval_high"],
        "baseline_mean": estimate["baseline_win_rate"],
        "baseline_lower": estimate["baseline_low"],
        "baseline_upper": estimate["baseline_high"],
        "baseline_lower_90": exact_90["baseline_low"],
        "baseline_upper_90": exact_90["baseline_high"],
    }
    supported = bool(estimate["supported"])
    return {
        **rates, "credible_mass": confidence, "lift": estimate["lift_pp"],
        "games": estimate["games"], "observations": estimate["observations"],
        "wins": estimate["wins"], "losses": estimate["losses"],
        "baseline_games": estimate["baseline_games"], "supported": supported,
        "status": "Sostenuto" if supported else "Da confermare", "reasons": reasons,
        "account_count": len(accounts), "comparable_accounts": len(estimate["comparable_accounts"]),
        "missing_accounts": estimate["missing_accounts"],
        "missing_baseline_accounts": estimate["missing_baseline_accounts"],
        "support_per_account": support, "prior_share": 0,
        "threshold": (1 - family_alpha / (2 * max(1, family_size))) * 100,
        "family_size": family_size,
        "min_games": 0, "meaningful_delta": delta * 100, "probability": None,
        "probability_method": "exact_binomial_clopper_pearson", "method": "exact_binomial",
    }


def composition(rows, category_id=None):
    groups = defaultdict(list)
    for row in rows:
        groups[row["champion"]].append(row)
    result = []
    for champion, group in groups.items():
        entry = champion_entry(champion)
        item = {"champion": champion, "name": entry["name"] if entry else champion,
                "games": len({r["match_id"] for r in group}), "wins": sum(bool(r["win"]) for r in group),
                "losses": sum(not r["win"] for r in group)}
        reason = entry.get("tag_reasons", {}).get(category_id) if entry else None
        if reason:
            item["reason"] = reason
        result.append(item)
    return sorted(result, key=lambda x: (-x["games"], x["champion"]))


def rank_categories(rows, accounts):
    settings = current_settings()
    definitions = load_catalog()["categories"]
    # Unknown champions have unknown membership, not evidence of nonmembership.
    known = [row for row in rows if champion_entry(row["champion"]) is not None]
    result = []
    for definition in definitions:
        candidate = [row for row in known if definition["id"] in champion_categories(row["champion"])]
        item = {**definition, **contrast(known, candidate, accounts, len(definitions), settings), "composition": composition(candidate, definition["id"])}
        dominant = item["composition"][0]["champion"] if candidate else None
        dominant_ids = {row["match_id"] for row in candidate if row["champion"] == dominant}
        remaining = [row for row in known if row["match_id"] not in dominant_ids]
        sensitivity = contrast(remaining, [row for row in candidate if row["match_id"] not in dominant_ids], accounts, len(definitions), settings)
        item["sensitivity"] = {"champion": dominant, "games": sensitivity["games"],
                               **{key: sensitivity[key] for key in (
                                   "mean", "lower", "upper", "lower_90", "upper_90", "credible_mass")},
                               "supported": sensitivity["supported"], "lift": sensitivity["lift"],
                               "depends_on_champion": bool(item["supported"] and not sensitivity["supported"]),
                               "reasons": sensitivity["reasons"]}
        result.append(item)
    return sorted(result, key=lambda x: (not x["supported"], -(x["lift"] or 0), -x["games"], x["id"]))


def duration_band(value, bounds=None):
    if value is None or not math.isfinite(float(value)) or float(value) <= 0:
        return None
    bounds = list(bounds if bounds is not None else current_settings()["playstyle"]["duration_bounds"])
    return next((index for index, boundary in enumerate(bounds) if float(value) < float(boundary)), len(bounds))


def contextual_percentiles(rows, metric):
    playstyle_settings = current_settings()["playstyle"]
    min_games = int(playstyle_settings["percentile_min_games"])
    bounds = playstyle_settings["duration_bounds"]
    cells = defaultdict(list)
    result = {}
    for row in rows:
        value, band = row.get(metric), duration_band(
            row.get("metrics_duration_minutes", row.get("duration_minutes")), bounds
        )
        if value is None or not math.isfinite(value) or band is None:
            continue
        key = (row["account"], row["champion"], row["role"], row["queue"], band)
        cells[key].append(row)
    for group in cells.values():
        if len(group) < min_games:
            continue
        counts = Counter(r[metric] for r in group)
        ranks, less = {}, 0
        for value, count in sorted(counts.items()):
            ranks[value] = 100 * (less + .5 * count) / len(group)
            less += count
        for row in group:
            result[(row["account"], row["match_id"])] = ranks[row[metric]]
    return result


def weighted_distribution(values):
    if not values:
        return None
    ordered = sorted(values)
    total = math.fsum(weight for _, weight in ordered)
    def quantile(q):
        accumulated = 0
        for index, (value, weight) in enumerate(ordered):
            accumulated += weight
            if math.isclose(accumulated, q * total, rel_tol=1e-12, abs_tol=1e-12) and index + 1 < len(ordered):
                return (value + ordered[index + 1][0]) / 2
            if accumulated > q * total:
                return value
        return ordered[-1][0]
    return {"median": quantile(.5), "q1": quantile(.25), "q3": quantile(.75), "n": len(values)}


def behavior_comparison(rows, accounts, metric, percentiles=None):
    groups = defaultdict(lambda: {True: [], False: []})
    for row in rows:
        value = row.get(metric) if percentiles is None else percentiles.get((row["account"], row["match_id"]))
        if value is not None and math.isfinite(value):
            groups[row["account"]][bool(row["win"])].append(value * (100 if metric == "participation" and percentiles is None else 1))
    comparable = [a for a in accounts if groups[a][True] and groups[a][False]]
    outcomes = {}
    for win, label in ((True, "wins"), (False, "losses")):
        values = [(value, 1 / len(groups[a][win])) for a in comparable for value in groups[a][win]]
        outcomes[label] = weighted_distribution(values)
    return {**outcomes, "accounts": len(comparable), "excluded_accounts": [a for a in accounts if a not in comparable],
            "account_weighting": "equal", "available_games": sum(len(g[True]) + len(g[False]) for g in groups.values())}


def behavior_summary(rows, accounts):
    return [{"id": key, "label": label, "unit": unit,
             "raw": behavior_comparison(rows, accounts, key),
             "percentiles": behavior_comparison(rows, accounts, key, contextual_percentiles(rows, key))}
            for key, label, unit in METRICS]


def suggestions(rows, lifetime_rows, accounts, role, category):
    if not category:
        return {"category_id": None, "exploratory": True, "played": [], "untried": []}
    selected = [r for r in rows if category["id"] in champion_categories(r["champion"])]
    played = []
    for champion in composition(selected):
        personal = contrast(rows, [r for r in rows if r["champion"] == champion["champion"]], accounts,
                            max(1, len({r["champion"] for r in rows})))
        played.append({**champion, **{k: personal[k] for k in (
            "mean", "lower", "upper", "lower_90", "upper_90", "credible_mass", "supported", "reasons")}})
    limit = int(current_settings()["playstyle"]["suggestion_limit"])
    played.sort(key=lambda x: (-(x["mean"] or 0), -x["games"], x["name"].casefold()))
    tried = {canonical_champion(r["champion"]) for r in lifetime_rows}
    references = [(champion, set(champion_categories(champion)))
                  for champion in sorted({r["champion"] for r in selected})]
    role_matches = lambda entry: role == "ALL" or role in entry["roles"]
    if not references:
        references = [(entry["id"], set(champion_categories(entry["id"]))) for entry in load_catalog()["champions"]
                      if category["id"] in champion_categories(entry["id"]) and role_matches(entry)]
    untried = []
    for entry in load_catalog()["champions"]:
        tags = set(champion_categories(entry["id"]))
        if entry["id"] in tried or not role_matches(entry) or category["id"] not in tags:
            continue
        comparisons = [(len(tags & reference) / len(tags | reference), reference_id, reference)
                       for reference_id, reference in references if tags | reference]
        similarity, _, best_reference = min(comparisons, key=lambda item: (-item[0], item[1])) if comparisons else (0, "", set())
        untried.append({"champion": entry["id"], "name": entry["name"], "similarity": similarity,
                        "taxonomy_tags": sorted(tags), "matched_tags": sorted(tags & best_reference),
                        "roles": entry["roles"], "label": "Ipotesi da provare"})
    untried.sort(key=lambda x: (-x["similarity"], x["name"].casefold(), x["champion"]))
    return {"category_id": category["id"], "exploratory": not category["supported"],
            "played": played[:limit], "untried": untried[:limit]}


def analyze(rows, lifetime_rows, accounts, params, metrics_fetcher=None, now=None):
    settings = current_settings()
    rows, lifetime_rows = deduplicate(rows), deduplicate(lifetime_rows)
    accounts = sorted(set(accounts))
    filters, options, scoped = resolve_filters(rows, params, now)
    categories = rank_categories(scoped, accounts)
    requested = params.get("category", [""])[0]
    if requested and requested not in {c["id"] for c in categories}:
        raise ValueError("Categoria sconosciuta.")
    selected = next((c for c in categories if c["id"] == requested), categories[0] if categories else None)
    enriched = metrics_fetcher(scoped) if metrics_fetcher else scoped
    unclassified = {r["match_id"] for r in scoped if champion_entry(r["champion"]) is None}
    # A shared match is fully classified only when every selected observation
    # has known membership. Coverage counts remain a disjoint partition.
    classified = {r["match_id"] for r in scoped} - unclassified
    catalog = load_catalog()
    evidence_settings = settings["evidence"]
    playstyle_settings = settings["playstyle"]
    bounds = [float(value) for value in playstyle_settings["duration_bounds"]]
    bounds_label = ", ".join(f"{value:g}" for value in bounds)
    return {"version": VERSION, "catalog": {key: catalog[key] for key in ("version", "source_version", "sources", "categories")},
            "filters": filters, "options": options, "summary": {
                "unique_games": len({r["match_id"] for r in scoped}), "observations": len(scoped), "accounts": len(accounts),
                "classified_games": len(classified), "unclassified_games": len(unclassified),
                "metrics_games": len({r["match_id"] for r in enriched if any(r.get(k) is not None for k, _, _ in METRICS)}),
                "supported_categories": sum(c["supported"] for c in categories)},
            "categories": categories, "behavior": behavior_summary(enriched, accounts),
            "suggestions": suggestions(scoped, lifetime_rows, accounts, filters["role"], selected),
            "notes": ["Associazioni storiche: non dimostrano che uno stile causi più vittorie e non sono previsioni validate.",
                      f"Esiti grezzi senza prior; intervalli binomiali esatti e vantaggio minimo di {float(evidence_settings['meaningful_delta']) * 100:g} punti, con soglia corretta su tutte le categorie. Ogni account osservato pesa ugualmente e i dati mancanti restano mancanti.",
                      "Le sconfitte sono esiti reali: i pesi di attribuzione non modificano queste stime.",
                      "Campioni non classificati esclusi dai confronti; categorie sovrapposte, totali non sommabili.",
                      f"Percentili entro account, campione, ruolo, modalità e fasce durata definite a {bounds_label} minuti, sui due esiti insieme; servono {int(playstyle_settings['percentile_min_games'])} valori per cella.",
                      "Le mediane e gli IQR pesano ogni account confrontabile allo stesso modo; account diversi possono essere esclusi per indicatore."]}


def evidence(rows, params, now=None):
    _, _, scoped = resolve_filters(deduplicate(rows), params, now)
    category = params.get("category", [""])[0]
    if category not in {c["id"] for c in load_catalog()["categories"]}:
        raise ValueError("Categoria sconosciuta.")
    page = max(1, int(params.get("page", ["1"])[0]))
    page_size = min(100, max(1, int(params.get("page_size", ["20"])[0])))
    matches = [r for r in scoped if category in champion_categories(r["champion"])]
    matches.sort(key=lambda r: (str(r.get("date") or ""), r["match_id"], r["account"]), reverse=True)
    fields = ("account", "match_id", "champion", "role", "queue", "date", "win", "note", "duration_minutes")
    return {"category_id": category, "page": page, "page_size": page_size, "total": len(matches),
            "matches": [{key: r.get(key) for key in fields} for r in matches[(page - 1) * page_size:page * page_size]]}
