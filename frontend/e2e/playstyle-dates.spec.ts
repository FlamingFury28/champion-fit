import { expect, test } from '@playwright/test'
import type { PlaystyleEvidenceResponse, PlaystylesResponse } from '../src/api/playstyles'

test.use({ timezoneId: 'Europe/Rome' })

test('stili: prove ordinate per UTC e date ISO leggibili dopo refresh @smoke', async ({ page }) => {
  await page.route('https://ddragon.leagueoflegends.com/**', (route) => route.abort())
  await page.route('**/api/**', (route) => route.request().method() === 'GET' ? route.fallback() : route.abort())
  await page.addInitScript(() => {
    localStorage.setItem('champion-fit-profile-accounts', JSON.stringify(['Alpha#EUW']))
  })

  const params = new URLSearchParams({ account: 'Alpha#EUW', category: 'class:mage', role: 'ALL', queue: 'all', days: 'all', page_size: '1' })
  // These are real API reads against the disposable SQLite or PostgreSQL fixture.
  for (const [index, matchId] of ['EUW1-001', 'EUW1-002', 'EUW1-003', 'EUW1-004'].entries()) {
    params.set('page', String(index + 1))
    const response = await page.request.get(`/api/playstyle-evidence?${params}`)
    expect(response.status()).toBe(200)
    const payload = await response.json() as PlaystyleEvidenceResponse
    expect(payload.total).toBe(4)
    expect(payload.matches).toHaveLength(1)
    expect(payload.matches[0]).toMatchObject({
      match_id: matchId,
      date_utc: `2026-08-${22 - index}T20:00:00.000000+00:00`,
    })
  }
  const styles = await page.request.get('/api/playstyles?account=Alpha%23EUW&role=ALL&queue=all&days=all')
  expect(styles.status()).toBe(200)
  const overview = await styles.json() as PlaystylesResponse
  const category = overview.categories.find((item) => item.id === 'class:mage')
  if (!category) throw new Error('The disposable fixture has no mage category')

  await page.route('**/api/playstyle-evidence?**', async (route) => {
    const response = await route.fetch()
    const payload = await response.json() as PlaystyleEvidenceResponse
    // Keep the server's UTC values and exercise accepted source spellings that
    // JavaScript Date cannot parse. Neither source database is changed.
    for (const match of payload.matches) {
      if (match.match_id === 'EUW1-002') match.date = '20260821T200000Z'
      if (match.match_id === 'EUW1-004') match.date = '2026-W34-3T20:00:00Z'
    }
    await route.fulfill({ response, json: payload })
  })
  await page.goto('/app/matches?section=style&role=ALL&queue=all&days=all')
  await page.reload()
  await page.getByRole('button', { name: `Perché ${category.label}?`, exact: true }).click()
  await page.getByRole('button', { name: `Mostra le partite · ${category.label}`, exact: true }).click()
  const region = page.getByRole('region', { name: `Partite a supporto di ${category.label}`, exact: true })
  const rows = region.locator('tbody tr')
  await expect(rows).toHaveCount(4)
  for (const [index, matchId] of ['EUW1-001', 'EUW1-002', 'EUW1-003', 'EUW1-004'].entries()) {
    const row = rows.nth(index)
    await expect(row.getByText(matchId, { exact: true })).toBeVisible()
    await expect(row.getByRole('cell').nth(3)).toHaveText(`${22 - index}/08/2026`)
  }
  await expect(region).not.toContainText('20260821T')
  await expect(region).not.toContainText('2026-W34')
})
