import { afterEach, describe, expect, it, vi } from 'vitest'
import { canonicalRole, clampInteger, fitStatus, formatDate, normalizeRole, pct } from './filters'

describe('normalizzazione filtri e adapter view-model', () => {
  it.each([
    [null, ''], ['', ''], [' \t\u0085\u001c ', ''],
    [' utility ', 'SUPPORT'], ['\u0085support\u0085', 'SUPPORT'],
    ['\u001ctop\u001f', 'TOP'], ['middle', 'MIDDLE'], ['ALL', 'ALL'],
    [' MID ', 'MID'], [' ADC ', 'ADC'], [' invalid ', 'INVALID'],
    ['SUP PORT', 'SUP PORT'], ['\ufeffutility', '\ufeffUTILITY'], ['utility\ufeff', 'UTILITY\ufeff'],
  ])('canonizza %j preservando anche i ruoli sconosciuti', (value, expected) => {
    expect(canonicalRole(value)).toBe(expected)
  })

  it('normalizza i ruoli e accetta il legacy UTILITY', () => {
    expect(normalizeRole('middle')).toBe('MIDDLE')
    expect(normalizeRole('UTILITY')).toBe('SUPPORT')
    expect(normalizeRole('invalid')).toBe('ALL')
  })

  it.each([
    [' \tutility\r\n', 'SUPPORT'],
    ['\u0085SUPPORT\u0085', 'SUPPORT'],
    ['\u001cTOP\u001f', 'TOP'],
    ['\u00a0middle\u3000', 'MIDDLE'],
    [' jungle ', 'JUNGLE'],
    [' bottom ', 'BOTTOM'],
  ])('riconosce il ruolo %j con lo strip Python', (value, expected) => {
    expect(normalizeRole(value)).toBe(expected)
  })

  it.each([null, '', ' \u0085\u001c ', 'MID', 'ADC', 'unknown', '\ufeffutility', 'utility\ufeff', 'SUP PORT'])(
    'mantiene il fallback ALL per %j senza accettare BOM o nuovi alias', (value) => {
      expect(normalizeRole(value)).toBe('ALL')
    },
  )

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

describe('date locali e convenzione UTC esplicita', () => {
  afterEach(() => vi.unstubAllEnvs())

  it.each([
    ['Europe/Rome', '2026-09-24T23:30:00.000000+00:00', '25/09/2026', '24/09/2026'],
    ['America/New_York', '2026-09-25T00:30:00.000000+00:00', '24/09/2026', '25/09/2026'],
  ])('mantiene il default locale in %s e usa UTC solo su richiesta', (timezone, value, localDate, utcDate) => {
    vi.stubEnv('TZ', timezone)
    expect(formatDate(value)).toBe(localDate)
    expect(formatDate(value, { timeZone: 'UTC' })).toBe(utcDate)
  })

  it.each([null, undefined, '', 'data non valida'])('mantiene il fallback per %j anche con UTC', (value) => {
    expect(formatDate(value, { timeZone: 'UTC' })).toBe(value || '—')
  })
})
