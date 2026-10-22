import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ObservedRecommendationDto, RecommendationsResponseDto } from '../api/types'
import { observedRecommendation, recommendationsFixture } from '../test/recommendations-fixture'
import { ChampionDetailPage } from './ChampionDetailPage'

vi.mock('../app/scope', () => ({ useScope: () => ({
  scope: { accounts: ['Alpha#EUW', 'Beta#EUW'], companion: null, algorithmRevision: 4 }, scopeReady: true,
}) }))

const modes = [
  { name: 'embedded', embedded: true, path: '/app/fit', route: '/app/fit', roleParam: 'detailRole' },
  { name: 'standalone', embedded: false, path: '/direct/Ahri', route: '/direct/:champion', roleParam: 'role' },
] as const
type Mode = typeof modes[number]
type CandidateRole = 'MIDDLE' | 'BOTTOM' | 'SUPPORT'
const navigationState = { championSheetFromList: true, source: 'synthetic-role-test' }
const disposables: (() => void)[] = []
const roleNames = { MIDDLE: 'Corsia centrale', BOTTOM: 'Corsia inferiore', SUPPORT: 'Supporto' }

function candidateFor(role: CandidateRole): ObservedRecommendationDto {
  const games = role === 'MIDDLE' ? 4 : 0
  const base = observedRecommendation()
  return observedRecommendation({
    role, games, account_count: games ? 2 : 0, selected_account_count: 2,
    performance: {
      ...base.performance!, games, observations: games, wins: games, losses: 0,
      win_rate: games ? 100 : null, interval_low: games ? 40 : null, interval_high: games ? 100 : null,
      missing_accounts: games ? [] : ['Alpha#EUW', 'Beta#EUW'],
      per_account: games ? {
        'Alpha#EUW': { games: 3, wins: 3, losses: 0, win_rate: 100 },
        'Beta#EUW': { games: 1, wins: 1, losses: 0, win_rate: 100 },
      } : {},
    },
  })
}

function responseFor(requestedRole: string | null): RecommendationsResponseDto {
  // Fixed detail fixtures matching the verified HTTP contract: the context has
  // six total facts, Ahri has four MIDDLE games and none in BOTTOM/SUPPORT.
  const role = requestedRole === 'AUTO' ? 'MIDDLE' : requestedRole ?? 'ALL'
  const observations = role === 'ALL' ? 6 : role === 'MIDDLE' ? 4 : role === 'SUPPORT' ? 1 : 0
  const candidate = candidateFor(role === 'ALL' ? 'MIDDLE' : role as CandidateRole)
  return recommendationsFixture({
    context: {
      accounts: ['Alpha#EUW', 'Beta#EUW'], role, queue: 'all', days: 'all', period: { value: 0, unit: 'days' },
      automatic_role: requestedRole === 'AUTO', all_roles: role === 'ALL', observations,
      suspended_accounts: [], unresolved_accounts: [],
    },
    coverage: {
      selected_accounts: ['Alpha#EUW', 'Beta#EUW'], active_accounts: observations ? ['Alpha#EUW', 'Beta#EUW'] : [],
      missing_accounts: observations ? [] : ['Alpha#EUW', 'Beta#EUW'], games: observations, observations,
    },
    candidate: role === 'ALL' ? null : candidate,
    candidates: role === 'ALL' ? [candidate] : undefined,
    known: role === 'ALL' || role === 'MIDDLE' ? [candidate] : [], discover: [], profile: [],
    trial_plan: { budget: 0, items: [] },
  })
}

function setup(mode: Mode, rawRole: string | null, outcome: 'success' | 'pending' | 'error' = 'success') {
  const requests: URL[] = []
  const responses: RecommendationsResponseDto[] = []
  const writes: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    if ((init?.method ?? 'GET') !== 'GET') {
      writes.push(String(init?.method))
      throw new Error('Unexpected write')
    }
    if (url.pathname !== '/api/recommendations') throw new Error('Unexpected request')
    requests.push(url)
    if (outcome === 'pending') return new Promise<Response>(() => undefined)
    if (outcome === 'error') return Response.json({ error: 'Servizio sintetico non disponibile' }, { status: 503 })
    const data = responseFor(url.searchParams.get('role'))
    responses.push(data)
    return Response.json(data)
  }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  const params = new URLSearchParams({
    section: 'choices', detail: 'Ahri', view: 'discover', budget: '1000',
    role: 'SUPPORT', detailRole: 'SUPPORT',
    queue: mode.embedded ? '420' : 'all', days: mode.embedded ? '180' : 'all',
    detailQueue: mode.embedded ? 'all' : '440', detailDays: mode.embedded ? 'all' : '90',
  })
  params.delete(mode.roleParam)
  if (rawRole !== null) params.set(mode.roleParam, rawRole)
  const initialParams = new URLSearchParams(params)
  const router = createMemoryRouter([{
    path: mode.route,
    element: mode.embedded ? <ChampionDetailPage champion="Ahri" embedded /> : <ChampionDetailPage />,
  }], { initialEntries: [{ pathname: mode.path, search: `?${params}`, state: navigationState }] })
  disposables.push(() => { router.dispose(); client.clear() })
  render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>)
  return {
    requests, responses, writes, router, client, initialParams, user: userEvent.setup(),
    get select() { return screen.getByRole('combobox', { name: 'Ruolo della scheda' }) },
  }
}

function expectPreservedContext(mode: Mode, state: ReturnType<typeof setup>) {
  const current = new URLSearchParams(state.router.state.location.search)
  for (const [key, value] of state.initialParams) if (key !== mode.roleParam) expect(current.get(key)).toBe(value)
  expect(state.router.state.location.state).toEqual(navigationState)
  expect(state.router.state.location.pathname).toBe(mode.path)
  const request = state.requests.at(-1)!
  expect(request.searchParams.get('champion')).toBe('Ahri')
  expect(request.searchParams.get('queue')).toBe('all')
  expect(request.searchParams.get('days')).toBe('all')
  expect(request.searchParams.getAll('account')).toEqual(['Alpha#EUW', 'Beta#EUW'])
  expect(request.searchParams.get('algorithm_revision')).toBe('4')
  expect(state.writes).toEqual([])
}

async function expectDetails(role: CandidateRole, games: number) {
  const result = await screen.findByRole('region', { name: `Scheda di Ahri · ${roleNames[role]}` })
  const metric = within(result).getByText('Partite uniche').closest<HTMLElement>('.metric-card')!
  expect(within(metric).getByText(String(games), { selector: 'strong' })).toBeVisible()
  if (role !== 'MIDDLE') expect(screen.queryByRole('region', { name: 'Scheda di Ahri · Corsia centrale' })).not.toBeInTheDocument()
  return result
}

afterEach(() => {
  cleanup()
  disposables.splice(0).forEach((dispose) => dispose())
  vi.unstubAllGlobals()
})

for (const mode of modes) describe(`ruolo della scheda ${mode.name}`, () => {
  it.each([
    { raw: 'MID', wire: 'MIDDLE', role: 'MIDDLE', observations: 4, games: 4 },
    { raw: '\u0085 mid \u001f', wire: 'MIDDLE', role: 'MIDDLE', observations: 4, games: 4 },
    { raw: 'ADC', wire: 'BOTTOM', role: 'BOTTOM', observations: 0, games: 0 },
    { raw: 'AUTO', wire: 'AUTO', role: 'MIDDLE', observations: 4, games: 4 },
    { raw: 'UTILITY', wire: 'SUPPORT', role: 'SUPPORT', observations: 1, games: 0 },
  ] as const)('rispetta $raw e cancella solo il parametro del ruolo della scheda', async ({ raw, wire, role, observations, games }) => {
    const state = setup(mode, raw)
    await waitFor(() => expect(state.requests).toHaveLength(1))
    expect(state.requests[0]!.searchParams.get('role')).toBe(wire)
    expect(state.responses[0]!.context.role).toBe(role)
    expect(state.responses[0]!.coverage.observations).toBe(observations)
    expect(state.select).toHaveValue(wire)
    expect(new URLSearchParams(state.router.state.location.search).get(mode.roleParam)).toBe(raw)
    expectPreservedContext(mode, state)
    const details = await expectDetails(role, games)
    if (wire === 'AUTO') {
      const selected = within(state.select).getByRole('option', { selected: true })
      expect(selected).toHaveTextContent('Ruolo automatico')
      expect(selected).toBeDisabled()
      expect(screen.getByRole('heading', { name: 'Ahri · Ruolo automatico' })).toBeVisible()
      expect(within(details).getByText(/^Contesto effettivo: Corsia centrale ·/)).toBeVisible()
      expect(state.responses[0]!.context.automatic_role).toBe(true)
    }

    await state.user.selectOptions(state.select, '')
    await waitFor(() => expect(state.requests).toHaveLength(2))
    expect(state.requests[1]!.searchParams.has('role')).toBe(false)
    expect(state.responses[1]!.context.role).toBe('ALL')
    expect(state.responses[1]!.coverage.observations).toBe(6)
    expect(state.select).toHaveValue('')
    expect(new URLSearchParams(state.router.state.location.search).has(mode.roleParam)).toBe(false)
    expectPreservedContext(mode, state)
    await expectDetails('MIDDLE', 4)
    expect(screen.getByRole('heading', { name: 'Ahri · Tutti i ruoli' })).toBeVisible()
  })

  it.each([null, '', 'ALL', 'unknown', '\ufeffMID\ufeff'])('mantiene il fallback senza filtro per %j, indipendente dal ruolo esterno', async (raw) => {
    const state = setup(mode, raw)
    await waitFor(() => expect(state.requests).toHaveLength(1))
    expect(state.requests[0]!.searchParams.has('role')).toBe(false)
    expect(state.responses[0]!.context.role).toBe('ALL')
    expect(state.responses[0]!.coverage.observations).toBe(6)
    expect(state.select).toHaveValue('')
    expect(within(state.select).getByRole('option', { selected: true })).toHaveTextContent('Tutti i ruoli · nessun filtro')
    expect(new URLSearchParams(state.router.state.location.search).get(mode.roleParam)).toBe(raw)
    expectPreservedContext(mode, state)
    await expectDetails('MIDDLE', 4)
    expect(screen.getByRole('heading', { name: 'Ahri · Tutti i ruoli' })).toBeVisible()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('riusa la query MID/MIDDLE e distingue AUTO anche quando risolve lo stesso ruolo', async () => {
    const state = setup(mode, 'MID')
    await waitFor(() => expect(state.requests).toHaveLength(1))
    const next = new URL(state.router.state.location.pathname + state.router.state.location.search, 'http://localhost')
    next.searchParams.set(mode.roleParam, 'MIDDLE')
    await act(() => state.router.navigate(next.pathname + next.search, { state: navigationState }))
    await expectDetails('MIDDLE', 4)
    expect(state.requests).toHaveLength(1)
    expect(state.client.getQueriesData({ queryKey: ['api', 'recommendations'] })).toHaveLength(1)

    next.searchParams.set(mode.roleParam, 'AUTO')
    await act(() => state.router.navigate(next.pathname + next.search, { state: navigationState }))
    await waitFor(() => expect(state.requests).toHaveLength(2))
    expect(state.requests[1]!.searchParams.get('role')).toBe('AUTO')
    expect(state.responses[1]!.context.role).toBe('MIDDLE')
    expect(state.responses[1]!.context.automatic_role).toBe(true)
    expect(state.client.getQueriesData({ queryKey: ['api', 'recommendations'] })).toHaveLength(2)
    expectPreservedContext(mode, state)
    await expectDetails('MIDDLE', 4)
    expect(screen.getByRole('heading', { name: 'Ahri · Ruolo automatico' })).toBeVisible()
  })

  it.each(['pending', 'error'] as const)('mantiene AUTO nell’intestazione anche con richiesta %s', async (outcome) => {
    const state = setup(mode, 'AUTO', outcome)
    await waitFor(() => expect(state.requests).toHaveLength(1))
    if (outcome === 'error') expect(await screen.findByRole('alert')).toHaveTextContent('Servizio sintetico non disponibile')
    expect(screen.getByRole('heading', { name: 'Ahri · Ruolo automatico' })).toBeVisible()
    expect(state.select).toHaveValue('AUTO')
    const selected = within(state.select).getByRole('option', { selected: true })
    expect(selected).toHaveTextContent('Ruolo automatico')
    expect(selected).toBeDisabled()
    expect(state.requests[0]!.searchParams.get('role')).toBe('AUTO')
    expect(new URLSearchParams(state.router.state.location.search).get(mode.roleParam)).toBe('AUTO')
    expectPreservedContext(mode, state)
  })
})
