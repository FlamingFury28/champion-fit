import { expect, test, type Locator, type Page } from '@playwright/test'
import type { RecommendationsResponseDto } from '../src/api/types'

const screens = [
  { id: 'friends', path: '/app/team/friends', parameters: {}, endpoint: '/api/friends', label: 'Ruolo del confronto', metric: 'Partite con partecipanti' },
  { id: 'playstyles', path: '/app/matches', parameters: { section: 'style' }, endpoint: '/api/playstyles', label: 'Ruolo degli stili', metric: 'Partite uniche' },
  { id: 'synergy', path: '/app/fit', parameters: { section: 'matchups', relation: 'allies', include_exploratory: '1' }, endpoint: '/api/synergy', label: 'Ruolo', metric: 'Partite analizzate' },
] as const

type Screen = typeof screens[number]
type FixtureResponse = { url: URL; status: number; games?: number }

async function observeFixture(page: Page, screen: Screen) {
  const requests: URL[] = []
  const responses: FixtureResponse[] = []
  const unexpectedWrites: string[] = []
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.route('https://ddragon.leagueoflegends.com/**', (route) => route.abort())
  await page.route('**/api/**', (route) => {
    if (route.request().method() === 'GET') return route.fallback()
    unexpectedWrites.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`)
    return route.abort()
  })
  await page.route(`**${screen.endpoint}?**`, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    const url = new URL(route.request().url())
    requests.push(url)
    // Keep the complete wire shape from the real synthetic fixture server.
    // Its SQLite/PG HTTP matrix proves aliases/whitespace -> SUPPORT,
    // invalid roles -> 400, and explicit whitespace-only -> automatic MIDDLE.
    // No frontend normalization implementation is imported into this test.
    const response = await route.fetch()
    const body: unknown = await response.json()
    const games = body && typeof body === 'object' && 'games' in body && typeof body.games === 'number' ? body.games : undefined
    responses.push({ url, status: response.status(), ...(games === undefined ? {} : { games }) })
    await route.fulfill({ response, json: body })
  })
  await page.addInitScript(() => {
    localStorage.setItem('champion-fit-profile-accounts', JSON.stringify(['Alpha#EUW']))
    localStorage.setItem('champion-fit:data-view:v2', JSON.stringify({ view: 'list' }))
  })
  return { requests, responses, unexpectedWrites }
}

async function openLinkAndRefresh(page: Page, screen: Screen, role: string, responses: { status: number }[]) {
  const parameters = new URLSearchParams({ ...screen.parameters, queue: '420', days: 'all', min_games: '1', role })
  const before = responses.length
  await page.goto(`${screen.path}?${parameters}`)
  const control = page.getByRole('combobox', { name: screen.label, exact: true })
  await expect(control).toBeVisible()
  await expect.poll(() => responses.length).toBeGreaterThan(before)
  if (responses.at(-1)?.status === 400) await expect(page.getByRole('alert')).toContainText('Ruolo non valido')
  else await expect(observations(page, screen)).toBeVisible()
  const beforeReload = responses.length
  await page.reload()
  await expect(control).toBeVisible()
  await expect.poll(() => responses.length).toBeGreaterThan(beforeReload)
  if (responses.at(-1)?.status === 400) await expect(page.getByRole('alert')).toContainText('Ruolo non valido')
  else await expect(observations(page, screen)).toBeVisible()
  expect(new URL(page.url()).searchParams.get('role')).toBe(role)
  return control
}

function observations(page: Page, screen: Screen) {
  return page.locator('.metric-card').filter({ has: page.getByText(screen.metric, { exact: true }) }).locator('strong')
}

async function expectFilteredObservations(page: Page, screen: Screen, count: number) {
  if (screen.id === 'synergy') {
    // Coverage describes the account's complete analyzed history; the detail
    // uses data.games for the requested role/queue/champion context.
    await expect(observations(page, screen)).toHaveText('4')
    await expect(page.locator('.metric-card').filter({ has: page.getByText(screen.metric, { exact: true }) }).locator('small')).toHaveText(`${count} con il filtro sul campione`)
  } else await expect(observations(page, screen)).toHaveText(String(count))
}

async function chooseAllWithKeyboard(control: Locator) {
  await control.focus()
  await control.press('Home')
  await control.press('Enter')
  await control.press('Tab')
  await expect(control).toHaveValue('ALL')
  await expect(control.locator('option:checked')).toHaveText('Tutti i ruoli · aggregato')
}

async function expectAggregate(page: Page, screen: Screen, requests: URL[], responses: FixtureResponse[]) {
  await expect.poll(() => requests.at(-1)?.searchParams.get('role')).toBe('ALL')
  expect(requests.at(-1)?.searchParams.getAll('account')).toEqual(['Alpha#EUW'])
  expect(requests.at(-1)?.searchParams.get('queue')).toBe('420')
  expect(requests.at(-1)?.searchParams.get('days')).toBe('all')
  await expectFilteredObservations(page, screen, 4)
  if (screen.id === 'friends') {
    await expect(page.getByRole('region', { name: 'Classifica dei compagni di squadra', exact: true }).locator('tbody tr')).toHaveCount(5)
  }
  if (screen.id === 'synergy') {
    await expect.poll(() => responses.at(-1)?.games).toBe(4)
    await expect(page.locator('[data-explorer-id="synergies-positive"] .synergy-list > article')).toHaveCount(2)
  }
  await expect(page.getByRole('alert')).toHaveCount(0)
}

for (const screen of screens) {
  test(`ruoli nei link: ${screen.id} rende visibile Supporto e permette Tutti da tastiera @smoke`, async ({ page }) => {
    const { requests, responses, unexpectedWrites } = await observeFixture(page, screen)
    for (const alias of ['UTILITY', '\u0085\u001c utility \u001f\u0085']) {
      const control = await openLinkAndRefresh(page, screen, alias, responses)
      await expect(control).toHaveValue('SUPPORT')
      await expect(control.locator('option:checked')).toHaveText('Supporto')
      await expect(control.getByRole('option', { name: 'Supporto', exact: true })).toHaveCount(1)
      await expect.poll(() => requests.at(-1)?.searchParams.get('role')).toBe('SUPPORT')
      await expectFilteredObservations(page, screen, 1)
      if (screen.id === 'synergy') await expect.poll(() => responses.at(-1)?.games).toBe(1)
      if (screen.id === 'friends') {
        await expect(page.getByRole('region', { name: 'Classifica dei compagni di squadra', exact: true }).locator('tbody tr')).toHaveCount(1)
      }
      await chooseAllWithKeyboard(control)
      await expectAggregate(page, screen, requests, responses)
    }
    expect(unexpectedWrites).toEqual([])
  })
}

for (const screen of [screens[0], screens[1]]) {
  test(`ruoli nei link: ${screen.id} conserva il 400 per unknown e BOM e recupera solo con Tutti esplicito @smoke`, async ({ page }) => {
    const { requests, responses, unexpectedWrites } = await observeFixture(page, screen)
    for (const invalid of ['unknown', '\ufeffMIDDLE\ufeff']) {
      const control = await openLinkAndRefresh(page, screen, invalid, responses)
      await expect.poll(() => responses.at(-1)?.status).toBe(400)
      await expect(page.getByRole('alert')).toContainText('Ruolo non valido')
      await expect(observations(page, screen)).toHaveCount(0)
      if (screen.id === 'friends') {
        await expect(page.getByRole('region', { name: 'Classifica dei compagni di squadra', exact: true })).toHaveCount(0)
      }
      await chooseAllWithKeyboard(control)
      await expectAggregate(page, screen, requests, responses)
    }
    expect(unexpectedWrites).toEqual([])
  })

  test(`ruoli nei link: ${screen.id} distingue il ruolo automatico composto da spazi da Tutti @smoke`, async ({ page }) => {
    const { requests, responses, unexpectedWrites } = await observeFixture(page, screen)
    const rawRole = '\u0085 \u001c'
    const control = await openLinkAndRefresh(page, screen, rawRole, responses)
    await expect(control).toHaveValue(rawRole)
    if (screen.id === 'friends') await expect(control.locator('option:checked')).toHaveText('Ruolo automatico')
    await expect.poll(() => requests.at(-1)?.searchParams.get('role')).toBe(rawRole)
    await expectFilteredObservations(page, screen, 3)
    await chooseAllWithKeyboard(control)
    await expectAggregate(page, screen, requests, responses)
    expect(unexpectedWrites).toEqual([])
  })
}

interface CompetitiveResponse {
  context: { role: string }
  items: { champion: string; role: string; unique_games: number }[]
}

const competitiveScreens = [
  { id: 'rendimento', section: 'best', endpoint: '/api/champions', results: 'Classifica del rendimento storico' },
  { id: 'piano competitivo', section: 'tournament', endpoint: '/api/training-plan', results: 'Piano per identificare il campione migliore' },
] as const

for (const screen of competitiveScreens) {
  test(`ruoli competitivi nei link: ${screen.id} allinea alias e fallback e permette Automatico da tastiera @smoke`, async ({ page }) => {
    const requests: URL[] = []
    const responses: CompetitiveResponse[] = []
    const unexpectedWrites: string[] = []
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.route('https://ddragon.leagueoflegends.com/**', (route) => route.abort())
    await page.route('**/api/**', (route) => {
      if (route.request().method() === 'GET') return route.fallback()
      unexpectedWrites.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`)
      return route.abort()
    })
    await page.route(`**${screen.endpoint}?**`, async (route) => {
      if (route.request().method() !== 'GET') return route.fallback()
      requests.push(new URL(route.request().url()))
      const response = await route.fetch()
      expect(response.status()).toBe(200)
      const body = await response.json() as CompetitiveResponse
      responses.push(body)
      await route.fulfill({ response, json: body })
    })
    await page.addInitScript(() => {
      localStorage.setItem('champion-fit-profile-accounts', JSON.stringify(['Alpha#EUW']))
    })
    const control = page.getByRole('combobox', { name: 'Ruolo', exact: true })
    const results = page.getByRole('region', { name: screen.results, exact: true })
    const openLink = async (role: string | null) => {
      const parameters = new URLSearchParams({ section: screen.section, queue: '420', days: 'all', budget: '400' })
      if (role !== null) parameters.set('role', role)
      await page.goto(`/app/fit?${parameters}`)
      await expect(results).toBeVisible()
      const beforeReload = responses.length
      await page.reload()
      await expect(results).toBeVisible()
      await expect.poll(() => responses.length).toBeGreaterThan(beforeReload)
      expect(new URL(page.url()).searchParams.get('role')).toBe(role)
    }
    const expectAutomatic = async () => {
      await expect(control).toHaveValue('')
      await expect(control.locator('option:checked')).toHaveText('Automatico')
      await expect.poll(() => new URL(page.url()).searchParams.has('role')).toBe(false)
      await expect.poll(() => requests.at(-1)?.searchParams.get('role')).toBeNull()
      await expect.poll(() => responses.at(-1)?.context.role).toBe('MIDDLE')
      await expect(results.locator('tbody tr')).toHaveCount(1)
      const row = results.locator('tbody tr')
      await expect(row.locator('th')).toContainText('Ahri')
      await expect(row.locator('td').nth(0)).toHaveText('Corsia centrale')
      await expect(row.locator('td').nth(1)).toHaveText('3')
    }
    const chooseAutomatic = async () => {
      await control.focus()
      await control.press('Home')
      await control.press('Tab')
      await expectAutomatic()
    }

    await openLink(null)
    await expectAutomatic()
    for (const alias of ['UTILITY', '\u0085\u001c utility \u001f\u0085']) {
      await openLink(alias)
      await expect(control).toHaveValue('SUPPORT')
      await expect(control.locator('option:checked')).toHaveText('Supporto')
      await expect.poll(() => requests.at(-1)?.searchParams.get('role')).toBe('SUPPORT')
      await expect.poll(() => responses.at(-1)?.context.role).toBe('SUPPORT')
      await expect(results.locator('tbody tr')).toHaveCount(1)
      const row = results.locator('tbody tr')
      await expect(row.locator('th')).toContainText('Lux')
      await expect(row.locator('td').nth(0)).toHaveText('Supporto')
      await expect(row.locator('td').nth(1)).toHaveText('1')
      await chooseAutomatic()
    }
    for (const fallback of ['', 'unknown']) {
      await openLink(fallback)
      await expect(control).toHaveValue('ALL')
      await expect(control.locator('option:checked')).toHaveText('Tutti i ruoli')
      await expect.poll(() => requests.at(-1)?.searchParams.get('role')).toBe('ALL')
      await expect.poll(() => responses.at(-1)?.context.role).toBe('ALL')
      await expect(page.getByRole('alert')).toHaveCount(0)
      await chooseAutomatic()
    }
    expect(unexpectedWrites).toEqual([])
  })
}

const recommendationScreens = [
  { id: 'preferenze', section: 'choices', training: '', loading: 'Caricamento dei suggerimenti' },
  { id: 'scoperte', section: 'training', training: 'discover', loading: 'Caricamento delle scoperte' },
  { id: 'piano di prove', section: 'training', training: 'plan', loading: 'Caricamento del piano di prove' },
] as const

for (const screen of recommendationScreens) {
  test(`ruoli preferenze nei link: ${screen.id} preserva MID, ADC e AUTO senza ampliare il contesto @smoke`, async ({ page }) => {
    test.setTimeout(60_000)
    const requests: URL[] = []
    const responses: RecommendationsResponseDto[] = []
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
      expect(response.status()).toBe(200)
      const body = await response.json() as RecommendationsResponseDto
      responses.push(body)
      await route.fulfill({ response, json: body })
    })
    await page.addInitScript(() => {
      localStorage.setItem('champion-fit-profile-accounts', JSON.stringify(['Alpha#EUW', 'Beta#EUW']))
    })
    const control = page.getByRole('combobox', { name: 'Ruolo', exact: true })
    const expectDisplayParams = () => {
      const params = new URL(page.url()).searchParams
      expect(params.get('section')).toBe(screen.section)
      expect(params.get('training')).toBe(screen.training || null)
      expect(params.get('view')).toBe('discover')
      expect(params.get('queue')).toBe('all')
      expect(params.get('days')).toBe('all')
    }
    const waitReady = async () => {
      await expect(control).toBeVisible()
      await expect(page.getByLabel(screen.loading, { exact: true })).toHaveCount(0)
      await expect(page.getByRole('alert')).toHaveCount(0)
      if (screen.id === 'preferenze') await expect(page.getByRole('region', { name: 'Campioni da scoprire', exact: true })).toBeVisible()
      if (screen.id === 'piano di prove') await expect(page.getByRole('region', { name: 'Piano di prove', exact: true })).toBeVisible()
    }
    const openLink = async (role: string) => {
      const params = new URLSearchParams({ section: screen.section, view: 'discover', queue: 'all', days: 'all', role })
      if (screen.training) params.set('training', screen.training)
      const before = responses.length
      await page.goto(`/app/fit?${params}`)
      await expect.poll(() => responses.length).toBeGreaterThan(before)
      await waitReady()
      const beforeReload = responses.length
      await page.reload()
      await expect.poll(() => responses.length).toBeGreaterThan(beforeReload)
      await waitReady()
      expect(new URL(page.url()).searchParams.get('role')).toBe(role)
      expectDisplayParams()
    }
    const expectContext = async (role: string, games: number) => {
      await expect.poll(() => responses.at(-1)?.context.role).toBe(role)
      await expect.poll(() => responses.at(-1)?.coverage.observations).toBe(games)
      await expect.poll(() => responses.at(-1)?.coverage.games).toBe(games)
      expect(requests.at(-1)?.searchParams.getAll('account')).toEqual(['Alpha#EUW', 'Beta#EUW'])
      expect(requests.at(-1)?.searchParams.get('queue')).toBe('all')
      expect(requests.at(-1)?.searchParams.get('days')).toBe('all')
      await waitReady()
      if (screen.id === 'preferenze') {
        await expect(page.getByText(`${games} partite uniche e ${games} osservazioni su`, { exact: false })).toBeVisible()
      }
      // Zero observations constrain the historical context; theoretical
      // discoveries can still be returned and must not be treated as an error.
      if (role === 'BOTTOM') {
        expect(responses.at(-1)?.known.every((item) => !item.performance || item.performance.games === 0)).toBe(true)
      }
    }
    const chooseAll = async () => {
      await control.focus()
      await control.press('Home')
      await control.press('Tab')
      await expect(control).toHaveValue('')
      await expect(control.locator('option:checked')).toHaveText('Tutti i ruoli · nessun filtro')
      await expect.poll(() => new URL(page.url()).searchParams.has('role')).toBe(false)
      await expect.poll(() => requests.at(-1)?.searchParams.get('role')).toBeNull()
      await expectContext('ALL', 6)
      expectDisplayParams()
    }

    for (const entry of [
      { raw: 'MIDDLE', value: 'MIDDLE', wire: 'MIDDLE', context: 'MIDDLE', label: 'Corsia centrale', games: 4 },
      { raw: 'BOTTOM', value: 'BOTTOM', wire: 'BOTTOM', context: 'BOTTOM', label: 'Corsia inferiore', games: 0 },
      { raw: 'MID', value: 'MIDDLE', wire: 'MIDDLE', context: 'MIDDLE', label: 'Corsia centrale', games: 4 },
      { raw: '\u0085\u001c adc \u001f\u0085', value: 'BOTTOM', wire: 'BOTTOM', context: 'BOTTOM', label: 'Corsia inferiore', games: 0 },
      { raw: 'AUTO', value: 'AUTO', wire: 'AUTO', context: 'MIDDLE', label: 'Ruolo automatico', games: 4 },
    ]) {
      await openLink(entry.raw)
      await expect(control).toHaveValue(entry.value)
      await expect(control.locator('option:checked')).toHaveText(entry.label)
      if (entry.value === 'AUTO') await expect(control.locator('option:checked')).toHaveJSProperty('disabled', true)
      await expect.poll(() => requests.at(-1)?.searchParams.get('role')).toBe(entry.wire)
      await expectContext(entry.context, entry.games)
      await chooseAll()
    }
    if (screen.id === 'preferenze') {
      for (const raw of ['unknown', '\ufeffMIDDLE\ufeff']) {
        await openLink(raw)
        await expect(control).toHaveValue('')
        await expect(control.locator('option:checked')).toHaveText('Tutti i ruoli · nessun filtro')
        await expect.poll(() => requests.at(-1)?.searchParams.get('role')).toBeNull()
        await expectContext('ALL', 6)
        expectDisplayParams()
      }
    }
    expect(unexpectedWrites).toEqual([])
  })
}

test('ruoli scheda nei link: alias e AUTO restano separati dal ruolo della pagina sottostante @smoke', async ({ page }) => {
  test.setTimeout(60_000)
  const parentRequests: URL[] = []
  const detailRequests: URL[] = []
  const detailResponses: RecommendationsResponseDto[] = []
  const unexpectedWrites: string[] = []
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.route('https://ddragon.leagueoflegends.com/**', (route) => route.abort())
  await page.route('**/api/**', (route) => {
    if (route.request().method() === 'GET') return route.fallback()
    unexpectedWrites.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`)
    return route.abort()
  })
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.pathname === '/api/champions') parentRequests.push(url)
  })
  await page.route('**/api/recommendations?**', async (route) => {
    const url = new URL(route.request().url())
    if (route.request().method() !== 'GET' || url.searchParams.get('champion') !== 'Ahri') return route.fallback()
    detailRequests.push(url)
    const response = await route.fetch()
    expect(response.status()).toBe(200)
    const body = await response.json() as RecommendationsResponseDto
    detailResponses.push(body)
    await route.fulfill({ response, json: body })
  })
  await page.addInitScript(() => {
    localStorage.setItem('champion-fit-profile-accounts', JSON.stringify(['Alpha#EUW', 'Beta#EUW']))
  })
  const dialog = page.getByRole('dialog', { name: 'Scheda di Ahri', exact: true })
  const control = dialog.getByRole('combobox', { name: 'Ruolo della scheda', exact: true })
  const expectParent = () => {
    const params = new URL(page.url()).searchParams
    expect(params.get('section')).toBe('best')
    expect(params.get('role')).toBe('SUPPORT')
    expect(params.get('queue')).toBe('all')
    expect(params.get('days')).toBe('all')
    expect(params.get('detail')).toBe('Ahri')
    expect(parentRequests.at(-1)?.searchParams.get('role')).toBe('SUPPORT')
    expect(parentRequests.at(-1)?.searchParams.getAll('account')).toEqual(['Alpha#EUW', 'Beta#EUW'])
  }
  const openLink = async (role: string) => {
    const params = new URLSearchParams({ section: 'best', role: 'SUPPORT', queue: 'all', days: 'all', detail: 'Ahri', detailRole: role })
    const before = detailResponses.length
    await page.goto(`/app/fit?${params}`)
    await expect(dialog).toBeVisible()
    await expect.poll(() => detailResponses.length).toBeGreaterThan(before)
    await expect(dialog.locator('.query-results')).toBeVisible()
    const beforeReload = detailResponses.length
    const beforeParentReload = parentRequests.length
    await page.reload()
    await expect(dialog).toBeVisible()
    await expect.poll(() => detailResponses.length).toBeGreaterThan(beforeReload)
    await expect.poll(() => parentRequests.length).toBeGreaterThan(beforeParentReload)
    await expect(dialog.locator('.query-results')).toBeVisible()
    expect(new URL(page.url()).searchParams.get('detailRole')).toBe(role)
    expectParent()
  }
  const expectCandidate = async (role: 'MIDDLE' | 'BOTTOM', games: number, contextRole: 'MIDDLE' | 'BOTTOM' | 'ALL' = role) => {
    const label = role === 'MIDDLE' ? 'Corsia centrale' : 'Corsia inferiore'
    const contextLabel = contextRole === 'ALL' ? 'Tutti i ruoli' : contextRole === 'MIDDLE' ? 'Corsia centrale' : 'Corsia inferiore'
    const results = dialog.getByRole('region', { name: `Scheda di Ahri · ${label}`, exact: true })
    await expect(results).toBeVisible()
    await expect(results.locator('.metric-card').filter({ has: page.getByText('Partite uniche', { exact: true }) }).locator('strong')).toHaveText(String(games))
    await expect(results.locator('.context-note').filter({ hasText: /^Contesto effettivo:/ })).toContainText(`Contesto effettivo: ${contextLabel}`)
    const body = detailResponses.at(-1)
    const candidates = body?.candidate ? [body.candidate] : body?.candidates ?? []
    expect(candidates).toEqual(expect.arrayContaining([expect.objectContaining({ champion: 'Ahri', role })]))
    const candidate = candidates.find((item) => item.champion === 'Ahri' && item.role === role)
    expect(candidate?.games).toBe(games)
    expect(candidate?.performance?.games ?? 0).toBe(games)
    expect(detailRequests.at(-1)?.searchParams.get('champion')).toBe('Ahri')
    expect(detailRequests.at(-1)?.searchParams.getAll('account')).toEqual(['Alpha#EUW', 'Beta#EUW'])
    expect(detailRequests.at(-1)?.searchParams.get('queue')).toBe('all')
    expect(detailRequests.at(-1)?.searchParams.get('days')).toBe('all')
  }

  for (const entry of [
    { raw: 'MID', value: 'MIDDLE', wire: 'MIDDLE', role: 'MIDDLE', label: 'Corsia centrale', games: 4 },
    { raw: '\u0085\u001c adc \u001f\u0085', value: 'BOTTOM', wire: 'BOTTOM', role: 'BOTTOM', label: 'Corsia inferiore', games: 0 },
    { raw: 'AUTO', value: 'AUTO', wire: 'AUTO', role: 'MIDDLE', label: 'Ruolo automatico', games: 4 },
    { raw: 'BOTTOM', value: 'BOTTOM', wire: 'BOTTOM', role: 'BOTTOM', label: 'Corsia inferiore', games: 0 },
  ] as const) {
    await openLink(entry.raw)
    await expect(control).toHaveValue(entry.value)
    await expect(control.locator('option:checked')).toHaveText(entry.label)
    if (entry.value === 'AUTO') await expect(control.locator('option:checked')).toHaveJSProperty('disabled', true)
    await expect(dialog.getByRole('heading', { name: `Ahri · ${entry.label}`, exact: true })).toBeVisible()
    await expect.poll(() => detailRequests.at(-1)?.searchParams.get('role')).toBe(entry.wire)
    await expect.poll(() => detailResponses.at(-1)?.context.role).toBe(entry.role)
    await expect.poll(() => detailResponses.at(-1)?.coverage.observations).toBe(entry.games)
    await expectCandidate(entry.role, entry.games)

    await control.focus()
    await control.press('Home')
    await control.press('Tab')
    await expect(control).toHaveValue('')
    await expect(control.locator('option:checked')).toHaveText('Tutti i ruoli · nessun filtro')
    await expect.poll(() => new URL(page.url()).searchParams.has('detailRole')).toBe(false)
    await expect.poll(() => detailRequests.at(-1)?.searchParams.get('role')).toBeNull()
    await expect.poll(() => detailResponses.at(-1)?.context.role).toBe('ALL')
    await expect.poll(() => detailResponses.at(-1)?.coverage.observations).toBe(6)
    await expect(dialog.getByRole('heading', { name: 'Ahri · Tutti i ruoli', exact: true })).toBeVisible()
    // The all-role context has six facts; Ahri's separate MIDDLE variant has four.
    await expectCandidate('MIDDLE', 4, 'ALL')
    expectParent()
  }
  expect(unexpectedWrites).toEqual([])
})
