import { describe, expect, it } from 'vitest'
import {
  candidateTypeLabel,
  planRationaleLabel,
  presentRecommendations,
  screeningClassificationLabel,
  selectActionableBan,
  signedPoints,
  splitTags,
  technicalText,
} from './presentation'

describe('adapter presentazionali', () => {
  it.each([
    ['validated', 'Già validato'],
    ['uncertain', 'Incerto da verificare'],
    ['observed_full_evidence_block', 'Già osservato · evidenza completa'],
  ])('traduce il tipo candidato %s', (wire, label) => {
    expect(candidateTypeLabel(wire)).toBe(label)
  })

  it.each([
    ['THEORETICAL_SCREEN_ONLY', 'Solo ipotesi teorica'],
    ['high-prior', 'Compatibilità teorica elevata'],
    ['explore', 'Da esplorare'],
  ])('traduce la classificazione %s', (wire, label) => {
    expect(screeningClassificationLabel(wire)).toBe(label)
  })

  it('gestisce tag con virgola o punto e virgola e termini tecnici nel testo', () => {
    expect(splitTags('Fighter;Assassin, Burst')).toEqual(['Fighter', 'Assassin', 'Burst'])
    expect(technicalText('VOI 0.4 · P(high fit) 70% · effective n 8')).toBe('valore informativo 0.4 · probabilità di compatibilità elevata 70% · campione effettivo 8')
  })

  it('trasforma la formula del piano in una motivazione operativa', () => {
    const formula = 'VOI 0.733; P(high fit) 86.1%; effective n 3.9; expected evidence/game 0.55; role budget 68 from sqrt(role exposure).'
    expect(planRationaleLabel('validated', formula)).toBe('Conferma se un segnale già promettente resta stabile in altre partite.')
    expect(planRationaleLabel('uncertain', formula)).toBe('Riduci l’incertezza con una prova mirata prima di decidere se giocarlo.')
    expect(planRationaleLabel('uncertain', 'Ridurre l’ampiezza dell’intervallo.')).toBe('Ridurre l’ampiezza dell’intervallo.')
  })

  it('formatta i punti percentuali con segno', () => {
    expect(signedPoints(-8.4)).toBe('−8,4 pp')
    expect(signedPoints(2)).toBe('+2 pp')
  })

  it('sceglie come ban soltanto un matchup operativo', () => {
    const observed = { champion: 'Zed', losses_to: 3, actionable: false }
    const actionable = { champion: 'Fizz', losses_to: 2, actionable: true }
    expect(selectActionableBan([observed, actionable])).toBe(actionable)
    expect(selectActionableBan([observed])).toBeUndefined()
  })

  it('rende visibile una collisione champion + ruolo senza confondere altri ruoli', () => {
    const recommendations = [{
      champion: 'Ahri', role: 'MIDDLE', score: 55, games: 12, posterior_fit: 62,
      credible_lower_90: 55, credible_upper_90: 70, effective_evidence: 10,
      reason: 'fixture', confidence: 'sufficiente', actionable: true, reliability: 'reliable' as const,
      baseline_win_rate: 50, probability_meaningful_advantage: 97, decision_threshold: 95,
      raw_win_rate: 66,
    }]
    const blacklist = [{
      champion: 'ahri', role: 'MIDDLE', tier: 'strong' as const, reason: 'fixture',
      games_observed: 12, informative_losses_equivalent: 4, account_adjusted_fit_score: 40,
      icon_url: '',
    }]
    expect(presentRecommendations(recommendations, blacklist)[0]?.conflict?.tier).toBe('strong')
    expect(presentRecommendations(recommendations, [{ ...blacklist[0]!, role: 'TOP' }])[0]?.conflict).toBeNull()
  })
})
