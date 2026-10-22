import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SynergyResponseDto } from '../api/types'
import { SynergyPage } from './SynergyPage'

vi.mock('../app/scope', () => ({ useScope: () => ({
  scope: { accounts: ['Alpha#EUW', 'Beta#EUW'], companion: null, algorithmRevision: 4 },
  state: { companion: null }, scopeReady: true,
  availableAccounts: [{ account: 'Alpha#EUW' }, { account: 'Beta#EUW' }],
  setAccounts: vi.fn(), clearCompanion: vi.fn(),
}) }))

const disposables: (() => void)[] = []
const periodError = 'days deve essere 90, 180, 365 oppure all'
type Period = '90' | '180' | '365' | 'all'

function responseFor(days: Period): SynergyResponseDto {
  // Six closed synthetic observations: four within 90 days, another within
  // 180 days, and the last within 365 days. This is an API response fixture.
  const games = { '90': 4, '180': 5, '365': 6, all: 6 }[days]
  return {
    champion: 'Ahri', accounts: ['Alpha#EUW', 'Beta#EUW'], companion_filter_active: false,
    context: { role: 'SUPPORT', queue: '440', days, observations: games },
    min_reliability: 'indicative', include_exploratory: true, min_games: 1,
    games, games_with_teammates: games,
    coverage: { raw_games: 6, eligible_games: 6, analyzed_games: games, games_with_roster: games, roster_coverage: 100 },
    available_champions: [{ champion: 'Ahri', games, icon_url: '' }],
    better_with: [], worse_with: [],
  }
}

function setup(rawDays: string | null) {
  const requests: URL[] = []
  const writes: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    if ((init?.method ?? 'GET') !== 'GET') {
      writes.push(init!.method!)
      throw new Error('Unexpected write')
    }
    if (url.pathname !== '/api/synergy') throw new Error('Unexpected request')
    requests.push(url)
    const days = url.searchParams.get('days')
    // Common analysis validates before any descriptive strip/lower operation.
    // In particular, recommendation-only days=0 has no meaning on this route.
    if (days !== '90' && days !== '180' && days !== '365' && days !== 'all') {
      return Response.json({ error: periodError }, { status: 400 })
    }
    return Response.json(responseFor(days))
  }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  const params = new URLSearchParams({
    section: 'matchups', relation: 'allies', role: 'utility', queue: 'RANKED_FLEX_SR', champion: 'Ahri',
    min_reliability: 'indicative', include_exploratory: '1', search: ' ', budget: '1000',
  })
  if (rawDays !== null) params.set('days', rawDays)
  const initialParams = new URLSearchParams(params)
  const router = createMemoryRouter([{ path: '/app/fit', element: <SynergyPage embedded /> }], {
    initialEntries: [`/app/fit?${params}`],
  })
  disposables.push(() => { router.dispose(); client.clear() })
  render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>)
  return { requests, writes, client, router, initialParams, user: userEvent.setup(), select: screen.getByRole('combobox', { name: 'Periodo' }) }
}
type State = ReturnType<typeof setup>

function expectPreservedContext(state: State, periodChanged = false) {
  const current = new URLSearchParams(state.router.state.location.search)
  for (const [key, value] of state.initialParams) if (!periodChanged || key !== 'days') expect(current.get(key)).toBe(value)
  expect(state.router.state.location.pathname).toBe('/app/fit')
  const request = state.requests.at(-1)!
  expect(request.searchParams.getAll('account')).toEqual(['Alpha#EUW', 'Beta#EUW'])
  expect(request.searchParams.get('algorithm_revision')).toBe('4')
  expect(request.searchParams.get('role')).toBe('SUPPORT')
  expect(request.searchParams.get('queue')).toBe('440')
  expect(request.searchParams.get('champion')).toBe('Ahri')
  expect(request.searchParams.get('min_reliability')).toBe('indicative')
  expect(request.searchParams.get('include_exploratory')).toBe('1')
  expect(screen.getByRole('combobox', { name: 'Ruolo' })).toHaveValue('SUPPORT')
  expect(screen.getByRole('combobox', { name: 'Modalità' })).toHaveValue('440')
  expect(screen.getByRole('combobox', { name: 'Campione giocato' })).toHaveValue('Ahri')
  expect(screen.getByRole('checkbox', { name: 'Mostra esplorativi' })).toBeChecked()
  expect(state.writes).toEqual([])
}

async function expectGames(games: number) {
  const region = await screen.findByRole('region', { name: 'Risultati delle sinergie' })
  const metric = within(region).getByText('Partite analizzate').closest<HTMLElement>('.metric-card')!
  expect(within(metric).getByText(String(games), { selector: 'strong' })).toBeVisible()
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
}

afterEach(() => {
  cleanup()
  disposables.splice(0).forEach((dispose) => dispose())
  vi.unstubAllGlobals()
})

describe('periodo delle sinergie nel contratto comune', () => {
  it.each(['unknown', '0', '\ufeffall\ufeff', ' 90 '])(
    'conserva il 400 e la cache distinti per %j; solo scegliere Tutto lo storico recupera', async (raw) => {
      const state = setup(raw)
      await waitFor(() => expect(state.requests).toHaveLength(1))
      await waitFor(() => expect(state.client.isFetching()).toBe(0))
      expect.soft(state.requests[0]!.searchParams.get('days')).toBe(raw)
      const queries = state.client.getQueryCache().findAll({ queryKey: ['api', 'synergy'] })
      expect(queries).toHaveLength(1)
      expect.soft(queries[0]!.queryKey.at(-1)).toMatchObject({ days: raw })
      expect.soft(queries[0]!.state.status).toBe('error')
      expect.soft(screen.queryByRole('alert')).toHaveTextContent(periodError)
      expect.soft(screen.getByText(/^Contesto richiesto/)).not.toHaveTextContent('tutto lo storico')
      expect.soft(state.select).toHaveValue(raw)
      const selected = within(state.select).getByRole('option', { selected: true })
      expect.soft(selected).toHaveTextContent('Periodo del link')
      expect.soft(selected).toBeDisabled()
      expectPreservedContext(state)

      // Native Home selection is covered by the browser regression. jsdom's
      // supported select interaction followed by Tab exercises the same change.
      await state.user.selectOptions(state.select, 'all')
      await state.user.tab()
      await waitFor(() => expect(state.requests).toHaveLength(2))
      expect(state.requests[1]!.searchParams.get('days')).toBe('all')
      expect(new URLSearchParams(state.router.state.location.search).has('days')).toBe(false)
      expect(state.select).toHaveValue('all')
      expect(within(state.select).getByRole('option', { selected: true })).toHaveTextContent('Tutto lo storico')
      await expectGames(6)
      const finalQueries = state.client.getQueryCache().findAll({ queryKey: ['api', 'synergy'] })
      expect(finalQueries).toHaveLength(2)
      expect(finalQueries.map((query) => query.queryKey.at(-1))).toEqual(expect.arrayContaining([
        expect.objectContaining({ days: raw }), expect.objectContaining({ days: 'all' }),
      ]))
      expectPreservedContext(state, true)
    },
  )

  it.each([
    { raw: '90', wire: '90', games: 4 },
    { raw: '180', wire: '180', games: 5 },
    { raw: '365', wire: '365', games: 6 },
    { raw: 'all', wire: 'all', games: 6 },
    { raw: null, wire: 'all', games: 6 },
    { raw: '', wire: 'all', games: 6 },
  ])('mantiene il controllo valido o il default corrente per $raw', async ({ raw, wire, games }) => {
    const state = setup(raw)
    await expectGames(games)
    expect(state.requests).toHaveLength(1)
    expect(state.requests[0]!.searchParams.get('days')).toBe(wire)
    expect(state.select).toHaveValue(wire)
    const queries = state.client.getQueryCache().findAll({ queryKey: ['api', 'synergy'] })
    expect(queries).toHaveLength(1)
    expect(queries[0]!.queryKey.at(-1)).toMatchObject({ days: wire })
    expectPreservedContext(state)
  })
})
