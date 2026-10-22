import { expect, test } from '@playwright/test'

test('le spiegazioni delle preferenze mostrano giorni UTC e ultima partita dopo refresh @smoke', async ({ page }) => {
  await page.route('https://ddragon.leagueoflegends.com/**', (route) => route.abort())
  await page.addInitScript(() => {
    localStorage.setItem('champion-fit-profile-accounts', JSON.stringify(['Alpha#EUW']))
  })
  await page.goto('/app/fit?section=choices&role=MIDDLE&queue=all&days=all')
  const card = page.locator('.answer-ranking .recommendation-card').first()
  await expect(card.getByRole('img', { name: 'Ahri', exact: true })).toBeVisible()
  await page.reload()
  await expect(card).toContainText('3 giorni giocati (UTC).')
  await expect(card).toContainText('Ultima partita: 2026-08-22T20:00:00Z.')
})
