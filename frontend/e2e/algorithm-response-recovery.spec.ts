import { expect, test, type Page } from '@playwright/test'
import type { AlgorithmPreviewResponseDto, AlgorithmSettings, AlgorithmSettingsResponseDto } from '../src/api/types'

const invalidResponseMessage = 'La risposta del server non è valida o completa. L’esito della richiesta non è confermato.'
interface Submission { expected_revision: number; settings: AlgorithmSettings }
interface PreviewSubmission extends Submission { scope: Record<string, unknown>; filters: Record<string, unknown> }
interface FixtureState {
  initial?: AlgorithmSettingsResponseDto
  readReply?: unknown
  failStatus: boolean
  reads: number
  puts: Submission[]
  previews: PreviewSubmission[]
  unexpectedWrites: string[]
  putReply?: (body: Submission, attempt: number) => unknown
  previewReply?: (body: PreviewSubmission, attempt: number) => unknown
}

function fixtureState(): FixtureState {
  return { failStatus: false, reads: 0, puts: [], previews: [], unexpectedWrites: [] }
}

function validPreview(body: PreviewSubmission): AlgorithmPreviewResponseDto {
  return {
    base_revision: body.expected_revision, proposed_fingerprint: 'synthetic-valid-preview',
    changed_paths: ['recommendations.trial_budget'], comparisons: [], sensitivity: [], context: {}, notes: [],
  }
}

async function mockApi(page: Page, state: FixtureState) {
  await page.route('https://ddragon.leagueoflegends.com/**', (route) => route.abort())
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.route('**/api/**', (route) => {
    if (route.request().method() === 'GET') return route.fallback()
    state.unexpectedWrites.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`)
    return route.abort()
  })
  await page.route('**/api/sync-status', (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    return state.failStatus
      ? route.fulfill({ status: 409, json: { error: 'Configuration changed' } }) : route.fallback()
  })
  await page.route('**/api/algorithm-settings', async (route) => {
    if (route.request().method() === 'GET') {
      state.reads += 1
      if (state.readReply !== undefined) await route.fulfill({ json: state.readReply })
      else {
        // Reuse the complete schema/defaults/history from the real synthetic server.
        const response = await route.fetch()
        state.initial = structuredClone(await response.json() as AlgorithmSettingsResponseDto)
        await route.fulfill({ response, json: state.initial })
      }
    } else if (route.request().method() === 'PUT' && state.putReply) {
      const body = route.request().postDataJSON() as Submission
      state.puts.push(body)
      await route.fulfill({ json: state.putReply(body, state.puts.length) })
    } else await route.fallback()
  })
  await page.route('**/api/algorithm-settings/preview', async (route) => {
    if (route.request().method() === 'POST' && state.previewReply) {
      const body = route.request().postDataJSON() as PreviewSubmission
      state.previews.push(body)
      await route.fulfill({ json: state.previewReply(body, state.previews.length) })
    } else await route.fallback()
  })
}

async function editAfterFullRefresh(page: Page, state: FixtureState) {
  await page.goto('/app/settings/algorithms')
  const input = page.getByRole('spinbutton', { name: 'Budget di prova', exact: true })
  await expect(input).toBeVisible()
  await page.reload()
  await expect(input).toBeVisible()
  if (!state.initial) throw new Error('No complete settings snapshot was loaded after the full refresh')
  const snapshot = structuredClone(state.initial)
  const initialBudget = Number((snapshot.settings.recommendations as Record<string, unknown>).trial_budget)
  const draftBudget = initialBudget === 4 ? 5 : 4
  await input.fill(String(draftBudget))
  await expect(page.getByText('Bozza non applicata', { exact: true })).toBeVisible()
  const originalInput = await input.elementHandle()
  if (!originalInput) throw new Error('The settings input was not mounted')
  return { input, originalInput, snapshot, draftBudget }
}

async function refetchExpiredStatus(page: Page) {
  await page.clock.setFixedTime(Date.now() + 60_000)
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    document.dispatchEvent(new Event('visibilitychange', { bubbles: true }))
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    document.dispatchEvent(new Event('visibilitychange', { bubbles: true }))
  })
}

test('risposte algoritmi: GET 200 incompleto conserva snapshot, campo e base della bozza @smoke', async ({ page }) => {
  const state = fixtureState()
  state.previewReply = validPreview
  await mockApi(page, state)
  const { input, originalInput, snapshot, draftBudget } = await editAfterFullRefresh(page, state)
  state.readReply = {}
  state.failStatus = true
  await refetchExpiredStatus(page)
  const error = page.getByRole('alert').filter({ has: page.getByRole('heading', { name: /Aggiornamento non riuscito/ }) })
  await expect(error).toBeVisible()
  await expect(error).toContainText(`Revisione ${snapshot.revision} conservata`)
  await expect(error).toContainText(invalidResponseMessage)
  await expect(page.getByRole('region', { name: 'Stato delle impostazioni', exact: true })).toContainText(snapshot.fingerprint)
  await expect(input).toHaveValue(String(draftBudget))
  expect(await input.evaluate((element, original) => element === original, originalInput)).toBe(true)
  await expect(page.getByRole('button', { name: 'Applica impostazioni', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Calcola anteprima', exact: true })).toBeDisabled()
  expect(state.puts).toEqual([])
  expect(state.previews).toEqual([])

  state.failStatus = false
  state.readReply = { ...structuredClone(snapshot), revision: snapshot.revision + 1, fingerprint: 'synthetic-refreshed-settings' }
  await error.getByRole('button', { name: 'Riprova', exact: true }).click()
  await expect(error).toHaveCount(0)
  await expect(input).toHaveValue(String(draftBudget))
  expect(await input.evaluate((element, original) => element === original, originalInput)).toBe(true)
  await page.getByRole('button', { name: 'Calcola anteprima', exact: true }).click()
  await expect(page.locator('.algorithm-preview')).toContainText('synthetic-valid-preview')
  expect(state.previews).toHaveLength(1)
  expect(state.previews[0]!.expected_revision).toBe(snapshot.revision)
  expect((state.previews[0]!.settings.recommendations as Record<string, unknown>).trial_budget).toBe(draftBudget)
  expect(state.puts).toEqual([])
  expect(state.unexpectedWrites).toEqual([])
})

test('risposte algoritmi: PUT 200 vuoto o parziale non applica la bozza e richiede retry esplicito @smoke', async ({ page }) => {
  const state = fixtureState()
  await mockApi(page, state)
  const { input, originalInput, snapshot, draftBudget } = await editAfterFullRefresh(page, state)
  const initialReads = state.reads
  state.putReply = (body, attempt) => {
    if (attempt === 1) return {}
    if (attempt === 2) return { revision: snapshot.revision + 1 }
    const saved: AlgorithmSettingsResponseDto = {
      ...structuredClone(snapshot), settings: structuredClone(body.settings),
      revision: snapshot.revision + 1, fingerprint: 'synthetic-settings-applied',
    }
    state.readReply = saved
    return saved
  }
  const apply = page.getByRole('button', { name: 'Applica impostazioni', exact: true })
  const error = page.getByRole('alert').filter({ has: page.getByRole('heading', { name: 'Impossibile applicare le impostazioni', exact: true }) })
  for (const attempt of [1, 2]) {
    await apply.click()
    await expect.poll(() => state.puts.length).toBe(attempt)
    await expect(apply).toBeEnabled()
    await expect(error).toContainText(invalidResponseMessage)
    await expect(input).toHaveValue(String(draftBudget))
    expect(await input.evaluate((element, original) => element === original, originalInput)).toBe(true)
    await expect(page.getByText('Bozza non applicata', { exact: true })).toBeVisible()
    const summary = page.getByRole('region', { name: 'Stato delle impostazioni', exact: true })
    await expect(summary).toContainText(snapshot.fingerprint)
    await expect(summary.locator('.surface').filter({ hasText: 'Revisione attiva' }).locator('strong')).toHaveText(String(snapshot.revision))
    await expect(page.getByText('Impostazioni applicate', { exact: true })).toHaveCount(0)
    expect(state.reads).toBe(initialReads)
    expect(state.puts).toHaveLength(attempt)
  }
  await apply.click()
  await expect(apply).toBeDisabled()
  await expect(input).toBeEnabled()
  await expect(input).toHaveValue(String(draftBudget))
  await expect(error).toHaveCount(0)
  await expect(page.getByText('Bozza non applicata', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Stato delle impostazioni', exact: true })).toContainText('synthetic-settings-applied')
  expect(state.puts).toHaveLength(3)
  for (const body of state.puts) {
    expect(body.expected_revision).toBe(snapshot.revision)
    expect((body.settings.recommendations as Record<string, unknown>).trial_budget).toBe(draftBudget)
  }
  expect(state.previews).toEqual([])
  expect(state.unexpectedWrites).toEqual([])
})

test('risposte algoritmi: preview 200 incompleta mostra errore locale e il retry valido conserva la bozza @smoke', async ({ page }) => {
  const state = fixtureState()
  state.previewReply = (body, attempt) => attempt === 1 ? {} : validPreview(body)
  await mockApi(page, state)
  const { input, originalInput, snapshot, draftBudget } = await editAfterFullRefresh(page, state)
  await page.getByRole('button', { name: 'Calcola anteprima', exact: true }).click()
  const error = page.getByRole('alert').filter({ has: page.getByRole('heading', { name: 'Impossibile calcolare l’anteprima', exact: true }) })
  await expect(error).toContainText(invalidResponseMessage)
  await expect(page.getByRole('heading', { name: 'Parametri degli algoritmi', exact: true })).toBeVisible()
  await expect(input).toHaveValue(String(draftBudget))
  expect(await input.evaluate((element, original) => element === original, originalInput)).toBe(true)
  await expect(page.locator('.algorithm-preview')).toHaveCount(0)
  expect(state.previews).toHaveLength(1)
  await error.getByRole('button', { name: 'Riprova', exact: true }).click()
  await expect(error).toHaveCount(0)
  await expect(page.locator('.algorithm-preview')).toContainText('synthetic-valid-preview')
  await expect(page.locator('.algorithm-preview')).toContainText(`Base revisione ${snapshot.revision}`)
  await expect(input).toHaveValue(String(draftBudget))
  expect(await input.evaluate((element, original) => element === original, originalInput)).toBe(true)
  await expect(page.getByText('Bozza non applicata', { exact: true })).toBeVisible()
  expect(state.previews).toHaveLength(2)
  expect(state.previews[1]).toEqual(state.previews[0])
  expect(state.previews[0]!.expected_revision).toBe(snapshot.revision)
  expect(state.puts).toEqual([])
  expect(state.unexpectedWrites).toEqual([])
})
