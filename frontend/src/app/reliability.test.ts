import { describe, expect, it } from 'vitest'
import { isVisibleReliability, priorSourceLabel, resolvedReliability } from './reliability'

describe('presentazione affidabilità', () => {
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
