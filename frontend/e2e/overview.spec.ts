import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.route('https://ddragon.leagueoflegends.com/**', (route) => route.abort())
  await page.emulateMedia({ reducedMotion: 'reduce' })
})

test('riepilogo: risultati, piano e contesto dopo refresh completo @smoke', async ({ page }, testInfo) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/app/overview')
  // Verify a settled page before replacing the document with a full reload.
  await expect(page.getByRole('list', { name: 'Anteprima delle partite assegnate' })).toBeVisible()
  await expect(page.getByText(/Ultimo aggiornamento dati:/).locator('time')).toBeVisible()
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Riepilogo', exact: true })).toBeVisible()
  await expect(page.getByRole('list', { name: 'Campioni da confrontare' })).toBeVisible()
  await expect(page.getByRole('list', { name: 'Anteprima delle partite assegnate' })).toBeVisible()
  await expect(page.locator('#main-content .skeleton')).toHaveCount(0)
  await expect(page.getByText('Analisi esplorativa', { exact: true })).toBeVisible()
  const updated = page.getByText(/Ultimo aggiornamento dati:/)
  await expect(updated).toBeVisible()
  await expect(updated.locator('time')).toHaveAttribute('datetime', '2026-08-24T12:30:00.000Z')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
  await page.evaluate(() => document.fonts.ready)
  await page.screenshot({ path: testInfo.outputPath('overview.png'), fullPage: true })
  const accessibility = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()
  expect(accessibility.violations.filter((item) => ['serious', 'critical'].includes(item.impact ?? ''))).toEqual([])

  const comparison = page.getByRole('link', { name: 'Confronta i campioni', exact: true })
  const params = new URL(await comparison.getAttribute('href') ?? '', page.url()).searchParams
  await comparison.click()
  await expect(page.getByRole('heading', { name: 'Quali giochi meglio?', exact: true })).toBeVisible()
  for (const key of ['role', 'queue', 'days']) expect(new URL(page.url()).searchParams.get(key)).toBe(params.get(key))
  await page.goBack()
  await page.getByRole('link', { name: 'Apri il piano', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Piano da 400 partite', exact: true })).toBeVisible()
  expect(errors).toEqual([])
})

test('riepilogo chiaro e finestra affiancata restano leggibili', async ({ page }, testInfo) => {
  await page.addInitScript(() => localStorage.setItem('champion-fit:appearance:v1', JSON.stringify({ theme: 'light', accent: 'mint', density: 'comfortable' })))
  for (const width of [1440, 900, 390, 320]) {
    await page.setViewportSize({ width, height: 900 })
    await page.goto('/app/overview')
    await page.reload()
    await expect(page.getByRole('list', { name: 'Campioni da confrontare' })).toBeVisible()
    await expect(page.locator('#main-content .skeleton')).toHaveCount(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
    await page.evaluate(() => document.fonts.ready)
    await page.screenshot({ path: testInfo.outputPath(`overview-light-${width}.png`), fullPage: true })
  }
  const accessibility = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()
  expect(accessibility.violations.filter((item) => ['serious', 'critical'].includes(item.impact ?? ''))).toEqual([])
})

test('riepilogo: modifica del numero di partite, ricalcolo e refresh @smoke', async ({ page }, testInfo) => {
  const requests: URL[] = []
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (['/api/champions', '/api/training-plan'].includes(url.pathname)) requests.push(url)
  })
  await page.goto('/app/overview?role=ALL&queue=440&days=all')
  await page.reload()
  await expect(page.getByRole('list', { name: 'Anteprima delle partite assegnate' })).toBeVisible()
  const input = page.getByRole('spinbutton', { name: 'Partite del piano' })
  let start = requests.length
  await input.fill('120')
  expect(requests).toHaveLength(start)
  await input.press('Enter')
  await expect.poll(() => requests.length).toBe(start + 1)
  const request = requests.at(-1)!
  expect(request.pathname).toBe('/api/training-plan')
  for (const [key, value] of Object.entries({ budget: '120', role: 'ALL', queue: '440', days: 'all' })) expect(request.searchParams.get(key)).toBe(value)
  await expect(page.locator('.overview-plan__allocation')).toHaveText('120partite distribuite')
  await expect(page.getByRole('link', { name: 'Apri il piano' })).toHaveAttribute('href', /budget=120/)
  await page.reload()
  await expect(input).toHaveValue('120')
  await expect(page.locator('.overview-plan__allocation')).toHaveText('120partite distribuite')
  start = requests.length
  await input.fill('80')
  await input.press('Tab')
  await expect.poll(() => requests.length).toBe(start + 1)
  await expect(page.locator('.overview-plan__allocation')).toHaveText('80partite distribuite')
  await expect(page.getByRole('list', { name: 'Campioni da confrontare' })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
  await page.evaluate(() => document.fonts.ready)
  await page.screenshot({ path: testInfo.outputPath('overview-budget.png'), fullPage: true })
  await page.getByRole('link', { name: 'Apri il piano', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Piano da 80 partite', exact: true })).toBeVisible()
  for (const [key, value] of Object.entries({ budget: '80', role: 'ALL', queue: '440', days: 'all' })) expect(new URL(page.url()).searchParams.get(key)).toBe(value)
})

test('filtri del riepilogo: campioni e piano condividono la selezione, anche dopo refresh @smoke', async ({ page }, testInfo) => {
  const requests: URL[] = []
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (['/api/champions', '/api/training-plan'].includes(url.pathname)) requests.push(url)
  })
  const role = page.getByRole('combobox', { name: 'Ruolo', exact: true })
  const queue = page.getByRole('combobox', { name: 'Modalità', exact: true })
  const period = page.getByRole('combobox', { name: 'Periodo', exact: true })
  const ready = async () => {
    await expect(role).toBeVisible()
    await expect(page.locator('#main-content .skeleton')).toHaveCount(0)
    await expect(page.getByRole('alert')).toHaveCount(0)
  }
  const checkPair = async (start: number, expected: Record<string, string | null>) => {
    await expect.poll(() => requests.length).toBe(start + 2)
    const pair = requests.slice(start)
    expect(pair.map((url) => url.pathname).sort()).toEqual(['/api/champions', '/api/training-plan'])
    for (const request of pair) for (const [key, value] of Object.entries(expected)) expect(request.searchParams.get(key)).toBe(value)
    await ready()
  }
  await page.goto('/app/overview')
  await page.reload()
  await ready()
  let start = requests.length
  await role.selectOption('ALL')
  await checkPair(start, { role: 'ALL', queue: null, days: null })
  start = requests.length
  await queue.selectOption('440')
  await checkPair(start, { role: 'ALL', queue: '440', days: null })
  start = requests.length
  await period.selectOption('all')
  await checkPair(start, { role: 'ALL', queue: '440', days: 'all' })

  for (const reload of [true, false]) {
    start = requests.length
    if (reload) await page.reload()
    else await page.goto('/app/overview')
    await checkPair(start, { role: 'ALL', queue: '440', days: 'all' })
    await expect(role).toHaveValue('ALL')
    await expect(queue).toHaveValue('440')
    await expect(period).toHaveValue('all')
  }
  for (const name of ['Confronta i campioni', 'Apri il piano']) {
    const link = new URL(await page.getByRole('link', { name, exact: true }).getAttribute('href') ?? '', page.url())
    for (const [key, value] of Object.entries({ role: 'ALL', queue: '440', days: 'all' })) expect(link.searchParams.get(key)).toBe(value)
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
  await page.evaluate(() => document.fonts.ready)
  await page.screenshot({ path: testInfo.outputPath('overview-selected-filters.png'), fullPage: true })

  await page.getByRole('button', { name: 'Ripristina filtri predefiniti' }).click()
  await ready()
  start = requests.length
  await page.goto('/app/overview')
  await checkPair(start, { role: null, queue: null, days: null })
  await expect(role).toHaveValue('')
  await expect(queue).toHaveValue('')
  await expect(period).toHaveValue('')
  await expect(page.getByRole('button', { name: 'Ripristina filtri predefiniti' })).toBeDisabled()
})
