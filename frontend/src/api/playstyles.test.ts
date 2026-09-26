import { QueryClient } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { playstyleEvidenceQuery, playstyleQueryKeys, playstylesQuery, type PlaystyleFilters } from './playstyles'
import type { ScopeSnapshot } from './client'

const scope: ScopeSnapshot = { accounts: ['Beta#EUW', 'Alpha#EUW'], companion: null }
const filters: PlaystyleFilters = { days: '180', role: 'MIDDLE', queue: '420' }

afterEach(() => vi.unstubAllGlobals())

describe('query degli stili', () => {
  it('isola tutti i filtri, la categoria e la pagina senza placeholder', () => {
    const baseline = playstyleQueryKeys.overview(scope, filters)
    for (const change of [{ days: '90' as const }, { role: 'TOP' }, { queue: '440' }, { category: 'tank' }]) {
      expect(playstyleQueryKeys.overview(scope, { ...filters, ...change })).not.toEqual(baseline)
    }
    expect(playstyleQueryKeys.overview({ ...scope, accounts: ['Alpha#EUW'] }, filters)).not.toEqual(baseline)
    expect(playstyleQueryKeys.overview({ ...scope, accounts: [...scope.accounts].reverse() }, filters)).toEqual(baseline)
    const proof = playstyleQueryKeys.evidence(scope, filters, 'mage', 1, 20)
    expect(playstyleQueryKeys.evidence(scope, filters, 'mage', 2, 20)).not.toEqual(proof)
    expect(playstyleQueryKeys.evidence(scope, filters, 'tank', 1, 20)).not.toEqual(proof)
    expect(playstyleQueryKeys.evidence(scope, filters, 'mage', 1, 50)).not.toEqual(proof)
    expect(playstylesQuery(scope, filters).placeholderData).toBeUndefined()
    expect(playstyleEvidenceQuery(scope, filters, 'mage').placeholderData).toBeUndefined()
  })

  it('trasmette scope compagni, filtri completi e AbortSignal alle prove', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ matches: [] }), { headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetch)
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const scoped: ScopeSnapshot = { ...scope, companion: { name: 'Amici', accounts: ['Friend#EUW'], profileAccounts: scope.accounts, mode: 'only' } }
    await client.fetchQuery(playstyleEvidenceQuery(scoped, filters, 'mage', 3))
    const [url, request] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    const params = new URL(url, 'http://localhost').searchParams
    expect(params.getAll('account')).toEqual(['Alpha#EUW', 'Beta#EUW'])
    expect(params.getAll('companion_account')).toEqual(['Friend#EUW'])
    expect(params.get('companion_mode')).toBe('only')
    expect(params.get('role')).toBe('MIDDLE')
    expect(params.get('queue')).toBe('420')
    expect(params.get('days')).toBe('180')
    expect(params.get('category')).toBe('mage')
    expect(params.get('page')).toBe('3')
    expect(request.signal).toBeInstanceOf(AbortSignal)
    client.clear()
  })

  it('lascia al server ruolo e coda automatici quando non sono espliciti', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('{}'))
    vi.stubGlobal('fetch', fetch)
    const client = new QueryClient()
    await client.fetchQuery(playstylesQuery(scope, { days: 'all' }))
    const params = new URL(fetch.mock.calls[0]?.[0] as string, 'http://localhost').searchParams
    expect(params.has('role')).toBe(false)
    expect(params.has('queue')).toBe(false)
    expect(params.get('days')).toBe('all')
    client.clear()
  })
})
