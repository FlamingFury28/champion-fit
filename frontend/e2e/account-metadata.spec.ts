import { expect, test } from '@playwright/test'
import type { AccountDto } from '../src/api/types'

test('account: estremi UTC corretti e selezione invariata dopo refresh @smoke', async ({ page }) => {
  await page.route('https://ddragon.leagueoflegends.com/**', (route) => route.abort())
  await page.goto('/app/profile')
  await page.reload()

  const response = await page.request.get('/api/accounts')
  expect(response.status()).toBe(200)
  const { items } = await response.json() as { items: AccountDto[] }
  const alpha = items.find((item) => item.account === 'Alpha#EUW')
  const beta = items.find((item) => item.account === 'Beta#EUW')
  expect(alpha).toMatchObject({
    first_game: '2026-08-19T20:00:00.000000+00:00',
    last_game: '2026-08-22T20:00:00.000000+00:00',
    games: 4, analyzed_games: 4,
  })
  expect(beta).toMatchObject({
    first_game: '2026-08-17T20:00:00.000000+00:00',
    last_game: '2026-08-18T20:00:00.000000+00:00',
    games: 2, analyzed_games: 2,
  })
  const filtered = await page.request.get('/api/accounts?q=Alpha')
  expect(filtered.status()).toBe(200)
  expect((await filtered.json()).items).toEqual([alpha])

  const accounts = page.locator('.selected-account-list')
  const alphaButton = accounts.getByRole('button', { name: /^Alpha#EUW/ })
  const betaButton = accounts.getByRole('button', { name: /^Beta#EUW/ })
  await expect(alphaButton).toContainText('4 partite analizzate')
  await expect(betaButton).toContainText('2 partite analizzate')
  await expect(betaButton).toHaveAttribute('aria-pressed', 'true')
  await betaButton.click()
  await expect(betaButton).toHaveAttribute('aria-pressed', 'false')
  await expect(alphaButton).toHaveAttribute('aria-pressed', 'true')
  await page.reload()
  await expect(alphaButton).toHaveAttribute('aria-pressed', 'true')
  await expect(betaButton).toHaveAttribute('aria-pressed', 'false')
})


type ProfileNamesPage = import('@playwright/test').Page

test('nomi dei profili: proprieta ereditate conservano salvataggio, applicazione e sincronizzazione fra schede @smoke', async ({ page, context }) => {
  test.setTimeout(90_000)
  const groupsKey = 'champion-fit-profile-groups'
  const eventCountKey = 'champion-fit:e2e:profile-name-events'
  const unexpectedWrites: string[] = []
  const pageErrors: { page: string; message: string }[] = []
  page.on('pageerror', (error) => pageErrors.push({ page: 'principale', message: error.message }))
  await context.route('https://ddragon.leagueoflegends.com/**', (route) => route.abort())
  await context.route('**/api/**', (route) => {
    if (route.request().method() === 'GET') return route.fallback()
    unexpectedWrites.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`)
    return route.abort()
  })
  await context.addInitScript(({ groupsKey, eventCountKey }) => {
    if (localStorage.getItem('champion-fit-profile-accounts') === null) {
      localStorage.setItem('champion-fit-profile-accounts', JSON.stringify(['Alpha#EUW']))
    }
    if (localStorage.getItem(groupsKey) === null) {
      localStorage.setItem(groupsKey, JSON.stringify(Object.fromEntries([['__proto__', ['Beta#EUW']]])))
    }
    sessionStorage.setItem(eventCountKey, '0')
    // The browser emits these events for the other tab's actual localStorage
    // changes. The test never dispatches a synthetic storage event.
    window.addEventListener('storage', (event) => {
      if (event.key === groupsKey && event.storageArea === localStorage) {
        sessionStorage.setItem(eventCountKey, String(Number(sessionStorage.getItem(eventCountKey) || '0') + 1))
      }
    })
  }, { groupsKey, eventCountKey })
  const chip = (tab: ProfileNamesPage, name: string) => tab.locator('.selected-account-list').getByRole('button', { name: new RegExp(`^${name}`) })
  const profile = (tab: ProfileNamesPage, name: string) => tab.locator('.saved-profile__apply').filter({
    has: tab.locator('strong').filter({ hasText: new RegExp(`^${name}$`) }),
  })
  const expectSelection = async (tab: ProfileNamesPage, name: string) => {
    await expect(chip(tab, name)).toHaveAttribute('aria-pressed', 'true')
    await expect(chip(tab, name === 'Alpha#EUW' ? 'Beta#EUW' : 'Alpha#EUW')).toHaveAttribute('aria-pressed', 'false')
  }
  const chooseOnly = async (tab: ProfileNamesPage, name: string) => {
    const target = chip(tab, name)
    if (await target.getAttribute('aria-pressed') !== 'true') await target.click()
    const other = chip(tab, name === 'Alpha#EUW' ? 'Beta#EUW' : 'Alpha#EUW')
    if (await other.getAttribute('aria-pressed') === 'true') await other.click()
    await expectSelection(tab, name)
  }
  const ready = async (tab: ProfileNamesPage, name: string) => {
    await expect(tab.getByRole('heading', { name: 'Dati usati', exact: true })).toBeVisible()
    await expectSelection(tab, name)
  }
  const readProfiles = async (tab: ProfileNamesPage) => {
    // Preserve the own __proto__ key across Playwright's object serializer.
    const raw = await tab.evaluate((key) => localStorage.getItem(key) || '{}', groupsKey)
    return JSON.parse(raw) as Record<string, string[]>
  }
  const nativeEvents = (tab: ProfileNamesPage) => tab.evaluate((key) => Number(sessionStorage.getItem(key) || '0'), eventCountKey)
  const save = async (tab: ProfileNamesPage, name: string, accounts: string[]) => {
    await tab.getByRole('textbox', { name: 'Nome profilo', exact: true }).fill(name)
    await tab.getByRole('button', { name: 'Salva', exact: true }).click()
    await expect(tab.getByRole('textbox', { name: 'Nome profilo', exact: true })).toHaveValue('')
    await expect(profile(tab, name)).toBeVisible()
    await expect.poll(async () => (await readProfiles(tab))[name]).toEqual(accounts)
  }
  const remove = async (tab: ProfileNamesPage, name: string) => {
    await tab.getByRole('button', { name: `Elimina profilo ${name}`, exact: true }).click()
    const dialog = tab.getByRole('dialog', { name: 'Eliminare questo profilo?', exact: true })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Conferma eliminazione', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect(profile(tab, name)).toHaveCount(0)
    await expect.poll(async () => Object.hasOwn(await readProfiles(tab), name)).toBe(false)
  }

  // Existing JSON with an own __proto__ key must survive bootstrap and reload.
  await page.goto('/app/profile')
  await ready(page, 'Alpha#EUW')
  await expect(profile(page, '__proto__')).toBeVisible()
  await page.reload()
  await ready(page, 'Alpha#EUW')
  await expect(profile(page, '__proto__')).toBeVisible()
  expect(await readProfiles(page)).toEqual(Object.fromEntries([['__proto__', ['Beta#EUW']]]))
  await profile(page, '__proto__').click()
  await expectSelection(page, 'Beta#EUW')
  await remove(page, '__proto__')
  await expectSelection(page, 'Beta#EUW')

  // Save, reload and apply constructor against a genuinely different selection.
  await save(page, 'constructor', ['Beta#EUW'])
  await page.reload()
  await ready(page, 'Beta#EUW')
  await expect(profile(page, 'constructor')).toBeVisible()
  await chooseOnly(page, 'Alpha#EUW')
  await profile(page, 'constructor').click()
  await expectSelection(page, 'Beta#EUW')

  const other = await context.newPage()
  other.on('pageerror', (error) => pageErrors.push({ page: 'secondaria', message: error.message }))
  try {
    await other.emulateMedia({ reducedMotion: 'reduce' })
    await other.goto('/app/profile')
    await ready(other, 'Beta#EUW')
    await other.reload()
    await ready(other, 'Beta#EUW')
    await expect(profile(other, 'constructor')).toBeVisible()
    await chooseOnly(other, 'Alpha#EUW')
    await expectSelection(page, 'Beta#EUW')
    const beforeIncoming = await nativeEvents(page)
    await save(other, '__proto__', ['Alpha#EUW'])
    await expect.poll(() => nativeEvents(page)).toBeGreaterThan(beforeIncoming)
    await expect(profile(page, '__proto__')).toBeVisible()
    await expect(profile(page, 'constructor')).toBeVisible()
    await expectSelection(page, 'Beta#EUW')
    await expectSelection(other, 'Alpha#EUW')
    expect(await readProfiles(other)).toEqual(Object.fromEntries([
      ['constructor', ['Beta#EUW']], ['__proto__', ['Alpha#EUW']],
    ]))
    await other.reload()
    await ready(other, 'Alpha#EUW')
    await expect(profile(other, '__proto__')).toBeVisible()
    await expect(profile(other, 'constructor')).toBeVisible()
    await profile(page, '__proto__').click()
    await expectSelection(page, 'Alpha#EUW')
    await expectSelection(other, 'Alpha#EUW')

    const beforeDelete = await nativeEvents(other)
    await remove(page, 'constructor')
    await expect.poll(() => nativeEvents(other)).toBeGreaterThan(beforeDelete)
    await expect(profile(other, 'constructor')).toHaveCount(0)
    await expect(profile(other, '__proto__')).toBeVisible()
    await expectSelection(other, 'Alpha#EUW')
    await remove(page, '__proto__')
    await expect(profile(other, '__proto__')).toHaveCount(0)
    await expectSelection(page, 'Alpha#EUW')
    await expectSelection(other, 'Alpha#EUW')
    expect(await readProfiles(page)).toEqual({})
    await page.reload()
    await ready(page, 'Alpha#EUW')
    await other.reload()
    await ready(other, 'Alpha#EUW')
    await expect(page.locator('.saved-profile__apply')).toHaveCount(0)
    await expect(other.locator('.saved-profile__apply')).toHaveCount(0)
  } finally {
    await other.close()
  }
  expect(unexpectedWrites).toEqual([])
  expect(pageErrors).toEqual([])
})
