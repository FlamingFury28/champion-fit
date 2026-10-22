import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RecommendationsResponseDto } from '../api/types'
import { discoveryRecommendation, observedRecommendation, recommendationsFixture } from '../test/recommendations-fixture'
import { FitPage } from './FitPage'
import { ScoutPage } from './ScoutPage'
import { TestPlanPage } from './TestPlanPage'

vi.mock('../app/scope', () => ({ useScope: () => ({
  scope: {
    accounts: ['Alpha#EUW', 'Beta#EUW'], algorithmRevision: 4,
    companion: { name: 'Compagno sintetico', accounts: ['Gamma#EUW'], mode: 'exclude', profileAccounts: ['Alpha#EUW', 'Beta#EUW'] },
  },
  scopeReady: true,
}) }))

const pages = [
  { id: 'fit', component: FitPage, params: { section: 'choices' } },
  { id: 'scout', component: ScoutPage, params: { section: 'training', training: 'discover' } },
  { id: 'plan', component: TestPlanPage, params: { section: 'training', training: 'plan' } },
] as const
type Page = typeof pages[number]
type Role = 'ALL' | 'MIDDLE' | 'SUPPORT' | 'BOTTOM'
const disposables: (() => void)[] = []

function responseFor(requestedRole: string | null): RecommendationsResponseDto {
  // Closed synthetic API responses, not the frontend normalization helper.
  // AUTO chooses MIDDLE here, while an omitted role retains all six facts.
  const role = requestedRole === 'AUTO' ? 'MIDDLE' : (requestedRole ?? 'ALL') as Role
  const facts = [
    { champion: 'Ahri', role: 'MIDDLE', games: 4, accounts: ['Alpha#EUW', 'Beta#EUW'] },
    { champion: 'Lux', role: 'SUPPORT', games: 1, accounts: ['Alpha#EUW'] },
    { champion: 'Garen', role: 'TOP', games: 1, accounts: ['Beta#EUW'] },
  ].filter((item) => role === 'ALL' || item.role === role)
  const games = facts.reduce((sum, item) => sum + item.games, 0)
  const activeAccounts = ['Alpha#EUW', 'Beta#EUW'].filter((account) => facts.some((item) => item.accounts.includes(account)))
  const known = facts.map((item) => {
    const base = observedRecommendation()
    return observedRecommendation({
      champion: item.champion, name: item.champion, role: item.role, games: item.games,
      account_count: item.accounts.length, selected_account_count: 2,
      performance: {
        ...base.performance!, games: item.games, observations: item.games, wins: item.games, losses: 0,
        missing_accounts: ['Alpha#EUW', 'Beta#EUW'].filter((account) => !item.accounts.includes(account)),
        per_account: Object.fromEntries(item.accounts.map((account) => {
          const accountGames = item.champion === 'Ahri' ? account === 'Alpha#EUW' ? 3 : 1 : 1
          return [account, { games: accountGames, wins: accountGames, losses: 0, win_rate: 100 }]
        })),
      },
    })
  })
  const discover = [
    discoveryRecommendation({ champion: 'Orianna', name: 'Orianna', role: 'MIDDLE' }),
    discoveryRecommendation({ champion: 'Sona', name: 'Sona', role: 'SUPPORT' }),
    discoveryRecommendation({ champion: 'Darius', name: 'Darius', role: 'TOP' }),
    // Zero observed BOTTOM games must not make the consumer discard a valid
    // catalog proposal or silently replace its role with the aggregate list.
    discoveryRecommendation({ champion: 'Ashe', name: 'Ashe', role: 'BOTTOM', similarity: null, source_champions: [], reasons: ['Proposta sintetica senza risultati osservati.'] }),
  ].filter((item) => role === 'ALL' || item.role === role)
  const trials = discover.slice(0, 3)
  return recommendationsFixture({
    context: {
      accounts: ['Alpha#EUW', 'Beta#EUW'], role, queue: 'all', days: 'all',
      period: { value: 0, unit: 'days' }, automatic_role: requestedRole === 'AUTO',
      all_roles: role === 'ALL', suspended_accounts: [], unresolved_accounts: [],
    },
    coverage: {
      selected_accounts: ['Alpha#EUW', 'Beta#EUW'], active_accounts: activeAccounts,
      missing_accounts: ['Alpha#EUW', 'Beta#EUW'].filter((account) => !activeAccounts.includes(account)),
      games, observations: games,
    },
    profile: [], known, discover,
    trial_plan: { budget: trials.length, items: trials.map((item) => ({ champion: item.champion, role: item.role, games: 1, reason: 'Prova nel ruolo richiesto.' })) },
  })
}

function setup(page: Page, rawRole: string | null) {
  const requests: URL[] = []
  const responses: RecommendationsResponseDto[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    if ((init?.method ?? 'GET') !== 'GET') throw new Error('Unexpected write')
    if (url.pathname === '/api/recommendation-feedback') {
      return Response.json({ revision: 7, accounts: ['Alpha#EUW', 'Beta#EUW'], suspended_accounts: [], unresolved_accounts: [], items: [], options: [], catalog_version: 'synthetic' })
    }
    if (url.pathname !== '/api/recommendations') throw new Error('Unexpected request')
    requests.push(url)
    const data = responseFor(url.searchParams.get('role'))
    responses.push(data)
    return Response.json(data)
  }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  const params = new URLSearchParams({ ...page.params, queue: 'all', days: 'all', search: ' ', tag: 'ALL', minSimilarity: '0', budget: '1000' })
  if (rawRole !== null) params.set('role', rawRole)
  const initialParams = new URLSearchParams(params)
  const router = createMemoryRouter([{ path: '*', element: <page.component /> }], { initialEntries: [`/app/fit?${params}`] })
  disposables.push(() => { router.dispose(); client.clear() })
  render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>)
  return { requests, responses, client, router, initialParams, user: userEvent.setup(), select: screen.getByRole('combobox', { name: /^Ruolo$/ }) }
}

function expectPreservedContext(state: ReturnType<typeof setup>) {
  const params = new URLSearchParams(state.router.state.location.search)
  for (const [key, value] of state.initialParams) if (key !== 'role') expect(params.get(key)).toBe(value)
  const request = state.requests.at(-1)!
  expect(request.searchParams.getAll('account')).toEqual(['Alpha#EUW', 'Beta#EUW'])
  expect(request.searchParams.getAll('companion_account')).toEqual(['Gamma#EUW'])
  expect(request.searchParams.get('companion_mode')).toBe('exclude')
  expect(request.searchParams.get('algorithm_revision')).toBe('4')
  expect(request.searchParams.get('queue')).toBe('all')
  expect(request.searchParams.get('days')).toBe('all')
}

async function expectCandidates(page: Page, role: Role) {
  const familiar = { ALL: ['Ahri', 'Lux', 'Garen'], MIDDLE: ['Ahri'], SUPPORT: ['Lux'], BOTTOM: [] }
  const discovery = { ALL: ['Orianna', 'Sona', 'Darius', 'Ashe'], MIDDLE: ['Orianna'], SUPPORT: ['Sona'], BOTTOM: ['Ashe'] }
  const expected = page.id === 'fit' ? familiar[role] : page.id === 'plan' ? discovery[role].slice(0, 3) : discovery[role]
  if (!expected.length) expect(await screen.findByText('Nessuna scelta già giocata o dichiarata')).toBeVisible()
  for (const champion of expected) expect(await screen.findByText(champion)).toBeVisible()
  for (const champion of page.id === 'fit' ? familiar.ALL : discovery.ALL) {
    if (!expected.includes(champion)) expect(screen.queryByText(champion)).not.toBeInTheDocument()
  }
}

afterEach(() => {
  cleanup()
  disposables.splice(0).forEach((dispose) => dispose())
  vi.unstubAllGlobals()
})

for (const page of pages) describe(`ruoli recommendation ${page.id}`, () => {
  it.each([
    { raw: 'MID', wire: 'MIDDLE', role: 'MIDDLE', games: 4 },
    { raw: '\u0085 mid \u001f', wire: 'MIDDLE', role: 'MIDDLE', games: 4 },
    { raw: 'ADC', wire: 'BOTTOM', role: 'BOTTOM', games: 0 },
    { raw: ' adc ', wire: 'BOTTOM', role: 'BOTTOM', games: 0 },
    { raw: 'AUTO', wire: 'AUTO', role: 'MIDDLE', games: 4 },
    { raw: '\u001c auto \u0085', wire: 'AUTO', role: 'MIDDLE', games: 4 },
    { raw: 'UTILITY', wire: 'SUPPORT', role: 'SUPPORT', games: 1 },
  ] as const)('rispetta $raw e torna a tutti i ruoli solo con una scelta esplicita', async ({ raw, wire, role, games }) => {
    const state = setup(page, raw)
    await waitFor(() => expect(state.requests).toHaveLength(1))
    expect(state.requests[0]!.searchParams.get('role')).toBe(wire)
    expect(state.responses[0]!.context.role).toBe(role)
    expect(state.responses[0]!.coverage.observations).toBe(games)
    expect(state.select).toHaveValue(wire)
    if (wire === 'AUTO') {
      const selected = within(state.select).getByRole('option', { selected: true })
      expect(selected).toHaveTextContent('Ruolo automatico')
      expect(selected).toBeDisabled()
      expect(state.responses[0]!.context.automatic_role).toBe(true)
    }
    expect(new URLSearchParams(state.router.state.location.search).get('role')).toBe(raw)
    expectPreservedContext(state)
    await expectCandidates(page, role)

    await state.user.selectOptions(state.select, '')
    await waitFor(() => expect(state.requests).toHaveLength(2))
    expect(state.requests[1]!.searchParams.has('role')).toBe(false)
    expect(state.responses[1]!.context.role).toBe('ALL')
    expect(state.responses[1]!.coverage.observations).toBe(6)
    expect(state.select).toHaveValue('')
    expect(new URLSearchParams(state.router.state.location.search).has('role')).toBe(false)
    expectPreservedContext(state)
    await expectCandidates(page, 'ALL')
  })

  it.each([null, '', 'ALL', 'unknown', '\ufeffMID\ufeff', '\u0085 \u001c'])(
    'conserva il default UI senza filtro per %j, senza imporre la policy backend degli unknown', async (raw) => {
      const state = setup(page, raw)
      await waitFor(() => expect(state.requests).toHaveLength(1))
      expect(state.requests[0]!.searchParams.has('role')).toBe(false)
      expect(state.responses[0]!.context.role).toBe('ALL')
      expect(state.responses[0]!.coverage.observations).toBe(6)
      expect(state.select).toHaveValue('')
      expect(within(state.select).getByRole('option', { selected: true })).toHaveTextContent('Tutti i ruoli · nessun filtro')
      expect(new URLSearchParams(state.router.state.location.search).get('role')).toBe(raw)
      expectPreservedContext(state)
      await expectCandidates(page, 'ALL')
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    },
  )

  it('condivide MID e MIDDLE nella cache, ma mantiene AUTO distinto dal medesimo ruolo risolto', async () => {
    const state = setup(page, 'MID')
    await waitFor(() => expect(state.requests).toHaveLength(1))
    const next = new URL(state.router.state.location.pathname + state.router.state.location.search, 'http://localhost')
    next.searchParams.set('role', 'MIDDLE')
    await act(() => state.router.navigate(next.pathname + next.search))
    await expectCandidates(page, 'MIDDLE')
    expect(state.requests).toHaveLength(1)
    expect(state.client.getQueriesData({ queryKey: ['api', 'recommendations'] })).toHaveLength(1)

    next.searchParams.set('role', 'AUTO')
    await act(() => state.router.navigate(next.pathname + next.search))
    await waitFor(() => expect(state.requests).toHaveLength(2))
    expect(state.requests[1]!.searchParams.get('role')).toBe('AUTO')
    expect(state.responses[1]!.context.role).toBe('MIDDLE')
    expect(state.responses[1]!.context.automatic_role).toBe(true)
    expect(state.responses[1]!.coverage.observations).toBe(4)
    expect(state.select).toHaveValue('AUTO')
    expect(state.client.getQueriesData({ queryKey: ['api', 'recommendations'] })).toHaveLength(2)
    expect(new URLSearchParams(state.router.state.location.search).get('role')).toBe('AUTO')
    expectPreservedContext(state)
    await expectCandidates(page, 'MIDDLE')
  })
})
