import { expect, test, type Locator, type Page } from '@playwright/test'

const recommendations = [
  { champion: 'Senna', role: 'SUPPORT', games: 63, score: 55 },
  { champion: 'Janna', role: 'SUPPORT', games: 16, score: 51 },
  { champion: 'Amumu', role: 'SUPPORT', games: 10, score: 49 },
] as const

async function showThreeRecommendations(page: Page) {
  await page.route(/\/api\/recommendations(?:\?|$)/, async (route) => {
    const response = await route.fetch()
    const payload = await response.json() as { known?: Array<Record<string, unknown>> }
    const base = payload.known?.[0]
    if (!base) throw new Error('La fixture deve fornire almeno una raccomandazione da usare come base del test di layout.')
    await route.fulfill({
      response,
      json: {
        ...payload,
        known: recommendations.map((item) => ({
          ...base,
          ...item,
          name: item.champion,
          performance: {
            ...(base.performance as Record<string, unknown>),
            games: item.games,
          },
        })),
      },
    })
  })
  await page.route('https://ddragon.leagueoflegends.com/**', async (route) => route.abort())
  await page.goto('/app/fit?section=choices')
  // Check the served artifact after a full refresh, including its current CSS assets.
  await page.reload()
  await page.evaluate(() => document.fonts.ready)
  for (const item of recommendations) {
    await expect(page.locator('.recommendation-card').filter({ has: page.getByText(item.champion, { exact: true }) })).toHaveCount(1)
  }
}

async function actionGeometry(actions: Locator) {
  return actions.evaluate((element) => {
    const box = (rect: DOMRect) => ({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height })
    const card = element.closest('.recommendation-card')
    if (!card) throw new Error('Le azioni devono appartenere a una card.')
    return {
      card: box(card.getBoundingClientRect()),
      cardClientWidth: card.clientWidth,
      cardScrollWidth: card.scrollWidth,
      actions: box(element.getBoundingClientRect()),
      links: Array.from(element.querySelectorAll('a')).map((link) => {
        const textBoxes: ReturnType<typeof box>[] = []
        const walker = document.createTreeWalker(link, NodeFilter.SHOW_TEXT)
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (!node.textContent?.trim()) continue
          const range = document.createRange()
          range.selectNodeContents(node)
          textBoxes.push(...Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0).map(box))
        }
        return {
          box: box(link.getBoundingClientRect()),
          textBoxes,
        }
      }),
    }
  })
}

for (const width of [1440, 1253, 1100, 900, 390]) {
  test(`tre consigli: schede e azione leggibili a ${width}px`, async ({ page, browserName }, testInfo) => {
    test.skip(browserName !== 'chromium', 'Geometria delle cinque larghezze verificata sul browser desktop.')
    await page.setViewportSize({ width, height: width === 1253 ? 912 : width === 390 ? 844 : 900 })
    await showThreeRecommendations(page)

    for (const item of recommendations) {
      const card = page.locator('.recommendation-card').filter({ has: page.getByText(item.champion, { exact: true }) })
      const actions = card.locator('.recommendation-card__actions')
      await expect(actions.getByRole('link', { name: 'Apri la scheda', exact: true })).toBeVisible()
    }

    const screenshotPath = testInfo.outputPath(`recommendations-three-cards-${width}.png`)
    await page.locator('.answer-ranking').screenshot({ path: screenshotPath, animations: 'disabled' })
    await testInfo.attach(`Tre card · ${width}px`, { path: screenshotPath, contentType: 'image/png' })

    for (const item of recommendations) {
      const context = `${item.champion} a ${width}px`
      const card = page.locator('.recommendation-card').filter({ has: page.getByText(item.champion, { exact: true }) })
      const actions = card.locator('.recommendation-card__actions')
      const links = actions.getByRole('link')
      await expect(links).toHaveCount(1)
      await expect(links).toHaveAttribute('href', /\/app\/fit\?.*detail=.*detailRole=SUPPORT/)

      const geometry = await actionGeometry(actions)
      expect(geometry.cardScrollWidth, `${context}: nessun contenuto esce dalla card`).toBeLessThanOrEqual(geometry.cardClientWidth + 1)
      for (const [index, link] of geometry.links.entries()) {
        expect(link.box.left, `${context}: azione ${index + 1} dentro il bordo sinistro`).toBeGreaterThanOrEqual(geometry.card.left + 1)
        expect(link.box.right, `${context}: azione ${index + 1} dentro il bordo destro`).toBeLessThanOrEqual(geometry.card.right - 1)
        expect(link.box.top, `${context}: azione ${index + 1} dentro la riga azioni`).toBeGreaterThanOrEqual(geometry.actions.top - 1)
        expect(link.box.bottom, `${context}: azione ${index + 1} dentro la riga azioni`).toBeLessThanOrEqual(geometry.actions.bottom + 1)
        expect(link.textBoxes, `${context}: etichetta ${index + 1} integra su una riga`).toHaveLength(1)
        const text = link.textBoxes[0]!
        expect(text.left, `${context}: testo ${index + 1} dentro il link`).toBeGreaterThanOrEqual(link.box.left - 1)
        expect(text.right, `${context}: testo ${index + 1} dentro il link`).toBeLessThanOrEqual(link.box.right + 1)
        expect(text.top, `${context}: testo ${index + 1} dentro il link`).toBeGreaterThanOrEqual(link.box.top - 1)
        expect(text.bottom, `${context}: testo ${index + 1} dentro il link`).toBeLessThanOrEqual(link.box.bottom + 1)
      }

    }

    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${width}px: nessuno scorrimento orizzontale della pagina`).toBe(true)
  })
}
