import { expect, test } from '@playwright/test'

function gate() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
}

for (const outcome of ['success', 'error'] as const) {
  test(`una risposta tardiva ${outcome} non modifica il nuovo gruppo in bozza`, async ({ page }) => {
    const pending = gate()
    let submitted = false
    await page.route(/\/api\/friend-groups$/, async (route) => {
      if (route.request().method() !== 'POST') { await route.continue(); return }
      const { name } = route.request().postDataJSON() as { name: string }
      submitted = true
      await pending.promise
      await route.fulfill(outcome === 'success'
        ? { json: { ok: true, name } }
        : { status: 503, json: { error: 'Richiesta del vecchio gruppo fallita' } })
    })
    try {
      await page.goto('/app/team/friends')
      await expect(page.getByRole('button', { name: 'Nuovo gruppo' })).toBeVisible()
      await page.reload()
      await page.getByRole('button', { name: 'Nuovo gruppo' }).click()
      const dialog = page.getByRole('dialog', { name: 'Crea gruppo di nomi' })
      await dialog.getByLabel('Nome gruppo').fill('Gruppo A')
      await dialog.getByLabel('Alias, separati da virgola').fill('A#EUW')
      await dialog.getByRole('button', { name: 'Crea gruppo', exact: true }).click()
      await expect.poll(() => submitted).toBe(true)
      await expect(dialog.getByLabel('Nome gruppo')).toBeDisabled()
      await dialog.getByRole('button', { name: 'Annulla' }).click()
      await page.getByRole('button', { name: 'Nuovo gruppo' }).click()
      await dialog.getByLabel('Nome gruppo').fill('Gruppo B')
      await dialog.getByLabel('Alias, separati da virgola').fill('B#EUW')
      pending.release()
      await expect(page.getByText(outcome === 'success' ? 'Gruppo creato' : 'Modifica non riuscita', { exact: true })).toBeVisible()
      await expect(dialog).toBeVisible()
      await expect(dialog.getByLabel('Nome gruppo')).toHaveValue('Gruppo B')
      await expect(dialog.getByLabel('Alias, separati da virgola')).toHaveValue('B#EUW')
      await expect(dialog.getByRole('button', { name: 'Crea gruppo', exact: true })).toBeEnabled()
      await expect(dialog.getByRole('alert')).toHaveCount(0)
    } finally { pending.release() }
  })
}

test('la prima risposta non chiude il secondo gruppo già in salvataggio', async ({ page }) => {
  const first = gate()
  const second = gate()
  const requests: string[] = []
  await page.route(/\/api\/friend-groups$/, async (route) => {
    if (route.request().method() !== 'POST') { await route.continue(); return }
    const { name } = route.request().postDataJSON() as { name: string }
    requests.push(name)
    await (name === 'Gruppo A' ? first.promise : second.promise)
    await route.fulfill({ json: { ok: true, name } })
  })
  try {
    await page.goto('/app/team/friends')
    await expect(page.getByRole('button', { name: 'Nuovo gruppo' })).toBeVisible()
    await page.reload()
    await page.getByRole('button', { name: 'Nuovo gruppo' }).click()
    const dialog = page.getByRole('dialog', { name: 'Crea gruppo di nomi' })
    await dialog.getByLabel('Nome gruppo').fill('Gruppo A')
    await dialog.getByLabel('Alias, separati da virgola').fill('A#EUW')
    await dialog.getByRole('button', { name: 'Crea gruppo', exact: true }).click()
    await expect.poll(() => requests).toEqual(['Gruppo A'])
    await dialog.getByRole('button', { name: 'Annulla' }).click()
    await page.getByRole('button', { name: 'Nuovo gruppo' }).click()
    await dialog.getByLabel('Nome gruppo').fill('Gruppo B')
    await dialog.getByLabel('Alias, separati da virgola').fill('B#EUW')
    await dialog.getByRole('button', { name: 'Crea gruppo', exact: true }).click()
    await expect.poll(() => requests).toEqual(['Gruppo A', 'Gruppo B'])
    first.release()
    await expect(page.getByText('Gruppo creato', { exact: true })).toBeVisible()
    await expect(dialog).toBeVisible()
    await expect(dialog.getByLabel('Nome gruppo')).toHaveValue('Gruppo B')
    await expect(dialog.getByLabel('Nome gruppo')).toBeDisabled()
    await expect(dialog.getByRole('button', { name: 'Creazione…', exact: true })).toBeDisabled()
    second.release()
    await expect(dialog).toBeHidden()
  } finally { first.release(); second.release() }
})
