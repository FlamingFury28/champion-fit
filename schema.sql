PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS source_metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- Stable ownership survives Riot ID changes; display names remain API-compatible.
CREATE TABLE IF NOT EXISTS riot_account_identities (
    identity_id TEXT PRIMARY KEY,
    account TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS riot_identity_puuids (
    puuid TEXT PRIMARY KEY,
    identity_id TEXT NOT NULL,
    FOREIGN KEY (identity_id) REFERENCES riot_account_identities(identity_id)
);

-- User assumptions are explicit and can be suspended for a single PUUID.
CREATE TABLE IF NOT EXISTS riot_identity_policy (
    puuid TEXT PRIMARY KEY,
    identity_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('assumed', 'verified', 'exception')),
    resume_state TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL,
    history_json TEXT NOT NULL DEFAULT '[]',
    FOREIGN KEY (identity_id) REFERENCES riot_account_identities(identity_id)
);

-- Explicit scoring inputs survive reconstruction of Riot-derived match facts.
CREATE TABLE IF NOT EXISTS match_import_provenance (
    account TEXT NOT NULL,
    match_id TEXT NOT NULL,
    source TEXT NOT NULL,
    classification TEXT NOT NULL,
    overrides_json TEXT NOT NULL DEFAULT '{}',
    recorded_at TEXT NOT NULL,
    PRIMARY KEY (account, match_id)
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

-- Riot IDs can be renamed while a historical Match-V5 payload keeps the old
-- spelling.  Only aliases verified by Account-V1 (or explicitly imported as
-- verified) belong here; ingestion never performs fuzzy name matching.
CREATE TABLE IF NOT EXISTS riot_account_aliases (
    account TEXT NOT NULL,
    normalized_riot_id TEXT NOT NULL,
    display_riot_id TEXT NOT NULL,
    puuid TEXT NOT NULL,
    verification_source TEXT NOT NULL,
    verified_at TEXT NOT NULL,
    PRIMARY KEY (account, normalized_riot_id, puuid)
);

-- Per-account materialization state separates raw coverage from matches that
-- are eligible and from matches already present in the analysis read model.
CREATE TABLE IF NOT EXISTS riot_match_materialization (
    account TEXT NOT NULL,
    match_id TEXT NOT NULL,
    status TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    identity_resolution TEXT NOT NULL DEFAULT '',
    participant_puuid TEXT NOT NULL DEFAULT '',
    attempts INTEGER NOT NULL DEFAULT 1,
    last_attempt_at TEXT NOT NULL,
    PRIMARY KEY (account, match_id)
);

CREATE TABLE IF NOT EXISTS champions (
    champion TEXT PRIMARY KEY,
    asset_id TEXT NOT NULL,
    icon_url TEXT NOT NULL
);

-- Playstyle facts are cached per canonical Match-V5 participant, not display alias.
CREATE TABLE IF NOT EXISTS playstyle_metric_sources (
    match_id TEXT PRIMARY KEY,
    source_fingerprint TEXT NOT NULL,
    extractor_version TEXT NOT NULL,
    status TEXT NOT NULL,
    participant_count INTEGER NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS playstyle_match_metrics (
    match_id TEXT NOT NULL,
    participant_id INTEGER NOT NULL,
    participant_puuid TEXT NOT NULL,
    champion TEXT NOT NULL,
    role TEXT NOT NULL,
    queue TEXT NOT NULL,
    duration_minutes REAL,
    farm REAL,
    vision REAL,
    participation REAL,
    turrets REAL,
    extractor_version TEXT NOT NULL,
    source_fingerprint TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (match_id, participant_id),
    UNIQUE (match_id, participant_puuid),
    FOREIGN KEY (match_id) REFERENCES playstyle_metric_sources(match_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS playstyle_backfill_checkpoints (
    job_name TEXT PRIMARY KEY,
    extractor_version TEXT NOT NULL,
    last_match_id TEXT NOT NULL DEFAULT '',
    processed_matches INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL DEFAULT 'running',
    updated_at TEXT NOT NULL
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
    UNIQUE (account, match_id),
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
    participant_id INTEGER NOT NULL DEFAULT 0,
    normalized_riot_id TEXT NOT NULL DEFAULT '',
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

-- Algorithm configuration is append-only.  The singleton pointer is updated
-- with an optimistic revision check so concurrent editors cannot overwrite one
-- another silently.
CREATE TABLE IF NOT EXISTS algorithm_settings_revisions (
    revision INTEGER PRIMARY KEY,
    fingerprint TEXT NOT NULL,
    settings_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS algorithm_settings_state (
    singleton_id INTEGER PRIMARY KEY,
    current_revision INTEGER NOT NULL,
    FOREIGN KEY (current_revision) REFERENCES algorithm_settings_revisions(revision)
);

-- Explicit champion preferences are a separate user-authored input. They do
-- not alter or replace raw match outcomes and survive Riot ID display renames
-- through the stable identity key when one is available.
CREATE TABLE IF NOT EXISTS recommendation_preferences (
    identity_key TEXT NOT NULL,
    account TEXT NOT NULL,
    champion TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'SUPPORT')),
    preference TEXT NOT NULL CHECK (preference IN ('like', 'dislike', 'neutral')),
    updated_at TEXT NOT NULL,
    PRIMARY KEY (identity_key, champion, role)
);

CREATE TABLE IF NOT EXISTS recommendation_feedback_state (
    singleton_id INTEGER PRIMARY KEY,
    revision INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS recommendation_feedback_events (
    revision INTEGER PRIMARY KEY,
    created_at TEXT NOT NULL,
    payload_json TEXT NOT NULL
);

INSERT INTO recommendation_feedback_state(singleton_id, revision)
VALUES(1, 0)
ON CONFLICT(singleton_id) DO NOTHING;
