import { expect, test } from '@playwright/test'
import type { AlgorithmSettings, AlgorithmSettingsResponseDto } from '../src/api/types'

for (const obsoleteStatus of [200, 409]) {
  test(`anteprima: una risposta ${obsoleteStatus} superata conserva la nuova bozza @smoke`, async ({ page }) => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let obsoleteFinished!: () => void
    const finished = new Promise<void>((resolve) => { obsoleteFinished = resolve })
    const budgets: number[] = []
    let settingsWrites = 0

    await page.route('https://ddragon.leagueoflegends.com/**', (route) => route.abort())
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.route('**/api/**', async (route) => {
      if (route.request().method() === 'GET') await route.fallback()
      else {
        settingsWrites += 1
        await route.abort()
      }
    })
    await page.route('**/api/algorithm-settings/preview', async (route) => {
      const body = route.request().postDataJSON()
      const budget = body.settings.recommendations.trial_budget as number
      budgets.push(budget)
      const obsolete = budgets.length === 1
      if (obsolete) await gate
      try {
        await route.fulfill({
          status: obsolete ? obsoleteStatus : 200,
          json: obsolete && obsoleteStatus === 409 ? { error: 'Revisione superata' } : {
            base_revision: body.expected_revision,
            proposed_fingerprint: `browser-preview-budget-${budget}`,
            changed_paths: ['recommendations.trial_budget'],
            comparisons: [], sensitivity: [], context: {}, notes: [],
          },
        })
      } catch (error) {
        // The obsolete request is intentionally aborted when the draft changes.
        if (!route.request().failure()) throw error
      } finally {
        if (obsolete) obsoleteFinished()
      }
    })

    try {
      await page.goto('/app/settings/algorithms')
      await page.reload()
      const budget = page.getByRole('spinbutton', { name: 'Budget di prova', exact: true })
      await expect(budget).toHaveValue('3')
      await budget.fill('4')
      await page.getByRole('button', { name: 'Calcola anteprima', exact: true }).click()
      await expect.poll(() => budgets).toEqual([4])
      await expect(page.getByRole('button', { name: 'Calcolo anteprima…', exact: true })).toBeDisabled()

      await budget.fill('5')
      const previewButton = page.getByRole('button', { name: 'Calcola anteprima', exact: true })
      await expect(previewButton).toBeEnabled()
      await previewButton.click()
      await expect.poll(() => budgets).toEqual([4, 5])
      await expect(page.getByText('browser-preview-budget-5', { exact: true })).toBeVisible()

      release()
      await finished
      await expect(budget).toHaveValue('5')
      await expect(page.getByText('browser-preview-budget-5', { exact: true })).toBeVisible()
      await expect(page.getByText('browser-preview-budget-4', { exact: true })).toHaveCount(0)
      await expect(page.getByRole('heading', { name: 'Impossibile calcolare l’anteprima', exact: true })).toHaveCount(0)
      expect(settingsWrites).toBe(0)
    } finally {
      release()
    }
  })
}

test('salvataggio: i campi restano protetti fino alla risposta @smoke', async ({ page }) => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let active: AlgorithmSettingsResponseDto | undefined
  type Submission = { expected_revision: number; settings: AlgorithmSettings & { recommendations: { trial_budget: number } } }
  let submitted: Submission | undefined
  await page.route('https://ddragon.leagueoflegends.com/**', (route) => route.abort())
  await page.route('**/api/**', async (route) => {
    if (route.request().method() === 'GET') await route.fallback()
    else await route.abort()
  })
  await page.route('**/api/algorithm-settings', async (route) => {
    if (route.request().method() === 'GET') {
      const response = await route.fetch()
      active = await response.json() as AlgorithmSettingsResponseDto
      await route.fulfill({ response, json: active })
      return
    }
    if (route.request().method() !== 'PUT' || !active) throw new Error('Unexpected settings request')
    const payload = route.request().postDataJSON() as Submission
    submitted = payload
    const responseBase = active
    await gate
    await route.fulfill({ json: {
      ...responseBase, settings: payload.settings,
      revision: payload.expected_revision + 1, fingerprint: 'browser-saved-budget-4',
    } })
  })

  try {
    await page.goto('/app/settings/algorithms')
    await page.reload()
    const budget = page.getByRole('spinbutton', { name: 'Budget di prova', exact: true })
    await budget.fill('4')
    await page.getByRole('button', { name: 'Applica impostazioni', exact: true }).click()
    await expect.poll(() => submitted?.settings.recommendations?.trial_budget).toBe(4)
    await expect(budget).toBeDisabled()
    await expect(page.getByRole('group', { name: 'Raccomandazioni attuali', exact: true })
      .getByRole('combobox', { name: /^Coda\b/ })).toBeDisabled()
    release()
    await expect(budget).toBeEnabled()
    await expect(budget).toHaveValue('4')
    await expect(page.getByText('Impostazioni applicate', { exact: true })).toBeVisible()
  } finally {
    release()
  }
})
