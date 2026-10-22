import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChampionPerformancePage } from './ChampionPerformancePage'
import { CompetitivePlanPage } from './CompetitivePlanPage'

vi.mock('../app/scope', () => ({ useScope: () => ({
  scope: { accounts: ['Alpha#EUW', 'Beta#EUW'], companion: null }, scopeReady: true,
}) }))

const pages = [
  { section: 'best', component: ChampionPerformancePage, endpoint: '/api/champions', query: 'champions' },
  { section: 'tournament', component: CompetitivePlanPage, endpoint: '/api/training-plan', query: 'training-plan' },
] as const
const flexAliases = ['RANKED_FLEX_SR', ' 440 ', '\u0085\u001c440\u001f\u0085']
const disposables: (() => void)[] = []

function fixture(queue: string) {
  const observations = [
    { champion: 'Ahri', role: 'MIDDLE', queue: '420', account: 'Alpha#EUW', games: 4 },
    { champion: 'Zed', role: 'MIDDLE', queue: '440', account: 'Beta#EUW', games: 2 },
  ].filter((item) => queue === 'all' || item.queue === queue)
  const items = observations.map((item) => ({
    ...item, icon_url: '', unique_games: item.games, posterior_win_rate: 56,
    credible_lower_90: 30, credible_upper_90: 80, credible_mass: .9, posterior_lift_pp: 6,
    classification: 'promising', historical_supported: false, account_coverage: 1, account_count: 2,
    allocation_games: 1000 / observations.length,
    account_allocations: [{ account: item.account, games: 1000 / observations.length }],
  }))
  return {
    items,
    context: {
      accounts: ['Alpha#EUW', 'Beta#EUW'], role: 'ALL', queue, days: 'all',
      unique_games: observations.reduce((total, item) => total + item.games, 0),
    },
    model: { validated: false, message: 'Fixture sintetica: quattro partite Alpha Solo/Duo e due Beta Flex.' },
    budget_total: 1000, budget_assigned: items.length ? 1000 : 0, budget_unassigned: items.length ? 0 : 1000,
  }
}

function setup(page: typeof pages[number], rawQueue: string | null) {
  const requests: URL[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    if ((init?.method ?? 'GET') !== 'GET' || url.pathname !== page.endpoint) throw new Error('Unexpected request')
    requests.push(url)
    const requested = url.searchParams.get('queue')
    // Closed examples from the common-analysis HTTP contract, independent of
    // the frontend helper: aliases stay valid; unsupported numbers stay empty.
    const queue = requested === null ? '420' : flexAliases.includes(requested) ? '440' : requested
    if (!['420', '440', 'all', '450', '999'].includes(queue)) {
      return Response.json({ error: 'Modalità non valida' }, { status: 400 })
    }
    return Response.json(fixture(queue))
  }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  const params = new URLSearchParams({ section: page.section, role: 'ALL', days: 'all', budget: '1000' })
  if (rawQueue !== null) params.set('queue', rawQueue)
  const router = createMemoryRouter([{ path: '*', element: <page.component embedded /> }], { initialEntries: [`/app/fit?${params}`] })
  disposables.push(() => { router.dispose(); client.clear() })
  render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>)
  return { requests, router, client, user: userEvent.setup(), select: screen.getByRole('combobox', { name: 'Modalità' }) }
}

function expectPreservedContext(page: typeof pages[number], router: ReturnType<typeof createMemoryRouter>, request: URL) {
  const params = new URLSearchParams(router.state.location.search)
  expect(params.get('section')).toBe(page.section)
  expect(params.get('role')).toBe('ALL')
  expect(params.get('days')).toBe('all')
  expect(params.get('budget')).toBe('1000')
  expect(request.searchParams.getAll('account')).toEqual(['Alpha#EUW', 'Beta#EUW'])
  expect(request.searchParams.get('role')).toBe('ALL')
  expect(request.searchParams.get('days')).toBe('all')
  if (page.section === 'tournament') {
    expect(request.searchParams.get('budget')).toBe('1000')
    expect(screen.getByRole('heading', { name: 'Piano da 1000 partite' })).toBeVisible()
    expect(screen.getByRole('spinbutton', { name: 'Budget partite' })).toHaveValue(1000)
  }
}

async function expectOnlyRow(champion: 'Ahri' | 'Zed', games: number) {
  const row = await screen.findByRole('row', { name: new RegExp(champion) })
  expect(within(row).getAllByRole('cell')[1]).toHaveTextContent(new RegExp(`^${games}$`))
  expect(screen.queryByRole('row', { name: new RegExp(champion === 'Ahri' ? 'Zed' : 'Ahri') })).not.toBeInTheDocument()
}

afterEach(() => {
  cleanup()
  disposables.splice(0).forEach((dispose) => dispose())
  vi.unstubAllGlobals()
})

for (const page of pages) describe(`modalità competitiva ${page.section}`, () => {
  it.each(flexAliases)('mostra Flex per %j e torna alla configurazione predefinita solo con una scelta esplicita', async (raw) => {
    const { requests, router, select, user } = setup(page, raw)
    await expectOnlyRow('Zed', 2)
    expect(select).toHaveValue('440')
    expect(within(select).getByRole('option', { selected: true })).toHaveTextContent('Classificata · flessibile')
    expect(within(select).getAllByRole('option').filter((option) => (option as HTMLOptionElement).value === '440')).toHaveLength(1)
    expect(requests[0]!.searchParams.get('queue')).toBe('440')
    expect(new URLSearchParams(router.state.location.search).get('queue')).toBe(raw)
    expectPreservedContext(page, router, requests[0]!)

    await user.selectOptions(select, '')
    await expectOnlyRow('Ahri', 4)
    expect(select).toHaveValue('')
    expect(requests).toHaveLength(2)
    expect(requests[1]!.searchParams.has('queue')).toBe(false)
    expect(new URLSearchParams(router.state.location.search).has('queue')).toBe(false)
    expectPreservedContext(page, router, requests[1]!)
  })

  it.each([null, ''])('mantiene Predefinita e omette la coda API per %j senza riscrivere il link', async (raw) => {
    const { requests, router, select } = setup(page, raw)
    await expectOnlyRow('Ahri', 4)
    expect(select).toHaveValue('')
    expect(within(select).getByRole('option', { selected: true })).toHaveTextContent('Predefinita')
    expect(requests[0]!.searchParams.has('queue')).toBe(false)
    expect(new URLSearchParams(router.state.location.search).get('queue')).toBe(raw)
    expectPreservedContext(page, router, requests[0]!)
  })

  it('mantiene all esplicito aggregato e poi rimuove solo la modalità scegliendo Predefinita', async () => {
    const { requests, router, select, user } = setup(page, 'all')
    await screen.findByRole('row', { name: /Zed/ })
    expect(screen.getByRole('row', { name: /Ahri/ })).toBeVisible()
    expect(select).toHaveValue('all')
    expect(within(select).getByRole('option', { selected: true })).toHaveTextContent('Tutte le modalità')
    expect(requests[0]!.searchParams.get('queue')).toBe('all')
    expect(new URLSearchParams(router.state.location.search).get('queue')).toBe('all')
    await user.selectOptions(select, '')
    await expectOnlyRow('Ahri', 4)
    expect(requests.at(-1)!.searchParams.has('queue')).toBe(false)
    expect(new URLSearchParams(router.state.location.search).has('queue')).toBe(false)
    expectPreservedContext(page, router, requests.at(-1)!)
  })

  it.each([
    { raw: 'ALL', wire: 'ALL' },
    { raw: 'unknown', wire: 'UNKNOWN' },
    { raw: '\ufeff440\ufeff', wire: '\ufeff440\ufeff' },
    { raw: 'QUEUEQUEUE440', wire: 'QUEUEQUEUE440' },
  ])('conserva il 400 per $raw e permette il recupero tramite Predefinita', async ({ raw, wire }) => {
    const { requests, router, select, user } = setup(page, raw)
    expect(await screen.findByRole('alert')).toHaveTextContent('Modalità non valida')
    expect(select).not.toHaveValue('')
    expect(select).not.toHaveValue('all')
    const selected = within(select).getByRole('option', { selected: true })
    expect(selected).toHaveTextContent('Modalità del link')
    expect(selected).toBeDisabled()
    expect(requests[0]!.searchParams.get('queue')).toBe(wire)
    expect(new URLSearchParams(router.state.location.search).get('queue')).toBe(raw)
    expect(requests).toHaveLength(1)

    await user.selectOptions(select, '')
    await expectOnlyRow('Ahri', 4)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(requests).toHaveLength(2)
    expect(requests[1]!.searchParams.has('queue')).toBe(false)
    expect(new URLSearchParams(router.state.location.search).has('queue')).toBe(false)
    expectPreservedContext(page, router, requests[1]!)
  })

  it.each(['450', '999'])('rappresenta la modalità numerica valida %s senza dichiararla non valida o ampliarla', async (raw) => {
    const { requests, router, select, user } = setup(page, raw)
    const emptyTitle = page.section === 'best' ? 'Nessun campione corrisponde ai filtri' : 'Nessun candidato nel contesto corrente'
    expect(await screen.findByText(emptyTitle)).toBeVisible()
    expect(select).toHaveValue(raw)
    const selected = within(select).getByRole('option', { selected: true })
    expect(selected).toHaveTextContent('Modalità del link')
    expect(selected).toBeDisabled()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(requests[0]!.searchParams.get('queue')).toBe(raw)
    expect(new URLSearchParams(router.state.location.search).get('queue')).toBe(raw)

    await user.selectOptions(select, '')
    await expectOnlyRow('Ahri', 4)
    expect(requests.at(-1)!.searchParams.has('queue')).toBe(false)
    expect(new URLSearchParams(router.state.location.search).has('queue')).toBe(false)
    expectPreservedContext(page, router, requests.at(-1)!)
  })

  it('condivide la cache fra alias e coda canonica senza nuove richieste', async () => {
    const { requests, router, client, select } = setup(page, 'RANKED_FLEX_SR')
    await expectOnlyRow('Zed', 2)
    const next = new URL(router.state.location.pathname + router.state.location.search, 'http://localhost')
    next.searchParams.set('queue', '440')
    await act(() => router.navigate(next.pathname + next.search))
    await waitFor(() => expect(select).toHaveValue('440'))
    expect(requests).toHaveLength(1)
    expect(client.getQueriesData({ queryKey: ['api', page.query] })).toHaveLength(1)
    expectPreservedContext(page, router, requests[0]!)
  })
})
