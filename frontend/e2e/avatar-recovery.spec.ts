import { expect, test } from '@playwright/test'
import { observedRecommendation, recommendationsFixture } from '../src/test/recommendations-fixture'

test('una nuova icona sostituisce il fallback dopo il ricaricamento dei dati @smoke', async ({ page }) => {
  let updated = false
  await page.route('https://ddragon.leagueoflegends.com/**', (route) => route.abort())
  await page.route('**/test-icons/unavailable.png', (route) => route.abort())
  await page.route('**/test-icons/recovered.svg', (route) => route.fulfill({
    contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="teal"/></svg>',
  }))
  await page.route('**/api/recommendations?**', (route) => route.fulfill({
    json: recommendationsFixture({
      known: [observedRecommendation({
        icon_url: updated ? '/test-icons/recovered.svg' : '/test-icons/unavailable.png',
        feedback: updated ? 'like' : null,
      })],
      discover: [], feedback_revision: updated ? 8 : 7,
    }),
  }))
  await page.route('**/api/recommendation-feedback', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback()
    updated = true
    await route.fulfill({ json: { ok: true, revision: 8, items: [] } })
  })
  await page.goto('/app/fit?section=choices')
  await page.reload()

  const card = page.locator('.answer-ranking .recommendation-card').first()
  const avatar = card.getByRole('img', { name: 'Ahri', exact: true })
  await expect(avatar).toBeVisible()
  await avatar.scrollIntoViewIfNeeded()
  await expect(avatar.locator('img')).toHaveCount(0)
  await card.getByRole('button', { name: 'Mi piace', exact: true }).click()
  await expect(card.getByRole('button', { name: 'Mi piace', exact: true })).toHaveAttribute('aria-pressed', 'true')
  const image = avatar.locator('img')
  await expect(image).toHaveAttribute('src', '/test-icons/recovered.svg')
  await avatar.scrollIntoViewIfNeeded()
  await expect.poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBe(16)
})
