import { expect, test } from '@playwright/test'
import type { FriendDto, FriendsResponseDto } from '../src/api/types'

const cases = [
  { parameter: 'games_from', label: 'Conta le partite dal', alternate: '20260821', games: 2 },
  { parameter: 'last_game_from', label: 'Ultima partita dal', alternate: '2026-W34-5', games: 2 },
] as const

for (const { parameter, label, alternate, games } of cases) {
  test(`filtri data compagni: ${parameter} rende visibile il cutoff del link e permette di rimuoverlo @smoke`, async ({ page }, testInfo) => {
    const requests: URL[] = []
    const unexpectedWrites: string[] = []
    await page.route('https://ddragon.leagueoflegends.com/**', (route) => route.abort())
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.route('**/api/**', (route) => {
      if (route.request().method() === 'GET') return route.fallback()
      unexpectedWrites.push(new URL(route.request().url()).pathname)
      return route.abort()
    })
    page.on('request', (request) => {
      const url = new URL(request.url())
      if (url.pathname === '/api/friends') requests.push(url)
    })
    await page.addInitScript(() => {
      localStorage.setItem('champion-fit-profile-accounts', JSON.stringify(['Alpha#EUW']))
      localStorage.setItem('champion-fit:data-view:v2', JSON.stringify({ view: 'list' }))
    })
    await page.goto(`/app/team/friends?min_games=1&queue=420&${parameter}=${alternate}`)
    const calendar = page.getByLabel(label, { exact: true })
    await expect(calendar).toBeVisible()
    await page.reload()
    await expect(calendar).toHaveValue('2026-08-21')
    const table = page.getByRole('region', { name: 'Classifica dei compagni di squadra', exact: true }).getByRole('table')
    // The fixture deliberately reuses this display name for distinct PUUIDs.
    // Keep those identities separate when checking their shared observations.
    const friends = table.getByRole('row').filter({ has: page.getByRole('rowheader', { name: /(?:^|\s)DuoFriend#EUW(?:\s|$)/ }) })
    const expectGames = async (total: number) => {
      await expect(friends).toHaveCount(total)
      await expect(friends.locator('td.numeric')).toHaveText(Array.from({ length: total }, () => '1'))
    }
    await expectGames(games)
    await expect.poll(() => requests.at(-1)?.searchParams.get(parameter)).toBe('2026-08-21')
    expect(new URL(page.url()).searchParams.get(parameter)).toBe(alternate)

    const beforeQueue = requests.length
    await page.getByRole('combobox', { name: 'Modalità del confronto', exact: true }).selectOption('all')
    await expect.poll(() => requests.length).toBeGreaterThan(beforeQueue)
    await expect(calendar).toHaveValue('2026-08-21')
    await expect.poll(() => requests.at(-1)?.searchParams.get(parameter)).toBe('2026-08-21')
    await expectGames(games)

    await calendar.fill('')
    await expect(calendar).toHaveValue('')
    await expect.poll(() => requests.at(-1)?.searchParams.get(parameter)).toBeNull()
    expect(new URL(page.url()).searchParams.has(parameter)).toBe(false)
    await expectGames(4)

    await calendar.fill('2026-08-21')
    await expect(calendar).toHaveValue('2026-08-21')
    expect(new URL(page.url()).searchParams.get(parameter)).toBe('2026-08-21')
    await expectGames(games)
    await page.reload()
    await expect(calendar).toHaveValue('2026-08-21')
    await expect.poll(() => requests.at(-1)?.searchParams.get(parameter)).toBe('2026-08-21')
    await expectGames(games)
    expect(unexpectedWrites).toEqual([])
    await page.evaluate(() => document.fonts.ready)
    await page.screenshot({ path: testInfo.outputPath('calendar-filter.png'), fullPage: true })
  })
}

test.describe('giorni UTC dei compagni', () => {
  test.use({ timezoneId: 'Europe/Rome' })

  test('filtri data compagni: ultima partita e schede mantengono il giorno UTC vicino a mezzanotte @smoke', async ({ page }, testInfo) => {
    const requests: URL[] = []
    const unexpectedWrites: string[] = []
    let template: FriendDto | undefined
    await page.route('https://ddragon.leagueoflegends.com/**', (route) => route.abort())
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.route('**/api/**', (route) => {
      if (route.request().method() === 'GET') return route.fallback()
      unexpectedWrites.push(new URL(route.request().url()).pathname)
      return route.abort()
    })
    await page.route('**/api/friends?**', async (route) => {
      if (route.request().method() !== 'GET') return route.fallback()
      const response = await route.fetch()
      const body = await response.json() as FriendsResponseDto
      template ??= body.items[0]
      if (!template) throw new Error('The synthetic Friends server returned no baseline row')
      const url = new URL(route.request().url())
      requests.push(url)
      // The UTC cutoff contract is also verified by real SQLite/PostgreSQL
      // requests. Keep the rest of each wire record from the fixture server.
      const night = { ...template, friend_key: 'utc-night', friend: 'Notte#EUW', first_game: '2026-08-21T23:30:00.000000+00:00', last_game: '2026-08-21T23:30:00.000000+00:00' }
      const nextDay = { ...template, friend_key: 'utc-next', friend: 'GiornoDopo#EUW', first_game: '2026-08-22T00:00:00.000000+00:00', last_game: '2026-08-22T00:00:00.000000+00:00' }
      body.items = url.searchParams.get('last_game_from') === '2026-08-22' ? [nextDay] : [night, nextDay]
      body.summary = { ...body.summary, friends_found: body.items.length }
      await route.fulfill({ response, json: body })
    })
    await page.addInitScript(() => {
      localStorage.setItem('champion-fit-profile-accounts', JSON.stringify(['Alpha#EUW']))
      localStorage.setItem('champion-fit:data-view:v2', JSON.stringify({ view: 'list' }))
    })
    await page.goto('/app/team/friends?min_games=1&queue=420')
    await expect(page.getByRole('heading', { name: 'Compagni', exact: true })).toBeVisible()
    await page.reload()
    const table = page.getByRole('region', { name: 'Classifica dei compagni di squadra', exact: true }).getByRole('table')
    const night = table.getByRole('row').filter({ has: page.getByRole('rowheader', { name: /(?:^|\s)Notte#EUW(?:\s|$)/ }) })
    const nextDay = table.getByRole('row').filter({ has: page.getByRole('rowheader', { name: /(?:^|\s)GiornoDopo#EUW(?:\s|$)/ }) })
    await expect(night.locator('td').last()).toHaveText('21/08/2026')
    await expect(nextDay.locator('td').last()).toHaveText('22/08/2026')
    await expect(page.getByText('Date mostrate e filtri temporali in UTC.', { exact: true })).toBeVisible()

    const calendar = page.getByLabel('Ultima partita dal', { exact: true })
    await calendar.fill('2026-08-22')
    await expect.poll(() => requests.at(-1)?.searchParams.get('last_game_from')).toBe('2026-08-22')
    await expect(night).toHaveCount(0)
    await expect(nextDay.locator('td').last()).toHaveText('22/08/2026')
    await calendar.fill('')
    await expect(night.locator('td').last()).toHaveText('21/08/2026')

    const controls = page.locator('.scope-bar__display-controls')
    if (await controls.getAttribute('open') === null) await controls.locator('summary').click()
    await page.getByRole('button', { name: 'Vista dati', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Visualizzazione dei dati', exact: true })
    await dialog.getByRole('radio', { name: /^Schede\b/ }).check()
    await dialog.getByRole('button', { name: 'Chiudi visualizzazione dati', exact: true }).click()
    await expect(dialog).toBeHidden()
    const explorer = page.locator('[data-explorer-id="friends-ranking"]')
    await expect(explorer).toHaveAttribute('data-view', 'cards')
    const nightCard = explorer.locator('.data-explorer__card').filter({ has: page.getByRole('heading', { name: 'Notte#EUW', exact: true }) })
    await expect(nightCard).toContainText('ultima partita 21/08/2026')
    expect(unexpectedWrites).toEqual([])
    await page.evaluate(() => document.fonts.ready)
    await page.screenshot({ path: testInfo.outputPath('friends-utc-cards.png'), fullPage: true })
  })
})
