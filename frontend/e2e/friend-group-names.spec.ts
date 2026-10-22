import { expect, test } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import type { AccountsResponseDto, FriendGroupDto, FriendsResponseDto, SyncStatusResponseDto } from '../src/api/types'

test('gruppi: nomi Unicode riusati e conflitti correggibili senza perdere la bozza @smoke', async ({ page }, testInfo) => {
  test.setTimeout(60_000)
  const [accountsResponse, syncResponse] = await Promise.all([
    page.request.get('/api/accounts'),
    page.request.get('/api/sync-status'),
  ])
  expect(accountsResponse.status()).toBe(200)
  expect(syncResponse.status()).toBe(200)
  const accounts = await accountsResponse.json() as AccountsResponseDto
  const sync = await syncResponse.json() as SyncStatusResponseDto
  // Refuse every write unless this is the known disposable E2E dataset.
  expect(accounts.items.map((item) => item.account).sort()).toEqual(['Alpha#EUW', 'Beta#EUW'])
  expect(sync.metadata.source).toBe('synthetic')
  expect(sync.metadata.window).toBe('fixture E2E · 2026-08-24')

  const project = testInfo.project.name.replace(/[^a-z0-9]/gi, '').toLowerCase()
  const token = `${project.slice(0, 2)}${randomUUID().slice(0, 8)}`
  const suffix = `${project}-${token}`
  const cases = [
    { display: 'Équipe', variant: 'éQUIPE', label: 'accento' },
    { display: 'Straße', variant: 'STRASSE', label: 'casefold' },
  ].map((item, index) => ({
    display: `${item.display} · ${suffix}`,
    variant: `${item.variant} · ${suffix}`,
    other: `Altro ${item.label} · ${suffix}`,
    corrected: `Corretto ${item.label} · ${suffix}`,
    firstAlias: `u${token}${index}a#EUW`,
    secondAlias: `u${token}${index}b#EUW`,
    otherAlias: `u${token}${index}c#EUW`,
  }))
  const generatedNames = new Set(cases.flatMap((item) => [item.display, item.variant, item.other, item.corrected]))
  const generatedAliases = new Set(cases.flatMap((item) => [item.firstAlias, item.secondAlias, item.otherAlias]))
  const friendsQuery = new URLSearchParams({ account: 'Alpha#EUW', role: 'ALL', queue: 'all', days: 'all', min_shared_games: '1' })
  const readGroups = async () => {
    const response = await page.request.get(`/api/friends?${friendsQuery}`)
    expect(response.status()).toBe(200)
    return (await response.json() as FriendsResponseDto).manual_groups
  }
  const baseline = await readGroups()
  const baselineIds = new Set(baseline.map((group) => String(group.id)))
  expect(baseline.some((group) => generatedNames.has(group.name) || group.aliases.some((alias) => generatedAliases.has(alias)))).toBe(false)
  const ownedIds = new Map<string, FriendGroupDto['id']>()
  const dismissNotifications = async () => {
    const close = page.getByRole('button', { name: 'Chiudi notifica', exact: true })
    while (await close.count()) await close.last().click()
  }
  const rememberGenerated = async () => {
    const groups = await readGroups()
    for (const group of groups) {
      if (baselineIds.has(String(group.id))) continue
      if (generatedNames.has(group.name) || (group.aliases.length > 0 && group.aliases.every((alias) => generatedAliases.has(alias)))) {
        ownedIds.set(String(group.id), group.id)
      }
    }
    return groups
  }
  const createGroup = async (name: string, alias: string) => {
    await page.getByRole('button', { name: 'Nuovo gruppo', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Crea gruppo di nomi', exact: true })
    await dialog.getByLabel('Nome gruppo', { exact: true }).fill(name)
    await dialog.getByLabel('Alias, separati da virgola', { exact: true }).fill(alias)
    const saved = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/friend-groups'
      && response.request().method() === 'POST' && response.request().postDataJSON().name === name)
    await dialog.getByRole('button', { name: 'Crea gruppo', exact: true }).click()
    expect((await saved).status()).toBe(200)
    await expect(dialog).toBeHidden()
    const group = (await rememberGenerated()).find((item) => item.aliases.includes(alias))
    expect(group).toBeDefined()
    expect(baselineIds.has(String(group!.id))).toBe(false)
    // Complete the notification interaction before scrolling to a group on
    // narrow screens, where the notification can cover its action buttons.
    await dismissNotifications()
    return group!
  }

  await page.route('https://ddragon.leagueoflegends.com/**', (route) => route.abort())
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.addInitScript(() => {
    localStorage.setItem('champion-fit-profile-accounts', JSON.stringify(['Alpha#EUW']))
    localStorage.setItem('champion-fit:data-view:v2', JSON.stringify({ view: 'list' }))
  })
  try {
    await page.goto('/app/team/friends?min_games=1&role=ALL&queue=all')
    await expect(page.getByRole('button', { name: 'Nuovo gruppo', exact: true })).toBeVisible()
    await page.reload()
    await expect(page.getByRole('button', { name: 'Nuovo gruppo', exact: true })).toBeVisible()
    for (const item of cases) {
      const initial = await createGroup(item.display, item.firstAlias)
      const reused = await createGroup(item.variant, item.secondAlias)
      expect(String(reused.id)).toBe(String(initial.id))
      expect(reused.name).toBe(item.display)
      expect(reused.aliases).toEqual(expect.arrayContaining([item.firstAlias, item.secondAlias]))
      const original = page.locator('.friend-group-list > article').filter({ has: page.getByRole('button', { name: `Rinomina ${item.display}`, exact: true }) })
      await expect(original).toHaveCount(1)
      await expect(original).toContainText(item.firstAlias)
      await expect(original).toContainText(item.secondAlias)
      await expect(page.getByRole('button', { name: `Rinomina ${item.variant}`, exact: true })).toHaveCount(0)

      const other = await createGroup(item.other, item.otherAlias)
      await page.getByRole('button', { name: `Rinomina ${item.other}`, exact: true }).click()
      const dialog = page.getByRole('dialog', { name: 'Rinomina gruppo di nomi', exact: true })
      const draft = dialog.getByLabel('Nuovo nome', { exact: true })
      await draft.fill(item.variant)
      const path = `/api/friend-groups/${other.id}`
      const conflict = page.waitForResponse((response) => new URL(response.url()).pathname === path
        && response.request().method() === 'PATCH' && response.request().postDataJSON().name === item.variant)
      await dialog.getByRole('button', { name: 'Salva nome', exact: true }).click()
      expect((await conflict).status()).toBe(409)
      await expect(dialog).toBeVisible()
      await expect(draft).toHaveValue(item.variant)
      await expect(draft).toBeEnabled()
      const afterConflict = await rememberGenerated()
      expect(afterConflict.find((group) => String(group.id) === String(other.id))).toMatchObject({ name: item.other, aliases: [item.otherAlias] })
      expect(afterConflict.find((group) => String(group.id) === String(initial.id))).toMatchObject({ name: item.display })

      await draft.fill(item.corrected)
      const renamed = page.waitForResponse((response) => new URL(response.url()).pathname === path
        && response.request().method() === 'PATCH' && response.request().postDataJSON().name === item.corrected)
      await dialog.getByRole('button', { name: 'Salva nome', exact: true }).click()
      expect((await renamed).status()).toBe(200)
      await expect(dialog).toBeHidden()
      await expect(page.getByRole('button', { name: `Rinomina ${item.corrected}`, exact: true })).toBeVisible()
      expect((await rememberGenerated()).find((group) => String(group.id) === String(other.id))).toMatchObject({ name: item.corrected, aliases: [item.otherAlias] })
      await dismissNotifications()
    }
  } finally {
    const failures: unknown[] = []
    // Also discover a just-created group if an assertion failed before its readback.
    try { await rememberGenerated() } catch (error) { failures.push(error) }
    for (const [key, id] of ownedIds) {
      if (baselineIds.has(key)) { failures.push(new Error('Refusing to remove a preexisting group')); continue }
      try {
        const removed = await page.request.delete(`/api/friend-groups/${id}`)
        expect(removed.status()).toBe(200)
      } catch (error) { failures.push(error) }
    }
    try { expect(await readGroups()).toEqual(baseline) } catch (error) { failures.push(error) }
    expect.soft(failures, 'Restore generated friend groups without changing preexisting rows').toEqual([])
  }
})
