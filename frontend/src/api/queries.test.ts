import { describe, expect, it, vi } from 'vitest'
import { championsQuery, matchupsQuery, queryKeys, recommendationEvidenceQuery, recommendationsQuery, retainScopedPlaceholder, synergyQueryInput, trainingPlanQuery } from './queries'
import type { ScopeSnapshot } from './client'

const alphaScope: ScopeSnapshot = { accounts: ['Alpha#EUW'], companion: null }
const betaScope: ScopeSnapshot = { accounts: ['Beta#EUW'], companion: null }

describe('placeholder delle query scoped', () => {
  it('conserva i dati precedenti soltanto per una query senza filtri nello stesso scope', () => {
    const previous = { items: ['Ahri'] }
    const previousQuery = { queryKey: queryKeys.overview(alphaScope) }

    expect(retainScopedPlaceholder(alphaScope, previous, previousQuery)).toBe(previous)
  })

  it('non conserva i risultati filtrati dei campioni durante il cambio filtro', () => {
    expect(championsQuery(alphaScope, { role: 'MIDDLE', status: 'all', search: 'Ahri' }).placeholderData).toBeUndefined()
  })

  it('inoltra modalità e periodo alla classifica dei campioni', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('{"items":[]}', { headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetch)
    const filters = { role: 'MIDDLE', status: 'ALL', search: '', queue: '440', days: '90' }
    const query = championsQuery(alphaScope, filters)
    await query.queryFn!({ signal: new AbortController().signal } as never)
    const params = new URL(String(fetch.mock.calls[0]?.[0]), 'http://localhost').searchParams
    expect(params.get('queue')).toBe('440')
    expect(params.get('days')).toBe('90')
    expect(query.queryKey).toEqual(queryKeys.champions(alphaScope, filters))
    vi.unstubAllGlobals()
  })

  it('invia il budget e lo stesso contesto al piano competitivo', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('{"items":[]}', { headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetch)
    const query = trainingPlanQuery(alphaScope, 400, 'MIDDLE', { queue: '440', days: '90' })
    await query.queryFn!({ signal: new AbortController().signal } as never)
    const params = new URL(String(fetch.mock.calls[0]?.[0]), 'http://localhost').searchParams
    expect(params.get('budget')).toBe('400')
    expect(params.get('queue')).toBe('440')
    expect(params.get('days')).toBe('90')
    vi.unstubAllGlobals()
  })

  it('rimuove i dati precedenti quando cambia lo scope account', () => {
    const previous = { champion: 'Ahri' }
    const previousQuery = { queryKey: queryKeys.overview(alphaScope) }

    expect(retainScopedPlaceholder(betaScope, previous, previousQuery)).toBeUndefined()
  })

  it('serializza i filtri di affidabilità della synergy senza una soglia raw di game', () => {
    const filters = { minReliability: 'indicative' as const, includeExploratory: true }

    expect(synergyQueryInput(alphaScope, 'Ahri', filters)).toEqual({
      account: ['Alpha#EUW'],
      champion: 'Ahri',
      min_reliability: 'indicative',
      include_exploratory: 1,
      queue: undefined,
      days: undefined,
    })
    expect(queryKeys.synergy(alphaScope, 'Ahri', filters)[4]).toEqual(filters)
  })

  it('trasmette coda e periodo alla synergy', () => {
    expect(synergyQueryInput(alphaScope, 'Ahri', {
      minReliability: 'indicative', includeExploratory: false, queue: '440', days: '365',
    })).toMatchObject({ champion: 'Ahri', queue: '440', days: '365' })
  })

  it('include coda e periodo nelle chiavi e nelle richieste matchup', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('{}', { headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetch)
    const filters = { queue: '440', days: '90' }
    const query = matchupsQuery(alphaScope, 'Ahri', 'MIDDLE', filters)
    expect(query.queryKey).toEqual(queryKeys.matchups(alphaScope, 'Ahri', 'MIDDLE', filters))
    await query.queryFn!({ signal: new AbortController().signal } as never)
    const params = new URL(String(fetch.mock.calls[0]?.[0]), 'http://localhost').searchParams
    expect(params.get('queue')).toBe('440')
    expect(params.get('days')).toBe('90')
    vi.unstubAllGlobals()
  })

  it('isola le partite delle raccomandazioni per scope, champion, ruolo e pagina', () => {
    const base = queryKeys.recommendationEvidence(alphaScope, 'Ahri', 'MIDDLE')
    expect(queryKeys.recommendationEvidence(betaScope, 'Ahri', 'MIDDLE')).not.toEqual(base)
    expect(queryKeys.recommendationEvidence(alphaScope, 'Lux', 'MIDDLE')).not.toEqual(base)
    expect(queryKeys.recommendationEvidence(alphaScope, 'Ahri', 'SUPPORT')).not.toEqual(base)
    expect(queryKeys.recommendationEvidence(alphaScope, 'Ahri', 'MIDDLE', 20)).not.toEqual(base)
    expect(queryKeys.recommendationEvidence(alphaScope, 'Ahri', 'MIDDLE', 0, 50)).not.toEqual(base)
    expect(recommendationEvidenceQuery(alphaScope, 'Ahri', 'MIDDLE').placeholderData).toBeUndefined()
  })

  it('isola il nuovo motore per scope e per ogni filtro senza placeholder', () => {
    const filters = { role: 'MIDDLE', queue: '420', days: 'all', champion: 'Ahri' }
    const base = queryKeys.recommendations(alphaScope, filters)
    expect(queryKeys.recommendations(betaScope, filters)).not.toEqual(base)
    expect(queryKeys.recommendations(alphaScope, { ...filters, role: 'TOP' })).not.toEqual(base)
    expect(queryKeys.recommendations(alphaScope, { ...filters, queue: '440' })).not.toEqual(base)
    expect(queryKeys.recommendations(alphaScope, { ...filters, days: '90' })).not.toEqual(base)
    expect(queryKeys.recommendations(alphaScope, { ...filters, champion: 'Lux' })).not.toEqual(base)
    expect(recommendationsQuery(alphaScope, filters).placeholderData).toBeUndefined()
    expect(recommendationsQuery(alphaScope, filters).retry).toBe(false)
  })
})
