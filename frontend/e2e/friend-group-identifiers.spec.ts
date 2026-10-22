import { expect, test } from '@playwright/test'
import type { FriendGroupDto, FriendsResponseDto } from '../src/api/types'

test('gruppi: le quattro azioni conservano ID adiacenti oltre la precisione JS @smoke', async ({ page }) => {
  const neighborId = '9007199254740992'
  const targetId = '9007199254740993'
  let groups: FriendGroupDto[] = [
    { id: neighborId, name: 'Gruppo vicino', aliases: ['Neighbor#EUW'] },
    { id: targetId, name: 'Gruppo da modificare', aliases: ['Target#EUW'] },
  ]
  const requests: { method: string; path: string }[] = []
  await page.route('https://ddragon.leagueoflegends.com/**', (route) => route.abort())
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.route('**/api/**', (route) => route.request().method() === 'GET' ? route.fallback() : route.abort())
  await page.route('**/api/friends?**', async (route) => {
    const response = await route.fetch()
    const payload = await response.json() as FriendsResponseDto
    payload.manual_groups = groups
    await route.fulfill({ response, json: payload })
  })
  await page.route('**/api/friend-groups/**', async (route) => {
    const { pathname } = new URL(route.request().url())
    const method = route.request().method()
    requests.push({ method, path: pathname })
    const [, , , id, resource, encodedAlias] = pathname.split('/')
    if (id !== targetId) {
      await route.fulfill({ status: 400, json: { error: 'Wrong group identifier' } })
      return
    }
    const target = groups.find((group) => group.id === id)
    if (!target) throw new Error('The target group was already removed')
    if (method === 'PATCH') target.name = (route.request().postDataJSON() as { name: string }).name
    else if (method === 'POST') target.aliases.push(...(route.request().postDataJSON() as { aliases: string[] }).aliases)
    else if (resource === 'aliases') {
      if (!encodedAlias) throw new Error('Expected an encoded alias in the removal request')
      const aliasToRemove = decodeURIComponent(encodedAlias)
      target.aliases = target.aliases.filter((alias) => alias !== aliasToRemove)
    }
    else groups = groups.filter((group) => group.id !== id)
    await route.fulfill({ json: { ok: true, id, name: method === 'PATCH' ? target.name : undefined, added_aliases: method === 'POST' ? ['Added#EUW'] : undefined } })
  })

  await page.goto('/app/team/friends')
  await page.reload()
  await page.getByRole('button', { name: 'Rinomina Gruppo da modificare', exact: true }).click()
  const rename = page.getByRole('dialog', { name: 'Rinomina gruppo di nomi', exact: true })
  await rename.getByRole('textbox', { name: 'Nuovo nome', exact: true }).fill('Gruppo aggiornato')
  await rename.getByRole('button', { name: 'Salva nome', exact: true }).click()
  await expect(rename).toBeHidden()
  await page.getByRole('button', { name: 'Aggiungi persone a Gruppo aggiornato', exact: true }).click()
  const add = page.getByRole('dialog', { name: 'Aggiungi persone a Gruppo aggiornato', exact: true })
  await add.getByRole('textbox', { name: 'Riot ID', exact: true }).fill('Added#EUW')
  await add.getByRole('button', { name: 'Aggiungi al gruppo', exact: true }).click()
  await expect(add).toBeHidden()
  await page.getByRole('button', { name: 'Rimuovi alias Target#EUW', exact: true }).click()
  const removeAlias = page.getByRole('dialog', { name: 'Rimuovere questo alias?', exact: true })
  await removeAlias.getByRole('button', { name: 'Conferma rimozione', exact: true }).click()
  await expect(removeAlias).toBeHidden()
  await expect(page.getByRole('button', { name: 'Rimuovi alias Added#EUW', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Elimina Gruppo aggiornato', exact: true }).click()
  const removeGroup = page.getByRole('dialog', { name: 'Rimuovere questo gruppo?', exact: true })
  await removeGroup.getByRole('button', { name: 'Conferma rimozione', exact: true }).click()
  await expect(removeGroup).toBeHidden()
  await expect(page.getByRole('button', { name: 'Rinomina Gruppo vicino', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Rimuovi alias Neighbor#EUW', exact: true })).toBeVisible()
  expect(requests).toEqual([
    { method: 'PATCH', path: `/api/friend-groups/${targetId}` },
    { method: 'POST', path: `/api/friend-groups/${targetId}/aliases` },
    { method: 'DELETE', path: `/api/friend-groups/${targetId}/aliases/Target%23EUW` },
    { method: 'DELETE', path: `/api/friend-groups/${targetId}` },
  ])
})
