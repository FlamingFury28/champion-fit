import { expect, test, type Locator } from '@playwright/test'
import type { RecommendationsResponseDto } from '../src/api/types'

const screens = [
  { id: 'friends', path: '/app/team/friends', parameters: {}, endpoint: '/api/friends', label: 'Modalità del confronto', flexLabel: 'Classificata Flex', metric: 'Partite con partecipanti' },
  { id: 'playstyles', path: '/app/matches', parameters: { section: 'style' }, endpoint: '/api/playstyles', label: 'Modalità degli stili', flexLabel: 'Classificata Flex', metric: 'Partite uniche' },
  { id: 'synergy', path: '/app/fit', parameters: { section: 'matchups', relation: 'allies', include_exploratory: '1' }, endpoint: '/api/synergy', label: 'Modalità', flexLabel: 'Classificata · flessibile', metric: 'Partite analizzate' },
] as const

interface QueueResponse {
  context?: { queue: string; observations: number }
  games?: number
  coverage?: { analyzed_games: number }
}

for (const screen of screens) {
  test(`modalità nei link: ${screen.id} allinea gli alias Flex e conserva la policy degli invalidi @smoke`, async ({ page }) => {
    // Each link is loaded and fully refreshed before the keyboard recovery.
    test.setTimeout(60_000)
    const requests: URL[] = []
    const responses: { status: number; body: QueueResponse }[] = []
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
      // Use the complete payload from the real synthetic fixture. The separate
      // SQLite/PG HTTP matrix establishes these aliases and error policies.
      const response = await route.fetch()
      const body = await response.json() as QueueResponse
      responses.push({ status: response.status(), body })
      await route.fulfill({ response, json: body })
    })
    await page.addInitScript(() => {
      localStorage.setItem('champion-fit-profile-accounts', JSON.stringify(['Alpha#EUW', 'Beta#EUW']))
      localStorage.setItem('champion-fit:data-view:v2', JSON.stringify({ view: 'list' }))
    })
    const control = page.getByRole('combobox', { name: screen.label, exact: true })
    const metric = page.locator('.metric-card').filter({ has: page.getByText(screen.metric, { exact: true }) })
    const waitForResults = async () => {
      if (responses.at(-1)?.status === 400) await expect(page.getByRole('alert')).toContainText('Modalità non valida')
      else await expect(metric).toBeVisible()
    }
    const openLink = async (queue: string) => {
      const parameters = new URLSearchParams({ ...screen.parameters, queue, role: 'ALL', days: 'all', min_games: '1' })
      const before = responses.length
      await page.goto(`${screen.path}?${parameters}`)
      await expect(control).toBeVisible()
      await expect.poll(() => responses.length).toBeGreaterThan(before)
      await waitForResults()
      const beforeReload = responses.length
      await page.reload()
      await expect(control).toBeVisible()
      await expect.poll(() => responses.length).toBeGreaterThan(beforeReload)
      await waitForResults()
      expect(new URL(page.url()).searchParams.get('queue')).toBe(queue)
    }
    const expectGames = async (games: number) => {
      await expect.poll(() => responses.at(-1)?.status).toBe(200)
      await expect.poll(() => responses.at(-1)?.body.context?.observations).toBe(games)
      if (screen.id === 'synergy') {
        // Account coverage remains global; games/detail describe this queue.
        await expect.poll(() => responses.at(-1)?.body.games).toBe(games)
        await expect.poll(() => responses.at(-1)?.body.coverage?.analyzed_games).toBe(6)
        await expect(metric.locator('strong')).toHaveText('6')
        await expect(metric.locator('small')).toHaveText(`${games} con il filtro sul campione`)
      } else {
        await expect(metric.locator('strong')).toHaveText(String(games))
      }
      if (screen.id === 'friends') {
        await expect(page.getByRole('region', { name: 'Classifica dei compagni di squadra', exact: true }).locator('tbody tr')).toHaveCount(games)
      }
      expect(requests.at(-1)?.searchParams.getAll('account')).toEqual(['Alpha#EUW', 'Beta#EUW'])
      expect(requests.at(-1)?.searchParams.get('role')).toBe('ALL')
      expect(requests.at(-1)?.searchParams.get('days')).toBe('all')
      await expect(page.getByRole('alert')).toHaveCount(0)
    }
    const chooseAll = async (select: Locator) => {
      await select.focus()
      await select.press('Home')
      await select.press('Tab')
      await expect(select).toHaveValue('all')
      await expect(select.locator('option:checked')).toHaveText('Tutte le modalità · aggregato')
      await expect.poll(() => requests.at(-1)?.searchParams.get('queue')).toBe('all')
      await expect.poll(() => responses.at(-1)?.body.context?.queue).toBe('all')
      await expectGames(6)
    }

    for (const alias of ['RANKED_FLEX_SR', ' 440 ', '\u0085\u001c440\u001f\u0085']) {
      await openLink(alias)
      await expect(control).toHaveValue('440')
      await expect(control.locator('option:checked')).toHaveText(screen.flexLabel)
      await expect(control.locator('option[value="440"]')).toHaveCount(1)
      await expect.poll(() => requests.at(-1)?.searchParams.get('queue')).toBe('440')
      await expect.poll(() => responses.at(-1)?.body.context?.queue).toBe('440')
      await expectGames(2)
      await chooseAll(control)
    }
    const invalidQueues = ['unknown', '\ufeff440\ufeff', 'QUEUEQUEUE440']
    for (const invalid of invalidQueues) {
      await openLink(invalid)
      await expect.poll(() => responses.at(-1)?.status).toBe(400)
      await expect(page.getByRole('alert')).toContainText('Modalità non valida')
      await expect(metric).toHaveCount(0)
      await chooseAll(control)
    }
    expect(unexpectedWrites).toEqual([])
  })
}

const comparisonScreens = [
  { id: 'rendimento', section: 'best', relation: '', endpoint: '/api/champions', results: 'Classifica del rendimento storico', defaultQueue: '420', defaultGames: 4 },
  { id: 'piano competitivo', section: 'tournament', relation: '', endpoint: '/api/training-plan', results: 'Piano per identificare il campione migliore', defaultQueue: '420', defaultGames: 4 },
  { id: 'avversari', section: 'matchups', relation: 'enemies', endpoint: '/api/matchups', results: 'Risultati dei confronti con gli avversari', defaultQueue: 'all', defaultGames: 6 },
] as const

interface ComparisonQueueResponse extends QueueResponse {
  items?: { champion: string; role: string; unique_games: number }[]
}

for (const screen of comparisonScreens) {
  test(`modalita confronto nei link: ${screen.id} mostra Flex, rispetta vuoto e assente e recupera da invalidi @smoke`, async ({ page }) => {
    test.setTimeout(60_000)
    const requests: URL[] = []
    const responses: { status: number; body: ComparisonQueueResponse }[] = []
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
      const body = await response.json() as ComparisonQueueResponse
      responses.push({ status: response.status(), body })
      await route.fulfill({ response, json: body })
    })
    await page.addInitScript(() => {
      localStorage.setItem('champion-fit-profile-accounts', JSON.stringify(['Alpha#EUW', 'Beta#EUW']))
    })
    const control = page.getByRole('combobox', { name: 'Modalità', exact: true })
    const results = page.getByRole('region', { name: screen.results, exact: true })
    const waitReady = async () => {
      if (responses.at(-1)?.status === 400) await expect(page.getByRole('alert')).toContainText('Modalità non valida')
      else await expect(results).toBeVisible()
    }
    const openLink = async (queue: string | null) => {
      const parameters = new URLSearchParams({ section: screen.section, role: 'ALL', days: 'all', budget: '400' })
      if (screen.relation) parameters.set('relation', screen.relation)
      if (queue !== null) parameters.set('queue', queue)
      const before = responses.length
      await page.goto(`/app/fit?${parameters}`)
      await expect(control).toBeVisible()
      await expect.poll(() => responses.length).toBeGreaterThan(before)
      await waitReady()
      const beforeReload = responses.length
      await page.reload()
      await expect(control).toBeVisible()
      await expect.poll(() => responses.length).toBeGreaterThan(beforeReload)
      await waitReady()
      expect(new URL(page.url()).searchParams.get('queue')).toBe(queue)
    }
    const expectContext = async (queue: string, games: number) => {
      await expect.poll(() => responses.at(-1)?.status).toBe(200)
      await expect.poll(() => responses.at(-1)?.body.context?.queue).toBe(queue)
      await expect.poll(() => responses.at(-1)?.body.context?.observations).toBe(games)
      await expect(results).toBeVisible()
      expect(requests.at(-1)?.searchParams.getAll('account')).toEqual(['Alpha#EUW', 'Beta#EUW'])
      expect(requests.at(-1)?.searchParams.get('role')).toBe('ALL')
      expect(requests.at(-1)?.searchParams.get('days')).toBe('all')
      if (screen.id === 'avversari') {
        expect(requests.at(-1)?.searchParams.get('champion')).toBe('ALL')
        await expect.poll(() => responses.at(-1)?.body.games).toBe(games)
        await expect(results.locator('.metric-card').filter({ has: page.getByText('Partite personali nel contesto', { exact: true }) }).locator('strong')).toHaveText(String(games))
      } else {
        const label = queue === '440' ? 'Classificata · flessibile' : 'Classificata · Solo/Duo'
        await expect(page.getByRole('heading', { name: `Tutti i ruoli · ${label}`, exact: true })).toBeVisible()
        await expect(results.locator('tbody tr')).toHaveCount(responses.at(-1)?.body.items?.length ?? 0)
        for (const item of responses.at(-1)?.body.items ?? []) {
          await expect(results.locator('tbody th').filter({ hasText: item.champion })).toHaveCount(1)
        }
      }
      await expect(page.getByRole('alert')).toHaveCount(0)
    }
    const chooseDefault = async () => {
      await control.focus()
      await control.press('Home')
      await control.press('Tab')
      const value = screen.id === 'avversari' ? 'all' : ''
      await expect(control).toHaveValue(value)
      await expect(control.locator('option:checked')).toHaveText(screen.id === 'avversari' ? 'Tutte le modalità' : 'Predefinita')
      // Enemies writes the aggregation sentinel; competitive pages remove it.
      await expect.poll(() => new URL(page.url()).searchParams.get('queue')).toBe(screen.id === 'avversari' ? 'all' : null)
      await expect.poll(() => requests.at(-1)?.searchParams.get('queue')).toBe(screen.id === 'avversari' ? 'all' : null)
      await expectContext(screen.defaultQueue, screen.defaultGames)
    }

    for (const alias of ['RANKED_FLEX_SR', '\u0085\u001c440\u001f\u0085']) {
      await openLink(alias)
      await expect(control).toHaveValue('440')
      await expect(control.locator('option:checked')).toHaveText('Classificata · flessibile')
      await expect(control.locator('option[value="440"]')).toHaveCount(1)
      await expect.poll(() => requests.at(-1)?.searchParams.get('queue')).toBe('440')
      await expectContext('440', 2)
      await chooseDefault()
    }
    for (const queue of ['', null]) {
      await openLink(queue)
      const emptyEnemies = screen.id === 'avversari' && queue === ''
      await expect(control).toHaveValue(emptyEnemies ? '' : screen.id === 'avversari' ? 'all' : '')
      await expect(control.locator('option:checked')).toHaveText(emptyEnemies ? 'Modalità predefinita' : screen.id === 'avversari' ? 'Tutte le modalità' : 'Predefinita')
      if (emptyEnemies) await expect(control.locator('option:checked')).toHaveJSProperty('disabled', true)
      await expect.poll(() => requests.at(-1)?.searchParams.get('queue')).toBe(screen.id === 'avversari' && queue === null ? 'all' : null)
      await expectContext(emptyEnemies ? '420' : screen.defaultQueue, emptyEnemies ? 4 : screen.defaultGames)
      if (emptyEnemies) await chooseDefault()
    }
    for (const invalid of ['unknown', '\ufeff440\ufeff', 'QUEUEQUEUE440']) {
      await openLink(invalid)
      await expect.poll(() => responses.at(-1)?.status).toBe(400)
      await expect(page.getByRole('alert')).toContainText('Modalità non valida')
      await expect(control.locator('option:checked')).toHaveJSProperty('disabled', true)
      await expect(results).toHaveCount(0)
      await chooseDefault()
    }
    expect(unexpectedWrites).toEqual([])
  })
}

test('coda preferenze nei link: alias, automatico e aggregato restano distinti e gli invalidi sono recuperabili @smoke', async ({ page }) => {
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
  const control = page.getByRole('combobox', { name: 'Coda', exact: true })
  const results = page.getByRole('region', { name: 'Scelte familiari e preferite', exact: true })
  const expectScope = () => {
    const params = new URL(page.url()).searchParams
    expect(params.get('section')).toBe('choices')
    expect(params.get('view')).toBe('known')
    expect(params.get('role')).toBe('ALL')
    expect(params.get('days')).toBe('all')
    expect(requests.at(-1)?.searchParams.getAll('account')).toEqual(['Alpha#EUW', 'Beta#EUW'])
    expect(requests.at(-1)?.searchParams.get('role')).toBeNull()
    expect(requests.at(-1)?.searchParams.get('days')).toBe('all')
  }
  const waitReady = async () => {
    await expect(control).toBeVisible()
    await expect(page.getByLabel('Caricamento dei suggerimenti', { exact: true })).toHaveCount(0)
    if (responses.at(-1)?.status === 400) {
      await expect(page.getByRole('alert')).toContainText('Scegli una modalità concreta')
      await expect(results).toHaveCount(0)
    } else {
      await expect(results).toBeVisible()
      await expect(page.getByRole('alert')).toHaveCount(0)
    }
  }
  const openLink = async (queue: string | null) => {
    const params = new URLSearchParams({ section: 'choices', view: 'known', role: 'ALL', days: 'all' })
    if (queue !== null) params.set('queue', queue)
    const before = responses.length
    await page.goto(`/app/fit?${params}`)
    await expect.poll(() => responses.length).toBeGreaterThan(before)
    await waitReady()
    expect(new URL(page.url()).searchParams.get('queue')).toBe(queue)
    expectScope()
    const beforeReload = responses.length
    await page.reload()
    await expect.poll(() => responses.length).toBeGreaterThan(beforeReload)
    await waitReady()
    expect(new URL(page.url()).searchParams.get('queue')).toBe(queue)
    expectScope()
  }
  const expectContext = async (queue: string, games: number) => {
    await expect.poll(() => responses.at(-1)?.status).toBe(200)
    await expect.poll(() => responses.at(-1)?.data?.context.queue).toBe(queue)
    await expect.poll(() => responses.at(-1)?.data?.context.role).toBe('ALL')
    await expect.poll(() => responses.at(-1)?.data?.coverage.games).toBe(games)
    await expect.poll(() => responses.at(-1)?.data?.coverage.observations).toBe(games)
    await expect(page.getByText(`${games} partite uniche e ${games} osservazioni su`, { exact: false })).toBeVisible()
    await expect(results).toBeVisible()
    await expect(results.locator('.recommendation-card')).toHaveCount(responses.at(-1)?.data?.known.length ?? 0)
    // A queue with no historical observations may still have discoveries.
    await expect(page.getByRole('button', { name: `Da scoprire · ${responses.at(-1)?.data?.discover.length ?? 0} mostrate`, exact: true })).toBeVisible()
    await expect(page.getByRole('alert')).toHaveCount(0)
    expectScope()
  }
  const clearToDefault = async () => {
    const before = responses.length
    await control.focus()
    await control.press('Home')
    await control.press('Tab')
    await expect(control).toHaveValue('')
    await expect(control.locator('option:checked')).toHaveText('Predefinita')
    await expect.poll(() => new URL(page.url()).searchParams.has('queue')).toBe(false)
    await expect.poll(() => requests.at(-1)?.searchParams.get('queue')).toBeNull()
    await expect.poll(() => responses.length).toBeGreaterThan(before)
    await expectContext('all', 6)
  }

  await openLink(null)
  await expect(control).toHaveValue('')
  await expect(control.locator('option:checked')).toHaveText('Predefinita')
  await expectContext('all', 6)
  for (const alias of ['RANKED_FLEX_SR', '\u0085\u001c440\u001f\u0085']) {
    await openLink(alias)
    await expect(control).toHaveValue('440')
    await expect(control.locator('option:checked')).toHaveText('Classificata · flessibile')
    await expect.poll(() => requests.at(-1)?.searchParams.get('queue')).toBe('440')
    await expectContext('440', 2)
    await clearToDefault()
  }
  for (const automatic of ['auto', '\u0085 \u001c']) {
    await openLink(automatic)
    await expect(control).toHaveValue('auto')
    await expect(control.locator('option:checked')).toHaveText('Coda automatica')
    await expect(control.locator('option:checked')).toHaveJSProperty('disabled', true)
    await expect.poll(() => requests.at(-1)?.searchParams.get('queue')).toBe('auto')
    await expectContext('420', 4)
    await clearToDefault()
  }
  for (const all of ['ALL', '\u0085 all \u001c']) {
    await openLink(all)
    await expect(control).toHaveValue('all')
    await expect(control.locator('option:checked')).toHaveText('Tutte le code')
    await expect.poll(() => requests.at(-1)?.searchParams.get('queue')).toBe('all')
    await expectContext('all', 6)
    await clearToDefault()
  }
  await openLink('999')
  await expect(control).toHaveValue('999')
  await expect(control.locator('option:checked')).toHaveText('Coda del link')
  await expect(control.locator('option:checked')).toHaveJSProperty('disabled', true)
  await expectContext('999', 0)
  await clearToDefault()
  for (const invalid of ['unknown', '\ufeff440\ufeff', 'QUEUEALL', 'QUEUEAUTO', 'QUEUEQUEUE440']) {
    await openLink(invalid)
    await expect.poll(() => responses.at(-1)?.status).toBe(400)
    expect(responses.at(-1)?.error).toBe('Scegli una modalità concreta')
    expect(requests.at(-1)?.searchParams.get('queue')).toBe(invalid)
    await expect(control.locator('option:checked')).toHaveText('Coda del link')
    await expect(control.locator('option:checked')).toHaveJSProperty('disabled', true)
    await expect(page.getByRole('alert')).toBeVisible()
    await expect(results).toHaveCount(0)
    await clearToDefault()
  }
  expect(unexpectedWrites).toEqual([])
})


const sheetQueueSources = [
  { section: 'choices', training: '', loading: 'Caricamento dei suggerimenti', results: 'Scelte familiari e preferite' },
  { section: 'training', training: 'discover', loading: 'Caricamento delle scoperte', results: '' },
  { section: 'training', training: 'plan', loading: 'Caricamento del piano di prove', results: 'Piano di prove' },
] as const

test('coda della scheda: i tre elenchi conservano la coda risolta senza cambiare il periodo @smoke', async ({ page }) => {
  test.setTimeout(90_000)
  const responses: { url: URL; body: RecommendationsResponseDto }[] = []
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
    const response = await route.fetch()
    expect(response.status()).toBe(200)
    const body = await response.json() as RecommendationsResponseDto
    responses.push({ url: new URL(route.request().url()), body })
    await route.fulfill({ response, json: body })
  })
  await page.addInitScript(() => localStorage.setItem('champion-fit-profile-accounts', JSON.stringify(['Alpha#EUW', 'Beta#EUW'])))
  const sourceResponses = () => responses.filter((entry) => !entry.url.searchParams.has('champion'))
  const detailResponses = () => responses.filter((entry) => entry.url.searchParams.has('champion'))

  for (const source of sheetQueueSources) {
    for (const filter of [
      { queue: 'auto', days: 'all', resolved: '420', observations: 4 },
      { queue: 'all', days: null, resolved: 'all', observations: 6 },
    ]) {
      const params = new URLSearchParams({ section: source.section, role: 'ALL', queue: filter.queue, view: 'known' })
      if (source.training) params.set('training', source.training)
      if (filter.days !== null) params.set('days', filter.days)
      const expectSource = async (before: number) => {
        await expect.poll(() => sourceResponses().length).toBe(before + 1)
        await expect(page.getByLabel(source.loading, { exact: true })).toHaveCount(0)
        if (source.results) await expect(page.getByRole('region', { name: source.results, exact: true })).toBeVisible()
        else await expect(page.getByRole('heading', { name: 'Scelte vicine ai tuoi gusti', exact: true })).toBeVisible()
        const latest = sourceResponses().at(-1)
        expect(latest?.url.searchParams.getAll('account')).toEqual(['Alpha#EUW', 'Beta#EUW'])
        expect(latest?.url.searchParams.get('role')).toBeNull()
        expect(latest?.url.searchParams.get('queue')).toBe(filter.queue)
        expect(latest?.url.searchParams.get('days')).toBe(filter.days)
        expect(latest?.body.context.role).toBe('ALL')
        expect(latest?.body.context.queue).toBe(filter.resolved)
        expect(latest?.body.context.period).toEqual({ value: 0, unit: 'days' })
        expect(latest?.body.coverage.observations).toBe(filter.observations)
        expect(Object.fromEntries(new URL(page.url()).searchParams)).toEqual(Object.fromEntries(params))
        await expect(page.getByRole('alert')).toHaveCount(0)
      }
      const beforeGoto = sourceResponses().length
      await page.goto(`/app/fit?${params}`)
      await expectSource(beforeGoto)
      const beforeReload = sourceResponses().length
      await page.reload()
      await expectSource(beforeReload)
      const data = sourceResponses().at(-1)?.body
      if (!data) throw new Error('La fixture deve restituire il contesto della lista.')
      const item = source.section === 'choices'
        ? data.known.find((candidate) => candidate.champion === 'Lux' && candidate.role === 'SUPPORT')
        : source.training === 'plan' ? data.trial_plan.items[0] : data.discover[0]
      if (!item) throw new Error('La fixture reale deve contenere un candidato apribile dalla lista.')
      const sourceCandidate = [...data.known, ...data.discover].find((candidate) => candidate.champion === item.champion && candidate.role === item.role)
      const expectedGames = sourceCandidate?.performance?.games ?? 0
      const link = source.training === 'plan'
        ? page.getByRole('region', { name: 'Prossime partite da provare', exact: true }).locator('tbody tr')
          .filter({ has: page.locator('th').filter({ hasText: item.champion }) }).getByRole('link', { name: 'Apri', exact: true })
        : page.locator('.recommendation-card').filter({
          has: page.locator('.answer-ranking__identity strong').filter({ hasText: new RegExp(`^${sourceCandidate?.name || item.champion}$`) }),
        }).getByRole('link', { name: 'Apri la scheda', exact: true })
      const href = await link.getAttribute('href')
      if (!href) throw new Error('Il candidato deve avere il collegamento alla propria scheda.')
      const expectedParams = new URLSearchParams(params)
      expectedParams.set('detail', item.champion)
      expectedParams.set('detailRole', item.role)
      expectedParams.set('detailQueue', data.context.queue)
      expect(Object.fromEntries(new URL(href, page.url()).searchParams)).toEqual(Object.fromEntries(expectedParams))
      const beforeClickSources = sourceResponses().length
      const beforeClickDetails = detailResponses().length
      await link.click()
      const dialog = page.getByRole('dialog', { name: `Scheda di ${item.champion}`, exact: true })
      const expectDetail = async (before: number) => {
        await expect.poll(() => detailResponses().length).toBe(before + 1)
        await expect(dialog.locator('.observed-recommendation')).toHaveCount(1)
        const latest = detailResponses().at(-1)
        expect(latest?.url.searchParams.getAll('account')).toEqual(['Alpha#EUW', 'Beta#EUW'])
        expect(latest?.url.searchParams.get('champion')).toBe(item.champion)
        expect(latest?.url.searchParams.get('role')).toBe(item.role)
        expect(latest?.url.searchParams.get('queue')).toBe(data.context.queue)
        expect(latest?.url.searchParams.get('days')).toBe(filter.days)
        expect(latest?.body.context.role).toBe(item.role)
        expect(latest?.body.context.queue).toBe(data.context.queue)
        expect(latest?.body.context.period).toEqual(data.context.period)
        expect(latest?.body.candidate?.champion).toBe(item.champion)
        expect(latest?.body.candidate?.role).toBe(item.role)
        if (sourceCandidate?.performance) {
          expect(latest?.body.candidate?.performance?.games).toBe(expectedGames)
        } else {
          expect(latest?.body.candidate?.performance).toBeNull()
        }
        expect(Object.fromEntries(new URL(page.url()).searchParams)).toEqual(Object.fromEntries(expectedParams))
        expect(new URL(page.url()).searchParams.has('detailDays')).toBe(false)
        await expect(page.getByRole('alert')).toHaveCount(0)
      }
      await expectDetail(beforeClickDetails)
      expect(sourceResponses()).toHaveLength(beforeClickSources)
      const beforeSheetReloadSources = sourceResponses().length
      const beforeSheetReloadDetails = detailResponses().length
      await page.reload()
      await expect.poll(() => sourceResponses().length).toBe(beforeSheetReloadSources + 1)
      await expectDetail(beforeSheetReloadDetails)
      const beforeCloseSources = sourceResponses().length
      await dialog.getByRole('button', { name: 'Chiudi', exact: true }).click()
      await expect(dialog).toHaveCount(0)
      expect(Object.fromEntries(new URL(page.url()).searchParams)).toEqual(Object.fromEntries(params))
      expect(sourceResponses()).toHaveLength(beforeCloseSources)
    }
  }
  expect(unexpectedWrites).toEqual([])
  expect(pageErrors).toEqual([])
})


test('contesto della scheda nei confronti: conserva modalita e periodo effettivi nella storia @smoke', async ({ page }) => {
  test.setTimeout(60_000)
  const sourceResponses: { url: URL; body: {
    games: number
    available_champions: { champion: string; games: number }[]
    context: { queue: string; days: string | number; role: string; observations: number }
  } }[] = []
  const detailResponses: { url: URL; body: RecommendationsResponseDto }[] = []
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
  await page.route('**/api/matchups?**', async (route) => {
    const response = await route.fetch()
    expect(response.status()).toBe(200)
    const body = await response.json() as typeof sourceResponses[number]['body']
    sourceResponses.push({ url: new URL(route.request().url()), body })
    await route.fulfill({ response, json: body })
  })
  await page.route('**/api/recommendations?**', async (route) => {
    const response = await route.fetch()
    expect(response.status()).toBe(200)
    const body = await response.json() as RecommendationsResponseDto
    detailResponses.push({ url: new URL(route.request().url()), body })
    await route.fulfill({ response, json: body })
  })
  await page.addInitScript(() => localStorage.setItem('champion-fit-profile-accounts', JSON.stringify(['Alpha#EUW', 'Beta#EUW'])))
  for (const rawDays of [null, '']) {
    const parent = new URLSearchParams({ section: 'matchups', relation: 'enemies', role: 'MIDDLE', search: ' keep ', budget: '1000', view: 'known' })
    if (rawDays !== null) parent.set('days', rawDays)
    const expectedDays = rawDays === null ? 'all' : '180'
    const selector = page.getByRole('combobox', { name: 'Che campione vuoi giocare?', exact: true })
    const sourceMetric = page.locator('.metric-card').filter({ has: page.getByText('Partite personali nel contesto', { exact: true }) })
    const expectParent = async () => {
      await expect.poll(() => Object.fromEntries(new URL(page.url()).searchParams)).toEqual(Object.fromEntries(parent))
      await expect(selector).toBeEnabled()
      await expect(page.getByRole('combobox', { name: 'Modalità', exact: true })).toHaveValue('all')
      await expect(page.getByRole('combobox', { name: 'Periodo', exact: true })).toHaveValue(rawDays ?? 'all')
      const source = sourceResponses.at(-1)
      expect(source?.url.searchParams.get('queue')).toBe('all')
      expect(source?.url.searchParams.get('days')).toBe(rawDays === null ? 'all' : null)
      expect(source?.url.searchParams.getAll('account')).toEqual(['Alpha#EUW', 'Beta#EUW'])
      expect(source?.body.context.queue).toBe('all')
      expect(String(source?.body.context.days)).toBe(expectedDays)
      expect(source?.body.context.role).toBe('MIDDLE')
      expect(source?.body.context.observations).toBe(4)
      await expect(sourceMetric.locator('strong')).toHaveText('4')
    }
    const beforeGotoSources = sourceResponses.length
    await page.goto(`/app/fit?${parent}`)
    await expect.poll(() => sourceResponses.length).toBe(beforeGotoSources + 1)
    await expectParent()
    await page.reload()
    await expect.poll(() => sourceResponses.length).toBe(beforeGotoSources + 2)
    await expectParent()
    const source = sourceResponses.at(-1)!.body
    const champion = source.available_champions.find((item) => item.champion === 'Ahri')
    if (!champion) throw new Error('La fixture reale deve rendere Ahri selezionabile nel ruolo centrale.')
    const expectedGames = champion.games
    const expectedParams = new URLSearchParams(parent)
    expectedParams.set('detail', champion.champion)
    expectedParams.set('detailRole', source.context.role)
    expectedParams.set('detailQueue', source.context.queue)
    expectedParams.set('detailDays', String(source.context.days))
    const beforeOpenDetails = detailResponses.length
    await selector.selectOption(champion.champion)
    const dialog = page.getByRole('dialog', { name: 'Scheda di Ahri', exact: true })
    const expectDetail = async () => {
      await expect(dialog).toBeVisible()
      const region = dialog.getByRole('region', { name: 'Scheda di Ahri · Corsia centrale', exact: true })
      await expect(region).toBeVisible()
      await expect(region.locator('.metric-card').filter({ has: page.getByText('Partite uniche', { exact: true }) }).locator('strong')).toHaveText(String(expectedGames))
      await expect.poll(() => Object.fromEntries(new URL(page.url()).searchParams)).toEqual(Object.fromEntries(expectedParams))
      const detail = detailResponses.at(-1)
      expect(detail?.url.searchParams.get('champion')).toBe(champion.champion)
      expect(detail?.url.searchParams.get('role')).toBe(source.context.role)
      expect(detail?.url.searchParams.get('queue')).toBe(source.context.queue)
      expect(detail?.url.searchParams.get('days')).toBe(String(source.context.days))
      expect(detail?.url.searchParams.getAll('account')).toEqual(['Alpha#EUW', 'Beta#EUW'])
      expect(detail?.body.context.queue).toBe(source.context.queue)
      expect(detail?.body.context.period).toEqual({ unit: 'days', value: expectedDays === 'all' ? 0 : Number(expectedDays) })
      expect(detail?.body.candidate?.performance?.games).toBe(expectedGames)
      await expect(page.getByRole('alert')).toHaveCount(0)
    }
    await expect.poll(() => detailResponses.length).toBe(beforeOpenDetails + 1)
    await expectDetail()
    await page.goBack()
    await expect(dialog).toHaveCount(0)
    await expectParent()
    await page.goForward()
    await expectDetail()
    await dialog.getByRole('button', { name: 'Chiudi', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expectParent()
    await page.goForward()
    await expectDetail()
    const beforeReloadSource = sourceResponses.length
    const beforeReloadDetail = detailResponses.length
    await page.reload()
    await expect.poll(() => sourceResponses.length).toBe(beforeReloadSource + 1)
    await expect.poll(() => detailResponses.length).toBe(beforeReloadDetail + 1)
    await expectDetail()
    await dialog.getByRole('button', { name: 'Chiudi', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expectParent()
  }
  expect(unexpectedWrites).toEqual([])
  expect(pageErrors).toEqual([])
})
