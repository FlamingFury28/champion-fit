import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { queryKeys } from '../api/queries'
import type { AccountDto, MatchupsResponseDto, RecommendationsResponseDto } from '../api/types'
import { AlgorithmSettingsProvider, RECOMMENDED_ALGORITHM_SETTINGS } from '../app/algorithm-settings'
import { PROFILE_ACCOUNTS_KEY, ScopeProvider } from '../app/scope'
import { observedRecommendation, recommendationsFixture } from '../test/recommendations-fixture'
import { ChampionsHubPage } from './ChampionsHubPage'

const account = 'Owned#EUW'
const disposables: (() => void)[] = []
const accountFixture: AccountDto = {
  account, aliases: [], raw_games: 6, eligible_games: 6, analyzed_games: 6,
  wins: 6, games: 6, first_game: null, last_game: null,
}

// The separate real HTTP audit verifies these six facts on SQLite and PG:
// two older Solo games, then four Flex games. REC defaults are auto/latest2;
// the common page defaults to all queues/all history, with empty days using180.
const facts = ['420', '420', '440', '440', '440', '440']

interface Exchange {
  url: URL
  status: number
  body: MatchupsResponseDto | RecommendationsResponseDto | { error: string }
}

function reply(url: URL): Omit<Exchange, 'url'> {
  const common = url.pathname === '/api/matchups'
  const requestedDays = url.searchParams.get('days')
  const days = requestedDays ?? (common ? '180' : 'all')
  if (!['90', '180', '365', 'all'].includes(days)) {
    return { status: 400, body: { error: 'days deve essere 90, 180, 365 oppure all' } }
  }
  const queue = url.searchParams.get('queue') ?? (common ? '420' : '440')
  const matches = facts.filter((item) => queue === 'all' || item === queue)
  const gamesPeriod = !common && requestedDays === null
  const games = gamesPeriod ? Math.min(2, matches.length) : matches.length
  const context = { accounts: [account], role: 'MIDDLE', queue, days, observations: games, unique_games: games }
  if (common) return { status: 200, body: {
    champion: 'ALL', role: 'MIDDLE', games, wins: games, win_rate: 100,
    games_with_opponents: games, baseline_win_rate: 50, loses_to: [], beats: [],
    available_champions: [{ champion: 'Ahri', games, icon_url: '' }], context,
  } }
  const base = observedRecommendation()
  const candidate = observedRecommendation({
    games, account_count: 1,
    performance: { ...base.performance!, games, observations: games, wins: games, losses: 0,
      per_account: { [account]: { games, wins: games, losses: 0, win_rate: 100 } }, missing_baseline_accounts: [account] },
  })
  return { status: 200, body: recommendationsFixture({
    context: { ...context, period: gamesPeriod ? { unit: 'games', value: 2 }
      : { unit: 'days', value: days === 'all' ? 0 : Number(days) }, suspended_accounts: [], unresolved_accounts: [] },
    candidate, known: [candidate], discover: [],
    coverage: { selected_accounts: [account], active_accounts: [account], missing_accounts: [], games, observations: games },
    trial_plan: { budget: 0, items: [] },
  }) }
}

function mount(initial: string, exchanges: Exchange[], writes: string[]) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    if ((init?.method ?? 'GET') !== 'GET') {
      writes.push(`${init?.method} ${url.pathname}`)
      throw new Error('Unexpected write')
    }
    if (url.pathname !== '/api/matchups' && url.pathname !== '/api/recommendations') {
      throw new Error(`Unexpected endpoint ${url.pathname}`)
    }
    const response = reply(url)
    exchanges.push({ url, ...response })
    return Response.json(response.body, { status: response.status })
  }))
  const settings = { ...structuredClone(RECOMMENDED_ALGORITHM_SETTINGS),
    recommendations: { limit: 6, trial_budget: 3, confidence: 0.9, queue: 'auto', period: { unit: 'games', value: 2 } },
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } })
  client.setQueryData(queryKeys.accounts, { items: [accountFixture] })
  client.setQueryData(queryKeys.algorithmSettings, {
    revision: 4, fingerprint: 'owned-memory', settings, defaults: RECOMMENDED_ALGORITHM_SETTINGS, history: [], schema: [],
  })
  const router = createMemoryRouter([{ path: '/app/fit', element: <ChampionsHubPage /> }], { initialEntries: [initial] })
  const rendered = render(<QueryClientProvider client={client}><AlgorithmSettingsProvider><ScopeProvider>
    <RouterProvider router={router} />
  </ScopeProvider></AlgorithmSettingsProvider></QueryClientProvider>)
  const dispose = () => { rendered.unmount(); router.dispose(); client.clear() }
  disposables.push(dispose)
  return { client, router, dispose, exchanges, writes }
}

function setup(queue: string | null, days: string | null, stale = false) {
  localStorage.clear()
  localStorage.setItem(PROFILE_ACCOUNTS_KEY, JSON.stringify([account]))
  const params = new URLSearchParams({
    section: 'matchups', relation: 'enemies', role: 'MIDDLE', search: ' keep ', budget: '1000', view: 'known',
  })
  if (queue !== null) params.set('queue', queue)
  if (days !== null) params.set('days', days)
  if (stale) { params.set('detailRole', 'SUPPORT'); params.set('detailQueue', '999'); params.set('detailDays', '365') }
  const initial = `/app/fit?${params}`
  return { ...mount(initial, [], []), initial, params }
}
type State = ReturnType<typeof setup>

async function chooseChampion() {
  const selector = screen.getByRole('combobox', { name: 'Che campione vuoi giocare?' })
  await waitFor(() => expect(selector).toBeEnabled())
  fireEvent.change(selector, { target: { value: 'Ahri' } })
  return screen.findByRole('region', { name: 'Scheda di Ahri · Corsia centrale' })
}

function location(state: Pick<State, 'router'>) {
  return state.router.state.location.pathname + state.router.state.location.search
}

async function expectSheet(state: Pick<State, 'router' | 'exchanges' | 'writes'>, sourceParams: URLSearchParams,
  queue: string, days: string, games: number) {
  const region = await screen.findByRole('region', { name: 'Scheda di Ahri · Corsia centrale' })
  const detail = state.exchanges.filter((entry) => entry.url.pathname === '/api/recommendations').at(-1)
  expect(detail?.status).toBe(200)
  const response = detail?.body as RecommendationsResponseDto
  expect.soft(detail?.url.searchParams.get('queue')).toBe(queue)
  expect.soft(detail?.url.searchParams.get('days')).toBe(days)
  expect(detail?.url.searchParams.get('champion')).toBe('Ahri')
  expect(detail?.url.searchParams.get('role')).toBe('MIDDLE')
  expect(detail?.url.searchParams.getAll('account')).toEqual([account])
  expect(detail?.url.searchParams.get('algorithm_revision')).toBe('4')
  expect.soft(response.context.queue).toBe(queue)
  expect.soft(response.context.period).toEqual({ unit: 'days', value: days === 'all' ? 0 : Number(days) })
  expect.soft(response.candidate?.performance?.games).toBe(games)
  const metric = within(region).getByText('Partite uniche').closest('.metric-card')!
  expect.soft(metric.querySelector('strong')).toHaveTextContent(new RegExp(`^${games}$`))
  const expected = new URLSearchParams(sourceParams)
  for (const key of ['detail', 'detailRole', 'detailQueue', 'detailDays']) expected.delete(key)
  expected.set('detail', 'Ahri')
  expected.set('detailRole', 'MIDDLE')
  expected.set('detailQueue', queue)
  expected.set('detailDays', days)
  expect.soft(Object.fromEntries(new URLSearchParams(state.router.state.location.search))).toEqual(Object.fromEntries(expected))
  expect(state.writes).toEqual([])
}

afterEach(() => {
  disposables.splice(0).reverse().forEach((dispose) => dispose())
  cleanup()
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('contesto della scheda aperta dai confronti', () => {
  it.each([
    { name: 'entrambi omessi', queue: null, days: null, effectiveQueue: 'all', effectiveDays: 'all', games: 6 },
    { name: 'solo coda omessa', queue: null, days: 'all', effectiveQueue: 'all', effectiveDays: 'all', games: 6 },
    { name: 'solo periodo omesso', queue: 'all', days: null, effectiveQueue: 'all', effectiveDays: 'all', games: 6 },
    { name: 'tutto esplicito', queue: 'all', days: 'all', effectiveQueue: 'all', effectiveDays: 'all', games: 6 },
    { name: 'coda e periodo concreti', queue: '440', days: '90', effectiveQueue: '440', effectiveDays: '90', games: 4 },
    { name: 'periodo vuoto usa il default comune', queue: 'all', days: '', effectiveQueue: 'all', effectiveDays: '180', games: 6 },
  ])('conserva entrambe le dimensioni effettive: $name', async ({ queue, days, effectiveQueue, effectiveDays, games }) => {
    const state = setup(queue, days)
    await chooseChampion()
    const source = state.exchanges[0]!.body as MatchupsResponseDto
    expect(source.context?.queue).toBe(effectiveQueue)
    expect(String(source.context?.days)).toBe(effectiveDays)
    expect(source.games).toBe(games)
    await expectSheet(state, state.params, effectiveQueue, effectiveDays, games)
    expect(state.exchanges).toHaveLength(2)
    expect(state.router.state.location.state).toEqual({ championSheetFromList: true })
  })

  it('mantiene il contesto in Indietro/Avanti, chiusura e remount completo della URL', async () => {
    const state = setup(null, null)
    await chooseChampion()
    const sheetUrl = location(state)
    await expectSheet(state, state.params, 'all', 'all', 6)
    await act(async () => { await state.router.navigate(-1) })
    expect(location(state)).toBe(state.initial)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await act(async () => { await state.router.navigate(1) })
    await expectSheet(state, state.params, 'all', 'all', 6)
    expect(location(state)).toBe(sheetUrl)
    fireEvent.click(screen.getByRole('button', { name: 'Chiudi' }))
    await waitFor(() => expect(location(state)).toBe(state.initial))
    expect(state.exchanges).toHaveLength(2)
    state.dispose()
    const reloaded = mount(sheetUrl, state.exchanges, state.writes)
    await expectSheet(reloaded, state.params, 'all', 'all', 6)
    expect(reloaded.router.state.location.state).toBe(null)
    fireEvent.click(screen.getByRole('button', { name: 'Chiudi' }))
    await waitFor(() => expect(location(reloaded)).toBe(state.initial))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(state.exchanges).toHaveLength(4)
  })

  it('sostituisce gli override di una scheda precedente senza modificare i filtri della lista', async () => {
    const state = setup(null, null, true)
    await chooseChampion()
    await expectSheet(state, state.params, 'all', 'all', 6)
    fireEvent.click(screen.getByRole('button', { name: 'Chiudi' }))
    await waitFor(() => expect(location(state)).toBe(state.initial))
    expect(state.exchanges).toHaveLength(2)
  })

  it('mantiene il periodo invalido e impedisce di aprire una scheda senza contesto valido', async () => {
    const state = setup(null, 'invalid')
    expect(await screen.findByRole('alert')).toHaveTextContent('days deve essere 90, 180, 365 oppure all')
    expect(screen.getByRole('combobox', { name: 'Che campione vuoi giocare?' })).toBeDisabled()
    expect(screen.getByRole('combobox', { name: 'Periodo' })).toHaveValue('invalid')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(state.exchanges).toHaveLength(1)
    expect(state.exchanges[0]!.status).toBe(400)
    expect(location(state)).toBe(state.initial)
    expect(state.writes).toEqual([])
  })
})
