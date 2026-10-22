import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
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
const menuQueues = ['all', '400', '420', '430', '440', '480', '490', '700']

function responseFor(queue: string): SynergyResponseDto {
  // Six closed synthetic observations: four Alpha Solo/Duo and two Beta Flex.
  // The API accepts numeric filters outside the menu even without observations.
  const games = queue === 'all' ? 6 : queue === '420' ? 4 : queue === '440' ? 2 : 0
  return {
    champion: 'Ahri', accounts: ['Alpha#EUW', 'Beta#EUW'], companion_filter_active: false,
    context: { role: 'SUPPORT', queue, days: 'all', observations: games },
    min_reliability: 'indicative', include_exploratory: true, min_games: 1,
    games, games_with_teammates: games,
    coverage: { raw_games: 6, eligible_games: 6, analyzed_games: 6, games_with_roster: games, roster_coverage: games ? 100 : 0 },
    available_champions: games ? [{ champion: 'Ahri', games, icon_url: '' }] : [],
    better_with: [], worse_with: [],
  }
}

function setup(rawQueue: string | null) {
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
    // Closed accepted examples, independent of the frontend queue helper.
    const raw = url.searchParams.get('queue')
    const queue = raw === 'RANKED_FLEX_SR' ? '440' : raw
    if (queue === null || ![...menuQueues, '999', '00440', '450'].includes(queue)) {
      return Response.json({ error: 'Modalità non valida' }, { status: 400 })
    }
    return Response.json(responseFor(queue))
  }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  const params = new URLSearchParams({
    section: 'matchups', relation: 'allies', role: 'UTILITY', days: 'all', champion: 'Ahri',
    min_reliability: 'indicative', include_exploratory: '1', search: ' ', budget: '1000',
  })
  if (rawQueue !== null) params.set('queue', rawQueue)
  const initialParams = new URLSearchParams(params)
  const router = createMemoryRouter([{ path: '/app/fit', element: <SynergyPage embedded /> }], {
    initialEntries: [`/app/fit?${params}`],
  })
  disposables.push(() => { router.dispose(); client.clear() })
  render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>)
  return { requests, writes, client, router, initialParams, user: userEvent.setup(), select: screen.getByRole('combobox', { name: 'Modalità' }) }
}
type State = ReturnType<typeof setup>

function expectPreservedContext(state: State, queueChanged = false) {
  const current = new URLSearchParams(state.router.state.location.search)
  for (const [key, value] of state.initialParams) if (!queueChanged || key !== 'queue') expect(current.get(key)).toBe(value)
  expect(state.router.state.location.pathname).toBe('/app/fit')
  const request = state.requests.at(-1)!
  expect(request.searchParams.getAll('account')).toEqual(['Alpha#EUW', 'Beta#EUW'])
  expect(request.searchParams.get('algorithm_revision')).toBe('4')
  expect(request.searchParams.get('role')).toBe('SUPPORT')
  expect(request.searchParams.get('days')).toBe('all')
  expect(request.searchParams.get('champion')).toBe('Ahri')
  expect(request.searchParams.get('min_reliability')).toBe('indicative')
  expect(request.searchParams.get('include_exploratory')).toBe('1')
  expect(screen.getByRole('combobox', { name: 'Ruolo' })).toHaveValue('SUPPORT')
  expect(screen.getByRole('combobox', { name: 'Periodo' })).toHaveValue('all')
  expect(screen.getByRole('combobox', { name: 'Campione giocato' })).toHaveValue('Ahri')
  expect(screen.getByRole('checkbox', { name: 'Mostra esplorativi' })).toBeChecked()
  expect(state.writes).toEqual([])
}

async function expectGames(games: number, soft = false) {
  const region = await screen.findByRole('region', { name: 'Risultati delle sinergie' })
  const metric = within(region).getByText('Partite analizzate').closest<HTMLElement>('.metric-card')!
  const value = metric.querySelector('strong')!
  expect(value).toHaveTextContent(/^6$/)
  if (soft) expect.soft(metric).toHaveTextContent(`${games} con il filtro sul campione`)
  else expect(metric).toHaveTextContent(`${games} con il filtro sul campione`)
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
}

function expectLinkedOption(state: State, queue: string) {
  expect.soft(state.select).toHaveValue(queue)
  const selected = within(state.select).getByRole('option', { selected: true })
  expect.soft(selected).toHaveTextContent('Modalità del link')
  expect.soft(selected).toBeDisabled()
}

async function chooseAll(state: State, previousQueue: string) {
  // The real browser regression covers native Home. Use jsdom's supported
  // select interaction and Tab here to verify URL, request and cache behavior.
  await state.user.selectOptions(state.select, 'all')
  await state.user.tab()
  await waitFor(() => expect(state.requests).toHaveLength(2))
  expect(state.requests[1]!.searchParams.get('queue')).toBe('all')
  expect(new URLSearchParams(state.router.state.location.search).has('queue')).toBe(false)
  expect(state.select).toHaveValue('all')
  expect(within(state.select).getByRole('option', { selected: true })).not.toBeDisabled()
  await expectGames(6)
  const queries = state.client.getQueryCache().findAll({ queryKey: ['api', 'synergy'] })
  expect(queries).toHaveLength(2)
  expect(queries.map((query) => query.queryKey.at(-1))).toEqual(expect.arrayContaining([
    expect.objectContaining({ queue: previousQueue }), expect.objectContaining({ queue: 'all' }),
  ]))
  expectPreservedContext(state, true)
}

afterEach(() => {
  cleanup()
  disposables.splice(0).forEach((dispose) => dispose())
  vi.unstubAllGlobals()
})

describe('code delle sinergie nel contratto comune', () => {
  it.each(['999', '00440', '450'])('mantiene la coda numerica valida %s vuota finché si scelgono Tutte', async (queue) => {
    const state = setup(queue)
    await waitFor(() => expect(state.requests).toHaveLength(1))
    await waitFor(() => expect(state.client.isFetching()).toBe(0))
    expect.soft(state.requests[0]!.searchParams.get('queue')).toBe(queue)
    const queries = state.client.getQueryCache().findAll({ queryKey: ['api', 'synergy'] })
    expect(queries).toHaveLength(1)
    expect.soft(queries[0]!.queryKey.at(-1)).toMatchObject({ queue })
    expectLinkedOption(state, queue)
    await expectGames(0, true)
    expectPreservedContext(state)
    await chooseAll(state, queue)
  })

  it.each([
    { raw: 'unknown', wire: 'UNKNOWN' },
    { raw: '\ufeff440\ufeff', wire: '\ufeff440\ufeff' },
    { raw: '0', wire: '0' },
  ])('conserva il 400 per $raw e recupera soltanto scegliendo Tutte', async ({ raw, wire }) => {
    const state = setup(raw)
    await waitFor(() => expect(state.requests).toHaveLength(1))
    await waitFor(() => expect(state.client.isFetching()).toBe(0))
    expect.soft(state.requests[0]!.searchParams.get('queue')).toBe(wire)
    const queries = state.client.getQueryCache().findAll({ queryKey: ['api', 'synergy'] })
    expect(queries).toHaveLength(1)
    expect.soft(queries[0]!.queryKey.at(-1)).toMatchObject({ queue: wire })
    expect.soft(queries[0]!.state.status).toBe('error')
    expect.soft(screen.queryByRole('alert')).toHaveTextContent('Modalità non valida')
    expectLinkedOption(state, wire)
    expectPreservedContext(state)
    await chooseAll(state, wire)
  })

  it.each([
    { raw: '420', wire: '420', games: 4 },
    { raw: '440', wire: '440', games: 2 },
    { raw: 'all', wire: 'all', games: 6 },
    { raw: null, wire: 'all', games: 6 },
    { raw: '', wire: 'all', games: 6 },
  ])('mantiene il menu ordinario o il default corrente per $raw', async ({ raw, wire, games }) => {
    const state = setup(raw)
    await expectGames(games)
    expect(state.requests).toHaveLength(1)
    expect(state.requests[0]!.searchParams.get('queue')).toBe(wire)
    expect(state.select).toHaveValue(wire)
    const options = within(state.select).getAllByRole('option') as HTMLOptionElement[]
    expect(options.map((option) => option.value).sort()).toEqual([...menuQueues].sort())
    expect(options.every((option) => !option.disabled)).toBe(true)
    expectPreservedContext(state)
  })

  it('condivide alias Flex e 440 nella cache mantenendo UTILITY e il link originale fino alla navigazione', async () => {
    const state = setup('RANKED_FLEX_SR')
    await expectGames(2)
    expect(state.select).toHaveValue('440')
    expect(state.requests[0]!.searchParams.get('queue')).toBe('440')
    expect(new URLSearchParams(state.router.state.location.search).get('queue')).toBe('RANKED_FLEX_SR')
    expectPreservedContext(state)
    const next = new URLSearchParams(state.router.state.location.search)
    next.set('queue', '440')
    await act(() => state.router.navigate(`/app/fit?${next}`))
    await expectGames(2)
    expect(state.requests).toHaveLength(1)
    expect(state.client.getQueryCache().findAll({ queryKey: ['api', 'synergy'] })).toHaveLength(1)
    expectPreservedContext(state, true)
  })
})
