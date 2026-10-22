import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, expect, it, vi } from 'vitest'
import type { MatchupsResponseDto } from '../api/types'
import { ChampionsPage } from './ChampionsPage'

vi.mock('../app/scope', () => ({ useScope: () => ({
  scope: { accounts: ['Alpha#EUW', 'Beta#EUW'], companion: null }, scopeReady: true, availableAccounts: [],
}) }))
const disposables: (() => void)[] = []

function payload(queue: string, games: number): MatchupsResponseDto {
  return {
    champion: 'ALL', role: 'ALL', games, wins: Math.floor(games / 2), win_rate: 50,
    games_with_opponents: games, baseline_win_rate: 50, loses_to: [], beats: [],
    available_champions: games ? [{ champion: queue === '440' ? 'Garen' : 'Ahri', games, icon_url: '' }] : [],
    context: { role: 'ALL', queue, days: 'all', observations: games },
  }
}

function setup(raw: string | null, { resolvedQueue = '440', games = 2, rejected = false } = {}) {
  const requests: URL[] = []
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname !== '/api/matchups') throw new Error('Unexpected request')
    requests.push(url)
    const aggregate = url.searchParams.get('queue') === 'all'
    return Promise.resolve(rejected && !aggregate ? Response.json({ error: 'Modalità non valida' }, { status: 400 })
      : Response.json(payload(aggregate ? 'all' : resolvedQueue, aggregate ? 6 : games)))
  }))
  const params = new URLSearchParams({ section: 'matchups', relation: 'enemies', role: 'ALL', days: 'all' })
  if (raw !== null) params.set('queue', raw)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  const router = createMemoryRouter([{ path: '*', element: <ChampionsPage /> }], { initialEntries: [`/app/fit?${params}`] })
  disposables.push(() => { router.dispose(); client.clear() })
  render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>)
  const metric = () => screen.getByText('Partite personali nel contesto').closest('article')!
  return { requests, router, user: userEvent.setup(), select: screen.getByRole('combobox', { name: 'Modalità' }), metric }
}

afterEach(() => { cleanup(); disposables.splice(0).forEach((dispose) => dispose()); vi.unstubAllGlobals() })

it.each(['RANKED_FLEX_SR', ' ranked flex ', ' 440 ', '\u0085\u001c440\u001f', 'QUEUE440'])(
  'mostra il contesto Flex del link %j e permette Tutte senza un passaggio intermedio', async (raw) => {
    const { requests, router, user, select, metric } = setup(raw)
    await waitFor(() => expect(requests).toHaveLength(1))
    expect(select).toHaveValue('440')
    expect(requests[0]!.searchParams.get('queue')).toBe('440')
    expect(new URLSearchParams(router.state.location.search).get('queue')).toBe(raw)
    await waitFor(() => expect(metric().querySelector('strong')).toHaveTextContent('2'))

    await user.selectOptions(select, 'all')
    await waitFor(() => expect(requests).toHaveLength(2))
    expect(select).toHaveValue('all')
    expect(requests[1]!.searchParams.get('queue')).toBe('all')
    expect(new URLSearchParams(router.state.location.search).get('queue')).toBe('all')
    expect(new URLSearchParams(router.state.location.search).get('relation')).toBe('enemies')
    await waitFor(() => expect(metric().querySelector('strong')).toHaveTextContent('6'))
  },
)

it.each([
  { raw: null, selected: 'all', wire: 'all', effective: 'all', games: 6 },
  { raw: '', selected: '', wire: null, effective: '420', games: 4 },
  { raw: 'all', selected: 'all', wire: 'all', effective: 'all', games: 6 },
  { raw: '440', selected: '440', wire: '440', effective: '440', games: 2 },
  { raw: '420', selected: '420', wire: '420', effective: '420', games: 4 },
])('mantiene distinto il default del link $raw dal contesto $effective', async ({ raw, selected, wire, effective, games }) => {
  const { requests, router, select, metric, user } = setup(raw, { resolvedQueue: effective, games })
  await waitFor(() => expect(requests).toHaveLength(1))
  expect(select).toHaveValue(selected)
  expect(requests[0]!.searchParams.get('queue')).toBe(wire)
  expect(new URLSearchParams(router.state.location.search).get('queue')).toBe(raw)
  await waitFor(() => expect(metric().querySelector('strong')).toHaveTextContent(String(games)))
  if (raw === '') {
    expect(within(select).getByRole('option', { name: 'Modalità predefinita' })).toBeDisabled()
    await user.selectOptions(select, 'all')
    await waitFor(() => expect(requests).toHaveLength(2))
    expect(requests[1]!.searchParams.get('queue')).toBe('all')
    await waitFor(() => expect(metric().querySelector('strong')).toHaveTextContent('6'))
  }
})

it.each(['unknown', 'ALL', ' all ', '\ufeff440\ufeff', 'QUEUEQUEUE440', 'QUEUERANKED_FLEX_SR', 'QUEUE', '\u0085 \u001c'])(
  'conserva l’errore per %j e permette di scegliere esplicitamente Tutte', async (raw) => {
    const { requests, select, user, router } = setup(raw, { rejected: true })
    expect(await screen.findByRole('alert')).toHaveTextContent('Modalità non valida')
    expect(select).not.toHaveValue('all')
    expect(within(select).getByRole('option', { name: 'Modalità del link' })).toBeDisabled()
    expect(new URLSearchParams(router.state.location.search).get('queue')).toBe(raw)
    expect(requests[0]!.searchParams.get('queue')).not.toBeNull()
    await user.selectOptions(select, 'all')
    await waitFor(() => expect(requests).toHaveLength(2))
    expect(requests[1]!.searchParams.get('queue')).toBe('all')
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
  },
)

it.each(['999', '00440', '450'])('mantiene senza clamp la modalità numerica %s con scope vuoto', async (queue) => {
  const { requests, select, metric } = setup(queue, { resolvedQueue: queue, games: 0 })
  await waitFor(() => expect(requests).toHaveLength(1))
  expect(select).toHaveValue(queue)
  expect(requests[0]!.searchParams.get('queue')).toBe(queue)
  expect(within(select).getByRole('option', { name: 'Modalità del link' })).toBeDisabled()
  await waitFor(() => expect(metric().querySelector('strong')).toHaveTextContent('0'))
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})

it('riusa la query per link Flex equivalenti senza riscrivere gli altri parametri', async () => {
  const { requests, router, select } = setup('RANKED_FLEX_SR')
  await waitFor(() => expect(requests).toHaveLength(1))
  const next = new URLSearchParams(router.state.location.search)
  next.set('queue', '440')
  await act(() => router.navigate(`/app/fit?${next}`))
  expect(select).toHaveValue('440')
  expect(requests).toHaveLength(1)
  expect(new URLSearchParams(router.state.location.search).get('role')).toBe('ALL')
})
