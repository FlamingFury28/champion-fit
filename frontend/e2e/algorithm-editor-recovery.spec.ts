import { expect, test } from '@playwright/test'
import type { AlgorithmSettings, AlgorithmSettingsResponseDto } from '../src/api/types'

test('algoritmi: buffer incompleto conservato dopo errore GET e risposta PUT persa @smoke', async ({ page }) => {
  let phase: 'ready' | 'offline' | 'recovered' = 'ready'
  let active: AlgorithmSettingsResponseDto | undefined
  const writes: { expected_revision: number; settings: AlgorithmSettings }[] = []
  const previews: { expected_revision: number; settings: AlgorithmSettings }[] = []
  const unexpectedWrites: string[] = []
  await page.route('https://ddragon.leagueoflegends.com/**', (route) => route.abort())
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.route('**/api/**', (route) => {
    if (route.request().method() === 'GET') return route.fallback()
    unexpectedWrites.push(route.request().url())
    return route.abort()
  })
  await page.route('**/api/sync-status', async (route) => {
    if (phase === 'offline') await route.fulfill({ status: 409, json: { error: 'Configuration changed' } })
    else await route.fallback()
  })
  await page.route('**/api/algorithm-settings', async (route) => {
    if (route.request().method() === 'PUT') {
      writes.push(route.request().postDataJSON())
      // The client cannot know whether a server committed a response it never received.
      await route.abort('connectionreset')
      return
    }
    if (phase === 'offline') {
      await route.fulfill({ status: 503, json: { error: 'Configurazione temporaneamente non disponibile' } })
      return
    }
    if (phase === 'recovered') {
      if (!active) throw new Error('The initial synthetic settings must be loaded first')
      await route.fulfill({ json: {
        ...active, revision: active.revision + 1, fingerprint: 'synthetic-remote-revision',
        settings: { ...active.settings, attribution: { ...active.settings.attribution as Record<string, unknown>, loss_weights: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5] } },
      } })
      return
    }
    const response = await route.fetch()
    active = await response.json() as AlgorithmSettingsResponseDto
    await route.fulfill({ response, json: active })
  })
  await page.route('**/api/algorithm-settings/preview', async (route) => {
    const submitted = route.request().postDataJSON()
    previews.push(submitted)
    await route.fulfill({ json: {
      base_revision: submitted.expected_revision, proposed_fingerprint: 'synthetic-recovery-preview',
      changed_paths: ['attribution.loss_weights'], comparisons: [], sensitivity: [], context: {}, notes: [],
    } })
  })

  await page.goto('/app/settings/algorithms')
  const budget = page.getByRole('spinbutton', { name: 'Budget di prova', exact: true })
  await expect(budget).toBeVisible()
  await page.reload()
  await expect(budget).toBeVisible()
  if (!active) throw new Error('No settings snapshot was loaded after the full refresh')
  const originalRevision = active.revision
  await budget.fill('4')
  await page.getByText('Attribuzione', { exact: true }).click()
  const weights = page.getByRole('textbox', { name: 'Pesi sconfitte', exact: true })
  await weights.fill('0.25, -')
  const originalInput = await weights.elementHandle()
  if (!originalInput) throw new Error('The weights editor was not mounted')
  const apply = page.getByRole('button', { name: 'Applica impostazioni', exact: true })
  const preview = page.getByRole('button', { name: 'Calcola anteprima', exact: true })
  await expect(apply).toBeDisabled()
  await expect(preview).toBeDisabled()
  await expect(page.getByRole('status').filter({ hasText: 'Conferma i valori modificati con Invio' })).toBeVisible()

  phase = 'offline'
  // A visibility refetch of the expired status query exercises the real 409 recovery path.
  await page.clock.setFixedTime(Date.now() + 60_000)
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    document.dispatchEvent(new Event('visibilitychange', { bubbles: true }))
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    document.dispatchEvent(new Event('visibilitychange', { bubbles: true }))
  })
  const notice = page.getByRole('alert').filter({ has: page.getByRole('heading', { name: /Aggiornamento non riuscito/ }) })
  await expect(notice).toBeVisible()
  await expect(notice).toContainText(`Revisione ${originalRevision} conservata`)
  await expect(weights).toHaveValue('0.25, -')
  expect(await weights.evaluate((element, original) => element === original, originalInput)).toBe(true)
  await expect(budget).toHaveValue('4')

  phase = 'recovered'
  await notice.getByRole('button', { name: 'Riprova', exact: true }).click()
  await expect(notice).toHaveCount(0)
  await expect(weights).toHaveValue('0.25, -')
  expect(await weights.evaluate((element, original) => element === original, originalInput)).toBe(true)
  await expect(apply).toBeDisabled()
  await expect(preview).toBeDisabled()
  expect(writes).toEqual([])
  expect(previews).toEqual([])

  await weights.fill('0.25, 0.5, 0.75, 1, 1, 1')
  await expect(preview).toBeDisabled()
  await weights.press('Enter')
  await expect(preview).toBeEnabled()
  await preview.click()
  await expect(page.getByText('synthetic-recovery-preview', { exact: true })).toBeVisible()
  expect(previews).toHaveLength(1)
  expect(previews[0]!.expected_revision).toBe(originalRevision)
  await apply.click()
  await expect(page.locator('.toast-root').getByText('Impossibile applicare le impostazioni', { exact: true })).toBeVisible()
  await expect(apply).toBeEnabled()
  await expect(weights).toHaveValue('0.25, 0.5, 0.75, 1, 1, 1')
  await expect(budget).toHaveValue('4')
  await expect(page.getByText('Impostazioni applicate', { exact: true })).toHaveCount(0)
  expect(writes).toHaveLength(1)
  expect(writes[0]!.expected_revision).toBe(originalRevision)
  expect((writes[0]!.settings.attribution as Record<string, unknown>).loss_weights).toEqual([0.25, 0.5, 0.75, 1, 1, 1])
  expect(unexpectedWrites).toEqual([])
})
