import type { BlacklistItemDto, ChampionListItemDto, PlanItemDto, RecommendationDto, TrainingPlanItemDto } from '../api/types'
import { championRoleKey } from './presentation'

export type HistoricalChoiceStatus = 'ALL' | 'validated' | 'testing' | 'strong' | 'provisional' | 'screen'

export interface ChampionDecision {
  key: string
  champion: string
  role: string
  iconUrl: string
  recommendation: RecommendationDto | null
  pause: BlacklistItemDto | null
  plan: PlanItemDto | TrainingPlanItemDto | null
  personal: ChampionListItemDto | null
  historical: ChampionListItemDto | null
  conflict: boolean
}

export interface ChampionDecisionFilters {
  role: string
  search: string
  decision: 'all' | 'pause'
  historicalStatus?: HistoricalChoiceStatus
}

interface ChampionDecisionSources {
  recommendations: RecommendationDto[]
  pauses: BlacklistItemDto[]
  plan: Array<PlanItemDto | TrainingPlanItemDto>
  champions: ChampionListItemDto[]
}

function historicalStatusMatches(item: ChampionListItemDto | null, status: HistoricalChoiceStatus) {
  if (status === 'ALL') return true
  if (!item) return false
  if (status === 'validated') return Boolean(item.validated_positive)
  if (status === 'testing') return item.allocated_games > 0
  if (status === 'strong') return Boolean(item.blacklist_strong)
  if (status === 'provisional') return Boolean(item.blacklist_provisional)
  return item.record_kind === 'screen'
}

/**
 * Combines server decisions by champion and role without recalculating or ranking them.
 * The insertion order is the order already supplied by each endpoint.
 */
export function buildChampionDecisions(sources: ChampionDecisionSources, filters: ChampionDecisionFilters): ChampionDecision[] {
  const rows = new Map<string, ChampionDecision>()

  const ensure = (champion: string, role: string, iconUrl = '') => {
    const key = championRoleKey(champion, role)
    const existing = rows.get(key)
    if (existing) {
      if (!existing.iconUrl && iconUrl) existing.iconUrl = iconUrl
      return existing
    }
    const row: ChampionDecision = {
      key,
      champion,
      role,
      iconUrl,
      recommendation: null,
      pause: null,
      plan: null,
      personal: null,
      historical: null,
      conflict: false,
    }
    rows.set(key, row)
    return row
  }

  for (const item of sources.recommendations) ensure(item.champion, item.role).recommendation = item
  for (const item of sources.pauses) ensure(item.champion, item.role, item.icon_url).pause = item
  for (const item of sources.plan) ensure(item.champion, item.role, item.icon_url).plan = item
  for (const item of sources.champions) {
    const row = ensure(item.champion, item.role, item.icon_url)
    if (item.record_kind === 'account') row.personal = item
    else row.historical = item
  }

  const normalizedSearch = filters.search.trim().toLocaleLowerCase('it')
  const historicalStatus = filters.historicalStatus ?? 'ALL'
  return [...rows.values()]
    .map((item) => ({ ...item, conflict: Boolean(item.recommendation && item.pause) }))
    .filter((item) => filters.role === 'ALL' || item.role === filters.role)
    .filter((item) => !normalizedSearch || item.champion.toLocaleLowerCase('it').includes(normalizedSearch))
    .filter((item) => filters.decision !== 'pause' || Boolean(item.pause))
    .filter((item) => historicalStatusMatches(item.personal ?? item.historical, historicalStatus))
}
