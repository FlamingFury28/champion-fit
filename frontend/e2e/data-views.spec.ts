import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'

const DATA_VIEW_STORAGE_KEY = 'champion-fit:data-view:v2'

const explorer = (page: Page, id: string) => page.locator(`[data-explorer-id="${id}"]`)

async function routeFriends(page: Page) {
  let template: Record<string, unknown> | undefined
  await page.route('**/api/friends?**', async (route) => {
    const response = await route.fetch()
    const body = await response.json() as { items: Array<Record<string, unknown>> }
    template ??= body.items[0]
    if (template) {
      const items = [
        { ...template, friend_key: 'many', friend: 'MoltePartite#EUW', shared_games: 20, friend_win_rate: 40, posterior_win_rate: 45 },
        { ...template, friend_key: 'few', friend: 'PochePartite#EUW', shared_games: 6, friend_win_rate: 80, posterior_win_rate: 70 },
      ]
      const query = new URL(route.request().url()).searchParams
      const search = query.get('friend_q')?.trim().toLocaleLowerCase('it')
      body.items = items
        .filter((item) => !search || String(item.friend).toLocaleLowerCase('it').includes(search))
        .sort((left, right) => Number(right.shared_games) - Number(left.shared_games))
    }
    await route.fulfill({ response, json: body })
  })
}

async function fresh(page: Page, route: string, id: string) {
  await page.goto(route)
  await page.reload()
  const region = explorer(page, id)
  await expect(region).toBeVisible()
  await expect(page.locator('#main-content .skeleton')).toHaveCount(0)
  return region
}

async function choose(page: Page, name: 'Elenco' | 'Schede' | 'Barre' | 'Mappa' | 'Radar') {
  const controls = page.locator('.scope-bar__display-controls')
  if (await controls.getAttribute('open') === null) await controls.locator('summary').click()
  await page.getByRole('button', { name: 'Vista dati', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Visualizzazione dei dati', exact: true })
  const radio = dialog.getByRole('radio', { name: new RegExp(`^${name}\\b`) })
  await radio.check()
  await expect(radio).toBeChecked()
  await dialog.getByRole('button', { name: 'Chiudi visualizzazione dati', exact: true }).click()
  await expect(dialog).toBeHidden()
}

async function expectView(region: ReturnType<typeof explorer>, name: 'Elenco' | 'Schede' | 'Barre' | 'Mappa' | 'Radar') {
  await expect(region).toHaveAttribute('data-view', {
    Schede: 'cards',
    Barre: 'bars',
    Mappa: 'scatter',
    Elenco: 'list',
    Radar: 'radar',
  }[name])
}

async function seriousViolations(page: Page) {
  const audit = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()
  return audit.violations.filter((item) => ['critical', 'serious'].includes(item.impact ?? ''))
}

test('Compagni conserva lo stesso insieme in elenco, schede, barre e mappa', async ({ page }) => {
  await routeFriends(page)
  const region = await fresh(page, '/app/team/friends?min_games=1', 'friends-ranking')
  const count = await region.locator('.data-table-wrap tbody tr').count()
  expect(count).toBeGreaterThan(1)

  await choose(page, 'Elenco')
  await expect(region.locator('.data-table-wrap tbody tr')).toHaveCount(count)
  await choose(page, 'Schede')
  await expectView(region, 'Schede')
  await expect(region.locator('.data-explorer__cards > .data-explorer__card')).toHaveCount(count)
  await choose(page, 'Barre')
  await expectView(region, 'Barre')
  await expect(region.locator('.data-explorer__bar')).toHaveCount(count)
  await choose(page, 'Mappa')
  await expectView(region, 'Mappa')
  await expect(region.locator('.data-explorer__point')).toHaveCount(count)

  const firstPoint = region.locator('.data-explorer__point').first()
  await firstPoint.click()
  await expect(region.locator('.data-explorer__inspection')).toContainText('MoltePartite#EUW')
})

test('la vista globale persiste dopo reload e navigazione interna', async ({ page }) => {
  await routeFriends(page)
  let region = await fresh(page, '/app/team/friends?min_games=1', 'friends-ranking')
  await choose(page, 'Schede')
  await expectView(region, 'Schede')
  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), DATA_VIEW_STORAGE_KEY)).toBe(JSON.stringify({ view: 'cards' }))

  await page.reload()
  region = explorer(page, 'friends-ranking')
  await expectView(region, 'Schede')
  await page.getByRole('link', { name: 'Riepilogo', exact: true }).click()
  await page.getByRole('heading', { name: 'Riepilogo', exact: true }).waitFor()
  await page.getByLabel('Navigazione principale').getByRole('link', { name: 'Compagni', exact: true }).click()
  await expect(explorer(page, 'friends-ranking')).toHaveAttribute('data-view', 'cards')
})

test('il filtro Compagni aggiorna i dati senza perdere la vista scelta', async ({ page }) => {
  await routeFriends(page)
  const region = await fresh(page, '/app/team/friends?min_games=1', 'friends-ranking')
  await choose(page, 'Schede')
  const initial = await region.locator('.data-explorer__cards > .data-explorer__card').count()
  expect(initial).toBeGreaterThan(1)

  const candidate = (await region.locator('.data-explorer__card h3').first().innerText()).trim()
  await page.getByLabel('Nome o Riot ID', { exact: true }).fill(candidate)
  await expect(region.locator('.data-explorer__cards > .data-explorer__card')).toHaveCount(1)
  await expect(region).toHaveAttribute('data-view', 'cards')
  await expect(region.getByRole('heading', { name: candidate, exact: true })).toBeVisible()
  await expect(page.locator('.filter-count')).toHaveText('1 compagni')
})

test('le categorie applicano il fallback della vista globale senza riscriverla', async ({ page }) => {
  const region = await fresh(page, '/app/matches?section=style', 'playstyle-archetypes')
  await choose(page, 'Radar')
  await expect(region).toHaveAttribute('data-view', 'bars')
  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), DATA_VIEW_STORAGE_KEY)).toBe(JSON.stringify({ view: 'radar' }))
})

test('il piano assegna una partita per candidato e chiarisce che non prevede l’esito', async ({ page }) => {
  await page.goto('/app/fit?section=training&training=plan')
  await page.reload()
  await expect(page.getByRole('heading', { name: /prove, una partita ciascuna$/i })).toBeVisible()
  await expect(page.getByText('Nessuna stima preventiva', { exact: true })).toBeVisible()
  await expect(page.getByText(/il piano non tenta di prevederne l’esito/i)).toBeVisible()
  const rows = page.getByRole('region', { name: 'Prossime partite da provare' }).getByRole('table').locator('tbody tr')
  await expect(rows).not.toHaveCount(0)
  for (const row of await rows.all()) await expect(row.locator('td').nth(1)).toHaveText('1')
})

test('l’ordinamento Friends aggiorna le schede fuori dalla tabella', async ({ page }) => {
  await page.route('**/api/friends?**', async (route) => {
    const response = await route.fetch()
    const body = await response.json() as { items: Array<Record<string, unknown>> }
    const template = body.items[0]
    if (template) {
      body.items = [
        { ...template, friend_key: 'many', friend: 'MoltePartite#EUW', shared_games: 20, friend_win_rate: 40, posterior_win_rate: 45 },
        { ...template, friend_key: 'few', friend: 'PochePartite#EUW', shared_games: 6, friend_win_rate: 80, posterior_win_rate: 70 },
      ]
      const ascending = new URL(route.request().url()).searchParams.get('sort')?.startsWith('games:asc')
      body.items.sort((left, right) => (Number(left.shared_games) - Number(right.shared_games)) * (ascending ? 1 : -1))
    }
    await route.fulfill({ response, json: body })
  })
  const region = await fresh(page, '/app/team/friends?min_games=1', 'friends-ranking')
  await choose(page, 'Schede')
  await expect(region.locator('.data-explorer__card h3').first()).toHaveText('MoltePartite#EUW')
  await page.getByRole('combobox', { name: 'Ordine principale', exact: true }).selectOption('games:asc')
  await expect(region.locator('.data-explorer__card h3').first()).toHaveText('PochePartite#EUW')
  await expect(region).toHaveAttribute('data-view', 'cards')
})

test('un solo controllo globale aggiorna insieme le raccolte senza richieste API', async ({ page }) => {
  await page.route('**/api/matchups?**', async (route) => {
    const response = await route.fetch()
    const body = await response.json() as Record<string, unknown>
    const common = {
      icon_url: '', games: 20, positive_evidence: 10, negative_evidence: 10,
      effective_evidence: 20, effective_sample_size: 20, personal_effective_sample_size: 20,
      weighted_win_rate_against: 50, baseline_win_rate: 55, credible_lower_90: 35,
      credible_upper_90: 65, direction_confidence: 99, direction_probability: 99,
      quality_coverage: 100, recent_90d_games: 20, exposure_rate: 50, matchup_score: 1,
      reliability: 'reliable', actionable: true, prior_source: 'global', prior_games: 30,
    }
    Object.assign(body, {
      games: 20,
      games_with_opponents: 20,
      loses_to: [{ ...common, champion: 'Zed', wins_against: 5, losses_to: 15, win_rate_against: 25, posterior_win_rate: 45, posterior_lift_pp: -10, relative_delta_pp: -10, probability_worse_than_baseline: 99, probability_meaningful_disadvantage: 99, probability_meaningful_advantage: 1, recommendation: 'loses_to' }],
      beats: [{ ...common, champion: 'Annie', wins_against: 15, losses_to: 5, win_rate_against: 75, posterior_win_rate: 65, posterior_lift_pp: 10, relative_delta_pp: 10, probability_worse_than_baseline: 1, probability_meaningful_disadvantage: 1, probability_meaningful_advantage: 99, recommendation: 'beats' }],
    })
    await route.fulfill({ response, json: body })
  })
  await page.route('**/api/synergy?**', async (route) => {
    const response = await route.fetch()
    const body = await response.json() as Record<string, unknown>
    const common = {
      icon_url: '', games: 20, wins: 10, losses: 10, win_rate: 50,
      baseline_win_rate: 50, credible_lower_90: 35, credible_upper_90: 65,
      direction_confidence: 99, direction_probability: 99, effective_sample_size: 20,
      personal_effective_sample_size: 20, reliability: 'reliable', actionable: true,
      prior_source: 'global', prior_games: 30,
    }
    Object.assign(body, {
      games: 20,
      games_with_teammates: 20,
      coverage: { raw_games: 20, eligible_games: 20, analyzed_games: 20, games_with_roster: 20, roster_coverage: 100 },
      better_with: [{ ...common, champion: 'Lux', posterior_win_rate: 60, posterior_lift_pp: 10, relative_delta_pp: 10, probability_meaningful_advantage: 99, probability_meaningful_disadvantage: 1 }],
      worse_with: [{ ...common, champion: 'Garen', posterior_win_rate: 40, posterior_lift_pp: -10, relative_delta_pp: -10, probability_meaningful_advantage: 1, probability_meaningful_disadvantage: 99 }],
    })
    await route.fulfill({ response, json: body })
  })
  const cases = [
    ['/app/fit?section=matchups&relation=allies&include_exploratory=1', ['synergies-positive', 'synergies-negative']],
    ['/app/team/friends?min_games=1', ['friends-ranking']],
    ['/app/matches?section=style', ['playstyle-archetypes']],
  ] as const
  for (const [route, ids] of cases) {
    await page.goto(route)
    await page.reload()
    await expect(page.locator('#main-content .skeleton')).toHaveCount(0)
    for (const id of ids) {
      const region = explorer(page, id)
      await expect(region, `${id} deve essere disponibile nel seed E2E`).toBeVisible()
      await expect(region.locator('.data-explorer__switch')).toHaveCount(0)
      await expect(region.locator('.data-explorer__return')).toHaveCount(0)
    }
    const controls = page.locator('.scope-bar__display-controls')
    await controls.locator('summary').click()
    await expect(page.getByRole('button', { name: 'Vista dati', exact: true })).toHaveCount(1)
    await expect(controls.getByRole('button', { name: 'Vista dati', exact: true })).toBeVisible()
    await expect(controls.getByRole('button', { name: 'Aspetto', exact: true })).toBeVisible()

    if (route.includes('relation=allies')) {
      const apiRequests: string[] = []
      page.on('request', (request) => {
        const path = new URL(request.url()).pathname
        if (path.startsWith('/api/') && path !== '/api/sync-status') apiRequests.push(request.url())
      })
      await choose(page, 'Schede')
      await Promise.all(ids.map((id) => expect(explorer(page, id)).toHaveAttribute('data-view', 'cards')))
      expect(apiRequests).toEqual([])
    }
  }
})

for (const [view, className] of [['Schede', '.data-explorer__cards'], ['Barre', '.data-explorer__bars'], ['Mappa', '.data-explorer__scatter']] as const) {
  test(`Compagni ${view}: accessibile, senza overflow e con screenshot`, async ({ page }, testInfo) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.addInitScript(() => localStorage.setItem('champion-fit:appearance:v1', JSON.stringify({ theme: 'light', accent: 'mint', density: 'comfortable' })))
    await routeFriends(page)
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
      const region = await fresh(page, '/app/team/friends?min_games=1', 'friends-ranking')
      await choose(page, view)
      await expect(region.locator(className)).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
      expect(await seriousViolations(page)).toEqual([])
      await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); scrollTo(0, 0) })
      await page.screenshot({ path: testInfo.outputPath(`fit-${view.toLocaleLowerCase('it')}-${width}.png`), fullPage: true })
    }
  })
}
