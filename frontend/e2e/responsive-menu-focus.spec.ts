import { expect, test, type Locator, type Page } from '@playwright/test'

async function tabToMenu(page: Page, menu: Locator) {
  for (let step = 0; step < 15; step += 1) {
    await page.keyboard.press('Tab')
    if (await menu.evaluate((element) => element === document.activeElement)) return
  }
  throw new Error('Il menu non è raggiungibile nell’ordine naturale di Tab.')
}

for (const resize of [false, true]) {
  test(`menu responsive: Escape ripristina il focus ${resize ? 'dopo il passaggio a desktop' : 'senza cambiare larghezza'} @smoke`, async ({ page }) => {
    const unexpectedWrites: string[] = []
    await page.route('**/api/**', (route) => {
      if (route.request().method() === 'GET') return route.fallback()
      unexpectedWrites.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`)
      return route.abort()
    })
    await page.route('https://ddragon.leagueoflegends.com/**', (route) => route.abort())
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.setViewportSize({ width: 1360, height: 900 })
    await page.goto('/app/map')
    const heading = page.getByRole('heading', { level: 1, name: 'Mappa del sito', exact: true })
    await expect(heading).toBeVisible()
    await page.reload()
    await expect(heading).toBeVisible()

    const menu = page.getByRole('button', { name: 'Apri il menu', exact: true })
    await expect(menu).toBeVisible()
    await tabToMenu(page, menu)
    await expect(menu).toBeFocused()
    await page.keyboard.press('Enter')
    const drawer = page.getByRole('dialog', { name: 'Esplora Champion Fit', exact: true })
    await expect(drawer).toBeVisible()
    await expect(drawer.getByRole('button', { name: 'Chiudi', exact: true })).toBeFocused()

    if (resize) {
      await page.setViewportSize({ width: 1440, height: 900 })
      // The original trigger remains mounted but is hidden by the desktop CSS.
      await expect(menu).toBeHidden()
      await expect(page.locator('.app-topbar > .app-nav')).toBeVisible()
    }
    await page.keyboard.press('Escape')
    await expect(drawer).toBeHidden()
    if (resize) {
      await expect(page.locator('#main-content')).toBeFocused()
      await page.keyboard.press('Tab')
      await expect(page.getByRole('searchbox', { name: 'Cerca una funzione', exact: true })).toBeFocused()
    } else {
      await expect(menu).toBeFocused()
    }
    expect(unexpectedWrites).toEqual([])
  })
}
