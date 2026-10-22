import { expect, test } from '@playwright/test'

for (const failure of ['unavailable', 'null', 'truncated', 'empty', 'partial'] as const) {
test(`configurazione: una bozza resta aperta durante errore e recupero (${failure}) @smoke`, async ({ page }, testInfo) => {
  let phase: 'ready' | 'failed' | 'recovered' = 'ready'
  let failedSettingsRequests = 0
  await page.route('https://ddragon.leagueoflegends.com/**', (route) => route.abort())
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.route('**/api/**', (route) => route.request().method() === 'GET' ? route.fallback() : route.abort())
  await page.route('**/api/sync-status', async (route) => {
    if (route.request().method() !== 'GET') { await route.fallback(); return }
    if (phase === 'failed') await route.fulfill({ status: 409, json: { error: 'Configuration changed' } })
    else await route.fallback()
  })
  await page.route('**/api/algorithm-settings', async (route) => {
    if (route.request().method() !== 'GET') { await route.fallback(); return }
    if (phase === 'failed') {
      failedSettingsRequests += 1
      if (failure === 'unavailable') await route.fulfill({ status: 503, json: { error: 'Temporarily unavailable' } })
      else if (failure === 'empty' || failure === 'partial') await route.fulfill({ status: 200, json: failure === 'empty' ? {} : { revision: 2 } })
      else await route.fulfill({ status: 200, contentType: 'application/json', body: failure === 'null' ? 'null' : '{"revision":' })
    } else await route.fallback()
  })

  await page.goto('/app/profile')
  const draft = page.getByRole('textbox', { name: 'Nome profilo', exact: true })
  await expect(draft).toBeVisible()
  await page.reload()
  await expect(draft).toBeVisible()
  await draft.fill('Sessione in preparazione')
  const originalInput = await draft.elementHandle()
  if (!originalInput) throw new Error('Profile name input was not mounted')

  phase = 'failed'
  // Expire the status query without waiting for its polling interval. A real
  // visibility event refetches it; its 409 exercises the global recovery path.
  await page.clock.setFixedTime(Date.now() + 60_000)
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    document.dispatchEvent(new Event('visibilitychange', { bubbles: true }))
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    document.dispatchEvent(new Event('visibilitychange', { bubbles: true }))
  })
  const notice = page.getByRole('status').filter({ hasText: 'Uso l’ultima configurazione disponibile' })
  await expect(notice).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  expect(await notice.getByRole('button', { name: 'Riprova aggiornamento', exact: true }).evaluate((button) => {
    const range = document.createRange()
    range.selectNodeContents(button)
    const text = range.getBoundingClientRect()
    const bounds = button.getBoundingClientRect()
    return text.left >= bounds.left - 1 && text.right <= bounds.right + 1
      && text.top >= bounds.top - 1 && text.bottom <= bounds.bottom + 1
  })).toBe(true)
  expect(failedSettingsRequests).toBeGreaterThan(0)
  await expect(draft).toHaveValue('Sessione in preparazione')
  expect(await draft.evaluate((element, original) => element === original, originalInput)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('settings-refresh-draft.png'), fullPage: true })

  phase = 'recovered'
  await notice.getByRole('button', { name: 'Riprova aggiornamento', exact: true }).click()
  await expect(notice).toHaveCount(0)
  await expect(draft).toHaveValue('Sessione in preparazione')
  expect(await draft.evaluate((element, original) => element === original, originalInput)).toBe(true)
  await originalInput.dispose()
})
}
