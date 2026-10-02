export type IntFlag = 0 | 1
export type Role = 'TOP' | 'JUNGLE' | 'MIDDLE' | 'BOTTOM' | 'SUPPORT'
export type CompanionMode = 'exclude' | 'only'
export type Reliability = 'exploratory' | 'weak' | 'indicative' | 'reliable'
export type MinimumReliability = Exclude<Reliability, 'exploratory'>
export type MetadataDto = Record<string, string>

export interface ScopeQueryInput {
  account?: readonly string[]
  companion_account?: readonly string[]
  companion_mode?: CompanionMode
  algorithm_revision?: number
}

export interface AccountDto {
  account: string
  aliases?: string[]
  raw_games: number
  eligible_games: number
  analyzed_games: number
  wins: number
  first_game: string | null
  last_game: string | null
  games: number
}

export interface AccountsResponseDto { items: AccountDto[] }

export interface OverviewSummaryDto {
  champion_role_pairs: number
  observed_games: number | null
  average_fit: number | null
  planned_games: number
  strong_blacklist: number
  provisional_blacklist: number
  contaminated_losses: number
  wins?: number | null
  win_rate?: number | null
}

export interface OverviewRoleDto {
  role: string
  champion_role_pairs: number
  observed_games: number | null
  average_fit: number | null
  planned_games: number
}

export interface OverviewResponseDto {
  metadata: MetadataDto
  summary: OverviewSummaryDto
  roles: OverviewRoleDto[]
}

export interface SyncStatusResponseDto {
  mode: 'importing' | 'snapshot'
  sync_active: boolean
  automatic_api_calls: false
  checkpoint_accounts: number
  last_checkpoint_at: string | null
  last_completed_at: string | null
  metadata: MetadataDto
}

export interface ProfileSummaryDto {
  games: number
  wins: number
  losses: number
  win_rate: number
  avg_duration: number
  champions_played: number
  first_game: string | null
  last_game: string | null
  invincible_games: number
  carryable_losses: number
  afk_games: number
  griefer_games: number
}

export interface ProfileRecentMatchDto {
  date: string
  account: string
  champion: string
  role: string
  win: IntFlag
  queue: string
  duration_minutes: number
  match_quality_score: number
  anomaly_flags: string
}

export interface ProfileChampionDto {
  champion: string
  games: number
  wins: number
  win_rate: number
  avg_duration: number
}

export interface ProfileRoleDto {
  role: string
  games: number
  wins: number
  win_rate: number
}

export interface ProfileWeekdayDto {
  weekday: number
  games: number
  win_rate: number
}

export interface RecommendationDto {
  champion: string
  role: string
  score: number
  games: number
  unique_games?: number
  posterior_fit: number
  credible_lower_90: number
  credible_upper_90: number
  credible_lower?: number
  credible_upper?: number
  credible_mass?: number
  effective_evidence: number
  reason: string
  confidence: string
  actionable: boolean
  reliability: Reliability
  baseline_win_rate: number
  probability_meaningful_advantage: number
  probabilities_are_lower_bounds?: boolean
  observed_account_count?: number
  account_count?: number
  decision_threshold: number
  raw_win_rate: number
  explanation?: {
    positive_evidence: number
    negative_evidence: number
    prior_fit: number
    prior_evidence: number
    prior_share: number
    uncertainty_width_90: number
    uncertainty_level: 'high' | 'medium' | 'low'
    uncertainty_reasons: string[]
    summary: string
    next_step: string
  }
}

export interface RecommendationEvidenceMatchDto {
  match_id: string
  account: string
  date: string
  champion: string
  role: string
  win: IntFlag
  queue: string
  duration_minutes: number
  evidence_weight: number
  contribution: 'positive' | 'negative' | 'excluded'
  weight_reason: string
}

export interface RecommendationEvidenceResponseDto {
  champion: string
  role: string
  total: number
  limit: number
  offset: number
  summary: {
    games: number
    wins: number
    losses: number
    positive_evidence: number
    negative_evidence: number
    discounted_games: number
    excluded_games: number
  }
  items: RecommendationEvidenceMatchDto[]
}

export interface ProfileResponseDto {
  accounts: string[]
  summary: ProfileSummaryDto
  recent: ProfileRecentMatchDto[]
  champions: ProfileChampionDto[]
  roles: ProfileRoleDto[]
  weekdays: ProfileWeekdayDto[]
  recommendations: RecommendationDto[]
  context?: Record<string, unknown>
}

export type RecordKind = 'observed' | 'account' | 'screen'
export type FitStatus = 'ALL' | 'validated' | 'testing' | 'strong' | 'provisional' | 'screen'

export interface ChampionListItemDto {
  scope: string
  role: string
  champion: string
  games_observed: number
  unique_games?: number
  wins: number
  losses: number
  raw_win_rate: number
  positive_evidence: number
  informative_losses_equivalent: number
  effective_sample_size: number
  account_adjusted_fit_score: number | null
  posterior_win_rate?: number | null
  baseline_win_rate?: number | null
  actionable?: boolean
  reliability?: Reliability
  fit_delta_vs_account_baseline_pp: number | null
  posterior_fit_probability: number | null
  credible_lower_90: number | null
  credible_upper_90: number | null
  credible_lower?: number | null
  credible_upper?: number | null
  credible_mass?: number
  uncertainty_width_90: number | null
  probability_above_high_fit_threshold: number | null
  accounts_played: number
  accounts: string
  recent_90d_games?: number
  validated_positive: IntFlag
  blacklist_strong: IntFlag
  blacklist_provisional: IntFlag
  blacklist_tier: string
  blacklist_reason: string
  value_of_information: number
  icon_url: string
  allocated_games: number
  record_kind: RecordKind
  theoretical_fit_prior: number | null
  quantitative_rationale: string
  posterior_lift_pp?: number | null
  probability_meaningful_advantage?: number
  probability_direction_above?: number
  historical_supported?: boolean
  historical_direction?: string
  classification?: 'supported' | 'promising' | 'other'
  account_coverage?: number
  account_count?: number
  model_version?: string
  model_validated?: boolean
  model_status?: 'validated' | 'exploratory' | string
  rationale?: string
}

export interface ModelValidationDto {
  status: 'validated' | 'exploratory' | string
  validated: boolean
  model_version: string
  message: string
}

export interface ChampionsResponseDto {
  items: ChampionListItemDto[]
  context?: Record<string, unknown>
  model?: ModelValidationDto
}

export interface AvailableChampionDto {
  champion: string
  games: number
  icon_url: string
}

export interface MatchupItemDto {
  champion: string
  icon_url: string
  games: number
  wins_against: number
  losses_to: number
  win_rate_against: number
  positive_evidence: number
  negative_evidence: number
  effective_evidence: number
  effective_sample_size: number
  weighted_win_rate_against: number
  posterior_win_rate: number
  posterior_lift_pp: number
  credible_lower_90: number
  credible_upper_90: number
  credible_lower?: number
  credible_upper?: number
  credible_mass?: number
  probability_worse_than_baseline: number
  probability_meaningful_advantage: number
  probability_meaningful_disadvantage: number
  direction_confidence: number
  direction_probability: number
  quality_coverage: number
  recent_90d_games: number
  exposure_rate: number
  baseline_win_rate: number
  relative_delta_pp: number
  matchup_score: number
  personal_effective_sample_size: number
  reliability: Reliability
  actionable: boolean
  prior_source: string
  prior_games: number
  recommendation: 'loses_to' | 'beats'
}

export interface MatchupsResponseDto {
  champion: string
  role: string
  games: number
  wins: number
  win_rate: number
  games_with_opponents: number
  available_champions: AvailableChampionDto[]
  baseline_win_rate: number
  loses_to: MatchupItemDto[]
  beats: MatchupItemDto[]
  context?: {
    accounts?: string[]
    role?: string
    queue?: string
    days?: string | number
    observations?: number
    unique_games?: number
    [key: string]: unknown
  }
}

export type ChampionFitDto = ChampionListItemDto

export interface ChampionStatsDto {
  games: number
  wins: number
  win_rate: number
  avg_duration: number
  invincible_games: number
  carryable_losses: number
  afk_games: number
  griefer_games: number
}

export interface ChampionRecentMatchDto {
  date: string
  account: string
  role: string
  win: IntFlag
  reason: string
}

export interface ChampionRoleFitDto {
  role: string
  games_observed: number
  account_adjusted_fit_score: number
  credible_lower_90: number
  credible_upper_90: number
  credible_lower?: number
  credible_upper?: number
  credible_mass?: number
}

export interface ChampionResponseDto {
  champion: string
  role: string
  accounts: string[]
  fit: ChampionFitDto | null
  stats: ChampionStatsDto
  recent: ChampionRecentMatchDto[]
  roles: ChampionRoleFitDto[]
  matchups: MatchupsResponseDto
}

export interface PlanItemDto {
  role: string
  champion: string
  allocated_games: number
  candidate_type: string
  starting_effective_sample_size: number
  account_adjusted_fit_score: number
  probability_high_fit: number
  base_value_of_information: number
  quantitative_rationale: string
  icon_url: string
}

export interface PlanResponseDto {
  items: PlanItemDto[]
  requested_n: number
  source_total: number
  role: Role | ''
}

export interface BlacklistItemDto {
  role: string
  champion: string
  tier: 'strong' | 'provisional'
  reason: string
  games_observed: number
  informative_losses_equivalent: number
  account_adjusted_fit_score: number
  icon_url: string
  wins?: number
  losses?: number
  actionable?: boolean
  posterior_win_rate?: number
  credible_lower_90?: number
  credible_upper_90?: number
  credible_lower?: number
  credible_upper?: number
  credible_mass?: number
}

export interface BlacklistResponseDto {
  items: BlacklistItemDto[]
  scope_accounts: string[]
}

export interface ScreenCandidateDto {
  role: string
  champion: string
  observed_role_games: number
  matched_tags: string
  theoretical_fit_prior: number
  profile_tag_signal: number
  classification: string
  reason: string
  icon_url: string
  personalized_prior: number
  role_games: number
  role_ambiguous_games?: number
  role_posterior_win_rate: number
  role_credible_lower_90: number
  role_credible_upper_90: number
}

export interface ScreenResponseDto { items: ScreenCandidateDto[] }

export type AlgorithmSettingValue = number | string | boolean | number[] | string[]
export type AlgorithmSettings = Record<string, unknown>

export interface AlgorithmSettingSchemaDto {
  path: string
  label: string
  description: string
  type: 'number' | 'integer' | 'boolean' | 'select' | 'number[]' | 'string[]' | string
  min?: number
  max?: number
  options?: Array<string | number | { label: string; value: string | number }>
  group: string
}

export interface AlgorithmSettingsHistoryDto {
  revision?: number
  fingerprint?: string
  created_at?: string
  summary?: string
  changed_paths?: string[]
  settings?: AlgorithmSettings
  [key: string]: unknown
}

export interface AlgorithmSettingsResponseDto {
  revision: number
  fingerprint: string
  settings: AlgorithmSettings
  defaults: AlgorithmSettings
  schema: AlgorithmSettingSchemaDto[]
  history: AlgorithmSettingsHistoryDto[]
}

export interface AlgorithmPreviewComparisonDto {
  algorithm: string
  before: unknown
  after: unknown
}

export interface AlgorithmPreviewResponseDto {
  base_revision: number
  proposed_fingerprint: string
  changed_paths: string[]
  comparisons: AlgorithmPreviewComparisonDto[]
  sensitivity: unknown[]
  context: Record<string, unknown>
  notes: string[]
}

export interface TrainingPlanAccountAllocationDto { account: string; games: number }
export interface TrainingPlanItemDto {
  champion: string
  role: string
  icon_url: string
  games: number
  unique_games: number
  reliability: Reliability
  actionable: boolean
  allocation_games: number
  account_allocations: TrainingPlanAccountAllocationDto[]
  expected_variance_now?: number | null
  expected_variance_after?: number | null
  expected_variance_reduction?: number | null
  expected_regret_now?: number | null
  expected_regret_after?: number | null
  expected_regret_reduction?: number | null
  classification?: 'supported' | 'promising' | 'other'
  historical_supported?: boolean
  posterior_win_rate?: number | null
  posterior_lift_pp?: number | null
  rationale: string
}
export interface TrainingPlanResponseDto {
  budget_total: number
  budget_assigned: number
  budget_default: number
  budget_unassigned?: number
  objective?: string
  optimizer?: string
  simulation_scenarios?: number
  monte_carlo_se?: number | null
  expected_regret_now?: number | null
  expected_regret_after?: number | null
  expected_regret_reduction?: number | null
  items: TrainingPlanItemDto[]
  model?: ModelValidationDto
  algorithm_revision: number
  context: Record<string, unknown>
}

export interface ExplorationItemDto {
  champion: string
  role: string
  icon_url: string
  taxonomy_tags: string[] | string
  matched_tags: string[] | string
  jaccard_similarity: number
  classification: 'exploration'
  lifetime_games_selected: 0
  rationale: string
}
export interface ExplorationResponseDto {
  items: ExplorationItemDto[]
  taxonomy_version: string
  algorithm_revision: number
  context: Record<string, unknown>
}

export type RecommendationPreference = 'like' | 'dislike' | 'neutral'

export interface ObservedPreferenceSourceDto {
  champion: string
  name: string
  games: number
  similarity: number
  matched_tags: string[]
  source_kind?: string
}

export interface ObservedPerformanceDto {
  games: number
  observations: number
  wins: number
  losses: number
  win_rate: number | null
  interval_low: number | null
  interval_high: number | null
  confidence: number | string
  baseline_games: number
  paired_candidate_win_rate?: number | null
  paired_candidate_low?: number | null
  paired_candidate_high?: number | null
  baseline_win_rate: number | null
  baseline_low: number | null
  baseline_high: number | null
  lift_pp: number | null
  comparable_accounts: string[]
  missing_accounts: string[]
  missing_baseline_accounts: string[]
  per_account: Record<string, unknown> | Array<Record<string, unknown>>
  supported: boolean
  direction: string
  family_size?: number
  family_alpha?: number
  meaningful_delta?: number
  meaningful_delta_pp?: number | null
  decision_side_alpha?: number
  decision_candidate_low?: number | null
  decision_candidate_high?: number | null
  decision_baseline_low?: number | null
  decision_baseline_high?: number | null
  method: string
}

export interface ObservedRecommendationDto {
  champion: string
  name: string
  role: string
  icon_url: string
  kind: 'familiar' | 'discovery'
  preference_score: number | null
  similarity: number | null
  priority_score?: number | null
  games: number
  account_count: number
  selected_account_count: number
  source_champions: ObservedPreferenceSourceDto[]
  reasons: string[]
  performance: ObservedPerformanceDto | null
  feedback: RecommendationPreference | null
}

export interface RecommendationProfileItemDto {
  tag: string
  label: string
  games: number
  accounts: number
  share: number
}

export interface RecommendationsResponseDto {
  model_version: 'observed_preferences_v1' | 'observed_preferences_v2'
  algorithm_revision: number
  algorithm_fingerprint: string
  context: {
    accounts: string[]
    role: string
    queue: string
    days: string | number
    period?: { value: number; unit: 'days' | 'games' }
    suspended_accounts: string[]
    unresolved_accounts: string[]
    [key: string]: unknown
  }
  feedback_revision: number
  coverage: {
    selected_accounts: string[]
    active_accounts: string[]
    missing_accounts: string[]
    games: number
    observations: number
    preference_observations?: number
    unclassified_games?: number
    excluded_count?: number
  }
  profile: RecommendationProfileItemDto[]
  known: ObservedRecommendationDto[]
  discover: ObservedRecommendationDto[]
  trial_plan: {
    budget: number
    items: Array<{ champion: string; role: string; games: 1; reason: string }>
  }
  notes: string[]
  candidate?: ObservedRecommendationDto | null
  candidates?: ObservedRecommendationDto[]
}

export interface RecommendationFeedbackInputDto {
  accounts: string[]
  champion: string
  role: string
  preference: RecommendationPreference
  expected_revision: number
}

export interface RecommendationFeedbackItemDto {
  account: string
  champion: string
  role: string
  preference: RecommendationPreference
  updated_at: string
}

export interface RecommendationFeedbackOptionDto {
  champion: string
  name: string
  roles: string[]
  roles_by_account: Record<string, string[]>
  icon_url: string | null
  classified: boolean
}

export interface RecommendationFeedbackResponseDto {
  revision: number
  accounts: string[]
  suspended_accounts: string[]
  unresolved_accounts: string[]
  items: RecommendationFeedbackItemDto[]
  options: RecommendationFeedbackOptionDto[]
  catalog_version: string
}

export interface MatchDto {
  id: number
  account: string
  match_id: string
  date: string
  patch: string
  queue: string
  champion: string
  role: string
  identity_resolution: string
  duration_minutes: number
  win: IntFlag
  explicit_afk: IntFlag
  suspected_quasi_afk: IntFlag
  early_surrender: IntFlag
  anomaly_flags: string
  match_quality_score: number
  loss_attribution_weight: number
  win_evidence_weight: number
  reason: string
  icon_url: string
  annotation_invincible: IntFlag
  annotation_carryable_loss: IntFlag
  annotation_afk_player: IntFlag
  annotation_griefer: IntFlag
  annotation_team_collapse: IntFlag
  annotation_manual_label: string
  annotation_note: string
  annotation_confidence: number
}

export interface MatchesResponseDto { items: MatchDto[] }

export interface AnnotationDto {
  match_id: string
  invincible: IntFlag
  carryable_loss: IntFlag
  afk_player: IntFlag
  griefer: IntFlag
  team_collapse: IntFlag
  manual_label: string
  note: string
  confidence: number
  updated_at: string
}

export interface AnnotationResponseDto {
  item: AnnotationDto | null
  revision: string | null
}

export interface AnnotationUpsertInput {
  match_id: string
  invincible: boolean
  carryable_loss: boolean
  afk_player: boolean
  griefer: boolean
  team_collapse: boolean
  manual_label: string
  note: string
  confidence: number
  expected_revision: string | null
}

export interface AnnotationMutationResponseDto { ok: true; match_id: string; revision: string }

export interface FriendDto {
  friend_key: string
  friend: string
  shared_games: number
  accounts_played_with: number
  first_game: string
  last_game: string
  friend_win_rate: number
  posterior_win_rate: number
  credible_lower_90: number
  credible_upper_90: number
  credible_lower?: number
  credible_upper?: number
  credible_mass?: number
  personal_effective_sample_size: number
  actionable: boolean
  baseline_win_rate: number
  baseline_games?: number
  recommendation?: 'beats' | 'loses_to' | 'neutral'
  posterior_lift_pp?: number
  probability_meaningful_advantage?: number
  probability_meaningful_disadvantage?: number
  decision_reason?: string
  decision_threshold?: number
  decision_games?: number
  family_size?: number
  mixed_role_context?: boolean
  missing_role_baselines?: Array<{ account: string; role: string }>
  reliability: Reliability
}

export interface FriendGroupDto { id: number; name: string; aliases: string[] }

export interface FriendsSummaryDto {
  tracked_accounts: number
  matches_with_participants: number
  friends_found: number
  min_shared_games: number
  accounts: string[]
}

export interface FriendsResponseDto {
  items: FriendDto[]
  summary: FriendsSummaryDto
  manual_groups: FriendGroupDto[]
}

export interface FriendGroupCreateInput { name: string; aliases: string[] }
export interface FriendGroupRenameInput { name: string }
export interface FriendGroupMutationResponseDto { ok: true; id?: number; name?: string; added_aliases?: string[] }

export interface SynergyItemDto {
  champion: string
  icon_url: string
  games: number
  wins: number
  losses: number
  win_rate: number
  posterior_win_rate: number
  baseline_win_rate: number
  posterior_lift_pp: number
  relative_delta_pp: number
  credible_lower_90: number
  credible_upper_90: number
  credible_lower?: number
  credible_upper?: number
  credible_mass?: number
  direction_confidence: number
  direction_probability: number
  probability_meaningful_advantage: number
  probability_meaningful_disadvantage: number
  effective_sample_size: number
  personal_effective_sample_size: number
  reliability: Reliability
  actionable: boolean
  unique_games?: number
  decision_reason?: string
  decision_reasons?: string[]
  decision_games?: number
  decision_threshold?: number
  family_size?: number
  mixed_role_context?: boolean
  missing_accounts?: string[]
  missing_baseline_accounts?: string[]
  missing_role_baselines?: Array<{ account: string; role: string }>
  attribution_veto_applied?: boolean
  prior_source: string
  prior_games: number
}

export interface SynergyCoverageDto {
  raw_games: number
  eligible_games: number
  analyzed_games: number
  games_with_roster: number
  roster_coverage: number
}

export interface SynergyResponseDto {
  champion: string
  accounts: string[]
  companion_filter_active: boolean
  context?: {
    role?: string
    queue?: string
    days?: string | number
    [key: string]: unknown
  }
  min_reliability: Reliability
  include_exploratory: boolean
  min_games: number
  games: number
  games_with_teammates: number
  coverage: SynergyCoverageDto
  available_champions: AvailableChampionDto[]
  better_with: SynergyItemDto[]
  worse_with: SynergyItemDto[]
}
