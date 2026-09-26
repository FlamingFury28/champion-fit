import type { BlacklistItemDto, MatchupItemDto, RecommendationDto } from '../api/types'
import { translateModelText } from './labels'

const candidateTypes: Record<string, string> = {
  VALIDATED: 'Già validato',
  UNCERTAIN: 'Incerto da verificare',
  OBSERVED_FULL_EVIDENCE_BLOCK: 'Già osservato · evidenza completa',
  THEORETICAL_SCREEN_ONLY: 'Solo valutazione teorica',
}

const screeningClassifications: Record<string, string> = {
  HIGH_PRIOR: 'Compatibilità teorica elevata',
  HIGH_PRIORITY: 'Priorità teorica alta',
  EXPLORE: 'Da esplorare',
  THEORETICAL_SCREEN_ONLY: 'Solo ipotesi teorica',
  EXTERNAL_TAGS_UNAVAILABLE: 'Caratteristiche esterne non disponibili',
  SCREENING: 'Da esplorare',
}

function token(value: string) {
  return value.trim().replace(/[\s-]+/g, '_').toUpperCase()
}

function humanize(value: string) {
  const words = value.trim().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ')
  if (!words) return 'Criterio non specificato'
  return words.charAt(0).toLocaleUpperCase('it') + words.slice(1).toLocaleLowerCase('it')
}

export function candidateTypeLabel(value: string) {
  return candidateTypes[token(value)] ?? humanize(value)
}

export function screeningClassificationLabel(value: string) {
  return screeningClassifications[token(value)] ?? humanize(value)
}

export function planRationaleLabel(candidateType: string, rationale: string) {
  const normalizedType = token(candidateType)
  const technicalRationale = /\bVOI\b|P\s*\(\s*high\s+fit\s*\)|effective\s+n|expected evidence\/game|sqrt\s*\(/i.test(rationale)
  if (!technicalRationale) return technicalText(rationale)
  if (normalizedType === 'VALIDATED') return 'Conferma se un segnale già promettente resta stabile in altre partite.'
  if (normalizedType === 'THEORETICAL_SCREEN_ONLY') return 'Raccogli la prima evidenza diretta prima di considerarlo una scelta.'
  if (normalizedType === 'OBSERVED_FULL_EVIDENCE_BLOCK') return 'Usalo come controllo: il piano considera già sufficiente l’evidenza disponibile.'
  return 'Riduci l’incertezza con una prova mirata prima di decidere se giocarlo.'
}

export function splitTags(value: string) {
  return [...new Set(value.split(/[;,]/).map((item) => item.trim()).filter(Boolean))]
}

export function technicalText(value: string) {
  return translateModelText(value)
}

export function signedPoints(value: number, digits = 1) {
  const formatted = new Intl.NumberFormat('it-IT', { maximumFractionDigits: digits }).format(Math.abs(value))
  return `${value > 0 ? '+' : value < 0 ? '−' : ''}${formatted} pp`
}

export function championRoleKey(champion: string, role: string) {
  return `${champion.trim().toLocaleLowerCase('it')}::${role.trim().toUpperCase()}`
}

export function selectActionableBan<T extends Pick<MatchupItemDto, 'actionable' | 'losses_to'>>(items: T[]) {
  return items.find((item) => item.actionable && item.losses_to > 0)
}

export interface RecommendationPresentation extends RecommendationDto {
  conflict: BlacklistItemDto | null
}

export function selectActionableRecommendation(items: RecommendationPresentation[]) {
  return items.find((item) => item.actionable && !item.conflict)
}

export function presentRecommendations(
  recommendations: RecommendationDto[],
  blacklist: BlacklistItemDto[],
): RecommendationPresentation[] {
  const decisions = new Map(
    blacklist.map((item) => [championRoleKey(item.champion, item.role), item]),
  )
  return recommendations.map((item) => ({
    ...item,
    conflict: decisions.get(championRoleKey(item.champion, item.role)) ?? null,
  }))
}
