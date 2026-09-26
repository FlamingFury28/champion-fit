import { expect, test, type Page } from '@playwright/test'

async function stabilizeAuditFixture(page: Page) {
  await page.route(/\/api\/matches(?:\?|$)/, async (route) => {
    const response = await route.fetch()
    const body = await response.json() as { items?: Array<Record<string, unknown>> }
    const items = body.items?.map((item) => item.annotation_manual_label === 'review e2e'
      ? { ...item, annotation_manual_label: '' }
      : item)
    await route.fulfill({ response, json: { ...body, items } })
  })
}

const pages = [
  ['landing', '/'], ['overview', '/app/overview'], ['fit', '/app/fit'],
  ['champion', '/app/fit?detail=Ahri&detailRole=MIDDLE'], ['audit', '/app/matches?flag=all'],
] as const

for (const [name, route] of pages) {
  test(`regressione visuale ${name}`, async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'Screenshot principali su Chromium')
    await page.route('https://ddragon.leagueoflegends.com/**', async (request) => request.abort())
    if (name === 'audit') await stabilizeAuditFixture(page)
    await page.goto(route)
    await page.reload()
    await page.evaluate(() => document.fonts.ready)
    if (name === 'champion') await expect(page.getByRole('dialog', { name: 'Scheda di Ahri' })).toBeVisible()
    else await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    await expect(page.locator('#main-content .skeleton')).toHaveCount(0)
    await expect(page).toHaveScreenshot(`${name}-1440x900.png`, { fullPage: true })
  })
}

for (const [name, route] of [['overview', '/app/overview'], ['fit', '/app/fit'], ['audit', '/app/matches?flag=all']] as const) {
  test(`regressione visuale mobile ${name}`, async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'Screenshot mobile principali su Chromium')
    await page.setViewportSize({ width: 390, height: 844 })
    await page.route('https://ddragon.leagueoflegends.com/**', async (request) => request.abort())
    if (name === 'audit') await stabilizeAuditFixture(page)
    await page.goto(route)
    await page.reload()
    await page.evaluate(() => document.fonts.ready)
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    await expect(page.locator('#main-content .skeleton')).toHaveCount(0)
    await expect(page).toHaveScreenshot(`${name}-390x844.png`, { fullPage: true })
  })
}

for (const [name, route, width, theme] of [
  ['landing-mobile', '/', 390, 'dark'],
  ['overview-light', '/app/overview', 1440, 'light'],
  ['champion-light-mobile', '/app/fit?detail=Ahri&detailRole=MIDDLE', 390, 'light'],
] as const) {
  test(`regressione visuale esperienza ${name}`, async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'Nuovi temi e composizioni su Chromium')
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.addInitScript((selectedTheme) => localStorage.setItem('champion-fit:appearance:v1', JSON.stringify({
      theme: selectedTheme, accent: 'mint', density: 'comfortable',
    })), theme)
    await page.route('https://ddragon.leagueoflegends.com/**', (request) => request.abort())
    await page.goto(route)
    await page.reload()
    await page.evaluate(() => document.fonts.ready)
    if (name === 'champion-light-mobile') await expect(page.getByRole('dialog', { name: 'Scheda di Ahri' })).toBeVisible()
    else await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    await expect(page.locator('#main-content .skeleton')).toHaveCount(0)
    await expect(page).toHaveScreenshot(`${name}.png`, { fullPage: true })
  })
}

test('regressione visuale preferenze mobile', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Preferenze una volta su Chromium')
  await page.setViewportSize({ width: 390, height: 844 })
  await page.route('https://ddragon.leagueoflegends.com/**', (request) => request.abort())
  await page.goto('/app/overview')
  await page.reload()
  await expect(page.locator('#main-content .skeleton')).toHaveCount(0)
  await page.locator('.scope-bar__display-controls > summary').click()
  await page.getByRole('button', { name: 'Aspetto', exact: true }).click()
  await page.getByRole('radio', { name: 'Chiaro', exact: true }).check()
  await page.getByRole('radio', { name: 'Ambra', exact: true }).check()
  await page.getByRole('radio', { name: 'Compatta', exact: true }).check()
  await page.evaluate(() => document.fonts.ready)
  await expect(page).toHaveScreenshot('appearance-light-mobile.png')
})
