import { expect, test } from '@playwright/test'
import type { RecommendationsResponseDto } from '../src/api/types'

interface CompetitiveTransitionResponse {
  context: { role: string; queue: string; days: string; observations: number; unique_games: number }
  items: { champion: string; role: string; unique_games: number }[]
}

const destinations = [
  { section: 'best', link: 'Quali giochi meglio?', endpoint: '/api/champions', results: 'Classifica del rendimento storico' },
  { section: 'tournament', link: 'Piano competitivo', endpoint: '/api/training-plan', results: 'Piano per identificare il campione migliore' },
] as const

test('ruolo fra sezioni: gli alias delle preferenze mantengono il contesto nei confronti @smoke', async ({ page }) => {
  test.setTimeout(60_000)
  const recommendations: { url: URL; body: RecommendationsResponseDto }[] = []
  const comparisons: { url: URL; body: CompetitiveTransitionResponse }[] = []
  const unexpectedWrites: string[] = []
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.route('https://ddragon.leagueoflegends.com/**', (route) => route.abort())
  await page.route('**/api/**', (route) => {
    if (route.request().method() === 'GET') return route.fallback()
    unexpectedWrites.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`)
    return route.abort()
  })
  await page.route('**/api/recommendations?**', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    const response = await route.fetch()
    expect(response.status()).toBe(200)
    const body = await response.json() as RecommendationsResponseDto
    recommendations.push({ url: new URL(route.request().url()), body })
    await route.fulfill({ response, json: body })
  })
  for (const destination of destinations) {
    await page.route(`**${destination.endpoint}?**`, async (route) => {
      if (route.request().method() !== 'GET') return route.fallback()
      const response = await route.fetch()
      expect(response.status()).toBe(200)
      const body = await response.json() as CompetitiveTransitionResponse
      comparisons.push({ url: new URL(route.request().url()), body })
      await route.fulfill({ response, json: body })
    })
  }
  await page.addInitScript(() => {
    localStorage.setItem('champion-fit-profile-accounts', JSON.stringify(['Alpha#EUW']))
  })

  for (const entry of [
    { raw: 'MID', role: 'MIDDLE', label: 'Corsia centrale', games: 3 },
    { raw: '\u0085\u001c adc \u001f\u0085', role: 'BOTTOM', label: 'Corsia inferiore', games: 0 },
  ]) {
    for (const destination of destinations) {
      // Empty detail leaves the source list accessible while all four stale
      // detail keys still exercise the section-link cleanup contract.
      const params = new URLSearchParams({
        section: 'choices', view: 'known', role: entry.raw, queue: '420', days: 'all', budget: '400',
        detail: '', detailRole: 'SUPPORT', detailQueue: '440', detailDays: '90',
      })
      const expectSource = async (before: number) => {
        await expect.poll(() => recommendations.length).toBeGreaterThan(before)
        await expect(page.getByRole('region', { name: 'Scelte familiari e preferite', exact: true })).toBeVisible()
        await expect(page.getByLabel('Caricamento dei suggerimenti', { exact: true })).toHaveCount(0)
        await expect(page.getByRole('combobox', { name: 'Ruolo', exact: true })).toHaveValue(entry.role)
        const latest = recommendations.at(-1)
        expect(latest?.url.searchParams.getAll('account')).toEqual(['Alpha#EUW'])
        expect(latest?.url.searchParams.get('role')).toBe(entry.role)
        expect(latest?.url.searchParams.get('queue')).toBe('420')
        expect(latest?.url.searchParams.get('days')).toBe('all')
        expect(latest?.body.context.role).toBe(entry.role)
        expect(latest?.body.coverage.games).toBe(entry.games)
        expect(latest?.body.coverage.observations).toBe(entry.games)
        expect(Object.fromEntries(new URL(page.url()).searchParams)).toEqual(Object.fromEntries(params))
        await expect(page.getByRole('alert')).toHaveCount(0)
      }
      const before = recommendations.length
      await page.goto(`/app/fit?${params}`)
      await expectSource(before)
      const beforeReload = recommendations.length
      await page.reload()
      await expectSource(beforeReload)

      const beforeClick = comparisons.length
      await page.getByRole('navigation', { name: 'Sezioni campioni', exact: true })
        .getByRole('link', { name: destination.link, exact: true }).click()
      await expect.poll(() => comparisons.length).toBeGreaterThan(beforeClick)
      const results = page.getByRole('region', { name: destination.results, exact: true })
      await expect(results).toBeVisible()
      const expectedParams = new URLSearchParams(params)
      expectedParams.set('section', destination.section)
      expectedParams.set('role', entry.role)
      for (const key of ['detail', 'detailRole', 'detailQueue', 'detailDays']) expectedParams.delete(key)
      expect(Object.fromEntries(new URL(page.url()).searchParams)).toEqual(Object.fromEntries(expectedParams))
      const latest = comparisons.at(-1)
      expect(latest?.url.pathname).toBe(destination.endpoint)
      expect(latest?.url.searchParams.getAll('account')).toEqual(['Alpha#EUW'])
      expect(latest?.url.searchParams.get('role')).toBe(entry.role)
      expect(latest?.url.searchParams.get('queue')).toBe('420')
      expect(latest?.url.searchParams.get('days')).toBe('all')
      if (destination.section === 'tournament') expect(latest?.url.searchParams.get('budget')).toBe('400')
      expect(latest?.body.context.role).toBe(entry.role)
      expect(latest?.body.context.queue).toBe('420')
      expect(latest?.body.context.days).toBe('all')
      expect(latest?.body.context.observations).toBe(entry.games)
      expect(latest?.body.context.unique_games).toBe(entry.games)
      await expect(page.getByRole('combobox', { name: 'Ruolo', exact: true })).toHaveValue(entry.role)
      await expect(page.getByRole('combobox', { name: 'Ruolo', exact: true }).locator('option:checked')).toHaveText(entry.label)
      await expect(results.locator('tbody tr')).toHaveCount(entry.games ? 1 : 0)
      if (entry.games) {
        expect(latest?.body.items.map((item) => [item.champion, item.role, item.unique_games])).toEqual([['Ahri', 'MIDDLE', 3]])
        await expect(results.locator('tbody th')).toContainText('Ahri')
      } else {
        expect(latest?.body.items).toEqual([])
      }
      await expect(page.getByRole('alert')).toHaveCount(0)
    }
  }
  expect(unexpectedWrites).toEqual([])
})

interface PeriodTransitionResponse {
  context?: { role?: string; queue?: string; days?: string | number; observations?: number }
  games?: number
  error?: string
}

const periodTransitions = [
  { source: 'choices', training: '', relation: '', loading: 'Caricamento dei suggerimenti', sourceResults: 'Scelte familiari e preferite', navigation: 'Sezioni campioni', link: 'Piano competitivo', target: 'tournament', endpoint: '/api/training-plan', results: 'Piano per identificare il campione migliore' },
  { source: 'training', training: 'discover', relation: '', loading: 'Caricamento delle scoperte', sourceResults: '', navigation: 'Sezioni campioni', link: 'Quali giochi meglio?', target: 'best', endpoint: '/api/champions', results: 'Classifica del rendimento storico' },
  { source: 'training', training: 'plan', relation: 'enemies', loading: 'Caricamento del piano di prove', sourceResults: 'Piano di prove', navigation: 'Confronti aggiuntivi', link: 'Avversari e alleati', target: 'matchups', endpoint: '/api/matchups', results: 'Risultati dei confronti con gli avversari' },
  { source: 'training', training: 'plan', relation: 'allies', loading: 'Caricamento del piano di prove', sourceResults: 'Piano di prove', navigation: 'Confronti aggiuntivi', link: 'Avversari e alleati', target: 'matchups', endpoint: '/api/synergy', results: 'Risultati delle sinergie' },
] as const

test('periodo fra sezioni: lo zero delle preferenze conserva tutto lo storico nei confronti @smoke', async ({ page }) => {
  test.setTimeout(60_000)
  const recommendations: { url: URL; body: RecommendationsResponseDto }[] = []
  const comparisons: { url: URL; status: number; body: PeriodTransitionResponse }[] = []
  const unexpectedWrites: string[] = []
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.route('https://ddragon.leagueoflegends.com/**', (route) => route.abort())
  await page.route('**/api/**', (route) => {
    if (route.request().method() === 'GET') return route.fallback()
    unexpectedWrites.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`)
    return route.abort()
  })
  await page.route('**/api/recommendations?**', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    const response = await route.fetch()
    expect(response.status()).toBe(200)
    const body = await response.json() as RecommendationsResponseDto
    recommendations.push({ url: new URL(route.request().url()), body })
    await route.fulfill({ response, json: body })
  })
  for (const endpoint of new Set(periodTransitions.map((entry) => entry.endpoint))) {
    await page.route(`**${endpoint}?**`, async (route) => {
      if (route.request().method() !== 'GET') return route.fallback()
      const response = await route.fetch()
      const body = await response.json() as PeriodTransitionResponse
      comparisons.push({ url: new URL(route.request().url()), status: response.status(), body })
      await route.fulfill({ response, json: body })
    })
  }
  await page.addInitScript(() => {
    localStorage.setItem('champion-fit-profile-accounts', JSON.stringify(['Alpha#EUW']))
    localStorage.setItem('champion-fit:data-view:v2', JSON.stringify({ view: 'list' }))
  })
  const sourceParams = (source = 'choices', training = '', relation = '') => {
    const params = new URLSearchParams({ section: source, role: 'MIDDLE', queue: '420', days: '0', budget: '400' })
    if (training) params.set('training', training)
    if (relation) params.set('relation', relation)
    return params
  }
  const expectRecommendationContext = () => {
    const latest = recommendations.at(-1)
    expect(latest?.url.searchParams.getAll('account')).toEqual(['Alpha#EUW'])
    expect(latest?.url.searchParams.get('role')).toBe('MIDDLE')
    expect(latest?.url.searchParams.get('queue')).toBe('420')
    expect(latest?.url.searchParams.get('days')).toBe('all')
    expect(latest?.body.context.role).toBe('MIDDLE')
    expect(latest?.body.context.queue).toBe('420')
    expect(latest?.body.context.days).toBe('all')
    expect(latest?.body.coverage.games).toBe(3)
    expect(latest?.body.coverage.observations).toBe(3)
  }
  const openSource = async (params: URLSearchParams, loading: string, results: string) => {
    const ready = async (before: number) => {
      await expect.poll(() => recommendations.length).toBeGreaterThan(before)
      await expect(page.getByLabel(loading, { exact: true })).toHaveCount(0)
      if (results) await expect(page.getByRole('region', { name: results, exact: true })).toBeVisible()
      await expect(page.getByRole('combobox', { name: 'Ruolo', exact: true })).toHaveValue('MIDDLE')
      expectRecommendationContext()
      expect(Object.fromEntries(new URL(page.url()).searchParams)).toEqual(Object.fromEntries(params))
      await expect(page.getByRole('alert')).toHaveCount(0)
    }
    const before = recommendations.length
    await page.goto(`/app/fit?${params}`)
    await ready(before)
    const beforeReload = recommendations.length
    await page.reload()
    await ready(beforeReload)
  }

  for (const entry of periodTransitions) {
    const params = sourceParams(entry.source, entry.training, entry.relation)
    await openSource(params, entry.loading, entry.sourceResults)
    const beforeClick = comparisons.length
    await page.getByRole('navigation', { name: entry.navigation, exact: true })
      .getByRole('link', { name: entry.link, exact: true }).click()
    await expect.poll(() => comparisons.length).toBeGreaterThan(beforeClick)
    await expect(page.getByRole('region', { name: entry.results, exact: true })).toBeVisible()
    const expectedParams = new URLSearchParams(params)
    expectedParams.set('section', entry.target)
    expectedParams.set('days', 'all')
    if (entry.target === 'matchups') expectedParams.delete('training')
    expect(Object.fromEntries(new URL(page.url()).searchParams)).toEqual(Object.fromEntries(expectedParams))
    const latest = comparisons.at(-1)
    expect(latest?.url.pathname).toBe(entry.endpoint)
    expect(latest?.status).toBe(200)
    expect(latest?.url.searchParams.getAll('account')).toEqual(['Alpha#EUW'])
    expect(latest?.url.searchParams.get('role')).toBe('MIDDLE')
    expect(latest?.url.searchParams.get('queue')).toBe('420')
    expect(latest?.url.searchParams.get('days')).toBe('all')
    expect(latest?.body.context?.role).toBe('MIDDLE')
    expect(latest?.body.context?.queue).toBe('420')
    expect(latest?.body.context?.days).toBe('all')
    expect(latest?.body.context?.observations).toBe(3)
    // Compare the shared context; matchups and synergy have their own result
    // shapes and must not be treated as training-plan item lists.
    if (entry.target === 'matchups') expect(latest?.body.games).toBe(3)
    await expect(page.getByRole('alert')).toHaveCount(0)
  }
  expect(comparisons.filter((entry) => entry.status === 400)).toEqual([])

  // REC-to-REC navigation retains the raw legacy token; the cached request
  // already describes the same effective all-history recommendation context.
  await openSource(sourceParams(), 'Caricamento dei suggerimenti', 'Scelte familiari e preferite')
  await page.getByRole('navigation', { name: 'Preferenze e scoperte facoltative', exact: true })
    .getByRole('link', { name: 'Scopri candidati', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Scelte vicine ai tuoi gusti', exact: true })).toBeVisible()
  expect(new URL(page.url()).searchParams.get('days')).toBe('0')
  expect(new URL(page.url()).searchParams.get('section')).toBe('training')
  expect(new URL(page.url()).searchParams.get('training')).toBe('discover')
  expectRecommendationContext()
  await expect(page.getByRole('alert')).toHaveCount(0)

  // A direct common-analysis bookmark still validates its own raw days=0.
  const bookmark = sourceParams('tournament')
  const expectDirectError = async (before: number) => {
    await expect.poll(() => comparisons.length).toBeGreaterThan(before)
    await expect(page.getByRole('alert')).toContainText('days deve essere 90, 180, 365 oppure all')
    expect(new URL(page.url()).searchParams.get('days')).toBe('0')
    expect(comparisons.at(-1)?.status).toBe(400)
    expect(comparisons.at(-1)?.url.searchParams.get('days')).toBe('0')
    expect(comparisons.at(-1)?.body.error).toBe('days deve essere 90, 180, 365 oppure all')
  }
  const beforeBookmark = comparisons.length
  await page.goto(`/app/fit?${bookmark}`)
  await expectDirectError(beforeBookmark)
  const beforeBookmarkReload = comparisons.length
  await page.reload()
  await expectDirectError(beforeBookmarkReload)
  expect(unexpectedWrites).toEqual([])
})
