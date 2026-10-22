import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChampionPerformancePage } from './ChampionPerformancePage'
import { CompetitivePlanPage } from './CompetitivePlanPage'

vi.mock('../app/scope', () => ({ useScope: () => ({ scope: { accounts: ['Alpha#EUW'], companion: null }, scopeReady: true }) }))

const pages = [
  { section: 'best', component: ChampionPerformancePage, endpoint: '/api/champions' },
  { section: 'tournament', component: CompetitivePlanPage, endpoint: '/api/training-plan' },
] as const
const clients: QueryClient[] = []
const routers: ReturnType<typeof createMemoryRouter>[] = []

function responseFor(requestedRole: string | null) {
  const role = requestedRole ?? 'MIDDLE'
  const candidates = [
    { champion: 'Ahri', role: 'MIDDLE', games: 3 },
    { champion: 'Lux', role: 'SUPPORT', games: 1 },
  ].filter((candidate) => role === 'ALL' || candidate.role === role)
  const items = candidates.map((candidate) => ({
    ...candidate, icon_url: '', unique_games: candidate.games, posterior_win_rate: 56,
    credible_lower_90: 30, credible_upper_90: 80, credible_mass: .9, posterior_lift_pp: 6,
    classification: 'promising', historical_supported: false, account_coverage: 1, account_count: 1,
    allocation_games: 400 / candidates.length, account_allocations: [{ account: 'Alpha#EUW', games: 400 / candidates.length }],
  }))
  return {
    items, context: { accounts: ['Alpha#EUW'], role, queue: '420', days: 'all', unique_games: candidates.reduce((total, item) => total + item.games, 0) },
    model: { validated: false, message: 'Fixture sintetica del contesto.' },
    budget_total: 400, budget_assigned: 400, budget_unassigned: 0,
  }
}

function setup(page: typeof pages[number], rawRole: string | null) {
  const requests: URL[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    if ((init?.method ?? 'GET') !== 'GET' || url.pathname !== page.endpoint) throw new Error('Unexpected request')
    requests.push(url)
    return Response.json(responseFor(url.searchParams.get('role')))
  }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  clients.push(client)
  const params = new URLSearchParams({ section: page.section, queue: '420', days: 'all' })
  if (rawRole !== null) params.set('role', rawRole)
  const router = createMemoryRouter([{ path: '*', element: <page.component embedded /> }], { initialEntries: [`/app/fit?${params}`] })
  routers.push(router)
  render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>)
  return { requests, router, client, user: userEvent.setup(), select: screen.getByRole('combobox', { name: 'Ruolo' }) }
}

afterEach(() => {
  cleanup()
  routers.splice(0).forEach((router) => router.dispose())
  clients.splice(0).forEach((client) => client.clear())
  vi.unstubAllGlobals()
})

for (const page of pages) describe(`ruolo competitivo ${page.section}`, () => {
  it.each(['SUPPORT', 'UTILITY', '\u0085 utility \u001c'])('mostra il filtro Supporto di %s e torna ad Automatico con la scelta esplicita', async (rawRole) => {
    const { requests, router, user, select } = setup(page, rawRole)
    const supportRow = await screen.findByRole('row', { name: /Lux/ })
    expect(supportRow).toHaveTextContent('Supporto')
    expect(screen.queryByRole('row', { name: /Ahri/ })).not.toBeInTheDocument()
    expect(select).toHaveValue('SUPPORT')
    expect(requests[0]!.searchParams.get('role')).toBe('SUPPORT')
    expect(new URLSearchParams(router.state.location.search).get('role')).toBe(rawRole)

    await user.selectOptions(select, '')
    await screen.findByRole('row', { name: /Ahri/ })
    expect(screen.queryByRole('row', { name: /Lux/ })).not.toBeInTheDocument()
    expect(select).toHaveValue('')
    expect(requests).toHaveLength(2)
    expect(requests[1]!.searchParams.has('role')).toBe(false)
    const updated = new URLSearchParams(router.state.location.search)
    expect(updated.has('role')).toBe(false)
    expect(updated.get('section')).toBe(page.section)
    expect(updated.get('queue')).toBe('420')
    expect(updated.get('days')).toBe('all')
  })

  it('mostra il ruolo minuscolo già normalizzato dalla richiesta', async () => {
    const { requests, router, select } = setup(page, 'middle')
    await screen.findByRole('row', { name: /Ahri/ })
    expect(select).toHaveValue('MIDDLE')
    expect(requests[0]!.searchParams.get('role')).toBe('MIDDLE')
    expect(new URLSearchParams(router.state.location.search).get('role')).toBe('middle')
  })

  it('mantiene Automatico e il ruolo dedotto quando manca il parametro', async () => {
    const { requests, router, select } = setup(page, null)
    await screen.findByRole('row', { name: /Ahri/ })
    expect(screen.queryByRole('row', { name: /Lux/ })).not.toBeInTheDocument()
    expect(select).toHaveValue('')
    expect(within(select).getByRole('option', { selected: true })).toHaveTextContent('Automatico')
    expect(requests[0]!.searchParams.has('role')).toBe(false)
    expect(new URLSearchParams(router.state.location.search).has('role')).toBe(false)
  })

  it.each(['', 'ALL', 'unknown', 'MID', '\ufeffSUPPORT'])('mostra Tutti per il fallback preesistente del ruolo esplicito %s', async (rawRole) => {
    const { requests, router, select } = setup(page, rawRole)
    await screen.findByRole('row', { name: /Lux/ })
    expect(screen.getByRole('row', { name: /Ahri/ })).toBeVisible()
    expect(select).toHaveValue('ALL')
    expect(within(select).getByRole('option', { selected: true })).toHaveTextContent('Tutti i ruoli')
    expect(requests[0]!.searchParams.get('role')).toBe('ALL')
    expect(new URLSearchParams(router.state.location.search).get('role')).toBe(rawRole)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('mantiene identità della cache fra alias e ruolo canonico', async () => {
    const { requests, router, client, select } = setup(page, 'UTILITY')
    await screen.findByRole('row', { name: /Lux/ })
    await act(() => router.navigate(`/app/fit?section=${page.section}&queue=420&days=all&role=SUPPORT`))
    await waitFor(() => expect(select).toHaveValue('SUPPORT'))
    expect(requests).toHaveLength(1)
    expect(client.getQueriesData({ queryKey: ['api', page.section === 'best' ? 'champions' : 'training-plan'] })).toHaveLength(1)
  })
})
