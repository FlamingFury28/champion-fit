import { expect, test } from '@playwright/test'
import { discoveryRecommendation, recommendationsFixture } from '../src/test/recommendations-fixture'

test('la ricerca dei candidati accetta nome, identificativo e spazi anche dopo refresh @smoke', async ({ page }) => {
  await page.route('https://ddragon.leagueoflegends.com/**', (route) => route.abort())
  await page.route('**/api/recommendations?**', (route) => route.fulfill({
    json: recommendationsFixture({ known: [], discover: [
      discoveryRecommendation({ champion: 'MonkeyKing', name: 'Wukong' }),
      discoveryRecommendation(),
    ] }),
  }))
  await page.goto('/app/fit?section=training&training=discover&search=%20MonkeyKing%20&tag=style%3Aduel&minSimilarity=50')
  await page.reload()

  const cards = page.locator('.answer-ranking .recommendation-card')
  const search = page.getByRole('textbox', { name: 'Campione', exact: true })
  await expect(cards).toHaveCount(1)
  await expect(cards.first()).toContainText('Wukong')
  await expect(search).toHaveValue(' MonkeyKing ')

  await search.fill(' WuKong ')
  await expect(cards).toHaveCount(1)
  await expect(cards.first()).toContainText('Wukong')
  await page.reload()
  await expect(cards).toHaveCount(1)
  await expect(cards.first()).toContainText('Wukong')
  await expect(search).toHaveValue(' WuKong ')
  await expect(page.getByRole('combobox', { name: 'Caratteristica', exact: true })).toHaveValue('style:duel')
  await expect(page.getByRole('slider', { name: /^Affinità minima/ })).toHaveValue('50')

  await search.fill('   ')
  await expect(cards).toHaveCount(2)
})
