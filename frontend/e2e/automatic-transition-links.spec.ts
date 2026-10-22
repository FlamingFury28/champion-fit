import { expect, test } from '@playwright/test'
import type { RecommendationsResponseDto } from '../src/api/types'

interface ComparisonResponse {
  context?: { role?: string; queue?: string; days?: string | number; observations?: number }
  games?: number
  error?: string
}

const destinations = {
  best: { section: 'best', navigation: 'Sezioni campioni', link: 'Quali giochi meglio?', endpoint: '/api/champions', results: 'Classifica del rendimento storico' },
  tournament: { section: 'tournament', navigation: 'Sezioni campioni', link: 'Piano competitivo', endpoint: '/api/training-plan', results: 'Piano per identificare il campione migliore' },
  enemies: { section: 'matchups', navigation: 'Confronti aggiuntivi', link: 'Avversari e alleati', endpoint: '/api/matchups', results: 'Risultati dei confronti con gli avversari' },
  allies: { section: 'matchups', navigation: 'Confronti aggiuntivi', link: 'Avversari e alleati', endpoint: '/api/synergy', results: 'Risultati delle sinergie' },
} as const

const transitions = [
  { source: 'choices', training: '', destination: 'tournament', role: 'AUTO', queue: 'all', effectiveRole: 'MIDDLE', effectiveQueue: 'all', games: 3 },
  { source: 'choices', training: '', destination: 'tournament', role: 'MIDDLE', queue: 'auto', effectiveRole: 'MIDDLE', effectiveQueue: '420', games: 3 },
  { source: 'choices', training: '', destination: 'tournament', role: 'AUTO', queue: 'auto', effectiveRole: 'MIDDLE', effectiveQueue: '420', games: 3 },
  { source: 'training', training: 'discover', destination: 'best', role: 'AUTO', queue: 'auto', effectiveRole: 'MIDDLE', effectiveQueue: '420', games: 3 },
  { source: 'training', training: 'plan', destination: 'enemies', role: 'AUTO', queue: 'auto', effectiveRole: 'MIDDLE', effectiveQueue: '420', games: 3 },
  { source: 'training', training: 'plan', destination: 'allies', role: 'AUTO', queue: 'auto', effectiveRole: 'MIDDLE', effectiveQueue: '420', games: 3 },
  // Resolving just the automatic dimension would let the common endpoint
  // independently choose a different role or its narrower default queue.
  { source: 'choices', training: '', destination: 'tournament', role: null, queue: 'auto', effectiveRole: 'ALL', effectiveQueue: '420', games: 4 },
  { source: 'choices', training: '', destination: 'tournament', role: 'AUTO', queue: null, effectiveRole: 'MIDDLE', effectiveQueue: 'all', games: 3 },
] as const

test('contesto automatico fra sezioni: i confronti conservano ruolo e coda risolti dalle preferenze @smoke', async ({ page }) => {
  test.setTimeout(90_000)
  const requests: URL[] = []
  const recommendations: { url: URL; body: RecommendationsResponseDto }[] = []
  const comparisons: { url: URL; status: number; body: ComparisonResponse }[] = []
  const unexpectedWrites: string[] = []
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.route('https://ddragon.leagueoflegends.com/**', (route) => route.abort())
  await page.route('**/api/**', (route) => {
    if (route.request().method() === 'GET') return route.fallback()
    unexpectedWrites.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`)
    return route.abort()
  })
  await page.route('**/api/recommendations?**', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    requests.push(new URL(route.request().url()))
    const response = await route.fetch()
    expect(response.status()).toBe(200)
    const body = await response.json() as RecommendationsResponseDto
    recommendations.push({ url: new URL(route.request().url()), body })
    await route.fulfill({ response, json: body })
  })
  for (const endpoint of new Set(Object.values(destinations).map((entry) => entry.endpoint))) {
    await page.route(`**${endpoint}?**`, async (route) => {
      if (route.request().method() !== 'GET') return route.fallback()
      const response = await route.fetch()
      const body = await response.json() as ComparisonResponse
      comparisons.push({ url: new URL(route.request().url()), status: response.status(), body })
      await route.fulfill({ response, json: body })
    })
  }
  await page.addInitScript(() => {
    localStorage.setItem('champion-fit-profile-accounts', JSON.stringify(['Alpha#EUW']))
    localStorage.setItem('champion-fit:data-view:v2', JSON.stringify({ view: 'list' }))
  })

  type Transition = typeof transitions[number]
  const paramsFor = (entry: Transition) => {
    const params = new URLSearchParams({ section: entry.source, days: 'all', budget: '400', view: 'known', detail: '', detailRole: 'SUPPORT', detailQueue: '440', detailDays: '90' })
    if (entry.training) params.set('training', entry.training)
    if (entry.role !== null) params.set('role', entry.role)
    if (entry.queue !== null) params.set('queue', entry.queue)
    if (entry.destination === 'enemies' || entry.destination === 'allies') params.set('relation', entry.destination)
    return params
  }
  const expectRecommendationContext = (entry: Transition) => {
    const latest = recommendations.at(-1)
    expect(latest?.url.searchParams.getAll('account')).toEqual(['Alpha#EUW'])
    expect(latest?.url.searchParams.get('role')).toBe(entry.role)
    expect(latest?.url.searchParams.get('queue')).toBe(entry.queue)
    expect(latest?.url.searchParams.get('days')).toBe('all')
    expect(latest?.body.context.role).toBe(entry.effectiveRole)
    expect(latest?.body.context.queue).toBe(entry.effectiveQueue)
    expect(latest?.body.coverage.games).toBe(entry.games)
    expect(latest?.body.coverage.observations).toBe(entry.games)
  }
  const openSource = async (entry: Transition, params: URLSearchParams) => {
    const loading = entry.source === 'choices' ? 'Caricamento dei suggerimenti' : entry.training === 'plan' ? 'Caricamento del piano di prove' : 'Caricamento delle scoperte'
    const ready = async (beforeRequests: number, beforeResponses: number) => {
      await expect.poll(() => recommendations.length).toBe(beforeResponses + 1)
      await expect(page.getByLabel(loading, { exact: true })).toHaveCount(0)
      if (entry.source === 'choices') await expect(page.getByRole('region', { name: 'Scelte familiari e preferite', exact: true })).toBeVisible()
      else if (entry.training === 'plan') await expect(page.getByRole('region', { name: 'Piano di prove', exact: true })).toBeVisible()
      else await expect(page.getByRole('heading', { name: 'Scelte vicine ai tuoi gusti', exact: true })).toBeVisible()
      await expect(page.getByRole('navigation', { name: 'Sezioni campioni', exact: true }).getByRole('link', { name: 'Piano competitivo', exact: true })).toHaveAttribute('href', /role=(?:MIDDLE|ALL)/)
      expect(requests).toHaveLength(beforeRequests + 1)
      expectRecommendationContext(entry)
      expect(Object.fromEntries(new URL(page.url()).searchParams)).toEqual(Object.fromEntries(params))
      await expect(page.getByRole('alert')).toHaveCount(0)
    }
    const beforeGoto = [requests.length, recommendations.length] as const
    await page.goto(`/app/fit?${params}`)
    await ready(beforeGoto[0], beforeGoto[1])
    const beforeReload = [requests.length, recommendations.length] as const
    await page.reload()
    await ready(beforeReload[0], beforeReload[1])
  }
  const clickComparison = async (entry: Transition, params: URLSearchParams) => {
    const destination = destinations[entry.destination]
    const sourceCount = requests.length
    const beforeComparisons = comparisons.length
    const link = page.getByRole('navigation', { name: destination.navigation, exact: true }).getByRole('link', { name: destination.link, exact: true })
    const expectedParams = new URLSearchParams(params)
    expectedParams.set('section', destination.section)
    expectedParams.set('role', entry.effectiveRole)
    expectedParams.set('queue', entry.effectiveQueue)
    for (const key of ['detail', 'detailRole', 'detailQueue', 'detailDays']) expectedParams.delete(key)
    if (destination.section === 'matchups') expectedParams.delete('training')
    const href = await link.getAttribute('href')
    expect(href).not.toBeNull()
    const destinationUrl = new URL(href!, page.url())
    expect(destinationUrl.pathname).toBe('/app/fit')
    expect(Object.fromEntries(destinationUrl.searchParams)).toEqual(Object.fromEntries(expectedParams))
    await link.click()
    await expect.poll(() => comparisons.length).toBeGreaterThan(beforeComparisons)
    await expect(page.getByRole('region', { name: destination.results, exact: true })).toBeVisible()
    expect(Object.fromEntries(new URL(page.url()).searchParams)).toEqual(Object.fromEntries(expectedParams))
    const latest = comparisons.at(-1)
    expect(latest?.status).toBe(200)
    expect(latest?.url.pathname).toBe(destination.endpoint)
    expect(latest?.url.searchParams.getAll('account')).toEqual(['Alpha#EUW'])
    expect(latest?.url.searchParams.get('role')).toBe(entry.effectiveRole)
    expect(latest?.url.searchParams.get('queue')).toBe(entry.effectiveQueue)
    expect(latest?.url.searchParams.get('days')).toBe('all')
    expect(latest?.body.context?.role).toBe(entry.effectiveRole)
    expect(latest?.body.context?.queue).toBe(entry.effectiveQueue)
    expect(latest?.body.context?.days).toBe('all')
    expect(latest?.body.context?.observations).toBe(entry.games)
    if (destination.section === 'matchups') expect(latest?.body.games).toBe(entry.games)
    expect(requests).toHaveLength(sourceCount)
    await expect(page.getByRole('combobox', { name: 'Ruolo', exact: true })).toHaveValue(entry.effectiveRole)
    await expect(page.getByRole('alert')).toHaveCount(0)
  }

  for (const entry of transitions) {
    const params = paramsFor(entry)
    await openSource(entry, params)
    await clickComparison(entry, params)
  }

  // A REC-to-REC link keeps AUTO tokens. The next common link must resolve
  // from the shared cached response, without starting another recommendation.
  const entry = transitions[2]
  const params = paramsFor(entry)
  await openSource(entry, params)
  const sourceCount = requests.length
  await page.getByRole('navigation', { name: 'Preferenze e scoperte facoltative', exact: true })
    .getByRole('link', { name: 'Scopri candidati', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Scelte vicine ai tuoi gusti', exact: true })).toBeVisible()
  params.set('section', 'training')
  params.set('training', 'discover')
  for (const key of ['detail', 'detailRole', 'detailQueue', 'detailDays']) params.delete(key)
  expect(Object.fromEntries(new URL(page.url()).searchParams)).toEqual(Object.fromEntries(params))
  expect(requests).toHaveLength(sourceCount)
  expectRecommendationContext(entry)
  await clickComparison({ ...entry, source: 'training', training: 'discover', destination: 'best' }, params)
  expect(unexpectedWrites).toEqual([])
  expect(pageErrors).toEqual([])
})
