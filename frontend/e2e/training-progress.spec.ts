import { expect, test } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

test('piano seguito persistente, filtri indipendenti e nessuna sincronizzazione esterna @smoke', async ({ page }, testInfo) => {
  await page.route('https://ddragon.leagueoflegends.com/**', (route) => route.abort())
  const writes: string[] = []
  page.on('request', (request) => { if (request.method() !== 'GET') writes.push(request.url()) })
  await page.goto('/app/fit?section=tournament&budget=20&role=MIDDLE&queue=420&days=all')
  await page.reload()
  const panel = page.getByRole('region', { name: 'Avanzamento del piano' })
  await expect(panel.getByRole('button', { name: 'Segui questo piano' })).toBeEnabled()
  expect(writes).toEqual([])
  await panel.getByRole('button', { name: 'Segui questo piano' }).click()
  await expect(panel.getByText('0/20 completate · 20 rimanenti')).toBeVisible()
  await expect(panel.getByRole('heading', { name: 'Prossima partita: Ahri · Corsia centrale' })).toBeVisible()
  const savedURL = page.url()
  await page.getByRole('combobox', { name: 'Modalità', exact: true }).selectOption('440')
  await expect(panel.getByText('0/20 completate · 20 rimanenti')).toBeVisible()
  await expect(panel).toContainText('Solo/Duo')
  await expect(panel.getByRole('heading', { name: 'Prossima partita: Ahri · Corsia centrale' })).toBeVisible()
  await page.goto('/app/matches')
  await expect(page.getByRole('heading', { name: 'Le mie partite', exact: true })).toBeVisible()
  await page.goto('/app/fit?section=tournament')
  await page.reload()
  await expect(panel.getByText('0/20 completate · 20 rimanenti')).toBeVisible()
  await panel.getByText('Dettaglio delle partite rimanenti').click()
  await expect(panel).toContainText('Ahri')
  await expect(panel).toContainText('Alpha#EUW')
  expect((await new AxeBuilder({ page }).include('.training-progress').analyze()).violations).toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
  await panel.screenshot({ path: testInfo.outputPath('training-progress.png') })
  await panel.getByRole('button', { name: 'Smetti di seguire' }).click()
  await expect(panel.getByRole('button', { name: 'Segui questo piano' })).toBeVisible()
  await page.goto(savedURL)
  await expect(panel.getByText('0/20 completate · 20 rimanenti')).toBeVisible()
  expect(writes).toHaveLength(1)
  expect(new URL(writes[0]!).pathname).toBe('/api/training-progress')
})

test('l’esito di un’importazione manuale aggiorna il conteggio senza premere aggiorna @smoke', async ({ page }) => {
  await page.route('https://ddragon.leagueoflegends.com/**', (route) => route.abort())
  await page.clock.install()
  await page.goto('/app/fit?section=tournament&budget=20&role=MIDDLE&queue=420&days=all')
  await page.reload()
  const panel = page.getByRole('region', { name: 'Avanzamento del piano' })
  await expect(panel.getByRole('button', { name: 'Segui questo piano' })).toBeEnabled()
  await panel.getByRole('button', { name: 'Segui questo piano' }).click()
  await expect(panel.getByText('0/20 completate · 20 rimanenti')).toBeVisible()
  // The browser observes only local import status. Actual archive counting is
  // verified through real ingestion and HTTP requests in test_training_progress.py.
  await page.route('**/api/training-progress?*', async (route) => {
    const response = await route.fetch()
    const data = await response.json()
    data.completed = 1
    data.remaining = 19
    data.items[0].completed = 1
    data.items[0].remaining -= 1
    data.items[0].accounts[0].completed = 1
    data.items[0].accounts[0].remaining -= 1
    await route.fulfill({ response, json: data })
  })
  await page.route('**/api/sync-status', async (route) => {
    const response = await route.fetch()
    await route.fulfill({ response, json: { ...await response.json(), last_completed_at: '2026-10-22T15:00:01Z' } })
  })
  await page.clock.fastForward(30_100)
  await expect(panel.getByText('1/20 completate · 19 rimanenti')).toBeVisible()
  await expect(panel).toContainText('Più partite rimanenti nel piano: 19.')
})

test('il prossimo campione cambia con le partite rimanenti, senza nuove scritture @smoke', async ({ page }, testInfo) => {
  await page.route('https://ddragon.leagueoflegends.com/**', (route) => route.abort())
  const id = '11111111-1111-4111-8111-111111111111'
  let imported = false
  const counts = (planned: number, remaining: number) => ({ planned, remaining, completed: planned - remaining, extra: 0 })
  await page.route('**/api/training-progress?*', (route) => route.fulfill({ json: {
    id, fingerprint: 'a'.repeat(64), started_at: '2026-10-22T10:00:00Z', budget_total: 20,
    ...counts(20, imported ? 8 : 11), queue: '420', accounts: ['Alpha#EUW'], companions: [], companion_mode: '',
    unavailable_accounts: [], companion_unavailable: false,
    items: [['Ahri', 'MIDDLE', 12, imported ? 3 : 6], ['Lux', 'SUPPORT', 8, 5]].map(([champion, role, planned, remaining]) => ({
      champion, role, ...counts(Number(planned), Number(remaining)), accounts: [{ account: 'Alpha#EUW', ...counts(Number(planned), Number(remaining)) }],
    })),
  } }))
  const writes: string[] = []
  page.on('request', (request) => { if (request.method() !== 'GET') writes.push(request.url()) })
  await page.clock.install()
  await page.goto(`/app/fit?section=tournament&budget=20&tracked_plan=${id}`)
  await page.reload()
  const panel = page.getByRole('region', { name: 'Avanzamento del piano' })
  await expect(panel.getByRole('heading', { name: 'Prossima partita: Ahri · Corsia centrale' })).toBeVisible()
  await page.route('**/api/sync-status', async (route) => {
    const response = await route.fetch()
    await route.fulfill({ response, json: { ...await response.json(), last_completed_at: '2026-10-22T15:00:01Z' } })
  })
  imported = true
  await page.clock.fastForward(30_100)
  await expect(panel.getByRole('heading', { name: 'Prossima partita: Lux · Supporto' })).toBeVisible()
  await expect(panel).toContainText('Più partite rimanenti nel piano: 5. Account: Alpha#EUW (5 da completare).')
  expect((await new AxeBuilder({ page }).include('.training-progress').analyze()).violations).toEqual([])
  if (testInfo.project.name === 'webkit-smoke') await page.setViewportSize({ width: 320, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
  await panel.screenshot({ path: testInfo.outputPath('next-planned-game.png') })
  expect(writes).toEqual([])
})
