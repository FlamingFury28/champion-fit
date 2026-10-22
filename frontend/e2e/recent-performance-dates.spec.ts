import { expect, test } from '@playwright/test'
import type { MatchesResponseDto, ProfileResponseDto } from '../src/api/types'

test.use({ timezoneId: 'Europe/Rome' })

test('andamento recente: conserva l’intero intervallo degli anni canonici del server @smoke', async ({ page }, testInfo) => {
  const dates = ['0001-01-01', '0004-02-29', '0099-12-31', '0100-01-01', '2026-09-01']
  const unexpectedWrites: string[] = []
  await page.route('https://ddragon.leagueoflegends.com/**', (route) => route.abort())
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.route('**/api/**', (route) => {
    if (route.request().method() === 'GET') return route.fallback()
    unexpectedWrites.push(new URL(route.request().url()).pathname)
    return route.abort()
  })
  await page.addInitScript(() => localStorage.setItem('champion-fit-profile-accounts', JSON.stringify(['Alpha#EUW'])))
  await page.route('**/api/profile?**', async (route) => {
    const response = await route.fetch()
    const profile = await response.json() as ProfileResponseDto
    const source = profile.recent[0]
    if (!source) throw new Error('The disposable profile fixture has no recent matches')
    // These canonical values are also checked against a real synthetic API
    // fixture; keep the rest of each wire record from the running server.
    profile.recent = dates.map((date, index) => ({ ...source, match_id: `RANGE-${index}`,
      date: `${date}T12:00:00Z`, date_utc: `${date}T12:00:00.000000+00:00`, win: 1 }))
    profile.summary = { ...profile.summary, games: dates.length, wins: dates.length,
      losses: 0, win_rate: 100, first_game: profile.recent[0]!.date_utc!, last_game: profile.recent.at(-1)!.date_utc! }
    await route.fulfill({ response, json: profile })
  })

  await page.goto('/app/matches')
  await page.reload()
  const trend = page.locator('.recent-performance').first()
  await expect(trend.getByText('5 vittorie su 5 osservazioni', { exact: true })).toBeVisible()
  await expect(trend.getByText(/osservazioni escluse/)).toHaveCount(0)
  await trend.getByText('Esamina giornate e partite', { exact: true }).click()
  const day = trend.getByRole('combobox', { name: 'Esamina un giorno', exact: true })
  await expect(day.locator('option')).toHaveCount(dates.length)
  expect(await day.locator('option').evaluateAll((options) => options.map((option) => option.getAttribute('value')))).toEqual(dates)
  await day.selectOption(dates[0]!)
  await expect(day).toHaveValue('0001-01-01')
  await expect(trend.getByRole('list').getByRole('listitem')).toHaveCount(1)
  const positions = await trend.locator('svg circle').evaluateAll((points) => points.map((point) => Number(point.getAttribute('cx'))))
  expect(positions).toHaveLength(dates.length)
  expect(positions.every(Number.isFinite)).toBe(true)
  expect(unexpectedWrites).toEqual([])
  await trend.screenshot({ path: testInfo.outputPath('canonical-year-range.png') })
})

test('andamento e annotazioni: i formati ISO usano le date canoniche del server @smoke', async ({ page }) => {
  await page.route('https://ddragon.leagueoflegends.com/**', (route) => route.abort())
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.route('**/api/**', async (route) => {
    if (route.request().method() === 'GET') await route.fallback()
    else await route.abort()
  })
  await page.route('**/api/profile?**', async (route) => {
    const response = await route.fetch()
    const profile = await response.json() as ProfileResponseDto
    const source = profile.recent[0]
    if (!source) throw new Error('The disposable profile fixture has no recent matches')
    const recent: (ProfileResponseDto['recent'][number] & { match_id: string })[] = [
      { ...source, match_id: 'UTC-NAIVE', date: '2026-10-17T00:30:00', date_utc: '2026-10-17T00:30:00.000000+00:00', win: 1 },
      { ...source, match_id: 'UTC-COMPACT', date: '20261017T003000+0200', date_utc: '2026-10-16T22:30:00.000000+00:00', win: 0 },
      { ...source, match_id: 'UTC-WEEK', date: '2026-W42-6T00:30:00+02:00', date_utc: '2026-10-16T22:30:00.000000+00:00', win: 1 },
    ]
    profile.recent = recent
    await route.fulfill({ response, json: profile })
  })
  await page.route('**/api/matches?**', async (route) => {
    const response = await route.fetch()
    const matches = await response.json() as MatchesResponseDto
    const source = matches.items[0]
    if (!source) throw new Error('The disposable fixture has no matches to review')
    matches.items = [
      { ...source, match_id: 'CANONICAL-COMPACT', date: '20261017T003000+0200', date_utc: '2026-10-16T22:30:00.000000+00:00' },
      { ...source, match_id: 'CANONICAL-WEEK', date: '2026-W42-6T00:30:00+02:00', date_utc: '2026-10-16T22:30:00.000000+00:00' },
    ]
    await route.fulfill({ response, json: matches })
  })

  await page.goto('/app/matches')
  await page.reload()
  const trend = page.locator('.recent-performance').first()
  await expect(trend.getByRole('heading', { name: 'Andamento recente', exact: true })).toBeVisible()
  await expect(trend.getByText('2 vittorie su 3 osservazioni', { exact: true })).toBeVisible()
  await expect(trend.getByText(/osservazioni escluse/)).toHaveCount(0)
  await trend.getByText('Esamina giornate e partite', { exact: true }).click()
  const day = trend.getByRole('combobox', { name: 'Esamina un giorno', exact: true })
  await expect(day).toHaveValue('2026-10-17')
  await expect(day.locator('option')).toHaveCount(2)
  await day.selectOption('2026-10-16')
  await expect(trend.getByText('1 vittoria e 1 sconfitta', { exact: false })).toBeVisible()
  await expect(trend.getByRole('list')).toBeVisible()
  await expect(trend.getByRole('list').getByRole('listitem')).toHaveCount(2)

  const history = page.locator('#match-history')
  const rows = history.locator('.audit-list > article > button')
  await expect(rows).toHaveCount(2)
  for (const row of await rows.all()) {
    await expect(row).toHaveAccessibleName(/17\/10\/2026/)
    await expect(row).toContainText('17/10/2026')
    await expect(row).not.toContainText('20261017T')
    await expect(row).not.toContainText('2026-W42')
  }
  await rows.first().click()
  const annotation = page.getByRole('dialog', { name: 'Annotazione della partita', exact: true })
  await expect(annotation).toBeVisible()
  await expect(annotation.locator('.annotation-match')).toContainText('17/10/2026')
})
