import { describe, expect, it } from 'vitest'
import { evidenceThresholds, isVisibleReliability, priorSourceLabel, resolvedReliability } from './reliability'

describe('presentazione affidabilità', () => {
  it('applica le soglie configurate al recupero delle classificazioni mancanti', () => {
    const thresholds = evidenceThresholds({ evidence: { display_min_games: 5, indicative_games: 12, min_games: 40 } })
    expect(resolvedReliability(undefined, 4, false, thresholds)).toBe('exploratory')
    expect(resolvedReliability(undefined, 5, false, thresholds)).toBe('weak')
    expect(resolvedReliability(undefined, 11, false, thresholds)).toBe('weak')
    expect(resolvedReliability(undefined, 12, false, thresholds)).toBe('indicative')
    expect(resolvedReliability(undefined, 39, true, thresholds)).toBe('indicative')
    expect(resolvedReliability(undefined, 40, true, thresholds)).toBe('reliable')
    expect(resolvedReliability('weak', 50, false, thresholds)).toBe('weak')
  })

  it.each(['toString', 'constructor', '__proto__'])('non accetta il nome ereditato %s come classificazione', (value) => {
    expect(resolvedReliability(value, 2)).toBe('exploratory')
  })

  it.each([NaN, Infinity, -Infinity])('non inventa evidenza per un campione non finito %s', (games) => {
    expect(resolvedReliability(undefined, games)).toBe('exploratory')
  })

  it('usa le soglie ESS senza promuovere un segnale non operativo', () => {
    expect(resolvedReliability(undefined, 2.9)).toBe('exploratory')
    expect(resolvedReliability(undefined, 3)).toBe('weak')
    expect(resolvedReliability(undefined, 8)).toBe('indicative')
    expect(resolvedReliability(undefined, 20)).toBe('indicative')
    expect(resolvedReliability(undefined, 20, true)).toBe('reliable')
    expect(resolvedReliability('reliable', 20, false)).toBe('indicative')
  })

  it('tiene gli esplorativi dietro un consenso esplicito', () => {
    expect(isVisibleReliability('exploratory', 'weak', false)).toBe(false)
    expect(isVisibleReliability('exploratory', 'reliable', true)).toBe(true)
    expect(isVisibleReliability('weak', 'indicative', true)).toBe(false)
    expect(isVisibleReliability('reliable', 'indicative', false)).toBe(true)
  })

  it('rende leggibile la sorgente del prior', () => {
    expect(priorSourceLabel('comparable_accounts')).toBe('account comparabili')
  })

  it.each(['neutral_50', ' Neutral-50 ', 'neutral 50'])(
    'localizza il prior neutro normalizzato %s',
    (source) => {
      expect(priorSourceLabel(source)).toBe('ipotesi neutra al 50%')
    },
  )
})
