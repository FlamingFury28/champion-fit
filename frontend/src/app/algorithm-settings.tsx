import { useQuery } from '@tanstack/react-query'
import { createContext, useContext, useMemo, type PropsWithChildren } from 'react'
import { algorithmSettingsQuery } from '../api/queries'
import type { AlgorithmSettings, AlgorithmSettingsResponseDto } from '../api/types'

export const RECOMMENDED_ALGORITHM_SETTINGS: AlgorithmSettings = {
  recommendations: { limit: 6, trial_budget: 3, period: { value: 0, unit: 'days' }, queue: 'all', confidence: 0.9 },
  evidence: {
    prior_mean: 0.5,
    prior_strength: 8,
    credible_mass: 0.9,
    meaningful_delta: 0.03,
    family_alpha: 0.05,
    min_games: 20,
    display_min_games: 3,
    indicative_games: 8,
    recommendation_limit: 3,
  },
  context: { queue: '420', days: 180 },
  attribution: {
    duration_bounds: [10, 15, 20, 23, 27],
    loss_weights: [1, 1, 1, 1, 1, 1],
    win_short_minutes: 20,
    win_short_weight: 1,
    win_long_weight: 1,
    explicit_afk_weight: 0,
    quasi_afk_multiplier: 1,
    early_surrender_multiplier: 1,
    team_collapse_multiplier: 1,
    surrender_multiplier: 1,
    kill_deficit_multiplier: 1,
    contaminated_threshold: 0.45,
    negative_veto: false,
  },
  matchup: { recent_days: 90, recent_weight: 0, limit: 12 },
  friends: { min_shared_games: 5 },
  playstyle: { percentile_min_games: 10, duration_bounds: [20, 30, 40], suggestion_limit: 10 },
  training: { budget: 20, max_candidates: 3 },
}

interface AlgorithmSettingsContextValue {
  data?: AlgorithmSettingsResponseDto
  revision?: number
  settings: AlgorithmSettings
  credibleMass: number
  isPending: boolean
  isFetching: boolean
  error: Error | null
  refreshError: Error | null
  refetch: () => Promise<unknown>
}

const fallbackContext: AlgorithmSettingsContextValue = {
  settings: RECOMMENDED_ALGORITHM_SETTINGS,
  credibleMass: 0.9,
  isPending: false,
  isFetching: false,
  error: null,
  refreshError: null,
  refetch: async () => undefined,
}

const AlgorithmSettingsContext = createContext<AlgorithmSettingsContextValue>(fallbackContext)

export function getSetting(settings: AlgorithmSettings, path: string): unknown {
  return path.split('.').reduce<unknown>((value, key) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    return (value as Record<string, unknown>)[key]
  }, settings)
}

export function setSetting(settings: AlgorithmSettings, path: string, value: unknown): AlgorithmSettings {
  const keys = path.split('.').filter(Boolean)
  if (!keys.length) return settings
  const root = structuredClone(settings)
  let cursor: Record<string, unknown> = root
  keys.slice(0, -1).forEach((key) => {
    const next = cursor[key]
    if (!next || typeof next !== 'object' || Array.isArray(next)) cursor[key] = {}
    cursor = cursor[key] as Record<string, unknown>
  })
  cursor[keys.at(-1)!] = value
  return root
}

export function AlgorithmSettingsProvider({ children }: PropsWithChildren) {
  const query = useQuery(algorithmSettingsQuery)
  const settings = query.data?.settings ?? RECOMMENDED_ALGORITHM_SETTINGS
  const configuredMass = Number(getSetting(settings, 'evidence.credible_mass'))
  const credibleMass = Number.isFinite(configuredMass) && configuredMass > 0 && configuredMass < 1 ? configuredMass : 0.9
  const value = useMemo<AlgorithmSettingsContextValue>(() => ({
    data: query.data,
    revision: query.data?.revision,
    settings,
    credibleMass,
    isPending: query.isPending,
    isFetching: query.isFetching,
    error: query.error,
    refreshError: query.data ? query.error : null,
    refetch: query.refetch,
  }), [credibleMass, query.data, query.error, query.isFetching, query.isPending, query.refetch, settings])
  return <AlgorithmSettingsContext value={value}>{children}</AlgorithmSettingsContext>
}

export function useAlgorithmSettings() {
  return useContext(AlgorithmSettingsContext)
}

export function credibleMassLabel(mass: number) {
  return `${(mass * 100).toLocaleString('it-IT', { maximumFractionDigits: 3 })}%`
}

export function credibleBounds(item: {
  credible_lower?: number | null
  credible_upper?: number | null
  credible_lower_90?: number | null
  credible_upper_90?: number | null
}) {
  if (item.credible_lower !== undefined || item.credible_upper !== undefined) {
    return { lower: item.credible_lower ?? null, upper: item.credible_upper ?? null }
  }
  return {
    lower: item.credible_lower_90 ?? null,
    upper: item.credible_upper_90 ?? null,
  }
}
