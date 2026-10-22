import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.route('https://ddragon.leagueoflegends.com/**', (route) => route.abort())
  await page.emulateMedia({ reducedMotion: 'reduce' })
})

test('navigazione principale, scheda condivisibile e ritorno ai filtri @smoke', async ({ page }) => {
  await page.goto('/app/fit?role=MIDDLE&search=Ahri')
  await page.reload()
  const viewportWidth = page.viewportSize()?.width ?? 1440
  const expectedLinks = ['Riepilogo', 'Campioni', 'Le mie partite', 'Compagni', 'Algoritmi']
  if (viewportWidth > 1180) {
    const navigation = page.getByRole('navigation', { name: 'Navigazione principale' })
    await expect(navigation.getByRole('link')).toHaveText(['Riepilogo', 'Campioni', 'Le mie partite', 'Compagni', 'Algoritmi'])
    await expect(navigation.getByRole('link', { name: 'Campioni', exact: true })).toHaveAttribute('aria-current', 'page')
  } else if (viewportWidth > 760) {
    await page.getByRole('button', { name: 'Apri il menu', exact: true }).click()
    const menu = page.getByRole('dialog', { name: 'Esplora Champion Fit', exact: true })
    const navigation = menu.getByRole('navigation', { name: 'Navigazione principale' })
    await expect(navigation.getByRole('link')).toHaveText(expectedLinks)
    await expect(navigation.getByRole('link', { name: 'Campioni', exact: true })).toHaveAttribute('aria-current', 'page')
    await menu.getByRole('button', { name: 'Chiudi', exact: true }).click()
    await expect(menu).toBeHidden()
  }
  const openSheet = page.locator('#main-content a[href*="detail=Ahri"]').first()
  await expect(openSheet).toBeVisible()
  await openSheet.click()
  const sheet = page.getByRole('dialog', { name: 'Scheda di Ahri', exact: true })
  await expect(sheet).toBeVisible()
  await expect(page).toHaveURL(/detail=Ahri/)
  await page.reload()
  await expect(sheet).toBeVisible()
  await expect(sheet.getByText('Risultati, consiglio e confronti.', { exact: false })).toBeVisible()
  await sheet.getByRole('button', { name: 'Chiudi', exact: true }).click()
  await expect(sheet).toBeHidden()
  await expect(page).toHaveURL(/role=MIDDLE/)
  await expect(page).toHaveURL(/search=Ahri/)
  expect(new URL(page.url()).searchParams.has('detail')).toBe(false)
  await expect(page.getByRole('heading', { level: 1, name: 'Campioni', exact: true })).toBeVisible()
})

test('scheda: Indietro e Avanti ripristinano lista e campione', async ({ page }) => {
  await page.goto('/app/fit?search=Ahri')
  await page.reload()
  await page.locator('#main-content a[href*="detail=Ahri"]').first().click()
  await expect(page.getByRole('dialog', { name: 'Scheda di Ahri' })).toBeVisible()
  await page.goBack()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page).toHaveURL(/search=Ahri/)
  await page.goForward()
  await expect(page.getByRole('dialog', { name: 'Scheda di Ahri' })).toBeVisible()
})

test('chiudere la scheda dopo refresh non aggiunge una lista duplicata alla cronologia', async ({ page }) => {
  await page.goto('/app/overview')
  await page.reload()
  await page.getByRole('navigation', { name: 'Navigazione principale' }).getByRole('link', { name: 'Campioni', exact: true }).click()
  await page.locator('#main-content a[href*="detail=Ahri"]').first().click()
  await page.reload()
  const sheet = page.getByRole('dialog', { name: 'Scheda di Ahri' })
  await sheet.getByRole('button', { name: 'Chiudi', exact: true }).click()
  await expect(sheet).toBeHidden()
  await page.goBack()
  await expect(page).toHaveURL(/\/app\/overview$/)
})

test('un ruolo nei confronti non riporta alle scelte quando cambia', async ({ page }) => {
  await page.goto('/app/champions?role=MIDDLE')
  await page.reload()
  await expect(page).toHaveURL(/section=matchups/)
  await page.getByRole('combobox', { name: 'Ruolo', exact: true }).selectOption('TOP')
  await expect(page).toHaveURL(/section=matchups/)
  await expect(page).toHaveURL(/role=TOP/)
  await expect(page.getByRole('heading', { name: 'Avversari e ban', exact: true })).toBeVisible()
  await page.getByRole('link', { name: 'Campioni alleati', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Con quali campioni alleati rendi meglio?' })).toBeVisible()
  await expect(page.getByText('Questi sono i campioni della tua squadra, non le persone con cui giochi.', { exact: false })).toBeVisible()
})

test('le nuove aree sono leggibili e accessibili dopo refresh', async ({ page, browserName }, testInfo) => {
  test.skip(browserName !== 'chromium', 'Ispezione completa una volta su Chromium')
  const routes = [
    ['riepilogo', '/app/overview'],
    ['campioni', '/app/fit'],
    ['partite', '/app/matches'],
    ['compagni', '/app/team/friends'],
  ] as const
  for (const [name, route] of routes) {
    await page.goto(route)
    await page.reload()
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    await expect(page.locator('#main-content .skeleton')).toHaveCount(0)
    await page.evaluate(() => document.fonts.ready)
    await page.screenshot({ path: testInfo.outputPath(`${name}-desktop.png`), fullPage: true })
    const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()
    expect(result.violations.filter((item) => ['serious', 'critical'].includes(item.impact ?? ''))).toEqual([])
    await page.setViewportSize({ width: 390, height: 844 })
    await page.reload()
    await expect(page.locator('#main-content .skeleton')).toHaveCount(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath(`${name}-mobile.png`), fullPage: true })
    await page.setViewportSize({ width: 1440, height: 900 })
  }
})


type ScoutTagRecommendations = import('../src/api/types').RecommendationsResponseDto

test('tag delle scoperte: i nomi ereditati restano testo e conservano il contesto @smoke', async ({ page }) => {
  test.setTimeout(60_000)
  const requests: URL[] = []
  const responses: ScoutTagRecommendations[] = []
  const unexpectedWrites: string[] = []
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
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
    const body = await response.json() as ScoutTagRecommendations
    responses.push(body)
    await route.fulfill({ response, json: body })
  })
  await page.addInitScript(() => localStorage.setItem('champion-fit-profile-accounts', JSON.stringify(['Alpha#EUW', 'Beta#EUW'])))
  const characteristic = page.getByRole('combobox', { name: 'Caratteristica', exact: true })
  const expectRequestContext = () => {
    const latest = requests.at(-1)
    expect(latest?.searchParams.getAll('account')).toEqual(['Alpha#EUW', 'Beta#EUW'])
    expect(latest?.searchParams.get('role')).toBeNull()
    expect(latest?.searchParams.get('queue')).toBe('440')
    expect(latest?.searchParams.get('days')).toBe('all')
    for (const local of ['tag', 'category', 'search', 'minSimilarity']) expect(latest?.searchParams.has(local)).toBe(false)
    expect(responses.at(-1)?.context.role).toBe('ALL')
    expect(responses.at(-1)?.context.queue).toBe('440')
    expect(responses.at(-1)?.context.days).toBe('all')
    expect(responses.at(-1)?.coverage.observations).toBe(2)
  }

  for (const entry of [
    { raw: '__proto__', label: 'proto' },
    { raw: 'class:__proto__', label: 'proto' },
    { raw: 'constructor', label: 'constructor' },
  ]) {
    const params = new URLSearchParams({ section: 'training', training: 'discover', role: 'ALL', queue: '440', days: 'all', tag: entry.raw, search: '', minSimilarity: '0' })
    const ready = async (beforeRequests: number, beforeResponses: number) => {
      await expect.poll(() => responses.length).toBe(beforeResponses + 1)
      await expect(page.getByRole('heading', { name: 'Scelte vicine ai tuoi gusti', exact: true })).toBeVisible()
      await expect(page.getByLabel('Caricamento delle scoperte', { exact: true })).toHaveCount(0)
      await expect(characteristic).toHaveValue(entry.raw)
      await expect(characteristic.locator('option:checked')).toHaveText(entry.label)
      await expect(page.getByRole('heading', { name: 'Nessuna scoperta per questi filtri', exact: true })).toBeVisible()
      await expect(page.locator('.recommendation-card')).toHaveCount(0)
      expect(Object.fromEntries(new URL(page.url()).searchParams)).toEqual(Object.fromEntries(params))
      expect(requests).toHaveLength(beforeRequests + 1)
      expectRequestContext()
      await expect(page.getByRole('alert')).toHaveCount(0)
    }
    const beforeGoto = [requests.length, responses.length] as const
    await page.goto(`/app/fit?${params}`)
    await ready(beforeGoto[0], beforeGoto[1])
    const beforeReload = [requests.length, responses.length] as const
    await page.reload()
    await ready(beforeReload[0], beforeReload[1])
    const data = responses.at(-1)
    if (!data) throw new Error('La fixture reale deve restituire il catalogo delle scoperte.')
    const sourceTags = [...new Set(data.discover.flatMap((item) => item.source_champions.flatMap((source) => source.matched_tags)))].slice(0, 30)
    const validTag = sourceTags[0]
    if (!validTag) throw new Error('Il contesto Flex della fixture deve offrire una caratteristica selezionabile.')
    const expectedItems = data.discover.filter((item) => item.source_champions.some((source) => source.matched_tags.includes(validTag)))
    expect(expectedItems.length).toBeGreaterThan(0)
    const beforeSelection = requests.length
    await characteristic.selectOption(validTag)
    await expect(characteristic).toHaveValue(validTag)
    await expect(page.getByRole('heading', { name: 'Nessuna scoperta per questi filtri', exact: true })).toHaveCount(0)
    await expect(page.locator('.recommendation-card')).toHaveCount(expectedItems.length)
    params.set('tag', validTag)
    expect(Object.fromEntries(new URL(page.url()).searchParams)).toEqual(Object.fromEntries(params))
    await expect(page.getByRole('combobox', { name: 'Ruolo', exact: true })).toHaveValue('')
    expect(requests).toHaveLength(beforeSelection)
    expectRequestContext()
    await expect(page.getByRole('alert')).toHaveCount(0)
  }
  expect(unexpectedWrites).toEqual([])
  expect(pageErrors).toEqual([])
})
