import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { expect, test, type Locator } from '@playwright/test'
import type { FriendGroupDto, FriendsResponseDto } from '../src/api/types'

test('notifiche: azioni Amici in coda, errore lungo e recupero da tastiera @smoke', async ({ page }, testInfo) => {
  let groups: FriendGroupDto[] = [{ id: 7401, name: 'Gruppo notifiche', aliases: ['Originale#EUW'] }]
  const writes: { method: string; path: string }[] = []
  const unexpectedWrites: string[] = []
  const longError = `Creazione temporaneamente non disponibile. ${'Conserva i nomi inseriti e riprova quando il servizio sarà disponibile. '.repeat(45)}Riferimento: ${'ABC123'.repeat(50)}`

  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.clock.install({ time: new Date('2026-10-17T12:00:00Z') })
  await page.route('https://ddragon.leagueoflegends.com/**', (route) => route.abort())
  // Only GET requests reach the synthetic server. Every mutation below is local to this test.
  await page.route('**/api/**', (route) => {
    if (route.request().method() === 'GET') return route.fallback()
    unexpectedWrites.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`)
    return route.abort()
  })
  await page.route('**/api/friends?**', async (route) => {
    const response = await route.fetch()
    const payload = await response.json() as FriendsResponseDto
    payload.manual_groups = groups
    await route.fulfill({ response, json: payload })
  })
  await page.route(/\/api\/friend-groups(?:\/[^?]*)?(?:\?.*)?$/, async (route) => {
    const { pathname } = new URL(route.request().url())
    const method = route.request().method()
    writes.push({ method, path: pathname })
    if (method === 'POST' && pathname === '/api/friend-groups') {
      const body = route.request().postDataJSON() as { name: string; aliases: string[] }
      if (body.name === 'Gruppo non disponibile') {
        await route.fulfill({ status: 503, json: { error: longError } })
      } else {
        groups = [...groups, { id: 7402, name: body.name, aliases: body.aliases }]
        await route.fulfill({ json: { ok: true, name: body.name } })
      }
      return
    }
    const target = groups.find((group) => group.id === 7401)
    if (!target) throw new Error('The synthetic notification group must remain present')
    if (method === 'PATCH' && pathname === '/api/friend-groups/7401') {
      target.name = (route.request().postDataJSON() as { name: string }).name
      await route.fulfill({ json: { ok: true, id: target.id, name: target.name } })
      return
    }
    if (method === 'POST' && pathname === '/api/friend-groups/7401/aliases') {
      const { aliases } = route.request().postDataJSON() as { aliases: string[] }
      const added = aliases.filter((alias) => !target.aliases.includes(alias))
      target.aliases.push(...added)
      await route.fulfill({ json: { ok: true, id: target.id, added_aliases: added } })
      return
    }
    if (method === 'DELETE' && pathname === '/api/friend-groups/7401/aliases/Nuovo%23EUW') {
      target.aliases = target.aliases.filter((alias) => alias !== 'Nuovo#EUW')
      await route.fulfill({ json: { ok: true, id: target.id } })
      return
    }
    throw new Error(`Unexpected synthetic group action: ${method} ${pathname}`)
  })

  const renameButton = page.getByRole('button', { name: 'Rinomina Gruppo notifiche', exact: true })
  await page.goto('/app/team/friends')
  await expect(renameButton).toBeVisible()
  await page.reload()
  await expect(renameButton).toBeVisible()
  // Freeze expiry while normal UI actions enqueue messages. Tiny advances flush query notifications.
  await page.clock.pauseAt(new Date('2026-10-17T12:05:00Z'))
  const settleClosed = async (dialog: Locator) => {
    await expect.poll(async () => {
      await page.clock.runFor(25)
      return dialog.isVisible()
    }).toBe(false)
  }

  await renameButton.click()
  const rename = page.getByRole('dialog', { name: 'Rinomina gruppo di nomi', exact: true })
  await rename.getByRole('textbox', { name: 'Nuovo nome', exact: true }).fill('Gruppo aggiornato')
  await rename.getByRole('button', { name: 'Salva nome', exact: true }).click()
  await settleClosed(rename)

  await page.getByRole('button', { name: 'Nuovo gruppo', exact: true }).click()
  const create = page.getByRole('dialog', { name: 'Crea gruppo di nomi', exact: true })
  await create.getByRole('textbox', { name: 'Nome gruppo', exact: true }).fill('Gruppo non disponibile')
  await create.getByRole('textbox', { name: 'Alias, separati da virgola', exact: true }).fill('Errore#EUW')
  await create.getByRole('button', { name: 'Crea gruppo', exact: true }).click()
  await expect.poll(async () => {
    await page.clock.runFor(25)
    return create.getByRole('alert').isVisible()
  }).toBe(true)
  await expect(create.getByRole('textbox', { name: 'Nome gruppo', exact: true })).toHaveValue('Gruppo non disponibile')
  await create.getByRole('button', { name: 'Annulla', exact: true }).click()
  await settleClosed(create)

  for (let addition = 0; addition < 2; addition++) {
    await page.getByRole('button', { name: 'Aggiungi persone a Gruppo aggiornato', exact: true }).click()
    const add = page.getByRole('dialog', { name: 'Aggiungi persone a Gruppo aggiornato', exact: true })
    await add.getByRole('textbox', { name: 'Riot ID', exact: true }).fill('Nuovo#EUW')
    await add.getByRole('button', { name: 'Aggiungi al gruppo', exact: true }).click()
    await settleClosed(add)
  }
  await page.getByRole('button', { name: 'Rimuovi alias Nuovo#EUW', exact: true }).click()
  const remove = page.getByRole('dialog', { name: 'Rimuovere questo alias?', exact: true })
  await remove.getByRole('button', { name: 'Conferma rimozione', exact: true }).click()
  await settleClosed(remove)

  await page.getByRole('button', { name: 'Nuovo gruppo', exact: true }).click()
  await create.getByRole('textbox', { name: 'Nome gruppo', exact: true }).fill('Gruppo creato in prova')
  await create.getByRole('textbox', { name: 'Alias, separati da virgola', exact: true }).fill('Creato#EUW')
  await create.getByRole('button', { name: 'Crea gruppo', exact: true }).click()
  await settleClosed(create)

  const toast = page.locator('.toast-root')
  const close = page.getByRole('button', { name: 'Chiudi notifica', exact: true })
  const titles = ['Gruppo rinominato', 'Modifica non riuscita', 'Persone aggiunte', 'Nessun Riot ID nuovo', 'Alias rimosso', 'Gruppo creato']
  for (const [index, title] of titles.entries()) {
    await expect(toast).toHaveCount(1)
    await expect(close).toHaveCount(1)
    await expect(toast.locator('.toast-title')).toHaveText(title)
    const remaining = titles.length - index - 1
    if (remaining) {
      await expect(toast.locator('.toast-pending')).toHaveText(`${remaining} ${remaining === 1 ? 'notifica in attesa' : 'notifiche in attesa'}`)
    } else {
      await expect(toast.locator('.toast-pending')).toHaveCount(0)
    }

    if (title === 'Modifica non riuscita') {
      const details = toast.getByRole('region', { name: 'Dettagli della notifica', exact: true })
      await expect(details).toHaveText(longError)
      const overflow = await details.evaluate((element) => ({ height: element.clientHeight, content: element.scrollHeight }))
      expect(overflow.content).toBeGreaterThan(overflow.height)
      expect(overflow.height).toBeLessThanOrEqual(180)
      await page.keyboard.press('F8')
      await page.keyboard.press('Tab')
      await expect(toast).toBeFocused()
      await page.keyboard.press('Tab')
      await expect(details).toBeFocused()
      await page.keyboard.press('End')
      await page.clock.runFor(300)
      await expect.poll(() => details.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
      const viewport = page.viewportSize()!
      for (const element of [toast, close]) {
        const box = await element.boundingBox()
        expect(box).not.toBeNull()
        expect(box!.x).toBeGreaterThanOrEqual(0)
        expect(box!.y).toBeGreaterThanOrEqual(0)
        expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width)
        expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height)
      }
      const pageWidth = await page.locator('html').evaluate((element) => ({ content: element.scrollWidth, viewport: element.clientWidth }))
      expect(pageWidth.content).toBeLessThanOrEqual(pageWidth.viewport)
      if (testInfo.project.name === 'webkit-smoke') {
        await mkdir(new URL('../../outputs/', import.meta.url), { recursive: true })
        await page.screenshot({ path: fileURLToPath(new URL('../../outputs/toast-queue-mobile.png', import.meta.url)), animations: 'disabled' })
      }
      await page.keyboard.press('Tab')
      await expect(close).toBeFocused()
      await page.keyboard.press('Enter')
    } else {
      await close.click()
    }
    await page.clock.runFor(25)
  }
  await expect(toast).toHaveCount(0)
  expect(unexpectedWrites).toEqual([])
  expect(writes).toEqual([
    { method: 'PATCH', path: '/api/friend-groups/7401' },
    { method: 'POST', path: '/api/friend-groups' },
    { method: 'POST', path: '/api/friend-groups/7401/aliases' },
    { method: 'POST', path: '/api/friend-groups/7401/aliases' },
    { method: 'DELETE', path: '/api/friend-groups/7401/aliases/Nuovo%23EUW' },
    { method: 'POST', path: '/api/friend-groups' },
  ])
})
