import { expect, test } from '@playwright/test'
import type { RecommendationsResponseDto } from '../src/api/types'

test('periodo preferenze nei link: zero, filtri espliciti e recupero degli invalidi @smoke', async ({ page }) => {
  test.setTimeout(60_000)
  const requests: URL[] = []
  const responses: { status: number; data?: RecommendationsResponseDto; error?: string }[] = []
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
    requests.push(new URL(route.request().url()))
    const response = await route.fetch()
    const body: unknown = await response.json()
    responses.push({
      status: response.status(),
      ...(response.ok() ? { data: body as RecommendationsResponseDto } : body as { error?: string }),
    })
    await route.fulfill({ response, json: body })
  })
  await page.addInitScript(() => {
    localStorage.setItem('champion-fit-profile-accounts', JSON.stringify(['Alpha#EUW', 'Beta#EUW']))
  })
  const control = page.getByRole('combobox', { name: 'Periodo', exact: true })
  const results = page.getByRole('region', { name: 'Scelte familiari e preferite', exact: true })
  const expectScope = () => {
    const params = new URL(page.url()).searchParams
    expect(params.get('section')).toBe('choices')
    expect(params.get('view')).toBe('known')
    expect(params.get('role')).toBe('ALL')
    expect(params.get('queue')).toBe('all')
    expect(requests.at(-1)?.searchParams.getAll('account')).toEqual(['Alpha#EUW', 'Beta#EUW'])
    expect(requests.at(-1)?.searchParams.get('role')).toBeNull()
    expect(requests.at(-1)?.searchParams.get('queue')).toBe('all')
  }
  const waitReady = async () => {
    await expect(control).toBeVisible()
    await expect(page.getByLabel('Caricamento dei suggerimenti', { exact: true })).toHaveCount(0)
    if (responses.at(-1)?.status === 400) {
      await expect(page.getByRole('alert')).toContainText('Periodo non valido:')
      await expect(results).toHaveCount(0)
    } else {
      await expect(results).toBeVisible()
      await expect(page.getByRole('alert')).toHaveCount(0)
    }
  }
  const openLink = async (days: string | null) => {
    const params = new URLSearchParams({ section: 'choices', view: 'known', role: 'ALL', queue: 'all' })
    if (days !== null) params.set('days', days)
    const before = responses.length
    await page.goto(`/app/fit?${params}`)
    await expect.poll(() => responses.length).toBeGreaterThan(before)
    await waitReady()
    expect(new URL(page.url()).searchParams.get('days')).toBe(days)
    expectScope()
    const beforeReload = responses.length
    await page.reload()
    await expect.poll(() => responses.length).toBeGreaterThan(beforeReload)
    await waitReady()
    expect(new URL(page.url()).searchParams.get('days')).toBe(days)
    expectScope()
  }
  const expectContext = async (days: string, games?: number) => {
    await expect.poll(() => responses.at(-1)?.status).toBe(200)
    const data = responses.at(-1)?.data
    if (!data) throw new Error('La fixture deve restituire il payload completo dei suggerimenti.')
    expect(data.context.days).toBe(days)
    expect(data.context.period).toEqual({ value: days === 'all' ? 0 : Number(days), unit: 'days' })
    expect(data.context.role).toBe('ALL')
    expect(data.context.queue).toBe('all')
    if (games !== undefined) {
      expect(data.coverage.games).toBe(games)
      expect(data.coverage.observations).toBe(games)
    }
    // Explicit rolling periods depend on the real date; render the returned
    // coverage without assuming all August fixture matches remain in 90 days.
    await expect(page.getByText(`${data.coverage.games} partite uniche e ${data.coverage.observations} osservazioni su`, { exact: false })).toBeVisible()
    await expect(results.locator('.recommendation-card')).toHaveCount(data.known.length)
    await expect(page.getByRole('button', { name: `Da scoprire · ${data.discover.length} mostrate`, exact: true })).toBeVisible()
    await expect(page.getByRole('alert')).toHaveCount(0)
    expectScope()
  }
  const clearToDefault = async () => {
    const before = responses.length
    await control.focus()
    await control.press('Home')
    await control.press('Tab')
    await expect(control).toHaveValue('')
    await expect(control.locator('option:checked')).toHaveText('Predefinito')
    await expect.poll(() => new URL(page.url()).searchParams.has('days')).toBe(false)
    await expect.poll(() => requests.at(-1)?.searchParams.get('days')).toBeNull()
    await expect.poll(() => responses.length).toBeGreaterThan(before)
    // The standard shared fixture keeps the configured period at zero days.
    await expectContext('all', 6)
  }

  await openLink(null)
  await expect(control).toHaveValue('')
  await expect(control.locator('option:checked')).toHaveText('Predefinito')
  expect(requests.at(-1)?.searchParams.get('days')).toBeNull()
  await expectContext('all', 6)
  for (const raw of ['0', 'all']) {
    await openLink(raw)
    await expect(control).toHaveValue('all')
    await expect(control.locator('option:checked')).toHaveText('Tutto lo storico')
    await expect(control.locator('option[value="all"]')).toHaveCount(1)
    expect(requests.at(-1)?.searchParams.get('days')).toBe('all')
    await expectContext('all', 6)
    await clearToDefault()
  }
  await openLink('90')
  await expect(control).toHaveValue('90')
  await expect(control.locator('option:checked')).toHaveText('90 giorni')
  expect(requests.at(-1)?.searchParams.get('days')).toBe('90')
  await expectContext('90')
  await clearToDefault()
  for (const invalid of [' 0 ', '\ufeff0\ufeff', 'unknown']) {
    await openLink(invalid)
    expect(responses.at(-1)?.status).toBe(400)
    expect(responses.at(-1)?.error).toMatch(/^Periodo non valido:/)
    expect(requests.at(-1)?.searchParams.get('days')).toBe(invalid)
    await expect(control).toHaveValue(invalid)
    await expect(control.locator('option:checked')).toHaveText('Periodo del link')
    await expect(control.locator('option:checked')).toHaveJSProperty('disabled', true)
    await clearToDefault()
  }
  expect(unexpectedWrites).toEqual([])
})

interface ComparisonPeriodResponse {
  context?: { role?: string; queue?: string; days?: string | number; observations?: number }
  games?: number
  error?: string
}

const comparisonPeriodScreens = [
  { section: 'best', endpoint: '/api/champions', results: 'Classifica del rendimento storico', fallback: '', defaultDays: '180' },
  { section: 'tournament', endpoint: '/api/training-plan', results: 'Piano per identificare il campione migliore', fallback: '', defaultDays: '180' },
  { section: 'matchups', endpoint: '/api/matchups', results: 'Risultati dei confronti con gli avversari', fallback: 'all', defaultDays: 'all' },
] as const

test('periodo confronto nei link: gli invalidi restano visibili e si ripristinano da tastiera @smoke', async ({ page }) => {
  test.setTimeout(90_000)
  const requests: URL[] = []
  const responses: { url: URL; status: number; body: ComparisonPeriodResponse }[] = []
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
  for (const screen of comparisonPeriodScreens) {
    await page.route(`**${screen.endpoint}?**`, async (route) => {
      if (route.request().method() !== 'GET') return route.fallback()
      const url = new URL(route.request().url())
      requests.push(url)
      const response = await route.fetch()
      const body = await response.json() as ComparisonPeriodResponse
      responses.push({ url, status: response.status(), body })
      await route.fulfill({ response, json: body })
    })
  }
  await page.addInitScript(() => {
    localStorage.setItem('champion-fit-profile-accounts', JSON.stringify(['Alpha#EUW', 'Beta#EUW']))
    localStorage.setItem('champion-fit:data-view:v2', JSON.stringify({ view: 'list' }))
  })
  const control = page.getByRole('combobox', { name: 'Periodo', exact: true })
  type Screen = typeof comparisonPeriodScreens[number]
  const expectScope = (screen: Screen) => {
    const params = new URL(page.url()).searchParams
    expect(params.get('section')).toBe(screen.section)
    expect(params.get('relation')).toBe('enemies')
    expect(params.get('role')).toBe('ALL')
    expect(params.get('queue')).toBe('all')
    expect(params.get('budget')).toBe('400')
    const request = requests.at(-1)
    expect(request?.pathname).toBe(screen.endpoint)
    expect(request?.searchParams.getAll('account')).toEqual(['Alpha#EUW', 'Beta#EUW'])
    expect(request?.searchParams.get('role')).toBe('ALL')
    expect(request?.searchParams.get('queue')).toBe('all')
    if (screen.section === 'tournament') expect(request?.searchParams.get('budget')).toBe('400')
  }
  const expectContext = async (screen: Screen, days: string) => {
    const latest = responses.at(-1)
    expect(latest?.status).toBe(200)
    expect(String(latest?.body.context?.days)).toBe(days)
    expect(latest?.body.context?.role).toBe('ALL')
    expect(latest?.body.context?.queue).toBe('all')
    expect(latest?.body.context?.observations).toBeGreaterThanOrEqual(0)
    if (days === 'all') expect(latest?.body.context?.observations).toBe(6)
    if (screen.section === 'matchups') expect(latest?.body.games).toBe(latest?.body.context?.observations)
    await expect(page.getByRole('region', { name: screen.results, exact: true })).toBeVisible()
    await expect(page.getByRole('alert')).toHaveCount(0)
    expectScope(screen)
  }
  const openLink = async (screen: Screen, raw: string | null, invalid = false) => {
    const params = new URLSearchParams({ section: screen.section, relation: 'enemies', role: 'ALL', queue: 'all', budget: '400' })
    if (raw !== null) params.set('days', raw)
    const ready = async (beforeRequests: number, beforeResponses: number) => {
      await expect.poll(() => responses.length).toBe(beforeResponses + 1)
      await expect(control).toBeVisible()
      expect(requests).toHaveLength(beforeRequests + 1)
      expect(Object.fromEntries(new URL(page.url()).searchParams)).toEqual(Object.fromEntries(params))
      const wire = raw === null && screen.section === 'matchups' ? 'all' : raw || null
      expect(requests.at(-1)?.searchParams.get('days')).toBe(wire)
      if (invalid) {
        expect(responses.at(-1)?.status).toBe(400)
        expect(responses.at(-1)?.body.error).toBe('days deve essere 90, 180, 365 oppure all')
        await expect(page.getByRole('alert')).toContainText('days deve essere 90, 180, 365 oppure all')
        await expect(control).toHaveValue(raw!)
        await expect(control.locator('option:checked')).toHaveText('Periodo del link')
        await expect(control.locator('option:checked')).toHaveJSProperty('disabled', true)
        await expect(page.getByRole('region', { name: screen.results, exact: true })).toHaveCount(0)
      } else {
        const selected = raw ?? screen.fallback
        await expect(control).toHaveValue(selected)
        const days = raw === '' ? '180' : raw ?? screen.defaultDays
        await expectContext(screen, days)
        if (screen.section === 'matchups' && raw === '') {
          await expect(control.locator('option:checked')).toHaveText('Periodo predefinito')
          await expect(control.locator('option:checked')).toHaveJSProperty('disabled', true)
        }
      }
      expectScope(screen)
    }
    const beforeGoto = [requests.length, responses.length] as const
    await page.goto(`/app/fit?${params}`)
    await ready(beforeGoto[0], beforeGoto[1])
    const beforeReload = [requests.length, responses.length] as const
    await page.reload()
    await ready(beforeReload[0], beforeReload[1])
  }
  const recoverByKeyboard = async (screen: Screen) => {
    const beforeRequests = requests.length
    const beforeResponses = responses.length
    await control.focus()
    await control.press('Home')
    await control.press('Tab')
    await expect(control).toHaveValue(screen.fallback)
    await expect(control.locator('option:checked')).toHaveText(screen.fallback ? 'Tutto lo storico' : 'Predefinito')
    await expect.poll(() => responses.length).toBe(beforeResponses + 1)
    expect(requests).toHaveLength(beforeRequests + 1)
    expect(new URL(page.url()).searchParams.get('days')).toBe(screen.fallback || null)
    expect(requests.at(-1)?.searchParams.get('days')).toBe(screen.fallback || null)
    await expectContext(screen, screen.defaultDays)
  }

  for (const screen of comparisonPeriodScreens) {
    for (const valid of [null, '', 'all', '90']) {
      await openLink(screen, valid)
      if (screen.section === 'matchups' && valid === '') await recoverByKeyboard(screen)
    }
    for (const invalid of ['unknown', '0', '\ufeffall\ufeff']) {
      await openLink(screen, invalid, true)
      await recoverByKeyboard(screen)
    }
  }
  expect(unexpectedWrites).toEqual([])
  expect(pageErrors).toEqual([])
})


type PlaystylePeriodDto = import('../src/api/playstyles').PlaystylesResponse
type PlaystylePeriodEvidenceDto = import('../src/api/playstyles').PlaystyleEvidenceResponse

test('periodo stili nei link: i periodi non validi non usano il predefinito e restano recuperabili @smoke', async ({ page }) => {
  test.setTimeout(90_000)
  const requests: URL[] = []
  const responses: { url: URL; status: number; body: Partial<PlaystylePeriodDto> & { error?: string } }[] = []
  const evidence: { url: URL; body: PlaystylePeriodEvidenceDto }[] = []
  const recommendations: { url: URL; body: RecommendationsResponseDto }[] = []
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
  await page.route('**/api/playstyles?**', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    const url = new URL(route.request().url())
    requests.push(url)
    const response = await route.fetch()
    const body = await response.json() as Partial<PlaystylePeriodDto> & { error?: string }
    responses.push({ url, status: response.status(), body })
    await route.fulfill({ response, json: body })
  })
  await page.route('**/api/playstyle-evidence?**', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    const response = await route.fetch()
    expect(response.status()).toBe(200)
    const body = await response.json() as PlaystylePeriodEvidenceDto
    evidence.push({ url: new URL(route.request().url()), body })
    await route.fulfill({ response, json: body })
  })
  await page.route('**/api/recommendations?**', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    const response = await route.fetch()
    expect(response.status()).toBe(200)
    const body = await response.json() as RecommendationsResponseDto
    recommendations.push({ url: new URL(route.request().url()), body })
    await route.fulfill({ response, json: body })
  })
  await page.addInitScript(() => {
    localStorage.setItem('champion-fit-profile-accounts', JSON.stringify(['Alpha#EUW', 'Beta#EUW']))
    localStorage.setItem('champion-fit:data-view:v2', JSON.stringify({ view: 'cards' }))
  })
  const control = page.getByRole('combobox', { name: 'Periodo degli stili', exact: true })
  const expectScope = () => {
    const params = new URL(page.url()).searchParams
    expect(params.get('section')).toBe('style')
    expect(params.get('role')).toBe('ALL')
    expect(params.get('queue')).toBe('440')
    expect(params.get('category')).toBe('class:mage')
    expect(params.get('search')).toBe('contesto da conservare')
    const request = requests.at(-1)
    expect(request?.searchParams.getAll('account')).toEqual(['Alpha#EUW', 'Beta#EUW'])
    expect(request?.searchParams.get('role')).toBe('ALL')
    expect(request?.searchParams.get('queue')).toBe('440')
    expect(request?.searchParams.get('category')).toBe('class:mage')
  }
  const expectContext = async (days: string) => {
    const latest = responses.at(-1)
    expect(latest?.status).toBe(200)
    expect(latest?.body.filters?.days).toBe(days)
    expect(latest?.body.filters?.role).toBe('ALL')
    expect(latest?.body.filters?.queue).toBe('440')
    expect(latest?.body.summary?.accounts).toBe(2)
    expect(latest?.body.summary?.observations).toBeGreaterThanOrEqual(0)
    if (days === 'all') expect(latest?.body.summary?.observations).toBe(2)
    await expect(page.getByRole('heading', { name: 'Con quali categorie vinci?', exact: true })).toBeVisible()
    await expect(page.locator('.playstyles-auto')).toContainText(days === 'all' ? 'tutto lo storico' : `ultimi ${days} giorni`)
    await expect(page.getByRole('alert')).toHaveCount(0)
    expectScope()
  }
  const openLink = async (raw: string | null, invalid = false) => {
    const params = new URLSearchParams({ section: 'style', role: 'ALL', queue: '440', category: 'class:mage', search: 'contesto da conservare' })
    if (raw !== null) params.set('days', raw)
    const ready = async (beforeResponses: number, beforeRequests: number) => {
      await expect.poll(() => responses.length).toBeGreaterThan(beforeResponses)
      await expect(control).toBeVisible()
      await expect(page.getByLabel('Analisi degli stili per i filtri attivi', { exact: true })).toHaveCount(0)
      expect(Object.fromEntries(new URL(page.url()).searchParams)).toEqual(Object.fromEntries(params))
      expect(requests.at(-1)?.searchParams.get('days')).toBe(raw || '180')
      if (invalid) {
        await expect(page.getByRole('alert')).toContainText('days deve essere 90, 180, 365 oppure all')
        expect(responses).toHaveLength(beforeResponses + 1)
        expect(requests).toHaveLength(beforeRequests + 1)
        expect(responses.at(-1)?.status).toBe(400)
        expect(responses.at(-1)?.body.error).toBe('days deve essere 90, 180, 365 oppure all')
        await expect(control).toHaveValue(raw!)
        await expect(control.locator('option:checked')).toHaveText('Periodo del link')
        await expect(control.locator('option:checked')).toHaveJSProperty('disabled', true)
        await expect(page.locator('.playstyles-auto')).toHaveCount(0)
        await expect(page.getByRole('heading', { name: 'Con quali categorie vinci?', exact: true })).toHaveCount(0)
      } else {
        await expect(control).toHaveValue(raw || '180')
        await expectContext(raw || '180')
      }
      expectScope()
    }
    const beforeGoto = [responses.length, requests.length] as const
    await page.goto(`/app/matches?${params}`)
    await ready(beforeGoto[0], beforeGoto[1])
    const beforeReload = [responses.length, requests.length] as const
    await page.reload()
    await ready(beforeReload[0], beforeReload[1])
  }

  for (const raw of [null, '', 'all', '90']) await openLink(raw)
  for (const invalid of ['unknown', '0', '\ufeffall\ufeff']) {
    await openLink(invalid, true)
    const beforeRetryRequests = requests.length
    const beforeRetryResponses = responses.length
    const retryPageUrl = page.url()
    const retryRequestUrl = requests.at(-1)?.href
    await page.getByRole('button', { name: 'Riprova', exact: true }).click()
    await expect.poll(() => responses.length).toBeGreaterThan(beforeRetryResponses)
    await expect(page.getByLabel('Analisi degli stili per i filtri attivi', { exact: true })).toHaveCount(0)
    await expect(page.getByRole('alert')).toContainText('days deve essere 90, 180, 365 oppure all')
    expect(responses).toHaveLength(beforeRetryResponses + 1)
    expect(requests).toHaveLength(beforeRetryRequests + 1)
    expect(responses.at(-1)?.status).toBe(400)
    expect(page.url()).toBe(retryPageUrl)
    expect(requests.at(-1)?.href).toBe(retryRequestUrl)
    await expect(control).toHaveValue(invalid)
    expectScope()
    const beforeRequests = requests.length
    const beforeResponses = responses.length
    await control.focus()
    await control.press('Home')
    await control.press('Tab')
    await expect(control).toHaveValue('90')
    await expect(control.locator('option:checked')).toHaveText('Ultimi 90 giorni')
    await expect.poll(() => responses.length).toBe(beforeResponses + 1)
    expect(requests).toHaveLength(beforeRequests + 1)
    expect(new URL(page.url()).searchParams.get('days')).toBe('90')
    expect(requests.at(-1)?.searchParams.get('days')).toBe('90')
    await expectContext('90')
  }

  // Search is local. Evidence and the natural link carry the period which
  // successfully loaded, alongside the existing role, queue and account scope.
  await openLink('all')
  const body = responses.at(-1)?.body
  const category = body?.categories?.find((item) => item.id === 'class:mage')
  if (!category) throw new Error('La fixture reale deve includere la categoria dei maghi.')
  const beforeSearch = requests.length
  await page.getByRole('searchbox', { name: 'Cerca categoria', exact: true }).fill(category.label)
  await expect(page.getByRole('heading', { name: category.label, exact: true })).toBeVisible()
  expect(requests).toHaveLength(beforeSearch)
  await page.getByRole('button', { name: `Perché ${category.label}?`, exact: true }).click()
  const beforeEvidence = evidence.length
  await page.getByRole('button', { name: `Mostra le partite · ${category.label}`, exact: true }).click()
  await expect.poll(() => evidence.length).toBe(beforeEvidence + 1)
  const latestEvidence = evidence.at(-1)
  expect(latestEvidence?.url.searchParams.getAll('account')).toEqual(['Alpha#EUW', 'Beta#EUW'])
  expect(latestEvidence?.url.searchParams.get('role')).toBe('ALL')
  expect(latestEvidence?.url.searchParams.get('queue')).toBe('440')
  expect(latestEvidence?.url.searchParams.get('days')).toBe('all')
  expect(latestEvidence?.url.searchParams.get('category')).toBe('class:mage')
  expect(latestEvidence?.body.category_id).toBe('class:mage')
  expect(latestEvidence?.body.matches.map((match) => [match.account, match.match_id, match.champion])).toEqual([['Beta#EUW', 'EUW1-006', 'Ahri']])
  const evidenceRegion = page.getByRole('region', { name: `Partite a supporto di ${category.label}`, exact: true })
  await expect(evidenceRegion.locator('tbody tr')).toHaveCount(latestEvidence?.body.matches.length ?? 0)
  expect(requests).toHaveLength(beforeSearch)
  expectScope()

  const suggestionLink = page.getByRole('link', { name: 'Vedi i campioni da provare', exact: true })
  const href = await suggestionLink.getAttribute('href')
  if (!href) throw new Error('Il collegamento naturale ai campioni deve avere una destinazione.')
  const destination = new URL(href, page.url())
  expect(destination.pathname).toBe('/app/fit')
  expect(destination.searchParams.get('section')).toBe('training')
  expect(destination.searchParams.get('queue')).toBe('440')
  expect(destination.searchParams.get('days')).toBe('all')
  expect(destination.searchParams.get('category')).toBe('class:mage')
  const beforeSuggestions = recommendations.length
  await suggestionLink.click()
  await expect(page.getByRole('heading', { name: 'Scelte vicine ai tuoi gusti', exact: true })).toBeVisible()
  await expect.poll(() => recommendations.length).toBeGreaterThan(beforeSuggestions)
  const latestRecommendations = recommendations.at(-1)
  expect(latestRecommendations?.url.searchParams.getAll('account')).toEqual(['Alpha#EUW', 'Beta#EUW'])
  expect(latestRecommendations?.url.searchParams.get('queue')).toBe('440')
  expect(latestRecommendations?.url.searchParams.get('days')).toBe('all')
  expect(latestRecommendations?.body.context.role).toBe('ALL')
  expect(latestRecommendations?.body.context.queue).toBe('440')
  expect(latestRecommendations?.body.context.days).toBe('all')
  expect(latestRecommendations?.body.coverage.observations).toBe(2)
  expect(unexpectedWrites).toEqual([])
  expect(pageErrors).toEqual([])
})
