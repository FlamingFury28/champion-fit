import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FriendsPage } from './FriendsPage'
import { PlaystylesPage } from './PlaystylesPage'
import { SynergyPage } from './SynergyPage'

vi.mock('../app/scope', () => ({ useScope: () => ({
  scope: { accounts: ['Alpha#EUW', 'Beta#EUW'], companion: null }, scopeReady: true,
  state: { companion: null }, availableAccounts: [], setAccounts: vi.fn(), clearCompanion: vi.fn(),
}) }))
vi.mock('../components/toast', () => ({ useToast: () => ({ notify: vi.fn() }) }))

const pages = [
  { name: 'Compagni', path: '/app/team/friends', endpoint: '/api/friends', label: 'Modalità del confronto', component: FriendsPage, fallback: 'all' },
  { name: 'Stili', path: '/app/playstyles', endpoint: '/api/playstyles', label: 'Modalità degli stili', component: PlaystylesPage, fallback: '420' },
  { name: 'Sinergie', path: '/app/fit?section=matchups&relation=allies', endpoint: '/api/synergy', label: 'Modalità', component: SynergyPage, fallback: 'all' },
] as const
const disposables: (() => void)[] = []

function fixture(endpoint: string, queue: string) {
  if (endpoint === '/api/friends') return { items: [], manual_groups: [], summary: {
    tracked_accounts: 2, matches_with_participants: 0, friends_found: 0, min_shared_games: 1, accounts: ['Alpha#EUW', 'Beta#EUW'],
  } }
  if (endpoint === '/api/synergy') return {
    champion: 'ALL', accounts: ['Alpha#EUW', 'Beta#EUW'], companion_filter_active: false,
    min_reliability: 'weak', include_exploratory: false, min_games: 1, games: 0, games_with_teammates: 0,
    available_champions: [], better_with: [], worse_with: [],
  }
  return {
    version: 'synthetic', catalog: { version: 'synthetic', source_version: 'synthetic', sources: [], categories: [] },
    filters: { role: 'ALL', queue, days: 'all' },
    options: { roles: ['MIDDLE', 'SUPPORT'], queues: [{ id: '420', label: 'Classificata Solo/Duo' }, { id: '440', label: 'Classificata Flex' }], pairs: [] },
    summary: { unique_games: 0, observations: 0, accounts: 2, classified_games: 0, unclassified_games: 0, metrics_games: 0, supported_categories: 0 },
    categories: [], behavior: [], suggestions: { category_id: null, exploratory: true, played: [], untried: [] }, notes: [],
  }
}

function setup(page: typeof pages[number], raw: string | null, rejected = false) {
  const requests: URL[] = []
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname !== page.endpoint) throw new Error('Unexpected request')
    requests.push(url)
    const queue = url.searchParams.get('queue') ?? page.fallback
    return Promise.resolve(rejected && queue !== 'all' ? Response.json({ error: 'Modalità non valida' }, { status: 400 }) : Response.json(fixture(page.endpoint, queue)))
  }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  const url = new URL(page.path, 'http://localhost')
  url.searchParams.set('days', 'all'); url.searchParams.set('min_games', '1')
  if (raw !== null) url.searchParams.set('queue', raw)
  const router = createMemoryRouter([{ path: '*', element: <page.component /> }], { initialEntries: [url.pathname + url.search] })
  disposables.push(() => { router.dispose(); client.clear() })
  render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>)
  return { requests, router, client, user: userEvent.setup(), select: screen.getByRole('combobox', { name: page.label }) }
}

afterEach(() => { cleanup(); disposables.splice(0).forEach((dispose) => dispose()); vi.unstubAllGlobals() })

for (const page of pages) describe(`modalità nei link ${page.name}`, () => {
  it.each(['RANKED_FLEX_SR', 'ranked_flex_sr', ' 440 ', ' Ranked Flex ', 'QUEUE440', '\u0085\u001c440\u001f'])('mostra e invia Flex per %j, poi permette Tutte senza passaggi intermedi', async (raw) => {
    const { requests, router, select, user } = setup(page, raw)
    await waitFor(() => expect(requests).toHaveLength(1))
    expect(select).toHaveValue('440')
    expect(requests[0]!.searchParams.get('queue')).toBe('440')
    expect(new URLSearchParams(router.state.location.search).get('queue')).toBe(raw)
    expect(within(select).getAllByRole('option').filter((option) => (option as HTMLOptionElement).value === '440')).toHaveLength(1)

    await user.selectOptions(select, 'all')
    await waitFor(() => expect(requests).toHaveLength(2))
    expect(requests[1]!.searchParams.get('queue')).toBe('all')
    expect(select).toHaveValue('all')
    expect(new URLSearchParams(router.state.location.search).get('queue')).toBe(page.name === 'Stili' ? 'all' : null)
  })

  it.each([null, '', '420', '440', 'all'])('mantiene il default e le modalità canoniche per %j', async (raw) => {
    const canonical = raw || page.fallback
    const { requests, router, select } = setup(page, raw)
    await waitFor(() => expect(requests).toHaveLength(1))
    expect(select).toHaveValue(canonical)
    expect(requests[0]!.searchParams.get('queue')).toBe(canonical)
    expect(new URLSearchParams(router.state.location.search).get('queue')).toBe(raw)
  })

  it.each(['unknown', 'ALL', ' all ', '\ufeff440\ufeff', 'QUEUE', '\u0085 \u001c', 'QUEUEQUEUE440', 'QUEUERANKED_FLEX_SR', 'QUEUENORMAL_DRAFT'])('mantiene la validazione server per %j e permette una scelta esplicita', async (raw) => {
    const { requests, router, select, user } = setup(page, raw, true)
    await waitFor(() => expect(requests).toHaveLength(1))
    expect(new URLSearchParams(router.state.location.search).get('queue')).toBe(raw)
    expect(await screen.findByRole('alert')).toHaveTextContent('Modalità non valida')
    expect(requests[0]!.searchParams.get('queue')).not.toBe('all')
    if (['QUEUEQUEUE440', 'QUEUERANKED_FLEX_SR', 'QUEUENORMAL_DRAFT'].includes(raw)) expect(requests[0]!.searchParams.get('queue')).toBe(raw)
    expect(within(select).getByRole('option', { name: 'Modalità del link' })).toBeDisabled()
    expect(select).not.toHaveValue('all')
    await user.selectOptions(select, 'all')
    await waitFor(() => expect(requests).toHaveLength(2))
    expect(requests[1]!.searchParams.get('queue')).toBe('all')
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
  })

  it('riusa la query canonica per due link Flex equivalenti', async () => {
    const { requests, router, select } = setup(page, 'RANKED_FLEX_SR')
    await waitFor(() => expect(requests).toHaveLength(1))
    const next = new URL(router.state.location.pathname + router.state.location.search, 'http://localhost')
    next.searchParams.set('queue', '440')
    await act(() => router.navigate(next.pathname + next.search))
    expect(select).toHaveValue('440')
    expect(requests).toHaveLength(1)
  })
})
