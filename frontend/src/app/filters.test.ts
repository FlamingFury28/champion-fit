import { describe, expect, it, vi } from 'vitest'
import { clampInteger, fitStatus, formatDate, normalizeRole, pct } from './filters'

describe('normalizzazione filtri e adapter view-model', () => {
  it('normalizza i ruoli e accetta il legacy UTILITY', () => {
    expect(normalizeRole('middle')).toBe('MIDDLE')
    expect(normalizeRole('UTILITY')).toBe('SUPPORT')
    expect(normalizeRole('invalid')).toBe('ALL')
  })

  it('applica clamp e fallback all’allocation', () => {
    expect(clampInteger('4', 20, 2000, 400)).toBe(20)
    expect(clampInteger('9000', 20, 2000, 400)).toBe(2000)
    expect(clampInteger('abc', 20, 2000, 400)).toBe(400)
  })

  it('adatta gli stati senza reinterpretare i dati wire', () => {
    expect(fitStatus({ record_kind: 'screen', validated_positive: 0, blacklist_strong: 0, blacklist_provisional: 0, allocated_games: 0 }).label).toBe('Valutazione preliminare')
    expect(fitStatus({ record_kind: 'observed', validated_positive: 1, blacklist_strong: 0, blacklist_provisional: 0, allocated_games: 0 }).tone).toBe('positive')
    expect(fitStatus({ record_kind: 'account', validated_positive: 0, blacklist_strong: 0, blacklist_provisional: 0, allocated_games: 0, actionable: true })).toEqual({ label: 'Vantaggio supportato', tone: 'positive' })
    expect(fitStatus({ record_kind: 'account', validated_positive: 1, blacklist_strong: 1, blacklist_provisional: 0, allocated_games: 20, actionable: false })).toEqual({ label: 'Da verificare', tone: 'warning' })
    expect(fitStatus({ record_kind: 'observed', validated_positive: 0, blacklist_strong: 1, blacklist_provisional: 0, allocated_games: 20 }).tone).toBe('negative')
  })

  it('formatta null e valori percentuali in modo stabile', () => {
    expect(pct(null)).toBe('—')
    expect(pct(51.25, 1)).toMatch(/^51[,.]3%$/)
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-08-24T12:00:00Z'))
    expect(formatDate(null)).toBe('—')
    vi.useRealTimers()
  })
})
