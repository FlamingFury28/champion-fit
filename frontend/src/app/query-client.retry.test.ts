import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScopeSnapshot } from '../api/client'
import { playstyleEvidenceQuery, playstyleQueryKeys, playstylesQuery, type PlaystyleDays, type PlaystyleEvidenceResponse, type PlaystyleFilters, type PlaystylesResponse } from '../api/playstyles'
import type { AlgorithmSettingsResponseDto } from '../api/types'
import { RECOMMENDED_ALGORITHM_SETTINGS } from './algorithm-settings'
import { queryClient } from './query-client'

const originalDefaults = queryClient.getDefaultOptions()
const settingsKey = ['api', 'algorithm-settings'] as const
const scope: ScopeSnapshot = { accounts: ['Beta#EUW', 'Alpha#EUW'], companion: null, algorithmRevision: 4 }
const filters: PlaystyleFilters = { role: 'MIDDLE', queue: '420', days: '90', category: 'mage' }

function overview(days: PlaystyleDays): PlaystylesResponse {
  return {
    version: 'synthetic-retry',
    catalog: { version: 'synthetic', source_version: 'synthetic', sources: [], categories: [] },
    filters: { role: 'MIDDLE', queue: '420', days },
    options: { roles: ['MIDDLE'], queues: [{ id: '420', label: 'Classificata singola' }], pairs: [] },
    summary: { unique_games: 0, observations: 0, accounts: 2, classified_games: 0, unclassified_games: 0, metrics_games: 0, supported_categories: 0 },
    categories: [], behavior: [],
    suggestions: { category_id: 'mage', exploratory: true, played: [], untried: [] },
    notes: [],
  }
}

function evidence(): PlaystyleEvidenceResponse {
  return {
    category_id: 'mage', page: 2, page_size: 20, total: 21,
    matches: [{ account: 'Alpha#EUW', match_id: 'SYNTH-RETRY-21', champion: 'Ahri', role: 'MIDDLE', queue: '420', date: '2026-10-10T12:00:00Z', win: true, duration_minutes: 30, note: 'Prova sintetica' }],
  }
}

function settings(revision: number): AlgorithmSettingsResponseDto {
  return {
    revision, fingerprint: `synthetic-${revision}`,
    settings: structuredClone(RECOMMENDED_ALGORITHM_SETTINGS),
    defaults: structuredClone(RECOMMENDED_ALGORITHM_SETTINGS), schema: [], history: [],
  }
}

function stubApi(reply: (url: URL, attempt: number) => Response | Promise<Response>) {
  const requests: URL[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    requests.push(url)
    if ((init?.method ?? 'GET') !== 'GET') throw new Error('Unexpected write')
    return reply(url, requests.length)
  }))
  return requests
}

function periodApi() {
  return stubApi((url) => {
    if (url.pathname !== '/api/playstyles' && url.pathname !== '/api/playstyle-evidence') throw new Error('Unexpected endpoint')
    const days = url.searchParams.get('days')
    // The common API validates exact period tokens, independently of the client.
    if (days !== '90' && days !== '180' && days !== '365' && days !== 'all') {
      return Response.json({ error: 'days deve essere 90, 180, 365 oppure all' }, { status: 400 })
    }
    return Response.json(url.pathname === '/api/playstyles' ? overview(days) : evidence())
  })
}

beforeEach(() => {
  queryClient.clear()
  // Exercise the production retry predicate; only remove its scheduling delay.
  queryClient.setDefaultOptions({ ...originalDefaults, queries: { ...originalDefaults.queries, retryDelay: 0 } })
})

afterEach(() => {
  queryClient.clear()
  queryClient.setDefaultOptions(originalDefaults)
  vi.unstubAllGlobals()
})

describe('retry HTTP del QueryClient di produzione', () => {
  it('non ripete il 400 degli stili e consente un solo nuovo GET per il refetch esplicito', async () => {
    const requests = periodApi()
    const defaults = { ...filters, days: '180' }
    const previous = overview('180')
    queryClient.setQueryData(playstyleQueryKeys.overview(scope, defaults), previous)
    const raw = { ...filters, days: 'unknown' }
    const query = playstylesQuery(scope, raw)

    await expect(queryClient.fetchQuery(query)).rejects.toMatchObject({ status: 400 })
    expect.soft(requests).toHaveLength(1)
    expect(queryClient.getQueryState(query.queryKey)).toMatchObject({ status: 'error', fetchStatus: 'idle', error: { status: 400 } })
    expect(queryClient.getQueryData(query.queryKey)).toBeUndefined()

    await queryClient.refetchQueries({ queryKey: query.queryKey, exact: true })

    expect.soft(requests).toHaveLength(2)
    expect(requests.every((url) => url.pathname === '/api/playstyles' && url.searchParams.get('days') === 'unknown')).toBe(true)
    expect(requests[0]?.searchParams.getAll('account')).toEqual(['Alpha#EUW', 'Beta#EUW'])
    expect(queryClient.getQueryCache().findAll({ queryKey: ['api', 'playstyles'] })).toHaveLength(2)
    expect(queryClient.getQueryData(playstyleQueryKeys.overview(scope, defaults))).toEqual(previous)
    expect(queryClient.getQueryState(query.queryKey)?.error).toMatchObject({ status: 400 })
  })

  it('non ripete il 400 delle prove e conserva una cache distinta quando il periodo diventa valido', async () => {
    const requests = periodApi()
    const raw = { ...filters, days: '\ufeffall' }
    const invalid = playstyleEvidenceQuery(scope, raw, 'mage', 2)

    await expect(queryClient.fetchQuery(invalid)).rejects.toMatchObject({ status: 400 })
    expect.soft(requests).toHaveLength(1)
    expect(queryClient.getQueryState(invalid.queryKey)).toMatchObject({ status: 'error', error: { status: 400 } })
    expect(queryClient.getQueryData(invalid.queryKey)).toBeUndefined()

    const valid = playstyleEvidenceQuery(scope, filters, 'mage', 2)
    await expect(queryClient.fetchQuery(valid)).resolves.toEqual(evidence())

    expect.soft(requests).toHaveLength(2)
    expect(requests.every((url) => url.pathname === '/api/playstyle-evidence')).toBe(true)
    expect(requests[0]?.searchParams.get('days')).toBe(raw.days)
    expect(requests.at(-1)?.searchParams.get('days')).toBe('90')
    expect(requests.at(-1)?.searchParams.get('page')).toBe('2')
    expect(requests.at(-1)?.searchParams.get('page_size')).toBe('20')
    expect(queryClient.getQueryCache().findAll({ queryKey: ['api', 'playstyle-evidence'] })).toHaveLength(2)
    expect(queryClient.getQueryData(valid.queryKey)).toEqual(evidence())
    expect(queryClient.getQueryState(invalid.queryKey)?.error).toMatchObject({ status: 400 })
  })

  it('recupera un errore di rete con un solo tentativo aggiuntivo', async () => {
    const response = overview('90')
    const requests = stubApi((url, attempt) => {
      if (url.pathname !== '/api/playstyles') throw new Error('Unexpected endpoint')
      if (attempt === 1) throw new TypeError('Failed to fetch')
      return Response.json(response)
    })
    const query = playstylesQuery(scope, filters)

    await expect(queryClient.fetchQuery(query)).resolves.toEqual(response)

    expect(requests.map((url) => url.pathname)).toEqual(['/api/playstyles', '/api/playstyles'])
    expect(queryClient.getQueryState(query.queryKey)).toMatchObject({ status: 'success', fetchStatus: 'idle', error: null })
    expect(queryClient.getQueryData(query.queryKey)).toEqual(response)
  })

  it('limita a due GET un 503 persistente senza ricaricare la configurazione', async () => {
    const requests = stubApi(() => Response.json({ error: 'Server temporaneamente indisponibile' }, { status: 503 }))
    const query = playstylesQuery(scope, filters)

    await expect(queryClient.fetchQuery(query)).rejects.toMatchObject({ status: 503 })

    expect(requests.map((url) => url.pathname)).toEqual(['/api/playstyles', '/api/playstyles'])
    expect(queryClient.getQueryState(query.queryKey)).toMatchObject({ status: 'error', fetchStatus: 'idle', error: { status: 503 } })
    expect(queryClient.getQueryData(query.queryKey)).toBeUndefined()
  })

  it('ripete un JSON 200 interrotto senza memorizzarlo come dato valido', async () => {
    const response = overview('90')
    let release!: (value: Response) => void
    const secondResponse = new Promise<Response>((resolve) => { release = resolve })
    const requests = stubApi((url, attempt) => {
      if (url.pathname !== '/api/playstyles') throw new Error('Unexpected endpoint')
      if (attempt === 1) return new Response('{"summary":', { headers: { 'Content-Type': 'application/json' } })
      return secondResponse
    })
    const query = playstylesQuery(scope, filters)
    const pending = queryClient.fetchQuery(query)

    try {
      await vi.waitFor(() => expect(requests).toHaveLength(2))
      expect(queryClient.getQueryState(query.queryKey)).toMatchObject({ status: 'pending', fetchStatus: 'fetching', fetchFailureReason: { status: 200 } })
      expect(queryClient.getQueryData(query.queryKey)).toBeUndefined()
    } finally {
      release(Response.json(response))
    }

    await expect(pending).resolves.toEqual(response)
    expect(requests.map((url) => url.pathname)).toEqual(['/api/playstyles', '/api/playstyles'])
    expect(queryClient.getQueryData(query.queryKey)).toEqual(response)
  })

  it('non ripete il 409 originale e recupera una sola nuova revisione delle impostazioni', async () => {
    const current = settings(4)
    const fresh = settings(5)
    queryClient.setQueryData(settingsKey, current)
    const requests = stubApi((url) => {
      if (url.pathname === '/api/playstyles') return Response.json({ error: 'Configuration changed' }, { status: 409 })
      if (url.pathname === '/api/algorithm-settings') return Response.json(fresh)
      throw new Error('Unexpected endpoint')
    })
    const query = playstylesQuery(scope, filters)

    await expect(queryClient.fetchQuery(query)).rejects.toMatchObject({ status: 409 })
    await vi.waitFor(() => expect(queryClient.getQueryData(settingsKey)).toEqual(fresh))

    expect(requests.map((url) => url.pathname)).toEqual(['/api/playstyles', '/api/algorithm-settings'])
    expect(requests[0]?.searchParams.get('algorithm_revision')).toBe('4')
    expect(queryClient.getQueryState(query.queryKey)).toMatchObject({ status: 'error', fetchStatus: 'idle', error: { status: 409 } })
    expect(queryClient.getQueryState(settingsKey)).toMatchObject({ status: 'success', fetchStatus: 'idle', error: null })
    expect(queryClient.getQueryData(query.queryKey)).toBeUndefined()
  })
})
