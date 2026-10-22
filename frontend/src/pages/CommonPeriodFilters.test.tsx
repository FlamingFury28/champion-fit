import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChampionPerformancePage } from './ChampionPerformancePage'
import { ChampionsPage } from './ChampionsPage'
import { CompetitivePlanPage } from './CompetitivePlanPage'

vi.mock('../app/scope', () => ({ useScope: () => ({
  scope: { accounts: ['Alpha#EUW', 'Beta#EUW'], companion: null, algorithmRevision: 4 },
  scopeReady: true, availableAccounts: [],
}) }))

const pages = [
  { id: 'best', endpoint: '/api/champions', query: 'champions', component: ChampionPerformancePage, firstEnabled: '', recoveredDays: '180' },
  { id: 'tournament', endpoint: '/api/training-plan', query: 'training-plan', component: CompetitivePlanPage, firstEnabled: '', recoveredDays: '180' },
  { id: 'matchups', endpoint: '/api/matchups', query: 'matchups', component: ChampionsPage, firstEnabled: 'all', recoveredDays: 'all' },
] as const
type Page = typeof pages[number]
type Period = '90' | '180' | '365' | 'all'
const disposables: (() => void)[] = []
const periodError = 'days deve essere 90, 180, 365 oppure all'

function fixture(page: Page, days: Period) {
  // Six synthetic observations, with four in 90 days and five in the configured
  // 180-day default. The common endpoint accepts only these exact wire tokens.
  const games = { '90': 4, '180': 5, '365': 6, all: 6 }[days]
  const context = { accounts: ['Alpha#EUW', 'Beta#EUW'], role: 'MIDDLE', queue: '420', days, observations: games, unique_games: games }
  if (page.id === 'matchups') return {
    champion: 'ALL', role: 'MIDDLE', context, games, wins: games, win_rate: 100,
    games_with_opponents: games, baseline_win_rate: 50,
    available_champions: [{ champion: 'Ahri', games, icon_url: '' }], loses_to: [], beats: [],
  }
  return {
    context, algorithm_revision: 4,
    model: { validated: false, message: 'Confronto sintetico esplorativo.' },
    budget_total: 1000, budget_default: 400, budget_assigned: 1000, budget_unassigned: 0,
    items: [{
      champion: 'Ahri', role: 'MIDDLE', icon_url: '', games, games_observed: games, unique_games: games,
      posterior_win_rate: 56, credible_lower_90: 30, credible_upper_90: 80, credible_mass: .9,
      posterior_lift_pp: 6, classification: 'promising', historical_supported: false,
      account_coverage: 2, account_count: 2, allocation_games: 1000,
      account_allocations: [{ account: 'Alpha#EUW', games: 500 }, { account: 'Beta#EUW', games: 500 }],
    }],
  }
}

function setup(page: Page, rawDays: string | null) {
  const requests: URL[] = []
  const responses: { context: { days: string; observations: number } }[] = []
  const writes: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    if ((init?.method ?? 'GET') !== 'GET') {
      writes.push(init!.method!)
      throw new Error('Unexpected write')
    }
    if (url.pathname !== page.endpoint) throw new Error('Unexpected request')
    requests.push(url)
    const requested = url.searchParams.get('days')
    const days = requested ?? '180'
    if (days !== '90' && days !== '180' && days !== '365' && days !== 'all') {
      return Response.json({ error: periodError }, { status: 400 })
    }
    const data = fixture(page, days)
    responses.push(data)
    return Response.json(data)
  }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  const params = new URLSearchParams({
    section: page.id, relation: 'enemies', role: 'MIDDLE', queue: '420', search: ' Ahri ', budget: '1000',
    account: 'Alpha#EUW',
  })
  params.append('account', 'Beta#EUW')
  if (rawDays !== null) params.set('days', rawDays)
  const initialParams = new URLSearchParams(params)
  const router = createMemoryRouter([{ path: '/app/fit', element: <page.component embedded /> }], {
    initialEntries: [`/app/fit?${params}`],
  })
  disposables.push(() => { router.dispose(); client.clear() })
  render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>)
  return { page, requests, responses, writes, client, router, initialParams, user: userEvent.setup(), select: screen.getByRole('combobox', { name: 'Periodo' }) }
}
type State = ReturnType<typeof setup>

function expectPreservedContext(state: State, periodChanged = false) {
  const current = new URLSearchParams(state.router.state.location.search)
  for (const [key, value] of state.initialParams) {
    if (key === 'account') continue
    if (!periodChanged || key !== 'days') expect(current.get(key)).toBe(value)
  }
  expect(current.getAll('account')).toEqual(['Alpha#EUW', 'Beta#EUW'])
  expect(state.router.state.location.pathname).toBe('/app/fit')
  const request = state.requests.at(-1)!
  expect(request.searchParams.getAll('account')).toEqual(['Alpha#EUW', 'Beta#EUW'])
  expect(request.searchParams.get('algorithm_revision')).toBe('4')
  expect(request.searchParams.get('role')).toBe('MIDDLE')
  expect(request.searchParams.get('queue')).toBe('420')
  if (state.page.id === 'best') expect(request.searchParams.get('search')).toBe(' Ahri ')
  if (state.page.id === 'tournament') {
    expect(request.searchParams.get('budget')).toBe('1000')
    expect(screen.getByRole('spinbutton', { name: 'Budget partite' })).toHaveValue(1000)
  }
  expect(state.writes).toEqual([])
}

function queries(state: State) {
  return state.client.getQueryCache().findAll({ queryKey: ['api', state.page.query] })
}

async function expectSuccess(state: State, days: Period) {
  const games = { '90': 4, '180': 5, '365': 6, all: 6 }[days]
  if (state.page.id === 'matchups') {
    expect(await screen.findByRole('option', { name: `Ahri · ${games} partite` })).toBeInTheDocument()
    expect(screen.getByText(/^Contesto effettivo:/)).toHaveTextContent(days === 'all' ? 'tutto lo storico' : `ultimi ${days} giorni`)
  } else {
    const row = await screen.findByRole('row', { name: /Ahri/ })
    expect(within(row).getAllByRole('cell')[1]).toHaveTextContent(new RegExp(`^${games}$`))
    expect(screen.getByText(days === 'all' ? 'tutto lo storico' : `ultimi ${days} giorni`, { exact: true })).toBeVisible()
  }
  expect(state.responses.at(-1)!.context.days).toBe(days)
  expect(state.responses.at(-1)!.context.observations).toBe(games)
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
}

function expectLinkedPeriod(state: State, raw: string, label = 'Periodo del link') {
  expect.soft(state.select).toHaveValue(raw)
  const selected = within(state.select).getByRole('option', { selected: true })
  expect.soft(selected).toHaveTextContent(label)
  expect.soft(selected).toBeDisabled()
}

async function chooseFirstEnabled(state: State) {
  const firstEnabled = (within(state.select).getAllByRole('option') as HTMLOptionElement[]).find((option) => !option.disabled)!
  expect(firstEnabled.value).toBe(state.page.firstEnabled)
  await state.user.selectOptions(state.select, firstEnabled.value)
  await state.user.tab()
  await waitFor(() => expect(state.requests).toHaveLength(2))
  const expected = state.page.firstEnabled || null
  expect(state.requests[1]!.searchParams.get('days')).toBe(expected)
  expect(new URLSearchParams(state.router.state.location.search).get('days')).toBe(expected)
  expect(state.select).toHaveValue(state.page.firstEnabled)
  await expectSuccess(state, state.page.recoveredDays)
  expect(queries(state)).toHaveLength(2)
  expectPreservedContext(state, true)
}

afterEach(() => {
  cleanup()
  disposables.splice(0).forEach((dispose) => dispose())
  vi.unstubAllGlobals()
})

describe('recupero del periodo nelle analisi comuni', () => {
  it.each([
    { page: pages[0], raw: 'unknown' }, { page: pages[0], raw: '0' },
    { page: pages[1], raw: '\ufeffall\ufeff' }, { page: pages[1], raw: '0' },
    { page: pages[2], raw: ' 90 ' }, { page: pages[2], raw: '0' },
  ])('mantiene $raw in $page.id e recupera attraverso la prima opzione abilitata', async ({ page, raw }) => {
    const state = setup(page, raw)
    expect(await screen.findByRole('alert')).toHaveTextContent(periodError)
    expect(state.requests).toHaveLength(1)
    expect(state.requests[0]!.searchParams.get('days')).toBe(raw)
    expect(queries(state)).toHaveLength(1)
    expect(queries(state)[0]!.queryKey.at(-1)).toMatchObject({ days: raw })
    expectLinkedPeriod(state, raw)
    expectPreservedContext(state)
    await chooseFirstEnabled(state)

    if (raw === '0') {
      const direct = new URLSearchParams(state.router.state.location.search)
      direct.set('days', '0')
      await act(() => state.router.navigate(`/app/fit?${direct}`))
      await waitFor(() => expect(state.requests).toHaveLength(3))
      expect(await screen.findByRole('alert')).toHaveTextContent(periodError)
      expect(state.requests[2]!.searchParams.get('days')).toBe('0')
      expectLinkedPeriod(state, '0')
      expect(queries(state)).toHaveLength(2)
      expectPreservedContext(state)
    }
  })

  it.each([
    { page: pages[0], raw: '90' as const }, { page: pages[1], raw: '180' as const },
    { page: pages[2], raw: '365' as const }, { page: pages[0], raw: 'all' as const },
  ])('conserva il periodo valido $raw in $page.id', async ({ page, raw }) => {
    const state = setup(page, raw)
    await expectSuccess(state, raw)
    expect(state.requests).toHaveLength(1)
    expect(state.requests[0]!.searchParams.get('days')).toBe(raw)
    expect(state.select).toHaveValue(raw)
    expect(queries(state)[0]!.queryKey.at(-1)).toMatchObject({ days: raw })
    expectPreservedContext(state)
  })

  it.each(pages.flatMap((page) => [null, ''].map((raw) => ({ page, raw }))))(
    'mantiene il default distinto per $page.id con days=$raw', async ({ page, raw }) => {
      const state = setup(page, raw)
      const aggregate = page.id === 'matchups' && raw === null
      await expectSuccess(state, aggregate ? 'all' : '180')
      expect(state.requests).toHaveLength(1)
      expect(state.requests[0]!.searchParams.get('days')).toBe(aggregate ? 'all' : null)
      expect(queries(state)[0]!.queryKey.at(-1)).toMatchObject({ days: page.id === 'matchups' ? aggregate ? 'all' : '' : undefined })
      expectPreservedContext(state)
      if (page.id === 'matchups' && raw === '') {
        expectLinkedPeriod(state, '', 'Periodo predefinito')
        await chooseFirstEnabled(state)
      } else {
        expect(state.select).toHaveValue(aggregate ? 'all' : '')
      }
    },
  )
})
