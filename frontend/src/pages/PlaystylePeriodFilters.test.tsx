import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ScopeSnapshot } from '../api/client'
import { playstyleEvidenceQuery, playstyleQueryKeys, playstylesQuery, type PlaystyleDays, type PlaystyleEvidenceResponse, type PlaystyleFilters, type PlaystylesResponse } from '../api/playstyles'
import { queryKeys } from '../api/queries'
import { AlgorithmSettingsProvider, RECOMMENDED_ALGORITHM_SETTINGS } from '../app/algorithm-settings'
import { DATA_VIEW_STORAGE_KEY, dataViewStore } from '../app/data-view'
import { playstyleDaysFromSettings, PlaystyleSuggestionsPanel, PlaystylesPage } from './PlaystylesPage'

const scope: ScopeSnapshot = { accounts: ['Alpha#EUW', 'Beta#EUW'], companion: null, algorithmRevision: 4 }
vi.mock('../app/scope', () => ({ useScope: () => ({ scope, scopeReady: true }) }))
const disposables: (() => void)[] = []
const periodError = 'days deve essere 90, 180, 365 oppure all'

function fixture(days: PlaystyleDays): PlaystylesResponse {
  const games = { '90': 4, '180': 5, '365': 6, all: 6 }[days]
  const champion = days === '90' ? 'Ahri' : 'Lux'
  const untried = days === '90' ? 'Orianna' : 'Sona'
  const definition = { id: 'mage', label: 'Maghi', kind: 'class', criteria: 'Danni magici', roles: ['MIDDLE'], sources: [] }
  return {
    version: 'synthetic-period', catalog: { version: 'synthetic', source_version: 'synthetic', sources: [], categories: [definition] },
    filters: { role: 'MIDDLE', queue: '420', days },
    options: { roles: ['MIDDLE'], queues: [{ id: '420', label: 'Classificata singola' }], pairs: [] },
    summary: { unique_games: games, observations: games, accounts: 2, classified_games: games, unclassified_games: 0, metrics_games: 0, supported_categories: 0 },
    categories: [{
      ...definition, games, observations: games, wins: games, losses: 0, mean: 100, lower: 40, upper: 100,
      baseline_mean: null, baseline_games: 0, lift: null, supported: false, status: 'exploratory', reasons: [],
      account_count: 2, comparable_accounts: 0, missing_accounts: [], missing_baseline_accounts: [...scope.accounts],
      support_per_account: { 'Alpha#EUW': { games: 3, baseline_games: 0 }, 'Beta#EUW': { games: games - 3, baseline_games: 0 } },
      prior_share: 1, threshold: 99, family_size: 1,
      composition: [{ champion, name: champion, games, wins: games, losses: 0 }], sensitivity: null,
    }],
    behavior: [],
    suggestions: {
      category_id: 'mage', exploratory: true,
      played: [{ champion, name: champion, games, wins: games, losses: 0, mean: 100, lower: 40, upper: 100 }],
      untried: [{ champion: untried, name: untried, similarity: .75, label: 'Proposta sintetica', roles: ['MIDDLE'] }],
    }, notes: [],
  }
}

function evidence(days: string, page = 1): PlaystyleEvidenceResponse {
  return {
    category_id: 'mage', page, page_size: 20, total: 1,
    matches: [{ account: 'Alpha#EUW', match_id: `SYNTH-${days}`, champion: 'Ahri', role: 'MIDDLE', queue: '420',
      date: '2026-10-10T12:00:00Z', win: true, duration_minutes: 30, note: `Finestra ${days}` }],
  }
}

function stubApi() {
  const requests: URL[] = []
  const writes: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    if ((init?.method ?? 'GET') !== 'GET') {
      writes.push(init!.method!)
      throw new Error('Unexpected write')
    }
    if (!['/api/playstyles', '/api/playstyle-evidence'].includes(url.pathname)) throw new Error('Unexpected request')
    requests.push(url)
    const days = url.searchParams.get('days')
    // Common analysis validates exact tokens before descriptive normalization.
    // This closed API fixture never consults playstyleFiltersFromParams.
    if (days !== '90' && days !== '180' && days !== '365' && days !== 'all') {
      return Response.json({ error: periodError }, { status: 400 })
    }
    return Response.json(url.pathname === '/api/playstyles' ? fixture(days) : evidence(days, Number(url.searchParams.get('page'))))
  }))
  return { requests, writes }
}

function createClient(category: string | undefined = 'mage') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.algorithmSettings, { settings: RECOMMENDED_ALGORITHM_SETTINGS, revision: 4 })
  const defaults = { role: 'MIDDLE', queue: '420', days: '180' as const, category }
  client.setQueryData(playstyleQueryKeys.overview(scope, defaults), fixture('180'))
  disposables.push(() => client.clear())
  return { client, defaults }
}

function setup(surface: 'page' | 'panel', rawDays: string | null, category = true) {
  const api = stubApi()
  const { client } = createClient(category ? 'mage' : undefined)
  const params = new URLSearchParams({ role: 'MIDDLE', queue: '420', search: ' ', budget: '1000' })
  if (category) params.set('category', 'mage')
  if (surface === 'panel') params.set('section', 'training')
  if (rawDays !== null) params.set('days', rawDays)
  const initialParams = new URLSearchParams(params)
  const path = surface === 'page' ? '/app/playstyles' : '/app/fit'
  const router = createMemoryRouter([{ path, element: surface === 'page' ? <PlaystylesPage /> : <PlaystyleSuggestionsPanel /> }], {
    initialEntries: [`${path}?${params}`],
  })
  disposables.push(() => router.dispose())
  render(<QueryClientProvider client={client}><AlgorithmSettingsProvider><RouterProvider router={router} /></AlgorithmSettingsProvider></QueryClientProvider>)
  return { ...api, client, router, initialParams, path, surface, user: userEvent.setup() }
}
type State = ReturnType<typeof setup>

function expectContext(state: State, daysChanged = false) {
  const current = new URLSearchParams(state.router.state.location.search)
  for (const [key, value] of state.initialParams) if (!daysChanged || key !== 'days') expect(current.get(key)).toBe(value)
  expect(state.router.state.location.pathname).toBe(state.path)
  for (const request of state.requests) {
    expect(request.searchParams.getAll('account')).toEqual(['Alpha#EUW', 'Beta#EUW'])
    expect(request.searchParams.get('algorithm_revision')).toBe('4')
    expect(request.searchParams.get('role')).toBe('MIDDLE')
    expect(request.searchParams.get('queue')).toBe('420')
    expect(request.searchParams.get('category')).toBe('mage')
  }
  expect(state.writes).toEqual([])
}

function overviewQueries(state: State) {
  return state.client.getQueryCache().findAll({ queryKey: ['api', 'playstyles'] })
}

async function expectRecoveredPage(state: State) {
  await screen.findByRole('heading', { name: 'Con quali categorie vinci?' })
  const metrics = screen.getByRole('region', { name: 'Copertura dell’analisi stili' })
  const metric = within(metrics).getByText('Partite uniche').closest<HTMLElement>('.metric-card')!
  expect(metric.querySelector('strong')).toHaveTextContent(/^4$/)
  const link = screen.getAllByRole('link', { name: 'Esplora i campioni · Maghi' })[0]!
  const destination = new URL(link.getAttribute('href')!, 'http://localhost')
  expect(destination.searchParams.get('days')).toBe('90')
  expect(destination.searchParams.get('role')).toBe('MIDDLE')
  expect(destination.searchParams.get('queue')).toBe('420')
  expect(destination.searchParams.get('category')).toBe('mage')
  await state.user.click(screen.getByRole('button', { name: 'Perché Maghi?' }))
  await state.user.click(screen.getByRole('button', { name: 'Mostra le partite · Maghi' }))
  const proof = await screen.findByRole('region', { name: 'Partite a supporto di Maghi' })
  expect(proof).toHaveTextContent('SYNTH-90')
  const request = state.requests.at(-1)!
  expect(request.pathname).toBe('/api/playstyle-evidence')
  expect(request.searchParams.get('days')).toBe('90')
  expect(request.searchParams.get('page')).toBe('1')
  expect(request.searchParams.get('page_size')).toBe('20')
}

afterEach(() => {
  cleanup()
  disposables.splice(0).forEach((dispose) => dispose())
  vi.unstubAllGlobals()
  dataViewStore.dispose()
  localStorage.removeItem(DATA_VIEW_STORAGE_KEY)
})

describe('periodo esplicito degli stili con default già presente in cache', () => {
  it.each([
    { surface: 'page' as const, raw: 'unknown' }, { surface: 'page' as const, raw: '0' }, { surface: 'page' as const, raw: 'ALL' },
    { surface: 'panel' as const, raw: '\ufeffall\ufeff' }, { surface: 'panel' as const, raw: ' 90 ' }, { surface: 'panel' as const, raw: ' \u0085\u001c ' },
  ])('conserva il 400 per $raw in $surface e recupera solo dopo una scelta esplicita', async ({ surface, raw }) => {
    const state = setup(surface, raw)
    await waitFor(() => expect(state.client.isFetching()).toBe(0))
    expect.soft(state.requests).toHaveLength(1)
    expect.soft(state.requests[0]?.searchParams.get('days')).toBe(raw)
    expect.soft(screen.queryByRole('alert')).toHaveTextContent(periodError)
    expect.soft(overviewQueries(state)).toHaveLength(2)
    expect.soft(overviewQueries(state).map((query) => query.queryKey[3])).toContainEqual(expect.objectContaining({ days: raw }))
    if (surface === 'page') {
      const select = screen.getByRole('combobox', { name: 'Periodo degli stili' })
      expect.soft(select).toHaveValue(raw)
      const selected = within(select).getByRole('option', { selected: true })
      expect.soft(selected).toHaveTextContent('Periodo del link')
      expect.soft(selected).toBeDisabled()
      expect.soft(screen.queryByRole('heading', { name: 'Con quali categorie vinci?' })).not.toBeInTheDocument()
    } else {
      expect.soft(screen.queryByRole('heading', { name: 'Già giocati' })).not.toBeInTheDocument()
      expect.soft(screen.queryByRole('link', { name: 'Lux' })).not.toBeInTheDocument()
      expect.soft(screen.queryByRole('link', { name: 'Sona' })).not.toBeInTheDocument()
    }
    expectContext(state)

    if (surface === 'page') {
      await state.user.selectOptions(screen.getByRole('combobox', { name: 'Periodo degli stili' }), '90')
      await state.user.tab()
    } else {
      const next = new URLSearchParams(state.router.state.location.search)
      next.set('days', '90')
      await act(() => state.router.navigate(`${state.path}?${next}`))
    }
    await waitFor(() => expect(state.requests).toHaveLength(2))
    expect(state.requests[1]!.searchParams.get('days')).toBe('90')
    expect(new URLSearchParams(state.router.state.location.search).get('days')).toBe('90')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(overviewQueries(state)).toHaveLength(3)
    if (surface === 'page') await expectRecoveredPage(state)
    else {
      const champion = await screen.findByRole('link', { name: 'Ahri' })
      expect(screen.getByRole('link', { name: 'Orianna' })).toBeVisible()
      const href = new URL(champion.getAttribute('href')!, 'http://localhost')
      expect(href.searchParams.get('days')).toBe('90')
      expect(href.searchParams.get('detailRole')).toBe('MIDDLE')
    }
    expectContext(state, true)
  })

  it.each([
    { surface: 'page' as const, raw: '90' as const }, { surface: 'page' as const, raw: '180' as const },
    { surface: 'panel' as const, raw: '365' as const }, { surface: 'panel' as const, raw: 'all' as const },
  ])('mantiene il periodo valido $raw in $surface', async ({ surface, raw }) => {
    const state = setup(surface, raw)
    if (surface === 'page') {
      await screen.findByRole('heading', { name: 'Con quali categorie vinci?' })
      expect(screen.getByRole('combobox', { name: 'Periodo degli stili' })).toHaveValue(raw)
    } else await screen.findByRole('heading', { name: 'Già giocati' })
    expect(state.requests).toHaveLength(raw === '180' ? 0 : 1)
    if (raw !== '180') expect(state.requests[0]!.searchParams.get('days')).toBe(raw)
    expectContext(state)
  })

  it.each((['page', 'panel'] as const).flatMap((surface) => [null, ''].map((raw) => ({ surface, raw }))))(
    'usa il default configurato per days=$raw in $surface senza riscrivere il link', async ({ surface, raw }) => {
      const state = setup(surface, raw)
      if (surface === 'page') expect(screen.getByRole('combobox', { name: 'Periodo degli stili' })).toHaveValue('180')
      else expect(screen.getByRole('link', { name: 'Lux' })).toBeVisible()
      expect(state.requests).toHaveLength(0)
      expect(overviewQueries(state)).toHaveLength(1)
      expectContext(state)
    },
  )

  it('non richiede suggerimenti senza una categoria, anche con periodo invalido', async () => {
    const state = setup('panel', 'unknown', false)
    await act(async () => undefined)
    expect(state.requests).toHaveLength(0)
    expect(screen.queryByRole('heading', { name: 'Già giocati' })).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expectContext(state)
  })

  it('mantiene la sanitizzazione delle impostazioni separate dai valori espliciti del link', () => {
    for (const value of [undefined, null, 'unknown', 0, 'ALL', '\ufeffall\ufeff']) expect(playstyleDaysFromSettings(value)).toBe('180')
  })
})

describe('trasporto API del periodo stili esplicito', () => {
  it.each([{ endpoint: 'overview', raw: '0' }, { endpoint: 'evidence', raw: '\ufeffall\ufeff' }])(
    'lascia al server il 400 $endpoint per $raw senza riusare il default', async ({ endpoint, raw }) => {
      const api = stubApi()
      const { client, defaults } = createClient()
      client.setQueryData(playstyleQueryKeys.evidence(scope, defaults, 'mage', 2, 20), evidence('180', 2))
      const filters: PlaystyleFilters = { role: 'MIDDLE', queue: '420', days: raw, category: 'mage' }
      if (endpoint === 'overview') await expect(client.fetchQuery(playstylesQuery(scope, filters))).rejects.toMatchObject({ status: 400 })
      else await expect(client.fetchQuery(playstyleEvidenceQuery(scope, filters, 'mage', 2, 20))).rejects.toMatchObject({ status: 400 })
      expect(api.requests).toHaveLength(1)
      expect(api.requests[0]!.searchParams.get('days')).toBe(raw)
      expect(api.requests[0]!.searchParams.get('role')).toBe('MIDDLE')
      expect(api.requests[0]!.searchParams.get('queue')).toBe('420')
      expect(api.requests[0]!.searchParams.get('category')).toBe('mage')
      if (endpoint === 'evidence') {
        expect(api.requests[0]!.searchParams.get('page')).toBe('2')
        expect(api.requests[0]!.searchParams.get('page_size')).toBe('20')
      }
      expect(client.getQueryData(playstyleQueryKeys.overview(scope, defaults))).toBeDefined()
      expect(api.writes).toEqual([])
    },
  )
})
