import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider, useSearchParams } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ObservedRecommendationDto, RecommendationsResponseDto } from '../api/types'
import { discoveryRecommendation, observedRecommendation, recommendationsFixture } from '../test/recommendations-fixture'
import { ChampionDetailPage } from './ChampionDetailPage'
import { FitPage } from './FitPage'
import { ScoutPage } from './ScoutPage'
import { TestPlanPage } from './TestPlanPage'

vi.mock('../app/scope', () => ({ useScope: () => ({
  scope: {
    accounts: ['Alpha#EUW', 'Beta#EUW'], algorithmRevision: 3,
    companion: { name: 'Gamma', accounts: ['Gamma#EUW'], mode: 'exclude', profileAccounts: ['Alpha#EUW', 'Beta#EUW'] },
  }, scopeReady: true,
}) }))

const pages = [
  { id: 'fit', element: <FitPage /> },
  { id: 'scout', element: <ScoutPage embedded /> },
  { id: 'plan', element: <TestPlanPage embedded /> },
] as const
type Page = typeof pages[number]
type Role = 'MIDDLE' | 'SUPPORT'
const disposables: (() => void)[] = []

function ListOrSheet({ page }: { page: Page }) {
  const [params] = useSearchParams()
  const champion = params.get('detail')
  return champion ? <ChampionDetailPage champion={champion} embedded /> : page.element
}

function candidate(champion: string, role: Role, games: number, queue: string): ObservedRecommendationDto {
  const base = observedRecommendation()
  const account = queue === '440' ? 'Beta#EUW' : 'Alpha#EUW'
  return observedRecommendation({
    champion, name: champion, role, games, account_count: games ? 1 : 0, selected_account_count: 2,
    performance: {
      ...base.performance!, games, observations: games, wins: games, losses: 0,
      win_rate: games ? 100 : null, missing_accounts: ['Alpha#EUW', 'Beta#EUW'].filter((item) => !games || item !== account),
      per_account: games ? { [account]: { games, wins: games, losses: 0, win_rate: 100 } } : {},
    },
  })
}

function responseFor(url: URL): RecommendationsResponseDto | null {
  const requestedQueue = url.searchParams.get('queue')
  const requestedRole = url.searchParams.get('role')
  const requestedDays = url.searchParams.get('days')
  if (![null, 'auto', 'all', '420', '440'].includes(requestedQueue)) return null
  if (requestedDays !== null && requestedDays !== 'all') return null
  const role = requestedRole === 'AUTO' ? 'MIDDLE' : requestedRole ?? 'ALL'
  // Closed examples from the HTTP audit: all-role AUTO chooses 420, whereas
  // narrowing to SUPPORT would choose 440 unless the card pins its source queue.
  const queue = requestedQueue === null || requestedQueue === 'auto' ? role === 'SUPPORT' ? '440' : '420' : requestedQueue
  const gamesPeriod = requestedDays === null
  const facts = [
    { champion: 'Ahri', role: 'MIDDLE' as const, queue: '420', games: gamesPeriod ? 2 : 3 },
    ...gamesPeriod ? [] : [{ champion: 'Lux', role: 'SUPPORT' as const, queue: '420', games: 1 }],
    { champion: 'Ahri', role: 'SUPPORT' as const, queue: '440', games: 1 },
    { champion: 'Garen', role: 'SUPPORT' as const, queue: '440', games: 1 },
  ].filter((fact) => (queue === 'all' || fact.queue === queue) && (role === 'ALL' || fact.role === role))
  const known = facts.map((fact) => candidate(fact.champion, fact.role, fact.games, fact.queue))
  const discover = [discoveryRecommendation({ champion: 'Orianna', name: 'Orianna', role: 'MIDDLE' })]
    .filter((item) => role === 'ALL' || item.role === role)
  const champion = url.searchParams.get('champion')
  const selected = champion ? known.find((item) => item.champion === champion)
    ?? discover.find((item) => item.champion === champion)
    ?? candidate(champion, role === 'SUPPORT' ? 'SUPPORT' : 'MIDDLE', 0, queue) : null
  const games = facts.reduce((total, fact) => total + fact.games, 0)
  return recommendationsFixture({
    algorithm_revision: 3,
    context: {
      accounts: ['Alpha#EUW', 'Beta#EUW'], role, queue, days: 'all',
      period: gamesPeriod ? { value: 2, unit: 'games' } : { value: 0, unit: 'days' },
      automatic_queue: requestedQueue === null || requestedQueue === 'auto',
      suspended_accounts: [], unresolved_accounts: [],
    },
    coverage: { selected_accounts: ['Alpha#EUW', 'Beta#EUW'], active_accounts: games ? ['Alpha#EUW'] : [], missing_accounts: [], games, observations: games },
    profile: [], known, discover, candidate: selected,
    trial_plan: { budget: discover.length, items: discover.map((item) => ({ champion: item.champion, role: item.role, games: 1, reason: 'Prova sintetica di catalogo.' })) },
  })
}

function setup(page: Page, rawRole: string, rawQueue: string | null, rawDays: string | null) {
  const requests: URL[] = []
  const responses: RecommendationsResponseDto[] = []
  const writes: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    if ((init?.method ?? 'GET') !== 'GET') {
      writes.push(init!.method!)
      throw new Error('Unexpected write')
    }
    if (url.pathname === '/api/recommendation-feedback') return Response.json({
      revision: 7, accounts: ['Alpha#EUW', 'Beta#EUW'], suspended_accounts: [], unresolved_accounts: [], items: [], options: [], catalog_version: 'synthetic',
    })
    if (url.pathname !== '/api/recommendations') throw new Error('Unexpected request')
    requests.push(url)
    const data = responseFor(url)
    if (!data) return Response.json({ error: 'Scegli una modalità concreta' }, { status: 400 })
    responses.push(data)
    return Response.json(data)
  }))
  const params = new URLSearchParams({
    section: page.id === 'fit' ? 'choices' : 'training', training: page.id === 'plan' ? 'plan' : 'discover',
    role: rawRole, search: ' ', tag: 'ALL', minSimilarity: '0', budget: '1000', account: 'Alpha#EUW',
  })
  params.append('account', 'Beta#EUW')
  if (rawQueue !== null) params.set('queue', rawQueue)
  if (rawDays !== null) params.set('days', rawDays)
  const initialParams = new URLSearchParams(params)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  const router = createMemoryRouter([{ path: '/app/fit', element: <ListOrSheet page={page} /> }], {
    initialEntries: [`/app/fit?${params}`],
  })
  disposables.push(() => { router.dispose(); client.clear() })
  render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>)
  return { page, requests, responses, writes, client, router, initialParams, user: userEvent.setup() }
}
type State = ReturnType<typeof setup>

async function sourceLink(state: State, champion: string) {
  if (state.page.id === 'plan') {
    const row = await screen.findByRole('row', { name: new RegExp(champion) })
    return within(row).getByRole('link', { name: 'Apri' })
  }
  const name = await screen.findByText(champion, { selector: 'strong' })
  return within(name.closest<HTMLElement>('.recommendation-card')!).getByRole('link', { name: 'Apri la scheda' })
}

function expectParentPreserved(state: State, target: URLSearchParams) {
  for (const [key, value] of state.initialParams) if (key !== 'account') expect(target.get(key)).toBe(value)
  expect(target.getAll('account')).toEqual(['Alpha#EUW', 'Beta#EUW'])
  expect(target.has('detailDays')).toBe(false)
  expect(target.get('days')).toBe(state.initialParams.get('days'))
  expect(state.writes).toEqual([])
}

async function expectSheet(state: State, champion: string, role: Role, queue: string, games: number, gamesPeriod: boolean) {
  const region = await screen.findByRole('region', { name: `Scheda di ${champion} · ${role === 'SUPPORT' ? 'Supporto' : 'Corsia centrale'}` })
  const metric = within(region).getByText('Partite uniche').closest<HTMLElement>('.metric-card')!
  expect.soft(metric.querySelector('strong')).toHaveTextContent(new RegExp(`^${games}$`))
  expect(state.requests).toHaveLength(2)
  const request = state.requests[1]!
  expect.soft(request.searchParams.get('queue')).toBe(queue)
  expect(request.searchParams.get('champion')).toBe(champion)
  expect(request.searchParams.get('role')).toBe(role)
  expect(request.searchParams.get('days')).toBe(gamesPeriod ? null : 'all')
  expect(request.searchParams.getAll('account')).toEqual(['Alpha#EUW', 'Beta#EUW'])
  expect(request.searchParams.getAll('companion_account')).toEqual(['Gamma#EUW'])
  expect(request.searchParams.get('companion_mode')).toBe('exclude')
  expect(request.searchParams.get('algorithm_revision')).toBe('3')
  expect.soft(state.responses[1]!.context.queue).toBe(queue)
  expect(state.responses[1]!.context.period).toEqual(gamesPeriod ? { value: 2, unit: 'games' } : { value: 0, unit: 'days' })
  expect(state.client.getQueryCache().findAll({ queryKey: ['api', 'recommendations'] })).toHaveLength(2)
  expectParentPreserved(state, new URLSearchParams(state.router.state.location.search))
  expect(state.router.state.location.state).toEqual({ championSheetFromList: true })
}

afterEach(() => {
  cleanup()
  disposables.splice(0).forEach((dispose) => dispose())
  vi.unstubAllGlobals()
})

describe('coda della scheda aperta dalle raccomandazioni', () => {
  it.each([
    { page: pages[0], role: 'ALL', queue: 'auto', days: 'all', champion: 'Lux', targetRole: 'SUPPORT' as const, games: 1 },
    { page: pages[1], role: 'AUTO', queue: 'auto', days: null, champion: 'Orianna', targetRole: 'MIDDLE' as const, games: 0 },
    { page: pages[2], role: 'ALL', queue: null, days: null, champion: 'Orianna', targetRole: 'MIDDLE' as const, games: 0 },
  ])('fissa la coda effettiva da $page.id mantenendo i filtri automatici e il periodo della lista', async ({ page, role, queue, days, champion, targetRole, games }) => {
    const state = setup(page, role, queue, days)
    const link = await sourceLink(state, champion)
    expect(state.requests).toHaveLength(1)
    expect(state.responses[0]!.context.queue).toBe('420')
    expect(state.responses[0]!.context.period).toEqual(days === null ? { value: 2, unit: 'games' } : { value: 0, unit: 'days' })
    const target = new URL(link.getAttribute('href')!, 'http://localhost')
    expect.soft(target.searchParams.get('detailQueue')).toBe('420')
    expect(target.searchParams.get('detail')).toBe(champion)
    expect(target.searchParams.get('detailRole')).toBe(targetRole)
    expectParentPreserved(state, target.searchParams)
    expect(new URLSearchParams(state.router.state.location.search).toString()).toBe(state.initialParams.toString())
    await state.user.click(link)
    await expectSheet(state, champion, targetRole, '420', games, days === null)
  })

  it.each([
    { queue: 'all', champion: 'Lux' }, { queue: '440', champion: 'Ahri' },
  ])('conserva il contesto già esplicito $queue senza allargare il periodo', async ({ queue, champion }) => {
    const state = setup(pages[0], 'ALL', queue, 'all')
    const link = await sourceLink(state, champion)
    const target = new URL(link.getAttribute('href')!, 'http://localhost')
    expectParentPreserved(state, target.searchParams)
    await state.user.click(link)
    await expectSheet(state, champion, 'SUPPORT', queue, 1, false)
  })

  it.each([
    { page: pages[0], queue: 'unknown' }, { page: pages[1], queue: '\ufeff440\ufeff' }, { page: pages[2], queue: 'QUEUEAUTO' },
  ])('non inventa una scheda da $page.id con coda non valida $queue', async ({ page, queue }) => {
    const state = setup(page, 'ALL', queue, 'all')
    expect(await screen.findByRole('alert')).toHaveTextContent('Scegli una modalità concreta')
    await waitFor(() => expect(state.requests).toHaveLength(1))
    expect(state.requests[0]!.searchParams.get('queue')).toBe(queue)
    expect(screen.queryByRole('link', { name: 'Apri la scheda' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Apri' })).not.toBeInTheDocument()
    expect(new URLSearchParams(state.router.state.location.search).toString()).toBe(state.initialParams.toString())
    expect(state.writes).toEqual([])
  })
})
