import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query'
import { getJson, scopeQuery, type ScopeSnapshot } from './client'
import { getAlgorithmSettings } from './algorithm-settings'
import type {
  AccountsResponseDto,
  AnnotationResponseDto,
  BlacklistResponseDto,
  ChampionResponseDto,
  ChampionsResponseDto,
  FriendsResponseDto,
  MatchesResponseDto,
  MatchupsResponseDto,
  OverviewResponseDto,
  PlanResponseDto,
  ProfileResponseDto,
  RecommendationEvidenceResponseDto,
  ScreenResponseDto,
  SynergyResponseDto,
  SyncStatusResponseDto,
  MinimumReliability,
  ExplorationResponseDto,
  TrainingPlanResponseDto,
  RecommendationsResponseDto,
  RecommendationFeedbackResponseDto,
} from './types'

export interface FitFilters extends AnalysisContextFilters { role?: string; status: string; search: string }
export interface FriendsFilters {
  role: string
  queue: string
  friend_q: string
  games_from: string
  last_game_from: string
  min_shared_games: number
  sort: string
}
export interface SynergyFilters {
  minReliability: MinimumReliability
  includeExploratory: boolean
  role?: string
  queue?: string
  days?: string | number
}
export interface AnalysisContextFilters { queue?: string; days?: string | number }
export interface MatchHistoryFilters { champion: string; role: string; queue: string; days: string }
export interface RecommendationFilters extends AnalysisContextFilters { role?: string; champion?: string }

export function retainScopedPlaceholder<T>(
  scope: ScopeSnapshot,
  previousData: T | undefined,
  previousQuery: { queryKey: readonly unknown[] } | undefined,
) {
  const canonicalScope = JSON.stringify(scopeQuery(scope))
  const previousScope = previousQuery?.queryKey[2]
  return JSON.stringify(previousScope) === canonicalScope ? previousData : undefined
}

export const queryKeys = {
  algorithmSettings: ['api', 'algorithm-settings'] as const,
  accounts: ['api', 'accounts'] as const,
  sync: ['api', 'sync-status'] as const,
  overview: (scope: ScopeSnapshot) => ['api', 'overview', scopeQuery(scope)] as const,
  profile: (scope: ScopeSnapshot, filters?: MatchHistoryFilters) => filters
    ? ['api', 'profile', scopeQuery(scope), filters] as const
    : ['api', 'profile', scopeQuery(scope)] as const,
  recommendationEvidence: (scope: ScopeSnapshot, champion: string, role: string, offset = 0, limit = 20) => ['api', 'recommendation-evidence', scopeQuery(scope), champion, role, offset, limit] as const,
  champions: (scope: ScopeSnapshot, filters: FitFilters) => ['api', 'champions', scopeQuery(scope), filters] as const,
  exploration: (scope: ScopeSnapshot, filters: AnalysisContextFilters & { role?: string }) => ['api', 'exploration', scopeQuery(scope), filters] as const,
  champion: (scope: ScopeSnapshot, champion: string, role?: string) => ['api', 'champion', scopeQuery(scope), champion, role] as const,
  matchups: (scope: ScopeSnapshot, champion: string, role?: string, filters: AnalysisContextFilters = {}) => ['api', 'matchups', scopeQuery(scope), champion, role, filters] as const,
  trainingPlan: (scope: ScopeSnapshot, budget: number, role: string | undefined, filters: AnalysisContextFilters = {}) => ['api', 'training-plan', scopeQuery(scope), budget, role, filters] as const,
  recommendations: (scope: ScopeSnapshot, filters: RecommendationFilters) => ['api', 'recommendations', scopeQuery(scope), filters] as const,
  recommendationFeedback: (scope: ScopeSnapshot) => ['api', 'recommendation-feedback', { account: scopeQuery(scope).account ?? [] }] as const,
  blacklist: (scope: ScopeSnapshot) => ['api', 'blacklist', scopeQuery(scope)] as const,
  matches: (scope: ScopeSnapshot, flag: string) => ['api', 'matches', scopeQuery(scope), flag] as const,
  matchHistory: (scope: ScopeSnapshot, flag: string, filters: MatchHistoryFilters) => ['api', 'matches', scopeQuery(scope), flag, filters, 'pages'] as const,
  annotation: (matchId: string) => ['api', 'annotations', matchId] as const,
  friends: (scope: ScopeSnapshot, filters: FriendsFilters) => ['api', 'friends', scopeQuery(scope), filters] as const,
  synergy: (scope: ScopeSnapshot, champion: string, filters: SynergyFilters) => ['api', 'synergy', scopeQuery(scope), champion, filters] as const,
}

export const algorithmSettingsQuery = queryOptions({
  queryKey: queryKeys.algorithmSettings,
  queryFn: ({ signal }) => getAlgorithmSettings(signal),
  staleTime: Infinity,
  retry: false,
})

export const accountsQuery = queryOptions({
  queryKey: queryKeys.accounts,
  queryFn: ({ signal }) => getJson<AccountsResponseDto>('/api/accounts', undefined, signal),
  staleTime: 5 * 60_000,
})

export const syncStatusQuery = queryOptions({
  queryKey: queryKeys.sync,
  queryFn: ({ signal }) => getJson<SyncStatusResponseDto>('/api/sync-status', undefined, signal),
  refetchInterval: 30_000,
  retry: false,
})

export const overviewQuery = (scope: ScopeSnapshot) => queryOptions({
  queryKey: queryKeys.overview(scope),
  queryFn: ({ signal }) => getJson<OverviewResponseDto>('/api/overview', scopeQuery(scope), signal),
  placeholderData: (previousData, previousQuery) => retainScopedPlaceholder(scope, previousData, previousQuery),
})

export const profileQuery = (scope: ScopeSnapshot, filters?: MatchHistoryFilters) => queryOptions({
  queryKey: queryKeys.profile(scope, filters),
  queryFn: ({ signal }) => getJson<ProfileResponseDto>('/api/profile', {
    ...scopeQuery(scope), queue: 'all', days: 'all', role: 'ALL', ...filters,
  }, signal),
  placeholderData: (previousData, previousQuery) => filters ? undefined : retainScopedPlaceholder(scope, previousData, previousQuery),
})

export const matchHistoryQuery = (scope: ScopeSnapshot, flag: string, filters: MatchHistoryFilters) => infiniteQueryOptions({
  queryKey: queryKeys.matchHistory(scope, flag, filters),
  initialPageParam: 0,
  queryFn: ({ signal, pageParam }) => getJson<MatchesResponseDto>('/api/matches', {
    ...scopeQuery(scope), ...filters, flag, limit: 24, offset: pageParam,
  }, signal),
  getNextPageParam: (lastPage) => lastPage.next_offset ?? undefined,
})

export const recommendationEvidenceQuery = (scope: ScopeSnapshot, champion: string, role: string, offset = 0, limit = 20) => queryOptions({
  queryKey: queryKeys.recommendationEvidence(scope, champion, role, offset, limit),
  queryFn: ({ signal }) => getJson<RecommendationEvidenceResponseDto>('/api/recommendation-evidence', {
    ...scopeQuery(scope), champion, role, offset, limit,
  }, signal),
  // Each page is independent: never show another champion, role, scope, or page while loading.
})

export const championsQuery = (scope: ScopeSnapshot, filters: FitFilters) => queryOptions({
  queryKey: queryKeys.champions(scope, filters),
  queryFn: ({ signal }) => getJson<ChampionsResponseDto>('/api/champions', {
    ...scopeQuery(scope),
    role: filters.role,
    status: filters.status,
    search: filters.search || undefined,
    queue: filters.queue,
    days: filters.days,
  }, signal),
  // Filtered results are intentionally blank while a new request is pending.
})

export const explorationQuery = (scope: ScopeSnapshot, filters: AnalysisContextFilters & { role?: string }) => queryOptions({
  queryKey: queryKeys.exploration(scope, filters),
  queryFn: ({ signal }) => getJson<ExplorationResponseDto>('/api/exploration', {
    ...scopeQuery(scope),
    role: filters.role,
    queue: filters.queue,
    days: filters.days,
  }, signal),
  // Never present another role, queue or period as the current result.
})

export const championQuery = (scope: ScopeSnapshot, champion: string, role?: string) => queryOptions({
  queryKey: queryKeys.champion(scope, champion, role),
  queryFn: ({ signal }) => getJson<ChampionResponseDto>('/api/champion', {
    ...scopeQuery(scope), champion, role,
  }, signal),
  // Champion and role identify a distinct detail response.
})

export const matchupsQuery = (scope: ScopeSnapshot, champion = 'ALL', role?: string, filters: AnalysisContextFilters = {}) => queryOptions({
  queryKey: queryKeys.matchups(scope, champion, role, filters),
  queryFn: ({ signal }) => getJson<MatchupsResponseDto>('/api/matchups', {
    ...scopeQuery(scope), champion, role, queue: filters.queue, days: filters.days,
  }, signal),
})

export const trainingPlanQuery = (scope: ScopeSnapshot, budget: number, role: string | undefined, filters: AnalysisContextFilters = {}) => queryOptions({
  queryKey: queryKeys.trainingPlan(scope, budget, role, filters),
  queryFn: ({ signal }) => getJson<TrainingPlanResponseDto>('/api/training-plan', {
    ...scopeQuery(scope), budget, role, queue: filters.queue, days: filters.days,
  }, signal),
  // A changed budget or analysis context must load its own plan.
})

export const recommendationsQuery = (scope: ScopeSnapshot, filters: RecommendationFilters = {}) => queryOptions({
  queryKey: queryKeys.recommendations(scope, filters),
  queryFn: ({ signal }) => getJson<RecommendationsResponseDto>('/api/recommendations', {
    ...scopeQuery(scope),
    role: filters.role,
    queue: filters.queue,
    days: filters.days,
    champion: filters.champion,
  }, signal),
  // Advice from another scope or context must never remain visible while this request changes.
  retry: false,
})

export const recommendationFeedbackQuery = (scope: ScopeSnapshot) => queryOptions({
  queryKey: queryKeys.recommendationFeedback(scope),
  queryFn: ({ signal }) => getJson<RecommendationFeedbackResponseDto>('/api/recommendation-feedback', {
    account: scopeQuery(scope).account,
  }, signal),
  // Feedback is an account-level ledger: never retain another account scope while loading.
  retry: false,
})

/** Legacy contracts remain exported for detail surfaces that have not migrated. */
export const screenQuery = (scope: ScopeSnapshot) => queryOptions({
  queryKey: ['api', 'screen', scopeQuery(scope)] as const,
  queryFn: ({ signal }) => getJson<ScreenResponseDto>('/api/screen', scopeQuery(scope), signal),
  placeholderData: (previousData, previousQuery) => retainScopedPlaceholder(scope, previousData, previousQuery),
})

export const planQuery = (scope: ScopeSnapshot, n: number, role: string) => queryOptions({
  queryKey: ['api', 'plan', scopeQuery(scope), n, role] as const,
  queryFn: ({ signal }) => getJson<PlanResponseDto>('/api/plan', {
    ...scopeQuery(scope), n, role: role === 'ALL' ? undefined : role,
  }, signal),
  // Budget and role identify a distinct plan.
})

export const blacklistQuery = (scope: ScopeSnapshot) => queryOptions({
  queryKey: queryKeys.blacklist(scope),
  queryFn: ({ signal }) => getJson<BlacklistResponseDto>('/api/blacklist', {
    ...scopeQuery(scope), role: 'ALL', queue: 'all', days: 'all',
  }, signal),
  placeholderData: (previousData, previousQuery) => retainScopedPlaceholder(scope, previousData, previousQuery),
})

export const matchesQuery = (scope: ScopeSnapshot, flag: string) => queryOptions({
  queryKey: queryKeys.matches(scope, flag),
  queryFn: ({ signal }) => getJson<MatchesResponseDto>('/api/matches', {
    ...scopeQuery(scope), queue: 'all', days: 'all', role: 'ALL', flag, limit: 24,
  }, signal),
  // A changed audit flag must not retain rows from the previous flag.
})

export const annotationQuery = (matchId: string) => queryOptions({
  queryKey: queryKeys.annotation(matchId),
  queryFn: ({ signal }) => getJson<AnnotationResponseDto>('/api/annotations', { match_id: matchId }, signal),
  enabled: Boolean(matchId),
})

export const friendsQuery = (scope: ScopeSnapshot, filters: FriendsFilters) => queryOptions({
  queryKey: queryKeys.friends(scope, filters),
  queryFn: ({ signal }) => getJson<FriendsResponseDto>('/api/friends', {
    ...scopeQuery(scope),
    days: 'all',
    ...filters,
  }, signal),
  // Search, dates and thresholds describe a distinct result set.
})

export function synergyQueryInput(scope: ScopeSnapshot, champion: string, filters: SynergyFilters) {
  return {
    ...scopeQuery(scope),
    champion,
    ...(filters.role ? { role: filters.role } : {}),
    min_reliability: filters.minReliability,
    include_exploratory: Number(filters.includeExploratory),
    queue: filters.queue,
    days: filters.days,
  }
}

export const synergyQuery = (scope: ScopeSnapshot, champion: string, filters: SynergyFilters) => queryOptions({
  queryKey: queryKeys.synergy(scope, champion, filters),
  queryFn: ({ signal }) => getJson<SynergyResponseDto>('/api/synergy', synergyQueryInput(scope, champion, filters), signal),
  // Champion, reliability and context changes never reuse visible results.
})
