import { queryOptions } from '@tanstack/react-query'
import { getJson, scopeQuery, type ScopeSnapshot } from './client'

export type PlaystyleDays = '90' | '180' | '365' | 'all'
export interface PlaystyleFilters { role?: string; queue?: string; days: PlaystyleDays; category?: string }
export type PlaystyleSource = string | { label?: string; name?: string; url?: string }
export interface PlaystyleCategoryDefinition {
  id: string; label: string; kind: string; criteria: string | string[]; roles: string[]; sources: PlaystyleSource[]
}
export interface PlaystyleSupport { games: number; baseline_games: number; local_missing?: boolean }
export interface PlaystyleComposition { champion: string; name: string; games: number; wins: number; losses: number }
export interface PlaystyleCategory extends PlaystyleCategoryDefinition {
  games: number; observations: number; wins: number; losses: number
  mean: number | null; lower?: number | null; upper?: number | null; lower_90?: number | null; upper_90?: number | null
  baseline_mean: number | null; baseline_lower?: number | null; baseline_upper?: number | null; baseline_lower_90?: number | null; baseline_upper_90?: number | null
  lift: number | null; baseline_games: number; supported: boolean; status: string; reasons: string[]
  account_count: number; comparable_accounts: number; missing_accounts: string[]; missing_baseline_accounts: string[]
  support_per_account: Record<string, PlaystyleSupport>; prior_share: number; threshold: number; family_size: number
  composition: PlaystyleComposition[]
  sensitivity: { champion: string | null; games: number; supported: boolean; lift: number | null; depends_on_champion: boolean } | null
}
export interface PlaystyleDistribution { median: number; q1: number; q3: number; n: number }
export interface PlaystyleComparison {
  wins: PlaystyleDistribution | null; losses: PlaystyleDistribution | null; accounts: number; excluded_accounts: string[]
}
export interface PlaystyleBehavior { id: string; label: string; unit: string; raw: PlaystyleComparison; percentiles: PlaystyleComparison }
export interface PlaystylesResponse {
  version: string
  catalog: { version: string; source_version: string; sources: PlaystyleSource[]; categories: PlaystyleCategoryDefinition[] }
  filters: { role: string; queue: string; days: PlaystyleDays }
  options: { roles: string[]; queues: { id: string; label: string }[]; pairs: { role: string; queue: string; games: number }[] }
  summary: { unique_games: number; observations: number; accounts: number; classified_games: number; unclassified_games: number; metrics_games: number; supported_categories: number }
  categories: PlaystyleCategory[]
  behavior: PlaystyleBehavior[]
  suggestions: {
    category_id: string | null; exploratory: boolean
    played: { champion: string; name: string; games: number; wins: number; losses: number; mean: number | null; lower?: number | null; upper?: number | null; lower_90?: number | null; upper_90?: number | null }[]
    untried: { champion: string; name: string; similarity: number; label: string; roles: string[] }[]
  }
  notes: string[]
}
export interface PlaystyleEvidenceResponse {
  category_id: string; page: number; page_size: number; total: number
  matches: { account: string; match_id: string; champion: string; role: string; queue: string; date: string; win: number | boolean; note: string; duration_minutes: number }[]
}

export const playstyleQueryKeys = {
  overview: (scope: ScopeSnapshot, filters: PlaystyleFilters) => ['api', 'playstyles', scopeQuery(scope), filters] as const,
  evidence: (scope: ScopeSnapshot, filters: PlaystyleFilters, category: string, page: number, pageSize: number) =>
    ['api', 'playstyle-evidence', scopeQuery(scope), filters, category, page, pageSize] as const,
}

export const playstylesQuery = (scope: ScopeSnapshot, filters: PlaystyleFilters) => queryOptions({
  queryKey: playstyleQueryKeys.overview(scope, filters),
  queryFn: ({ signal }) => getJson<PlaystylesResponse>('/api/playstyles', { ...scopeQuery(scope), ...filters }, signal),
  // A new account, context or category must never display the previous result.
})

export const playstyleEvidenceQuery = (scope: ScopeSnapshot, filters: PlaystyleFilters, category: string, page = 1, pageSize = 20) => queryOptions({
  queryKey: playstyleQueryKeys.evidence(scope, filters, category, page, pageSize),
  queryFn: ({ signal }) => getJson<PlaystyleEvidenceResponse>('/api/playstyle-evidence', {
    ...scopeQuery(scope), ...filters, category, page, page_size: pageSize,
  }, signal),
})
