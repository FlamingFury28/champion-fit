import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'

const routes = [
  '/', '/app/overview', '/app/profile', '/app/fit',
  '/app/fit?section=matchups&relation=enemies', '/app/fit?section=matchups&relation=allies',
  '/app/fit?section=training&training=plan', '/app/fit?section=training&training=discover',
  '/app/fit?detail=Ahri&detailRole=MIDDLE', '/app/matches?flag=all',
  '/app/matches?section=style', '/app/team/friends',
]

async function freshPage(page: Page, route: string) {
  await page.goto(route)
  // Full document refresh is required before checking a changed interface.
  await page.reload()
  if (route.includes('detail=')) await expect(page.getByRole('dialog', { name: /Scheda di/ })).toBeVisible()
  else await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await expect(page.locator('#main-content .skeleton')).toHaveCount(0)
  await page.evaluate(() => document.fonts.ready)
}

async function seriousViolations(page: Page) {
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()
  return result.violations.filter((violation) => ['serious', 'critical'].includes(violation.impact ?? ''))
}

async function openAppearance(page: Page) {
  const controls = page.locator('.scope-bar__display-controls')
  if (await controls.getAttribute('open') === null) await controls.locator('summary').click()
  const trigger = controls.getByRole('button', { name: 'Aspetto', exact: true })
  await trigger.click()
  return trigger
}

test.beforeEach(async ({ page }) => {
  await page.route('https://ddragon.leagueoflegends.com/**', (route) => route.abort())
})

test('preferenze aspetto persistenti, semantica colori e focus @smoke', async ({ page }) => {
  await freshPage(page, '/app/overview')
  const root = page.locator('html')
  await expect(root).toHaveAttribute('data-theme', 'dark')
  const originalPositive = await root.evaluate((element) => getComputedStyle(element).getPropertyValue('--positive'))
  const trigger = await openAppearance(page)
  const dialog = page.getByRole('dialog', { name: 'Il tuo spazio di analisi' })
  await dialog.getByRole('radio', { name: 'Cielo', exact: true }).check()
  const skyPositive = await root.evaluate((element) => getComputedStyle(element).getPropertyValue('--positive'))
  expect(skyPositive).toBe(originalPositive)
  await dialog.getByRole('radio', { name: 'Chiaro', exact: true }).check()
  await dialog.getByRole('radio', { name: 'Compatta', exact: true }).check()
  await expect(root).toHaveAttribute('data-theme', 'light')
  await expect(root).toHaveAttribute('data-accent', 'sky')
  await expect(root).toHaveAttribute('data-density', 'compact')
  await page.getByRole('button', { name: 'Chiudi impostazioni aspetto' }).click()
  await expect(trigger).toBeFocused()
  await page.reload()
  await expect(root).toHaveAttribute('data-theme', 'light')
  await expect(root).toHaveAttribute('data-accent', 'sky')
  await expect(root).toHaveAttribute('data-density', 'compact')
  await page.locator('.scope-bar__display-controls > summary').click()
  const size = await trigger.boundingBox()
  expect(size?.height).toBeGreaterThanOrEqual(44)
  expect(size?.width).toBeGreaterThanOrEqual(44)
})

test('tema sistema segue il dispositivo e resta selezionato dopo refresh', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await freshPage(page, '/app/overview')
  await openAppearance(page)
  await page.getByRole('radio', { name: 'Sistema', exact: true }).check()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.emulateMedia({ colorScheme: 'light' })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await openAppearance(page)
  await expect(page.getByRole('radio', { name: 'Sistema', exact: true })).toBeChecked()
})

test('il filtro compagno attivo resta leggibile su mobile @smoke', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.addInitScript(() => {
    localStorage.setItem('champion-fit-profile-accounts', JSON.stringify(['Alpha#EUW']))
    localStorage.setItem('champion-fit-companion-filter', JSON.stringify({
      name: 'Compagni della sera', accounts: ['Beta#EUW'], mode: 'exclude', profile_accounts: ['Alpha#EUW'],
    }))
  })
  await freshPage(page, '/app/overview')
  const status = page.locator('.scope-bar__status')
  await expect(status).toBeVisible()
  await expect(status).toContainText('Escludi · Compagni della sera')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
})

test('andamento recente, selezione da tastiera e avatar della scheda @smoke', async ({ page }) => {
  await freshPage(page, '/app/matches?flag=all')
  const trend = page.getByRole('region', { name: 'Andamento recente' })
  await expect(trend).toContainText('4 vittorie su 6 osservazioni')
  const disclosure = trend.locator('summary')
  await expect(disclosure).toHaveText('Esamina giornate e partite')
  await disclosure.focus()
  await page.keyboard.press('Enter')
  const select = trend.getByLabel('Esamina un giorno')
  await expect(select).toBeVisible()
  await select.selectOption('2026-08-19')
  await expect(trend.getByRole('list')).toContainText('Ahri')
  await select.focus()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await expect(select).toHaveValue('2026-08-20')
  await expect(trend.getByRole('list')).toContainText('Lux')
  await freshPage(page, '/app/fit?detail=Ahri&detailRole=MIDDLE')
  const sheet = page.getByRole('dialog', { name: 'Scheda di Ahri' })
  await expect(sheet.locator('.champion-hero .champion-artwork')).toBeHidden()
  await expect(sheet.getByRole('heading', { level: 2, name: 'Ahri · Corsia centrale', exact: true })).toBeVisible()
  await expect(sheet.locator('.observed-recommendation .champion-avatar')).toHaveAttribute('aria-label', 'Ahri')
  await expect(sheet.getByRole('region', { name: 'Scheda di Ahri' }).getByRole('heading', { name: 'Copertura del confronto' })).toBeVisible()
  await expect(sheet.getByRole('region', { name: 'Scheda di Ahri' })).toContainText('4 · 3–1')
})

test('landing: ancore, capitolo attivo, profondità e movimento ridotto', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Verifica interazione puntatore desktop')
  await freshPage(page, '/')
  const scene = page.locator('.landing-preview-scene')
  await scene.hover({ position: { x: 20, y: 20 } })
  await expect.poll(() => scene.evaluate((element) => element.style.getPropertyValue('--landing-tilt-y'))).not.toBe('0deg')
  const guide = page.getByRole('navigation', { name: 'Percorso di lettura' })
  await guide.getByRole('link', { name: /Il metodo/ }).click()
  await expect(page).toHaveURL(/#metodo$/)
  await expect(guide.getByRole('link', { name: /Il metodo/ })).toHaveAttribute('aria-current', 'location')
  await expect.poll(async () => (await guide.boundingBox())?.y).toBe(0)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await freshPage(page, '/')
  await scene.hover({ position: { x: 20, y: 20 } })
  await expect(page.locator('.landing-preview--interactive')).toHaveCSS('transform', 'none')
  await expect(page.locator('.landing-kinetic-answer')).toHaveCSS('animation-name', 'none')
})

for (const route of routes) {
  test(`tema chiaro accessibile e layout mobile: ${route}`, async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'Matrice completa una volta su Chromium')
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.addInitScript(() => localStorage.setItem('champion-fit:appearance:v1', JSON.stringify({ theme: 'light', accent: 'mint', density: 'compact' })))
    await freshPage(page, route)
    expect(await seriousViolations(page)).toEqual([])
    await page.setViewportSize({ width: 390, height: 844 })
    await page.reload()
    await expect(page.locator('#main-content .skeleton')).toHaveCount(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
    expect(await seriousViolations(page)).toEqual([])
    await page.setViewportSize({ width: 320, height: 740 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
  })
}

test('tutti gli accenti mantengono contrasto e leggibilità in entrambi i temi', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Matrice accenti una volta su Chromium')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await freshPage(page, '/app/overview')
  await openAppearance(page)
  const dialog = page.getByRole('dialog', { name: 'Il tuo spazio di analisi' })
  for (const theme of ['Scuro', 'Chiaro']) {
    await dialog.getByRole('radio', { name: theme, exact: true }).check()
    for (const accent of ['Menta', 'Cielo', 'Ambra']) {
      await dialog.getByRole('radio', { name: accent, exact: true }).check()
      expect(await seriousViolations(page)).toEqual([])
    }
  }
})
