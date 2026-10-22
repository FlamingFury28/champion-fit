import { expect, test } from '@playwright/test'
import type { FriendGroupDto, FriendsResponseDto } from '../src/api/types'

const targetId = '9007199254740993'
const neighborId = '9007199254740992'
const unconfirmed = 'L’esito della richiesta non è confermato'

for (const action of ['create', 'rename', 'add-aliases', 'delete-alias', 'delete-group'] as const) {
  test(`gruppi: ${action} conserva il modulo finché il server non conferma la richiesta esatta @smoke`, async ({ page }) => {
    let groups: FriendGroupDto[] = [{ id: targetId, name: 'Équipe', aliases: ['Friend#EUW', 'Keep#EUW'] }]
    const writes: Array<{ method: string; path: string; body: unknown }> = []
    const unexpectedWrites: string[] = []
    let reads = 0
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.route('https://ddragon.leagueoflegends.com/**', (route) => route.abort())
    await page.route('**/api/**', (route) => {
      if (route.request().method() === 'GET') return route.fallback()
      unexpectedWrites.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`)
      return route.abort()
    })
    await page.route('**/api/friends?**', async (route) => {
      reads += 1
      const response = await route.fetch()
      const payload = await response.json() as FriendsResponseDto
      payload.manual_groups = groups
      await route.fulfill({ response, json: payload })
    })
    await page.route(/\/api\/friend-groups(?:\/[^?]*)?(?:\?.*)?$/, async (route) => {
      const request = route.request()
      const method = request.method()
      if (method === 'GET') { await route.fallback(); return }
      const path = new URL(request.url()).pathname
      const body = method === 'DELETE' ? null : request.postDataJSON()
      writes.push({ method, path, body })
      if (writes.length === 1) {
        const invalid = action === 'create' ? {}
          : action === 'rename' ? { ok: true, id: neighborId, name: 'Nome aggiornato' }
            : action === 'add-aliases' ? { ok: true, id: targetId }
              : action === 'delete-alias' ? { ok: true, id: neighborId } : { ok: true }
        await route.fulfill({ json: invalid })
        return
      }
      if (writes.length !== 2) throw new Error('Unexpected automatic retry')
      if (action === 'create') {
        groups[0]!.aliases.push('Altro#EUW')
        await route.fulfill({ json: { ok: true, name: 'éQUIPE' } })
      } else if (action === 'rename') {
        groups[0]!.name = 'Nome aggiornato'
        await route.fulfill({ json: { ok: true, id: targetId, name: 'Nome aggiornato' } })
      } else if (action === 'add-aliases') {
        // Adding an existing alias is a valid no-op, acknowledged by an empty array.
        await route.fulfill({ json: { ok: true, id: targetId, added_aliases: [] } })
      } else if (action === 'delete-alias') {
        groups[0]!.aliases = ['Keep#EUW']
        await route.fulfill({ json: { ok: true, id: targetId } })
      } else {
        groups = []
        await route.fulfill({ json: { ok: true, id: targetId } })
      }
    })

    await page.goto('/app/team/friends')
    const rename = page.getByRole('button', { name: 'Rinomina Équipe', exact: true })
    await expect(rename).toBeVisible()
    await page.reload()
    await expect(rename).toBeVisible()
    const trigger = action === 'create' ? 'Nuovo gruppo' : action === 'rename' ? 'Rinomina Équipe'
      : action === 'add-aliases' ? 'Aggiungi persone a Équipe'
        : action === 'delete-alias' ? 'Rimuovi alias Friend#EUW' : 'Elimina Équipe'
    await page.getByRole('button', { name: trigger, exact: true }).click()
    const dialog = page.getByRole('dialog')
    const field = action === 'create' ? dialog.getByRole('textbox', { name: 'Nome gruppo', exact: true })
      : action === 'rename' ? dialog.getByRole('textbox', { name: 'Nuovo nome', exact: true })
        : action === 'add-aliases' ? dialog.getByRole('textbox', { name: 'Riot ID', exact: true }) : null
    const draft = action === 'create' ? 'éQUIPE' : action === 'rename' ? 'Nome aggiornato' : 'Friend#EUW'
    if (field) await field.fill(draft)
    if (action === 'create') await dialog.getByRole('textbox', { name: 'Alias, separati da virgola', exact: true }).fill('Altro#EUW')
    const original = field ? await field.elementHandle() : null
    const submitName = action === 'create' ? 'Crea gruppo' : action === 'rename' ? 'Salva nome'
      : action === 'add-aliases' ? 'Aggiungi al gruppo' : 'Conferma rimozione'
    const submit = dialog.getByRole('button', { name: submitName, exact: true })
    const readsBefore = reads
    await submit.click()
    await expect(dialog.getByRole('alert')).toContainText(unconfirmed)
    await expect(submit).toBeEnabled()
    await expect(dialog).toBeVisible()
    if (field) {
      await expect(field).toHaveValue(draft)
      expect(await field.evaluate((element, previous) => element === previous, original)).toBe(true)
    }
    expect(writes).toHaveLength(1)
    expect(reads).toBe(readsBefore)

    await submit.click()
    await expect(dialog).toBeHidden()
    await expect.poll(() => reads).toBe(readsBefore + 1)
    expect(writes).toHaveLength(2)
    expect(writes[1]).toEqual(writes[0])
    const expectedMethod = action === 'create' || action === 'add-aliases' ? 'POST' : action === 'rename' ? 'PATCH' : 'DELETE'
    const expectedPath = action === 'create' ? '/api/friend-groups'
      : `/api/friend-groups/${targetId}${action === 'add-aliases' ? '/aliases' : action === 'delete-alias' ? '/aliases/Friend%23EUW' : ''}`
    expect(writes[0]).toMatchObject({ method: expectedMethod, path: expectedPath })
    if (action === 'create') {
      await expect(rename).toBeVisible()
      await expect(page.getByRole('button', { name: 'Rinomina éQUIPE', exact: true })).toHaveCount(0)
    } else if (action === 'rename') await expect(page.getByRole('button', { name: 'Rinomina Nome aggiornato', exact: true })).toBeVisible()
    else if (action === 'delete-group') await expect(rename).toHaveCount(0)
    else if (action === 'delete-alias') await expect(page.getByRole('button', { name: 'Rimuovi alias Friend#EUW', exact: true })).toHaveCount(0)
    else await expect(page.getByRole('button', { name: 'Rimuovi alias Friend#EUW', exact: true })).toBeVisible()
    expect(unexpectedWrites).toEqual([])
    await original?.dispose()
  })
}
