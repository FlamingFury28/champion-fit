PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS source_metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- Complete Riot responses are retained for future analyses. The normalized
-- tables below remain the fast read model used by the current website.
CREATE TABLE IF NOT EXISTS riot_accounts_raw (
    puuid TEXT PRIMARY KEY,
    account TEXT NOT NULL,
    game_name TEXT NOT NULL,
    tag_line TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    payload_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS riot_match_raw (
    match_id TEXT PRIMARY KEY,
    routing_region TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    payload_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS riot_match_list_raw (
    account TEXT NOT NULL,
    puuid TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    match_ids_json TEXT NOT NULL,
    PRIMARY KEY (account, puuid)
);

CREATE TABLE IF NOT EXISTS champions (
    champion TEXT PRIMARY KEY,
    asset_id TEXT NOT NULL,
    icon_url TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS champion_fit (
    scope TEXT NOT NULL,
    role TEXT NOT NULL,
    champion TEXT NOT NULL,
    games_observed INTEGER NOT NULL,
    wins INTEGER NOT NULL,
    losses INTEGER NOT NULL,
    raw_win_rate REAL NOT NULL,
    positive_evidence REAL NOT NULL,
    informative_losses_equivalent REAL NOT NULL,
    effective_sample_size REAL NOT NULL,
    account_adjusted_fit_score REAL NOT NULL,
    fit_delta_vs_account_baseline_pp REAL NOT NULL,
    posterior_fit_probability REAL NOT NULL,
    credible_lower_90 REAL NOT NULL,
    credible_upper_90 REAL NOT NULL,
    uncertainty_width_90 REAL NOT NULL,
    probability_above_high_fit_threshold REAL NOT NULL,
    accounts_played INTEGER NOT NULL,
    accounts TEXT NOT NULL,
    recent_90d_games INTEGER NOT NULL,
    validated_positive INTEGER NOT NULL,
    blacklist_strong INTEGER NOT NULL,
    blacklist_provisional INTEGER NOT NULL,
    blacklist_tier TEXT NOT NULL,
    blacklist_reason TEXT NOT NULL,
    value_of_information REAL NOT NULL,
    PRIMARY KEY (role, champion),
    FOREIGN KEY (champion) REFERENCES champions(champion)
);

CREATE TABLE IF NOT EXISTS test_plan (
    role TEXT NOT NULL,
    champion TEXT NOT NULL,
    allocated_games INTEGER NOT NULL,
    candidate_type TEXT NOT NULL,
    starting_effective_sample_size REAL NOT NULL,
    account_adjusted_fit_score REAL NOT NULL,
    probability_high_fit REAL NOT NULL,
    base_value_of_information REAL NOT NULL,
    quantitative_rationale TEXT NOT NULL,
    PRIMARY KEY (role, champion),
    FOREIGN KEY (role, champion) REFERENCES champion_fit(role, champion)
);

CREATE TABLE IF NOT EXISTS blacklist (
    role TEXT NOT NULL,
    champion TEXT NOT NULL,
    tier TEXT NOT NULL CHECK(tier IN ('strong', 'provisional')),
    reason TEXT NOT NULL,
    PRIMARY KEY (role, champion),
    FOREIGN KEY (role, champion) REFERENCES champion_fit(role, champion)
);

CREATE TABLE IF NOT EXISTS screening_candidates (
    role TEXT NOT NULL,
    champion TEXT NOT NULL,
    observed_role_games INTEGER NOT NULL,
    matched_tags TEXT NOT NULL,
    theoretical_fit_prior REAL NOT NULL,
    profile_tag_signal REAL NOT NULL,
    classification TEXT NOT NULL,
    reason TEXT NOT NULL,
    PRIMARY KEY (role, champion),
    FOREIGN KEY (champion) REFERENCES champions(champion)
);

CREATE TABLE IF NOT EXISTS match_quality (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account TEXT NOT NULL,
    match_id TEXT NOT NULL,
    date TEXT NOT NULL,
    patch TEXT NOT NULL,
    queue TEXT NOT NULL,
    champion TEXT NOT NULL,
    role TEXT NOT NULL,
    identity_resolution TEXT NOT NULL,
    duration_minutes REAL NOT NULL,
    win INTEGER NOT NULL,
    explicit_afk INTEGER NOT NULL,
    suspected_quasi_afk INTEGER NOT NULL,
    early_surrender INTEGER NOT NULL,
    anomaly_flags TEXT NOT NULL,
    match_quality_score REAL NOT NULL,
    loss_attribution_weight REAL NOT NULL,
    win_evidence_weight REAL NOT NULL,
    reason TEXT NOT NULL,
    FOREIGN KEY (champion) REFERENCES champions(champion)
);

CREATE TABLE IF NOT EXISTS match_annotations (
    match_id TEXT PRIMARY KEY,
    invincible INTEGER NOT NULL DEFAULT 0,
    carryable_loss INTEGER NOT NULL DEFAULT 0,
    afk_player INTEGER NOT NULL DEFAULT 0,
    griefer INTEGER NOT NULL DEFAULT 0,
    team_collapse INTEGER NOT NULL DEFAULT 0,
    manual_label TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    confidence REAL NOT NULL DEFAULT 1.0,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS match_participants (
    match_id TEXT NOT NULL,
    puuid TEXT NOT NULL,
    riot_id TEXT NOT NULL,
    team_id INTEGER NOT NULL DEFAULT 0,
    win INTEGER NOT NULL DEFAULT 0,
    champion TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (match_id, puuid)
);

CREATE TABLE IF NOT EXISTS tracked_account_puuids (
    puuid TEXT PRIMARY KEY,
    account TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS friend_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS friend_group_aliases (
    group_id INTEGER NOT NULL,
    alias TEXT NOT NULL UNIQUE,
    PRIMARY KEY (group_id, alias),
    FOREIGN KEY (group_id) REFERENCES friend_groups(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_fit_role_score ON champion_fit(role, account_adjusted_fit_score DESC);
CREATE INDEX IF NOT EXISTS idx_matches_role_champion ON match_quality(role, champion);
CREATE INDEX IF NOT EXISTS idx_matches_champion ON match_quality(champion);
CREATE INDEX IF NOT EXISTS idx_matches_date ON match_quality(date DESC);
CREATE INDEX IF NOT EXISTS idx_annotations_label ON match_annotations(manual_label);
CREATE INDEX IF NOT EXISTS idx_participants_riot_id ON match_participants(riot_id);
CREATE INDEX IF NOT EXISTS idx_riot_match_raw_fetched_at ON riot_match_raw(fetched_at);
