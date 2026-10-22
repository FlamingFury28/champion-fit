import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RecommendationsResponseDto } from '../api/types'
import { discoveryRecommendation, observedRecommendation, recommendationsFixture } from '../test/recommendations-fixture'
import { ChampionDetailPage } from './ChampionDetailPage'
import { FitPage } from './FitPage'
import { ScoutPage } from './ScoutPage'
import { TestPlanPage } from './TestPlanPage'

vi.mock('../app/scope', () => ({ useScope: () => ({
  scope: {
    accounts: ['Alpha#EUW', 'Beta#EUW'], algorithmRevision: 4,
    companion: { name: 'Compagno sintetico', accounts: ['Gamma#EUW'], mode: 'exclude', profileAccounts: ['Alpha#EUW', 'Beta#EUW'] },
  }, scopeReady: true,
}) }))

const consumers = [
  { id: 'fit', periodKey: 'days', path: '/app/fit', route: '/app/fit', element: <FitPage /> },
  { id: 'scout', periodKey: 'days', path: '/app/fit', route: '/app/fit', element: <ScoutPage embedded /> },
  { id: 'plan', periodKey: 'days', path: '/app/fit', route: '/app/fit', element: <TestPlanPage embedded /> },
  { id: 'detail-embedded', periodKey: 'detailDays', path: '/app/fit', route: '/app/fit', element: <ChampionDetailPage champion="Ahri" embedded /> },
  { id: 'detail-standalone', periodKey: 'days', path: '/direct/Ahri', route: '/direct/:champion', element: <ChampionDetailPage /> },
] as const
type Consumer = typeof consumers[number]
const navigationState = { championSheetFromList: true, source: 'synthetic-period-test' }
const disposables: (() => void)[] = []
const periodError = 'Periodo non valido: scegli 90, 180, 365 giorni o tutto lo storico'

function responseFor(days: '1' | '90' | '180' | '365' | 'all'): RecommendationsResponseDto {
  // Six distinct synthetic facts, all older than the configured one-day default.
  // Fixed windows are explicit examples rather than a frontend normalization oracle.
  const games = { '1': 0, '90': 4, '180': 5, '365': 6, all: 6 }[days]
  const accountGames = games ? { 'Alpha#EUW': 4, ...(games > 4 ? { 'Beta#EUW': games - 4 } : {}) } : {}
  const activeAccounts = Object.keys(accountGames)
  const missingAccounts = ['Alpha#EUW', 'Beta#EUW'].filter((account) => !activeAccounts.includes(account))
  const base = observedRecommendation()
  const candidate = games ? observedRecommendation({
    games, account_count: activeAccounts.length, selected_account_count: 2,
    performance: {
      ...base.performance!, games, observations: games, wins: games, losses: 0,
      missing_accounts: missingAccounts,
      per_account: Object.fromEntries(Object.entries(accountGames).map(([account, count]) => [account, { games: count, wins: count, losses: 0, win_rate: 100 }])),
    },
  }) : discoveryRecommendation({ champion: 'Ahri', name: 'Ahri', source_champions: [] })
  const discover = [discoveryRecommendation(), discoveryRecommendation({ champion: 'Sona', name: 'Sona' })]
  return recommendationsFixture({
    context: {
      accounts: ['Alpha#EUW', 'Beta#EUW'], role: 'MIDDLE', queue: 'all', days,
      period: { value: days === 'all' ? 0 : Number(days), unit: 'days' },
      suspended_accounts: [], unresolved_accounts: [],
    },
    coverage: { selected_accounts: ['Alpha#EUW', 'Beta#EUW'], active_accounts: activeAccounts, missing_accounts: missingAccounts, games, observations: games },
    profile: [], known: games ? [candidate] : [], discover, candidate,
    trial_plan: { budget: 2, items: discover.map((item) => ({ champion: item.champion, role: item.role, games: 1, reason: 'Proposta sintetica di catalogo.' })) },
  })
}

function setup(consumer: Consumer, rawDays: string | null) {
  const requests: URL[] = []
  const responses: RecommendationsResponseDto[] = []
  const writes: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    if ((init?.method ?? 'GET') !== 'GET') {
      writes.push(init!.method!)
      throw new Error('Unexpected write')
    }
    if (url.pathname === '/api/recommendation-feedback') return Response.json({
      revision: 7, accounts: ['Alpha#EUW', 'Beta#EUW'], suspended_accounts: [], unresolved_accounts: [], items: [], options: [], catalog_version: 'synthetic',
    })
    if (url.pathname !== '/api/recommendations') throw new Error('Unexpected request')
    requests.push(url)
    // The recommendation HTTP contract recognizes exactly "0" as legacy all.
    // Whitespace, case and BOM are deliberately not normalized by this mock.
    const raw = url.searchParams.get('days')
    const days = raw === null ? '1' : raw === '0' ? 'all' : raw
    if (days !== '1' && days !== '90' && days !== '180' && days !== '365' && days !== 'all') {
      return Response.json({ error: periodError }, { status: 400 })
    }
    // Explicit days=1 is not a public option: it is only the configured default.
    if (raw === '1') return Response.json({ error: periodError }, { status: 400 })
    const data = responseFor(days)
    responses.push(data)
    return Response.json(data)
  }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  const params = new URLSearchParams({
    section: consumer.id === 'fit' ? 'choices' : 'training', training: consumer.id === 'plan' ? 'plan' : 'discover',
    role: 'MID', detailRole: 'MID', queue: 'ALL', detailQueue: 'all', days: '90', detailDays: 'unknown',
    search: ' ', tag: 'ALL', minSimilarity: '0', budget: '1000',
  })
  params.delete(consumer.periodKey)
  if (rawDays !== null) params.set(consumer.periodKey, rawDays)
  const initialParams = new URLSearchParams(params)
  const router = createMemoryRouter([{ path: consumer.route, element: consumer.element }], {
    initialEntries: [{ pathname: consumer.path, search: `?${params}`, state: navigationState }],
  })
  disposables.push(() => { router.dispose(); client.clear() })
  render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>)
  return { consumer, requests, responses, writes, client, router, initialParams, user: userEvent.setup() }
}
type State = ReturnType<typeof setup>

function expectContextPreserved(state: State, periodChanged = false) {
  const current = new URLSearchParams(state.router.state.location.search)
  for (const [key, value] of state.initialParams) {
    if (!periodChanged || key !== state.consumer.periodKey) expect(current.get(key)).toBe(value)
  }
  expect(state.router.state.location.pathname).toBe(state.consumer.path)
  if (!periodChanged || state.consumer.id.startsWith('detail')) expect(state.router.state.location.state).toEqual(navigationState)
  const request = state.requests.at(-1)!
  expect(request.searchParams.getAll('account')).toEqual(['Alpha#EUW', 'Beta#EUW'])
  expect(request.searchParams.getAll('companion_account')).toEqual(['Gamma#EUW'])
  expect(request.searchParams.get('companion_mode')).toBe('exclude')
  expect(request.searchParams.get('algorithm_revision')).toBe('4')
  expect(request.searchParams.get('role')).toBe('MIDDLE')
  expect(request.searchParams.get('queue')).toBe('all')
  expect(request.searchParams.get('champion')).toBe(state.consumer.id.startsWith('detail') ? 'Ahri' : null)
  expect(state.writes).toEqual([])
}

async function expectRendered(state: State, games: number) {
  if (state.consumer.id === 'fit') {
    expect(await screen.findByText(new RegExp(`^${games} partite uniche e ${games} osservazioni`))).toBeVisible()
  } else if (state.consumer.id === 'scout') {
    expect(await screen.findByText(/^Contesto effettivo:/)).toBeVisible()
  } else if (state.consumer.id === 'plan') {
    expect(await screen.findByRole('region', { name: 'Piano di prove' })).toBeVisible()
  } else {
    const region = await screen.findByRole('region', { name: 'Scheda di Ahri · Corsia centrale' })
    const metric = within(region).getByText('Partite uniche').closest<HTMLElement>('.metric-card')!
    expect(within(metric).getByText(String(games), { selector: 'strong' })).toBeVisible()
  }
  expect(state.responses.at(-1)!.coverage.observations).toBe(games)
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
}

async function chooseDefault(state: State) {
  await state.user.selectOptions(screen.getByRole('combobox', { name: /^Periodo$/ }), '')
  await waitFor(() => expect(state.requests).toHaveLength(2))
  expect(state.requests[1]!.searchParams.has('days')).toBe(false)
  expect(new URLSearchParams(state.router.state.location.search).has('days')).toBe(false)
  const select = screen.getByRole('combobox', { name: /^Periodo$/ })
  expect(select).toHaveValue('')
  expect(within(select).getByRole('option', { selected: true })).toHaveTextContent('Predefinito')
  await expectRendered(state, 0)
  expect(state.responses.at(-1)!.context.period).toEqual({ value: 1, unit: 'days' })
  expectContextPreserved(state, true)
}

afterEach(() => {
  cleanup()
  disposables.splice(0).forEach((dispose) => dispose())
  vi.unstubAllGlobals()
})

for (const consumer of consumers) describe(`periodo recommendation ${consumer.id}`, () => {
  it('usa tutto lo storico e la stessa cache per 0 e all senza riscrivere il link', async () => {
    const state = setup(consumer, '0')
    await expectRendered(state, 6)
    expect.soft(state.requests[0]!.searchParams.get('days')).toBe('all')
    expect(state.responses[0]!.context.period).toEqual({ value: 0, unit: 'days' })
    if (consumer.id === 'fit') expect.soft(screen.getByRole('combobox', { name: /^Periodo$/ })).toHaveValue('all')
    expectContextPreserved(state)

    const next = new URL(state.router.state.location.pathname + state.router.state.location.search, 'http://localhost')
    next.searchParams.set(consumer.periodKey, 'all')
    await act(() => state.router.navigate(next.pathname + next.search, { state: navigationState }))
    await expectRendered(state, 6)
    expect(state.requests).toHaveLength(1)
    expect(state.client.getQueriesData({ queryKey: ['api', 'recommendations'] })).toHaveLength(1)
    expectContextPreserved(state, true)
  })
})

describe('selettore periodo dei suggerimenti', () => {
  it('mostra Tutto lo storico per 0 e passa al default di un giorno solo scegliendo Predefinito', async () => {
    const state = setup(consumers[0], '0')
    await expectRendered(state, 6)
    const select = screen.getByRole('combobox', { name: /^Periodo$/ })
    expect.soft(select).toHaveValue('all')
    expect.soft(within(select).getByRole('option', { selected: true })).toHaveTextContent('Tutto lo storico')
    expectContextPreserved(state)
    await chooseDefault(state)
  })

  it.each([' 0 ', 'unknown', 'ALL', '\ufeffall\ufeff'])('conserva il 400 per %j e consente il recupero esplicito', async (raw) => {
    const state = setup(consumers[0], raw)
    expect(await screen.findByRole('alert')).toHaveTextContent(periodError)
    expect(state.requests).toHaveLength(1)
    expect(state.requests[0]!.searchParams.get('days')).toBe(raw)
    const select = screen.getByRole('combobox', { name: /^Periodo$/ })
    expect(select).toHaveValue(raw)
    const selected = within(select).getByRole('option', { selected: true })
    expect(selected).toHaveTextContent('Periodo del link')
    expect(selected).toBeDisabled()
    expectContextPreserved(state)
    await chooseDefault(state)
  })

  it.each([
    { days: '90', games: 4 }, { days: '180', games: 5 }, { days: '365', games: 6 },
  ])('mantiene il periodo esplicito $days', async ({ days, games }) => {
    const state = setup(consumers[0], days)
    await expectRendered(state, games)
    expect(state.requests[0]!.searchParams.get('days')).toBe(days)
    expect(screen.getByRole('combobox', { name: /^Periodo$/ })).toHaveValue(days)
    expect(state.responses[0]!.context.period).toEqual({ value: Number(days), unit: 'days' })
    expectContextPreserved(state)
  })

  it.each([null, ''])('mantiene omissione e Predefinito per %j', async (raw) => {
    const state = setup(consumers[0], raw)
    await expectRendered(state, 0)
    expect(state.requests[0]!.searchParams.has('days')).toBe(false)
    expect(screen.getByRole('combobox', { name: /^Periodo$/ })).toHaveValue('')
    expect(state.responses[0]!.context.period).toEqual({ value: 1, unit: 'days' })
    expectContextPreserved(state)
  })
})

describe('precedenza del periodo della scheda', () => {
  it('eredita il periodo esterno quando detailDays manca', async () => {
    const state = setup(consumers[3], null)
    await expectRendered(state, 4)
    expect(state.requests[0]!.searchParams.get('days')).toBe('90')
    expectContextPreserved(state)
  })

  it('mantiene detailDays vuoto come omissione esplicita senza ereditare 90', async () => {
    const state = setup(consumers[3], '')
    await expectRendered(state, 0)
    expect(state.requests[0]!.searchParams.has('days')).toBe(false)
    expect(state.responses[0]!.context.period).toEqual({ value: 1, unit: 'days' })
    expect(new URLSearchParams(state.router.state.location.search).get('detailDays')).toBe('')
    expectContextPreserved(state)
  })

  it('continua a ignorare detailDays nella scheda standalone', async () => {
    const state = setup(consumers[4], '90')
    await expectRendered(state, 4)
    expect(state.requests[0]!.searchParams.get('days')).toBe('90')
    expect(new URLSearchParams(state.router.state.location.search).get('detailDays')).toBe('unknown')
    expectContextPreserved(state)
  })
})
