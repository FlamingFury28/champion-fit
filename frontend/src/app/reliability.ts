import type { MinimumReliability, Reliability } from '../api/types'

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

export function resolvedReliability(value: unknown, effectiveSampleSize: number, actionable = false): Reliability {
  if (typeof value === 'string' && value in reliabilityOrder) {
    return value === 'reliable' && !actionable ? 'indicative' : value as Reliability
  }
  if (effectiveSampleSize < 3) return 'exploratory'
  if (effectiveSampleSize < 8) return 'weak'
  if (effectiveSampleSize < 20) return 'indicative'
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
