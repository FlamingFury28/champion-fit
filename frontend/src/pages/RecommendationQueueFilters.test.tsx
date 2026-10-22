import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RecommendationsResponseDto } from '../api/types'
import { discoveryRecommendation, observedRecommendation, recommendationsFixture } from '../test/recommendations-fixture'
import { ChampionDetailPage } from './ChampionDetailPage'
import { FitPage } from './FitPage'
import { ScoutPage } from './ScoutPage'
import { TestPlanPage } from './TestPlanPage'

vi.mock('../app/scope', () => ({ useScope: () => ({
  scope: {
    accounts: ['Alpha#EUW', 'Beta#EUW'], algorithmRevision: 4,
    companion: { name: 'Compagno sintetico', accounts: ['Gamma#EUW'], mode: 'exclude', profileAccounts: ['Alpha#EUW', 'Beta#EUW'] },
  }, scopeReady: true,
}) }))

const consumers = [
  { id: 'fit', queueKey: 'queue', path: '/app/fit', route: '/app/fit', element: <FitPage /> },
  { id: 'scout', queueKey: 'queue', path: '/app/fit', route: '/app/fit', element: <ScoutPage embedded /> },
  { id: 'plan', queueKey: 'queue', path: '/app/fit', route: '/app/fit', element: <TestPlanPage embedded /> },
  { id: 'detail-embedded', queueKey: 'detailQueue', path: '/app/fit', route: '/app/fit', element: <ChampionDetailPage champion="Ahri" embedded /> },
  { id: 'detail-standalone', queueKey: 'queue', path: '/direct/Ahri', route: '/direct/:champion', element: <ChampionDetailPage /> },
] as const
type Consumer = typeof consumers[number]
const fit = consumers[0]
const navigationState = { championSheetFromList: true, source: 'synthetic-queue-test' }
const disposables: (() => void)[] = []

// Closed examples from the verified recommendation HTTP contract. In particular,
// invalid QUEUEALL/QUEUEAUTO cannot acquire sentinel meaning after normalization.
// This lookup deliberately does not use either frontend queue helper.
const wireExamples = new Map<string | null, string>([
  [null, 'all'], ['all', 'all'], ['ALL', 'all'], ['\u0085 ALL \u001f', 'all'],
  ['auto', 'auto'], ['AUTO', 'auto'], ['\u0085 AuTo \u001f', 'auto'], ['\u0085 \u001c', 'auto'],
  ['420', '420'], ['440', '440'], ['QUEUE440', '440'], ['RANKED_FLEX_SR', '440'], ['\u0085 440 \u001f', '440'],
  ['450', '450'], ['999', '999'], ['00440', '00440'],
])

function responseFor(queue: string, automatic: boolean): RecommendationsResponseDto {
  // Six distinct account/match facts: four Alpha Solo/Duo and two Beta Flex.
  // The catalog proposals remain meaningful even in a valid empty queue.
  const facts = [
    { account: 'Alpha#EUW', queue: '420', games: 4 },
    { account: 'Beta#EUW', queue: '440', games: 2 },
  ].filter((item) => queue === 'all' || item.queue === queue)
  const games = facts.reduce((total, item) => total + item.games, 0)
  const activeAccounts = facts.map((item) => item.account)
  const missingAccounts = ['Alpha#EUW', 'Beta#EUW'].filter((account) => !activeAccounts.includes(account))
  const base = observedRecommendation()
  const candidate = observedRecommendation({
    games, account_count: activeAccounts.length, selected_account_count: 2,
    performance: {
      ...base.performance!, games, observations: games, wins: games, losses: 0,
      win_rate: games ? 100 : null, missing_accounts: missingAccounts,
      per_account: Object.fromEntries(facts.map((item) => [item.account, { games: item.games, wins: item.games, losses: 0, win_rate: 100 }])),
    },
  })
  const discover = [discoveryRecommendation(), discoveryRecommendation({ champion: 'Sona', name: 'Sona' })]
  return recommendationsFixture({
    context: {
      accounts: ['Alpha#EUW', 'Beta#EUW'], role: 'MIDDLE', queue, days: 'all', period: { value: 0, unit: 'days' },
      automatic_queue: automatic, all_queues: queue === 'all', suspended_accounts: [], unresolved_accounts: [],
    },
    coverage: { selected_accounts: ['Alpha#EUW', 'Beta#EUW'], active_accounts: activeAccounts, missing_accounts: missingAccounts, games, observations: games },
    profile: [], known: games ? [candidate] : [], discover, candidate,
    trial_plan: { budget: 2, items: discover.map((item) => ({ champion: item.champion, role: item.role, games: 1, reason: 'Proposta sintetica di catalogo.' })) },
  })
}

function setup(consumer: Consumer, rawQueue: string | null) {
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
    const requested = url.searchParams.get('queue')
    const resolved = wireExamples.get(requested)
    if (!resolved) return Response.json({ error: 'Scegli una modalità concreta' }, { status: 400 })
    const data = responseFor(resolved === 'auto' ? '420' : resolved, resolved === 'auto')
    responses.push(data)
    return Response.json(data)
  }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  const params = new URLSearchParams({
    section: consumer.id === 'fit' ? 'choices' : 'training', training: consumer.id === 'plan' ? 'plan' : 'discover',
    role: 'MID', detailRole: 'MID', queue: '420', days: 'all', detailDays: 'all',
    detailQueue: 'QUEUEAUTO', search: ' ', tag: 'ALL', minSimilarity: '0', budget: '1000',
  })
  params.delete(consumer.queueKey)
  if (rawQueue !== null) params.set(consumer.queueKey, rawQueue)
  const initialParams = new URLSearchParams(params)
  const router = createMemoryRouter([{ path: consumer.route, element: consumer.element }], {
    initialEntries: [{ pathname: consumer.path, search: `?${params}`, state: navigationState }],
  })
  disposables.push(() => { router.dispose(); client.clear() })
  render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>)
  return { consumer, requests, responses, writes, client, router, initialParams, user: userEvent.setup() }
}
type State = ReturnType<typeof setup>

function expectContextPreserved(state: State, queueChanged = false) {
  const current = new URLSearchParams(state.router.state.location.search)
  for (const [key, value] of state.initialParams) {
    if (!queueChanged || key !== state.consumer.queueKey) expect(current.get(key)).toBe(value)
  }
  expect(state.router.state.location.pathname).toBe(state.consumer.path)
  if (state.consumer.id.startsWith('detail')) expect(state.router.state.location.state).toEqual(navigationState)
  const request = state.requests.at(-1)!
  expect(request.searchParams.getAll('account')).toEqual(['Alpha#EUW', 'Beta#EUW'])
  expect(request.searchParams.getAll('companion_account')).toEqual(['Gamma#EUW'])
  expect(request.searchParams.get('companion_mode')).toBe('exclude')
  expect(request.searchParams.get('algorithm_revision')).toBe('4')
  expect(request.searchParams.get('role')).toBe('MIDDLE')
  expect(request.searchParams.get('days')).toBe('all')
  expect(request.searchParams.get('champion')).toBe(state.consumer.id.startsWith('detail') ? 'Ahri' : null)
  expect(state.writes).toEqual([])
}

async function expectRendered(state: State, games: number) {
  if (state.consumer.id === 'fit') {
    expect(await screen.findByText(new RegExp(`^${games} partite uniche e ${games} osservazioni`))).toBeVisible()
  } else if (state.consumer.id === 'scout') {
    expect(await screen.findByText(/^Contesto effettivo:/)).toBeVisible()
  } else if (state.consumer.id === 'plan') {
    expect(await screen.findByRole('region', { name: 'Piano di prove' })).toBeVisible()
  } else {
    const region = await screen.findByRole('region', { name: 'Scheda di Ahri · Corsia centrale' })
    const metric = within(region).getByText('Partite uniche').closest<HTMLElement>('.metric-card')!
    expect(within(metric).getByText(String(games), { selector: 'strong' })).toBeVisible()
  }
  expect(state.responses.at(-1)!.coverage.observations).toBe(games)
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
}

function expectLinkedOption(value: string, label: string) {
  const select = screen.getByRole('combobox', { name: /^Coda$/ })
  expect(select).toHaveValue(value)
  const selected = within(select).getByRole('option', { selected: true })
  expect(selected).toHaveTextContent(label)
  expect(selected).toBeDisabled()
  return select
}

async function chooseDefault(state: State) {
  await state.user.selectOptions(screen.getByRole('combobox', { name: /^Coda$/ }), '')
  await waitFor(() => expect(state.requests).toHaveLength(2))
  expect(state.requests[1]!.searchParams.has('queue')).toBe(false)
  expect(new URLSearchParams(state.router.state.location.search).has('queue')).toBe(false)
  expect(screen.getByRole('combobox', { name: /^Coda$/ })).toHaveValue('')
  await expectRendered(state, 6)
  expect(state.responses.at(-1)!.context.queue).toBe('all')
  expect(state.responses.at(-1)!.context.automatic_queue).toBe(false)
  expectContextPreserved(state, true)
}

afterEach(() => {
  cleanup()
  disposables.splice(0).forEach((dispose) => dispose())
  vi.unstubAllGlobals()
})

for (const consumer of consumers) describe(`coda recommendation ${consumer.id}`, () => {
  it('usa Flex e la stessa cache per alias e 440, conservando il contesto del link', async () => {
    const state = setup(consumer, 'RANKED_FLEX_SR')
    await expectRendered(state, 2)
    expect.soft(state.requests[0]!.searchParams.get('queue')).toBe('440')
    expect(state.responses[0]!.context.queue).toBe('440')
    if (consumer.id === 'fit') expect.soft(screen.getByRole('combobox', { name: /^Coda$/ })).toHaveValue('440')
    expectContextPreserved(state)

    const next = new URL(state.router.state.location.pathname + state.router.state.location.search, 'http://localhost')
    next.searchParams.set(consumer.queueKey, '440')
    await act(() => state.router.navigate(next.pathname + next.search, { state: navigationState }))
    await expectRendered(state, 2)
    expect(state.requests).toHaveLength(1)
    expect(state.client.getQueriesData({ queryKey: ['api', 'recommendations'] })).toHaveLength(1)
    expectContextPreserved(state, true)
  })
})

describe('selettore coda dei suggerimenti', () => {
  it('normalizza gli spazi Python intorno a 440 e recupera tutte le sei partite con Predefinita', async () => {
    const state = setup(fit, '\u0085 440 \u001f')
    await expectRendered(state, 2)
    expect(screen.getByRole('combobox', { name: /^Coda$/ })).toHaveValue('440')
    expect(state.requests[0]!.searchParams.get('queue')).toBe('440')
    expectContextPreserved(state)
    await chooseDefault(state)
  })

  it.each(['\u0085 AuTo \u001f', '\u0085 \u001c'])('mantiene la scelta automatica %j distinta dal default aggregato', async (raw) => {
    const state = setup(fit, raw)
    await expectRendered(state, 4)
    expect(state.requests[0]!.searchParams.get('queue')).toBe('auto')
    expect(state.responses[0]!.context.automatic_queue).toBe(true)
    expectLinkedOption('auto', 'Coda automatica')
    expectContextPreserved(state)
    await chooseDefault(state)
  })

  it('riconosce all solo dal valore originale senza riscrivere il link', async () => {
    const state = setup(fit, '\u0085 ALL \u001f')
    await expectRendered(state, 6)
    expect(state.requests[0]!.searchParams.get('queue')).toBe('all')
    expect(screen.getByRole('combobox', { name: /^Coda$/ })).toHaveValue('all')
    expectContextPreserved(state)
  })

  it.each([null, ''])('mantiene omissione e Predefinita per %j', async (raw) => {
    const state = setup(fit, raw)
    await expectRendered(state, 6)
    expect(state.requests[0]!.searchParams.has('queue')).toBe(false)
    expect(screen.getByRole('combobox', { name: /^Coda$/ })).toHaveValue('')
    expectContextPreserved(state)
  })

  it.each(['999', '00440', '450'])('mantiene il filtro numerico valido %s senza limitarlo alle opzioni elencate', async (raw) => {
    const state = setup(fit, raw)
    await expectRendered(state, 0)
    expect(state.requests[0]!.searchParams.get('queue')).toBe(raw)
    expectLinkedOption(raw, 'Coda del link')
    expectContextPreserved(state)
  })

  it.each(['QUEUEALL', 'QUEUEAUTO', 'A LL', 'A UTO', 'QUEUEQUEUE440', 'QUEUERANKED_FLEX_SR', '\ufeff440\ufeff', 'unknown', '0', '99999'])(
    'mantiene il 400 per %j e consente il recupero esplicito', async (raw) => {
      const state = setup(fit, raw)
      expect(await screen.findByRole('alert')).toHaveTextContent('Scegli una modalità concreta')
      expect(state.requests).toHaveLength(1)
      expect(state.requests[0]!.searchParams.has('queue')).toBe(true)
      expectLinkedOption(state.requests[0]!.searchParams.get('queue')!, 'Coda del link')
      expectContextPreserved(state)
      await chooseDefault(state)
    },
  )
})

describe('precedenza della coda della scheda', () => {
  it('eredita la coda esterna quando detailQueue manca', async () => {
    const state = setup(consumers[3], null)
    await expectRendered(state, 4)
    expect(state.requests[0]!.searchParams.get('queue')).toBe('420')
    expectContextPreserved(state)
  })

  it('mantiene detailQueue vuoto come omissione esplicita senza ereditare 420', async () => {
    const state = setup(consumers[3], '')
    await expectRendered(state, 6)
    expect(state.requests[0]!.searchParams.has('queue')).toBe(false)
    expect(new URLSearchParams(state.router.state.location.search).get('detailQueue')).toBe('')
    expectContextPreserved(state)
  })

  it('continua a ignorare detailQueue nella scheda standalone', async () => {
    const state = setup(consumers[4], '420')
    await expectRendered(state, 4)
    expect(state.requests[0]!.searchParams.get('queue')).toBe('420')
    expect(new URLSearchParams(state.router.state.location.search).get('detailQueue')).toBe('QUEUEAUTO')
    expectContextPreserved(state)
  })
})
