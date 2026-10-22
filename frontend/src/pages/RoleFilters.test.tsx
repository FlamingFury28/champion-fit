import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PlaystylesResponse } from '../api/playstyles'
import type { FriendsResponseDto } from '../api/types'
import { FriendsPage } from './FriendsPage'
import { PlaystylesPage } from './PlaystylesPage'

vi.mock('../app/scope', () => ({ useScope: () => ({ scope: { accounts: ['Alpha#EUW'], companion: null }, scopeReady: true }) }))
vi.mock('../components/toast', () => ({ useToast: () => ({ notify: vi.fn() }) }))

const pages = [
  { name: 'Compagni', path: '/app/team/friends', endpoint: '/api/friends', label: 'Ruolo del confronto', component: FriendsPage },
  { name: 'Stili', path: '/app/playstyles', endpoint: '/api/playstyles', label: 'Ruolo degli stili', component: PlaystylesPage },
] as const
const clients: QueryClient[] = []
const routers: ReturnType<typeof createMemoryRouter>[] = []

function friendsResponse(): FriendsResponseDto {
  return { items: [], manual_groups: [], summary: {
    tracked_accounts: 1, matches_with_participants: 0, friends_found: 0, min_shared_games: 1, accounts: ['Alpha#EUW'],
  } }
}

function playstylesResponse(role: string, queue: string): PlaystylesResponse {
  return {
    version: 'synthetic', catalog: { version: 'synthetic', source_version: 'synthetic', sources: [], categories: [] },
    filters: { role, queue, days: 'all' }, options: {
      roles: ['MIDDLE', 'SUPPORT'], queues: [{ id: '420', label: 'Solo/Duo' }, { id: '440', label: 'Flex' }], pairs: [],
    },
    summary: { unique_games: 0, observations: 0, accounts: 1, classified_games: 0, unclassified_games: 0, metrics_games: 0, supported_categories: 0 },
    categories: [], behavior: [], suggestions: { category_id: null, exploratory: true, played: [], untried: [] }, notes: [],
  }
}

function setup(page: typeof pages[number], raw: string | null, { resolvedRole = 'SUPPORT', fail = false, pending = false, queue = '420' } = {}) {
  const requests: URL[] = []
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    if ((init?.method ?? 'GET') !== 'GET' || url.pathname !== page.endpoint) throw new Error('Unexpected request')
    requests.push(url)
    if (pending) return new Promise<Response>(() => undefined)
    return Promise.resolve(fail ? Response.json({ error: 'Ruolo non valido' }, { status: 400 })
      : Response.json(page.name === 'Compagni' ? friendsResponse() : playstylesResponse(resolvedRole, queue)))
  }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  clients.push(client)
  const params = new URLSearchParams({ min_games: '1', queue, days: 'all' })
  if (raw !== null) params.set('role', raw)
  const router = createMemoryRouter([{ path: '*', element: <page.component /> }], { initialEntries: [`${page.path}?${params}`] })
  routers.push(router)
  render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>)
  return { requests, client, router, user: userEvent.setup(), select: screen.getByRole('combobox', { name: page.label }) }
}

afterEach(() => {
  cleanup()
  routers.splice(0).forEach((router) => router.dispose())
  clients.splice(0).forEach((client) => client.clear())
  vi.unstubAllGlobals()
})

for (const page of pages) describe(`ruolo nei filtri ${page.name}`, () => {
  it.each([
    ['middle', 'MIDDLE'], ['UTILITY', 'SUPPORT'], ['\u0085utility\u001c', 'SUPPORT'],
  ])('mostra e invia %s canonico, poi permette di scegliere Tutti senza passaggi intermedi', async (raw, canonical) => {
    const { requests, router, user, select } = setup(page, raw, { resolvedRole: canonical })
    await waitFor(() => expect(requests).toHaveLength(1))
    expect(select).toHaveValue(canonical)
    expect(requests[0]!.searchParams.get('role')).toBe(canonical)
    expect(new URLSearchParams(router.state.location.search).get('role')).toBe(raw)
    if (canonical === 'SUPPORT') expect(within(select).getAllByRole('option', { name: /^Supporto$/ })).toHaveLength(1)

    await user.selectOptions(select, 'ALL')
    await waitFor(() => expect(requests).toHaveLength(2))
    expect(requests[1]!.searchParams.get('role')).toBe('ALL')
    expect(select).toHaveValue('ALL')
    expect(new URLSearchParams(router.state.location.search).get('role')).toBe(page.name === 'Compagni' ? null : 'ALL')
  })

  it.each([null, '', 'ALL', 'MIDDLE', 'SUPPORT'])('conserva il contratto del ruolo canonico o assente %s', async (raw) => {
    const canonical = raw || 'ALL'
    const { requests, router, select } = setup(page, raw, { resolvedRole: canonical })
    await waitFor(() => expect(requests).toHaveLength(1))
    expect(select).toHaveValue(canonical)
    expect(requests[0]!.searchParams.get('role')).toBe(canonical)
    expect(new URLSearchParams(router.state.location.search).get('role')).toBe(raw)
  })

  it.each([['unknown', 'UNKNOWN'], ['\ufeffSUPPORT', '\ufeffSUPPORT']])('conserva l’errore del ruolo sconosciuto %s senza trasformarlo in un aggregato', async (raw, canonical) => {
    const { requests, router, select, user } = setup(page, raw, { fail: true })
    expect(await screen.findByRole('alert')).toHaveTextContent('Ruolo non valido')
    expect(requests[0]!.searchParams.get('role')).toBe(canonical)
    expect(select).toHaveValue(canonical)
    expect(new URLSearchParams(router.state.location.search).get('role')).toBe(raw)
    expect(within(select).getByRole('option', { name: /^Ruolo non valido$/ })).toBeDisabled()
    if (page.name === 'Compagni') {
      expect(screen.getByText(/^Contesto:/)).toHaveTextContent('ruolo non valido')
      expect(screen.getByText(/^Contesto:/)).not.toHaveTextContent('Supporto')
    }
    await user.selectOptions(select, 'ALL')
    await waitFor(() => expect(requests).toHaveLength(2))
    expect(requests[1]!.searchParams.get('role')).toBe('ALL')
  })

  it('mantiene il ruolo automatico whitespace-only distinto da Tutti e preserva il wire', async () => {
    const raw = '\u0085 \u001c'
    const { requests, router, select, user } = setup(page, raw, { resolvedRole: 'MIDDLE' })
    await waitFor(() => expect(requests).toHaveLength(1))
    expect(requests[0]!.searchParams.get('role')).toBe(raw)
    expect(select).toHaveValue(raw)
    expect(new URLSearchParams(router.state.location.search).get('role')).toBe(raw)
    expect(within(select).getByRole('option', { name: /^Ruolo automatico$/ })).toBeDisabled()
    if (page.name === 'Compagni') {
      expect(screen.getByText(/^Contesto:/)).toHaveTextContent('ruolo automatico')
    }
    await user.selectOptions(select, 'ALL')
    await waitFor(() => expect(requests).toHaveLength(2))
    expect(requests[1]!.searchParams.get('role')).toBe('ALL')
    expect(select).toHaveValue('ALL')
  })

  it('riusa la query del ruolo equivalente senza riscrivere il link iniziale', async () => {
    const { requests, router, client, select } = setup(page, 'utility')
    await waitFor(() => expect(requests).toHaveLength(1))
    await act(() => router.navigate(`${page.path}?min_games=1&queue=420&days=all&role=SUPPORT`))
    await waitFor(() => expect(select).toHaveValue('SUPPORT'))
    expect(requests).toHaveLength(1)
    expect(client.getQueriesData({ queryKey: ['api', page.name === 'Compagni' ? 'friends' : 'playstyles'] })).toHaveLength(1)
  })
})

it('Stili conserva ruolo canonico e coda440 anche prima di una risposta senza dati', async () => {
  const { select, requests } = setup(pages[1], ' utility ', { pending: true, queue: '440' })
  await waitFor(() => expect(requests).toHaveLength(1))
  expect(select).toHaveValue('SUPPORT')
  expect(within(select).getAllByRole('option', { name: /^Supporto$/ })).toHaveLength(1)
  expect(screen.getByRole('combobox', { name: 'Modalità degli stili' })).toHaveValue('440')
  expect(requests[0]!.searchParams.get('role')).toBe('SUPPORT')
  expect(requests[0]!.searchParams.get('queue')).toBe('440')
})
