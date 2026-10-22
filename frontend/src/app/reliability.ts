import type { AlgorithmSettings, MinimumReliability, Reliability } from '../api/types'

export interface EvidenceThresholds {
  displayMinGames: number
  indicativeGames: number
  minGames: number
  meaningfulDelta: number
}

export function evidenceThresholds(settings: AlgorithmSettings = {}): EvidenceThresholds {
  const evidence = settings.evidence && typeof settings.evidence === 'object'
    ? settings.evidence as Record<string, unknown> : {}
  const count = (key: string, fallback: number) => {
    const value = evidence[key]
    return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback
  }
  const minGames = Math.max(20, count('min_games', 20))
  const displayMinGames = Math.min(minGames, count('display_min_games', 3))
  const indicativeGames = Math.max(displayMinGames, Math.min(minGames, count('indicative_games', 8)))
  const delta = evidence.meaningful_delta
  const meaningfulDelta = typeof delta === 'number' && Number.isFinite(delta) && delta > 0 && delta < 1 ? delta : .03
  return { displayMinGames, indicativeGames, minGames, meaningfulDelta }
}

export function meaningfulDeltaPoints(value: unknown, thresholds: EvidenceThresholds): string {
  const delta = typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 1
    ? value : thresholds.meaningfulDelta
  return (delta * 100).toLocaleString('it-IT', { maximumFractionDigits: 3 })
}

const reliabilityOrder: Record<Reliability, number> = {
  exploratory: 0,
  weak: 1,
  indicative: 2,
  reliable: 3,
}

const reliabilityLabels: Record<Reliability, string> = {
  exploratory: 'Esplorativo',
  weak: 'Debole',
  indicative: 'Indicativo',
  reliable: 'Affidabile',
}

const priorLabels: Record<string, string> = {
  pair: 'coppia personale',
  personal_pair: 'coppia personale',
  personal_baseline: 'rendimento personale di riferimento',
  account_role: 'stesso account e ruolo',
  account_profile: 'profilo account',
  comparable_accounts: 'account comparabili',
  role: 'stesso ruolo',
  champion_role: 'campione e ruolo',
  same_champion_role: 'stesso campione e ruolo',
  peer_role: 'altri account nello stesso ruolo',
  champion_archetype: 'tipo di campione',
  neutral: 'ipotesi iniziale neutra',
  neutral_50: 'ipotesi neutra al 50%',
  global: 'storico globale',
}

export function resolvedReliability(value: unknown, games: number, actionable = false, thresholds = evidenceThresholds()): Reliability {
  if (typeof value === 'string' && Object.hasOwn(reliabilityOrder, value)) {
    return value === 'reliable' && !actionable ? 'indicative' : value as Reliability
  }
  const sampleSize = Number.isFinite(games) ? Math.max(0, games) : 0
  if (sampleSize < thresholds.displayMinGames) return 'exploratory'
  if (sampleSize < thresholds.indicativeGames) return 'weak'
  if (sampleSize < thresholds.minGames) return 'indicative'
  return actionable ? 'reliable' : 'indicative'
}

export function reliabilityLabel(value: Reliability) {
  return reliabilityLabels[value]
}

export function reliabilityTone(value: Reliability): 'neutral' | 'warning' | 'info' | 'positive' {
  if (value === 'reliable') return 'positive'
  if (value === 'indicative') return 'info'
  if (value === 'weak') return 'warning'
  return 'neutral'
}

export function isVisibleReliability(
  value: Reliability,
  minimum: MinimumReliability,
  includeExploratory: boolean,
) {
  if (value === 'exploratory') return includeExploratory
  return reliabilityOrder[value] >= reliabilityOrder[minimum]
}

export function priorSourceLabel(value: string) {
  const key = value.trim().toLocaleLowerCase('it').replace(/[\s-]+/g, '_')
  return priorLabels[key] ?? (key.replace(/_/g, ' ') || 'ipotesi iniziale non specificata')
}
