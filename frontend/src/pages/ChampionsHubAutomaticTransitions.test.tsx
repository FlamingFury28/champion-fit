import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { createMemoryRouter, RouterProvider, useSearchParams } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ScopeSnapshot } from '../api/client'
import { queryKeys, recommendationsQuery } from '../api/queries'
import type { RecommendationsResponseDto } from '../api/types'
import { AlgorithmSettingsProvider, RECOMMENDED_ALGORITHM_SETTINGS, setSetting } from '../app/algorithm-settings'
import { recommendationPeriodFilter, recommendationQueueFilter, recommendationRoleFilter } from '../app/recommendation-filters'
import { useScope } from '../app/scope'
import { recommendationsFixture } from '../test/recommendations-fixture'
import { ChampionsHubPage } from './ChampionsHubPage'

const scopeHarness = vi.hoisted(() => ({
  scope: { accounts: ['Alpha#EUW', 'Beta#EUW'], companion: null, algorithmRevision: 4 } as ScopeSnapshot,
  scopeReady: true,
}))
vi.mock('../app/scope', () => ({ useScope: () => scopeHarness }))

type Source = 'fit' | 'scout' | 'plan'
function filtersFor(source: Source, params: URLSearchParams) {
  const queue = recommendationQueueFilter(params.get('queue'))
  const days = recommendationPeriodFilter(params.get('days'))
  return {
    role: recommendationRoleFilter(params.get('role')),
    queue: source === 'fit' ? queue || undefined : queue ?? undefined,
    days: source === 'fit' ? days || undefined : days ?? undefined,
  }
}

// Only independent content is replaced. Each REC child observes the real query,
// and its local draft detects accidental remounts when navigation cache changes.
function RecommendationProbe({ source }: { source: Source }) {
  const { scope, scopeReady } = useScope()
  const [params] = useSearchParams()
  const [draft, setDraft] = useState('')
  const query = useQuery({ ...recommendationsQuery(scope, filtersFor(source, params)), enabled: scopeReady })
  return <section>
    <label>Bozza REC<input value={draft} onChange={(event) => setDraft(event.target.value)} /></label>
    <output aria-label="Stato REC">{query.status}</output>
    <output aria-label="Contesto REC">{JSON.stringify(query.data?.context ?? null)}</output>
  </section>
}

vi.mock('./FitPage', () => ({ FitPage: () => <RecommendationProbe source="fit" /> }))
vi.mock('./ScoutPage', () => ({ ScoutPage: () => <RecommendationProbe source="scout" /> }))
vi.mock('./TestPlanPage', () => ({ TestPlanPage: () => <RecommendationProbe source="plan" /> }))
vi.mock('./ChampionDetailPage', () => ({ ChampionDetailPage: () => null }))
vi.mock('./ChampionPerformancePage', () => ({ ChampionPerformancePage: () => <h2>Rendimento comune</h2> }))
vi.mock('./CompetitivePlanPage', () => ({ CompetitivePlanPage: () => <h2>Piano comune</h2> }))
vi.mock('./ChampionsPage', () => ({ ChampionsPage: () => <h2>Avversari comuni</h2> }))
vi.mock('./SynergyPage', () => ({ SynergyPage: () => <h2>Alleati comuni</h2> }))

const disposables: (() => void)[] = []
const commonNames = ['Quali giochi meglio?', 'Piano competitivo', 'Avversari e alleati']
const recNames = ['Familiari e preferiti', 'Scopri candidati', 'Piano di prove']
const baseAccounts = ['Alpha#EUW', 'Beta#EUW']

function packet(role = 'MIDDLE', queue = '420', revision = 4): RecommendationsResponseDto {
  return recommendationsFixture({
    algorithm_revision: revision,
    context: { accounts: baseAccounts, role, queue, days: 'all', period: { value: 0, unit: 'days' }, suspended_accounts: [], unresolved_accounts: [] },
  })
}

function setup(source: Source, role: string, queue: string | null, options: { defaultQueue?: 'auto' | 'all'; ready?: boolean; companion?: boolean } = {}) {
  scopeHarness.scope = {
    accounts: [...baseAccounts], algorithmRevision: 4,
    companion: options.companion ? { name: 'Gamma', accounts: ['Gamma#EUW'], mode: 'exclude', profileAccounts: [...baseAccounts] } : null,
  }
  scopeHarness.scopeReady = options.ready ?? true
  const requests: { url: URL; respond: (response: Response) => void }[] = []
  const unexpected: string[] = []
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    if ((init?.method ?? 'GET') !== 'GET' || url.pathname !== '/api/recommendations') {
      unexpected.push(`${init?.method ?? 'GET'} ${url.pathname}`)
      return Promise.reject(new Error('Unexpected request'))
    }
    return new Promise<Response>((respond) => { requests.push({ url, respond }) })
  }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  const settings = setSetting(RECOMMENDED_ALGORITHM_SETTINGS, 'recommendations.queue', options.defaultQueue ?? 'all')
  client.setQueryData(queryKeys.algorithmSettings, { settings, revision: 4 })
  const params = new URLSearchParams({
    section: source === 'fit' ? 'choices' : 'training', training: source === 'plan' ? 'plan' : 'discover',
    role, days: '0', search: ' Ahri ', minSimilarity: '0', budget: '1000',
    detail: '', detailRole: 'TOP', detailQueue: '999', detailDays: '90',
  })
  if (queue !== null) params.set('queue', queue)
  const initialSearch = `?${params}`
  const key = recommendationsQuery(scopeHarness.scope, filtersFor(source, params)).queryKey
  const router = createMemoryRouter([{ path: '/app/fit', element: <ChampionsHubPage /> }], {
    initialEntries: [{ pathname: '/app/fit', search: initialSearch }],
  })
  disposables.push(() => { router.dispose(); client.clear() })
  render(<QueryClientProvider client={client}><AlgorithmSettingsProvider><RouterProvider router={router} /></AlgorithmSettingsProvider></QueryClientProvider>)
  return { source, requests, unexpected, client, router, params, initialSearch, key, user: userEvent.setup() }
}
type State = ReturnType<typeof setup>

const commonLink = (name = commonNames[0]!) => screen.getByRole('link', { name })

function expectRecLinksRaw(state: State) {
  for (const name of recNames) {
    const link = screen.getByRole('link', { name })
    expect(link).not.toHaveAttribute('aria-disabled', 'true')
    const destination = new URL(link.getAttribute('href')!, 'http://localhost')
    expect(destination.searchParams.get('role')).toBe(state.params.get('role'))
    expect(destination.searchParams.get('queue')).toBe(state.params.get('queue'))
    expect(destination.searchParams.get('days')).toBe('0')
  }
  expect(state.router.state.location.search).toBe(state.initialSearch)
}

function expectBlocked(soft = false) {
  for (const name of commonNames) {
    const link = commonLink(name)
    const assertion = soft ? expect.soft(link) : expect(link)
    assertion.toHaveAttribute('aria-disabled', 'true')
    if (soft) expect.soft(link).not.toHaveAttribute('href')
    else expect(link).not.toHaveAttribute('href')
  }
}

function expectResolved(role: string, queue: string) {
  for (const name of commonNames) {
    const link = commonLink(name)
    expect(link).not.toHaveAttribute('aria-disabled', 'true')
    const href = link.getAttribute('href')
    expect(href).not.toBeNull()
    const destination = new URL(href!, 'http://localhost')
    expect(destination.searchParams.get('role')).toBe(role)
    expect(destination.searchParams.get('queue')).toBe(queue)
    expect(destination.searchParams.get('days')).toBe('all')
    expect(destination.searchParams.get('search')).toBe(' Ahri ')
    for (const key of ['detail', 'detailRole', 'detailQueue', 'detailDays']) expect(destination.searchParams.has(key)).toBe(false)
  }
}

async function respond(state: State, index: number, data: RecommendationsResponseDto | 'error') {
  await act(async () => {
    state.requests[index]!.respond(data === 'error'
      ? Response.json({ error: 'Servizio sintetico non disponibile' }, { status: 503 })
      : Response.json(data))
  })
  await waitFor(() => expect(state.client.isFetching()).toBe(0))
}

function expectRequests(state: State, count: number) {
  expect(state.requests).toHaveLength(count)
  expect(state.unexpected).toEqual([])
  if (screen.queryByRole('textbox', { name: 'Bozza REC' })) {
    const observed = state.client.getQueryCache().findAll({ queryKey: ['api', 'recommendations'] })
      .filter((query) => query.getObserversCount() > 0)
    expect(observed).toHaveLength(1)
    expect(observed[0]!.getObserversCount()).toBe(1)
  }
}

afterEach(() => {
  cleanup()
  disposables.splice(0).forEach((dispose) => dispose())
  vi.unstubAllGlobals()
})

describe('passaggi automatici dai suggerimenti al contesto comune corrente', () => {
  it.each([
    { source: 'fit' as const, role: '\u0085 auto \u001f', queue: 'RANKED_FLEX_SR', resolvedRole: 'MIDDLE', resolvedQueue: '440', target: 'Quali giochi meglio?' },
    { source: 'scout' as const, role: 'ALL', queue: '\u0085 auto \u001f', resolvedRole: 'ALL', resolvedQueue: '420', target: 'Piano competitivo' },
    { source: 'plan' as const, role: 'AUTO', queue: 'all', resolvedRole: 'SUPPORT', resolvedQueue: 'all', target: 'Avversari e alleati' },
  ])('congela entrambi i campi da $source senza rimontare la bozza o creare una seconda GET', async ({ source, role, queue, resolvedRole, resolvedQueue, target }) => {
    const state = setup(source, role, queue, { companion: true })
    await waitFor(() => expect(state.requests).toHaveLength(1))
    expectBlocked(true)
    expectRecLinksRaw(state)
    const draft = screen.getByRole('textbox', { name: 'Bozza REC' })
    await state.user.type(draft, 'prova locale')
    expect(state.requests[0]!.url.searchParams.getAll('companion_account')).toEqual(['Gamma#EUW'])
    expect(state.requests[0]!.url.searchParams.get('companion_mode')).toBe('exclude')
    expect(state.requests[0]!.url.searchParams.get('algorithm_revision')).toBe('4')
    await respond(state, 0, packet(resolvedRole, resolvedQueue))
    await waitFor(() => expectResolved(resolvedRole, resolvedQueue))
    expect(screen.getByRole('textbox', { name: 'Bozza REC' })).toBe(draft)
    expect(draft).toHaveValue('prova locale')
    expectRecLinksRaw(state)
    expectRequests(state, 1)
    expect(state.client.getQueryCache().findAll({ queryKey: ['api', 'recommendations'] })).toHaveLength(1)
    await state.user.click(commonLink(target))
    const destination = new URLSearchParams(state.router.state.location.search)
    expect(destination.get('role')).toBe(resolvedRole)
    expect(destination.get('queue')).toBe(resolvedQueue)
    expectRequests(state, 1)
  })

  it.each([
    { source: 'fit' as const, rawQueue: null, role: 'MID', resolvedRole: 'MIDDLE' },
    { source: 'scout' as const, rawQueue: '', role: 'ADC', resolvedRole: 'BOTTOM' },
  ])('risolve il default automatico con queue=$rawQueue in $source usando la chiave esatta della pagina', async ({ source, rawQueue, role, resolvedRole }) => {
    const state = setup(source, role, rawQueue, { defaultQueue: 'auto' })
    await waitFor(() => expect(state.requests).toHaveLength(1))
    expect(state.requests[0]!.url.searchParams.has('queue')).toBe(false)
    expect(state.client.getQueryState(state.key)).toBeDefined()
    expectBlocked(true)
    await respond(state, 0, packet(resolvedRole, '440'))
    await waitFor(() => expectResolved(resolvedRole, '440'))
    expectRecLinksRaw(state)
    expectRequests(state, 1)
  })

  it('lascia i link manuali attivi anche con una richiesta pendente e default configurato auto', async () => {
    const state = setup('fit', 'MID', 'all', { defaultQueue: 'auto' })
    await waitFor(() => expect(state.requests).toHaveLength(1))
    expectResolved('MIDDLE', 'all')
    expectRecLinksRaw(state)
    expectRequests(state, 1)
  })

  it.each([
    { name: 'pending', ready: true, data: null },
    { name: 'error', ready: true, data: 'error' as const },
    { name: 'scope non pronto con snapshot valido in cache', ready: false, data: packet() },
    { name: 'revisione diversa', ready: true, data: packet('MIDDLE', '420', 3) },
    { name: 'ruolo ancora AUTO', ready: true, data: packet('AUTO', '420') },
    { name: 'coda fuori intervallo', ready: true, data: packet('MIDDLE', '99999') },
    { name: 'contesto mancante', ready: true, data: { ...packet(), context: null } as unknown as RecommendationsResponseDto },
  ])('blocca solo i link comuni con $name', async ({ ready, data }) => {
    const state = setup('fit', 'AUTO', 'auto', { ready })
    if (ready) await waitFor(() => expect(state.requests).toHaveLength(1))
    if (data !== null) {
      if (!ready && data !== 'error') await act(() => { state.client.setQueryData(state.key, data) })
      else await respond(state, 0, data)
    }
    expectBlocked()
    expectRecLinksRaw(state)
    expectRequests(state, ready ? 1 : 0)
  })

  it('revoca subito i link invalidati idle e durante il refetch, conservando la stessa bozza', async () => {
    const state = setup('fit', 'AUTO', 'auto')
    await waitFor(() => expect(state.requests).toHaveLength(1))
    await respond(state, 0, packet('MIDDLE', '420'))
    await waitFor(() => expectResolved('MIDDLE', '420'))
    const draft = screen.getByRole('textbox', { name: 'Bozza REC' })
    await state.user.type(draft, 'non perdere')
    await act(() => state.client.invalidateQueries({ queryKey: state.key, exact: true, refetchType: 'none' }))
    expect(state.client.getQueryState(state.key)).toMatchObject({ isInvalidated: true, fetchStatus: 'idle' })
    await waitFor(() => expectBlocked())
    expectRequests(state, 1)
    let refetch!: Promise<void>
    await act(() => { refetch = state.client.refetchQueries({ queryKey: state.key, exact: true }) })
    await waitFor(() => expect(state.requests).toHaveLength(2))
    expectBlocked()
    expect(screen.getByRole('textbox', { name: 'Bozza REC' })).toBe(draft)
    expect(draft).toHaveValue('non perdere')
    await respond(state, 1, packet('BOTTOM', '440'))
    await refetch
    await waitFor(() => expectResolved('BOTTOM', '440'))
    expect(screen.getByRole('textbox', { name: 'Bozza REC' })).toBe(draft)
    expect(draft).toHaveValue('non perdere')
    expectRequests(state, 2)
  })

  it('non riabilita un vecchio successo dopo un errore di aggiornamento con data ancora presente', async () => {
    const state = setup('plan', 'AUTO', 'all')
    await waitFor(() => expect(state.requests).toHaveLength(1))
    await respond(state, 0, packet('MIDDLE', 'all'))
    await waitFor(() => expectResolved('MIDDLE', 'all'))
    let refetch!: Promise<void>
    await act(() => { refetch = state.client.refetchQueries({ queryKey: state.key, exact: true }) })
    await waitFor(() => expect(state.requests).toHaveLength(2))
    await respond(state, 1, 'error')
    await refetch
    expect(state.client.getQueryState(state.key)).toMatchObject({ status: 'error' })
    expect(state.client.getQueryData(state.key)).toBeDefined()
    await waitFor(() => expectBlocked())
    expectRecLinksRaw(state)
    expectRequests(state, 2)
  })

  it('ignora snapshot di altro companion, revisione o scheda senza avviare query proprie', async () => {
    const state = setup('fit', 'AUTO', 'RANKED_FLEX_SR', { companion: true })
    await waitFor(() => expect(state.requests).toHaveLength(1))
    const filters = filtersFor('fit', state.params)
    await act(() => {
      state.client.setQueryData(recommendationsQuery({ ...scopeHarness.scope, companion: null }, filters).queryKey, packet('BOTTOM', '999'))
      state.client.setQueryData(recommendationsQuery({ ...scopeHarness.scope, algorithmRevision: 3 }, filters).queryKey, packet('TOP', '450', 3))
      state.client.setQueryData(recommendationsQuery(scopeHarness.scope, { ...filters, champion: 'Ahri' }).queryKey, packet('SUPPORT', '400'))
    })
    expectBlocked(true)
    expectRequests(state, 1)
    await respond(state, 0, packet('MIDDLE', '440'))
    await waitFor(() => expectResolved('MIDDLE', '440'))
    expect(state.client.getQueryCache().findAll({ queryKey: ['api', 'recommendations'] })).toHaveLength(4)
    expectRequests(state, 1)
  })

  it('mantiene il contesto corrente se la risposta del vecchio account e filtro arriva per ultima', async () => {
    const state = setup('fit', 'AUTO', '440')
    await waitFor(() => expect(state.requests).toHaveLength(1))
    const draft = screen.getByRole('textbox', { name: 'Bozza REC' })
    await state.user.type(draft, 'stessa pagina')
    const oldPacket = packet('MIDDLE', '440')
    scopeHarness.scope = { accounts: ['Delta#EUW'], companion: null, algorithmRevision: 4 }
    const next = new URLSearchParams(state.router.state.location.search)
    next.set('queue', '420')
    await act(() => state.router.navigate(`/app/fit?${next}`))
    await waitFor(() => expect(state.requests).toHaveLength(2))
    expect(state.requests[1]!.url.searchParams.getAll('account')).toEqual(['Delta#EUW'])
    expectBlocked(true)
    const currentPacket = packet('SUPPORT', '420')
    currentPacket.context.accounts = ['Delta#EUW']
    await act(async () => { state.requests[1]!.respond(Response.json(currentPacket)) })
    await waitFor(() => expectResolved('SUPPORT', '420'))
    await respond(state, 0, oldPacket)
    expectResolved('SUPPORT', '420')
    expect(screen.getByRole('textbox', { name: 'Bozza REC' })).toBe(draft)
    expect(draft).toHaveValue('stessa pagina')
    expectRequests(state, 2)
  })
})
