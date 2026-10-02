import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { translateModelText } from '../src/app/labels'
import type { ObservedRecommendationDto, RecommendationFeedbackResponseDto, RecommendationPreference, RecommendationsResponseDto } from '../src/api/types'

const CHOICES = '/app/fit?section=choices&queue=all&days=all'
const AHRI_DETAIL = `${CHOICES}&detail=Ahri&detailRole=MIDDLE`

function recommendationsResponse(page: Page, champion?: string) {
  return page.waitForResponse((response) => {
    const url = new URL(response.url())
    return response.ok() && url.pathname === '/api/recommendations' &&
      (champion === undefined || url.searchParams.get('champion') === champion)
  })
}

async function refreshRecommendations(page: Page, path: string, champion?: string) {
  await page.goto(path)
  const response = recommendationsResponse(page, champion)
  await page.reload()
  const resolved = await response
  await resolved.finished()
  return { response: resolved, body: await resolved.json() as RecommendationsResponseDto }
}

function candidate(payload: RecommendationsResponseDto, champion: string, role: string): ObservedRecommendationDto {
  const item = payload.candidate ?? [...payload.known, ...payload.discover]
    .find((entry) => entry.champion === champion && entry.role === role)
  expect(item, `${champion} ${role} deve essere presente nella risposta`).toBeDefined()
  return item!
}

async function feedbackLibrary(page: Page) {
  const response = await page.request.get('/api/recommendation-feedback')
  expect(response.ok()).toBe(true)
  return response.json() as Promise<RecommendationFeedbackResponseDto>
}

test('@smoke suggerimenti spiegabili: motivi, incertezza e risultati reali', async ({ page }, testInfo) => {
  const staleEvidenceRequests: string[] = []
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/recommendation-evidence') staleEvidenceRequests.push(request.url())
  })
  const { response, body } = await refreshRecommendations(page, AHRI_DETAIL, 'Ahri')
  const ahri = candidate(body, 'Ahri', 'MIDDLE')
  const performance = ahri.performance
  expect(performance).not.toBeNull()
  expect(performance!.games).toBe(4)
  expect(performance!.observations).toBe(4)
  expect(performance!.wins).toBe(3)
  expect(performance!.losses).toBe(1)
  expect(performance!.interval_low).toBeLessThan(performance!.win_rate!)
  expect(performance!.interval_high).toBeGreaterThan(performance!.win_rate!)
  expect(performance!.supported).toBe(false)

  const requestUrl = new URL(response.url())
  expect(requestUrl.searchParams.get('champion')).toBe('Ahri')
  expect(requestUrl.searchParams.get('role')).toBe('MIDDLE')
  expect(requestUrl.searchParams.getAll('account').sort()).toEqual(['Alpha#EUW', 'Beta#EUW'])
  expect(requestUrl.searchParams.get('queue')).toBe('all')
  expect(staleEvidenceRequests).toEqual([])

  const sheet = page.getByRole('dialog', { name: 'Scheda di Ahri' })
  await expect(sheet).toBeVisible()
  await expect(sheet.getByText(/3 vittorie e 1 sconfitta in 4 osservazioni account-partita, da 4 partite uniche/)).toBeVisible()
  for (const reason of ahri.reasons) {
    await expect(sheet.getByText(translateModelText(reason), { exact: true })).toBeVisible()
  }
  const accounts = sheet.getByRole('region', { name: 'Risultati per account · Corsia centrale' }).getByRole('table')
  await expect(accounts.locator('tbody tr')).toHaveCount(2)
  await expect(accounts.getByText('Alpha#EUW', { exact: true })).toBeVisible()
  await expect(accounts.getByText('Beta#EUW', { exact: true })).toBeVisible()

  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()
  expect(results.violations.filter((item) => ['critical', 'serious'].includes(item.impact ?? ''))).toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    window.scrollTo(0, 0)
  })
  await page.screenshot({ path: testInfo.outputPath('recommendation-explanation.png'), fullPage: true })
})

test('il cambio account ricarica i risultati e non conserva quelli fuori perimetro', async ({ page }) => {
  await refreshRecommendations(page, AHRI_DETAIL, 'Ahri')
  const before = page.getByRole('region', { name: 'Risultati per account · Corsia centrale' }).getByRole('table')
  await expect(before.getByText('Beta#EUW', { exact: true })).toBeVisible()

  await page.goto('/app/profile')
  await page.getByRole('button', { name: /Beta#EUW/ }).click()
  const { response, body } = await refreshRecommendations(page, AHRI_DETAIL, 'Ahri')
  const requestUrl = new URL(response.url())
  expect(requestUrl.searchParams.getAll('account')).toEqual(['Alpha#EUW'])
  const ahri = candidate(body, 'Ahri', 'MIDDLE')
  expect(ahri.performance?.games).toBe(3)
  expect(ahri.performance?.observations).toBe(3)

  const after = page.getByRole('region', { name: 'Risultati per account · Corsia centrale' }).getByRole('table')
  await expect(after.locator('tbody tr')).toHaveCount(1)
  await expect(after.getByText('Alpha#EUW', { exact: true })).toBeVisible()
  await expect(after.getByText('Beta#EUW', { exact: true })).toHaveCount(0)
})

test('il profilo resta dedicato alla scelta dei dati', async ({ page }) => {
  await page.goto('/app/profile')
  await page.reload()
  await expect(page.getByRole('heading', { level: 1, name: 'Dati usati' })).toBeVisible()
  await expect(page.getByRole('button', { name: /Alpha#EUW/ })).toBeVisible()
  await expect(page.locator('.recommendation-card')).toHaveCount(0)
})

test('una preferenza aggiorna i suggerimenti e persiste al refresh', async ({ page }, testInfo) => {
  testInfo.setTimeout(45_000)
  await page.route('https://ddragon.leagueoflegends.com/**', (route) => route.abort())
  const initial = await refreshRecommendations(page, CHOICES)
  const initialAhri = candidate(initial.body, 'Ahri', 'MIDDLE')
  const originalPreference = initialAhri.feedback
  let latestRevision = initial.body.feedback_revision
  let primaryFailure: unknown
  let cleanupFailure: unknown
  try {
    const card = page.locator('.recommendation-card').filter({ has: page.getByText('Ahri', { exact: true }) }).first()
    const feedbackResponse = page.waitForResponse((response) =>
      response.ok() && new URL(response.url()).pathname === '/api/recommendation-feedback')
    const refreshedResponse = recommendationsResponse(page)
    await card.getByRole('button', { name: 'Mi piace', exact: true }).click()
    await feedbackResponse
    const refreshed = await refreshedResponse
    const refreshedBody = await refreshed.json() as RecommendationsResponseDto
    latestRevision = refreshedBody.feedback_revision
    expect(candidate(refreshedBody, 'Ahri', 'MIDDLE').feedback).toBe('like')
    await expect(card.getByText('Attuale: Mi piace. Modifica l’ordine dei suggerimenti, non i risultati osservati.', { exact: true })).toBeVisible()
    await expect(card.getByRole('button', { name: 'Mi piace', exact: true })).toHaveAttribute('aria-pressed', 'true')

    const persistedResponse = recommendationsResponse(page)
    await page.reload({ waitUntil: 'domcontentloaded' })
    const persisted = await persistedResponse
    const persistedBody = await persisted.json() as RecommendationsResponseDto
    latestRevision = persistedBody.feedback_revision
    expect(candidate(persistedBody, 'Ahri', 'MIDDLE').feedback).toBe('like')
    const persistedCard = page.locator('.recommendation-card').filter({ has: page.getByText('Ahri', { exact: true }) }).first()
    await expect(persistedCard.getByRole('button', { name: 'Mi piace', exact: true })).toHaveAttribute('aria-pressed', 'true')
  } catch (error) {
    primaryFailure = error
  } finally {
    try {
      const restore = await page.request.post('/api/recommendation-feedback', {
        data: {
          accounts: [],
          champion: 'Ahri',
          role: 'MIDDLE',
          preference: (originalPreference ?? 'neutral') satisfies RecommendationPreference,
          expected_revision: latestRevision,
        },
        timeout: 5_000,
      })
      if (!restore.ok()) cleanupFailure = new Error(`Ripristino preferenza fallito: HTTP ${restore.status()}`)
    } catch (cleanupError) {
      cleanupFailure = cleanupError
    }
  }
  if (primaryFailure !== undefined) throw primaryFailure
  if (cleanupFailure !== undefined) throw cleanupFailure
})

test('l’editor salva per account un campione mai giocato, persiste al refresh e ripristina il feedback', async ({ page }, testInfo) => {
  testInfo.setTimeout(45_000)
  const initial = await feedbackLibrary(page)
  const option = initial.options.find((item) => item.champion === 'TahmKench')
  expect(option, 'La fixture sintetica deve esporre Tahm Kench dal catalogo completo').toBeDefined()
  expect(option!.roles_by_account['Alpha#EUW']).toContain('TOP')
  expect(option!.roles_by_account['Beta#EUW']).toContain('TOP')
  const initialItems = initial.items.filter((item) => item.champion === 'TahmKench' && item.role === 'TOP')
  const originalAlpha = initialItems.find((item) => item.account === 'Alpha#EUW')?.preference ?? 'neutral'
  const savedPreference: RecommendationPreference = originalAlpha === 'dislike' ? 'like' : 'dislike'
  const savedLabel = savedPreference === 'like' ? 'Mi piace' : 'Non fa per me'
  let latestRevision = initial.revision
  let primaryFailure: unknown
  let cleanupFailure: unknown

  try {
    await page.goto(CHOICES)
    const loadedLibrary = page.waitForResponse((response) =>
      response.ok() && response.request().method() === 'GET' && new URL(response.url()).pathname === '/api/recommendation-feedback')
    await page.reload({ waitUntil: 'domcontentloaded' })
    await loadedLibrary

    await page.getByLabel('Cerca nel catalogo').fill('Tahm Kench')
    await page.getByLabel('Campione della preferenza').selectOption('TahmKench')
    await page.getByLabel('Ruolo della preferenza').selectOption('TOP')
    await expect(page.getByLabel('Ruolo della preferenza')).toHaveValue('TOP')
    await page.getByText('Account · 2/2 selezionati', { exact: true }).click()
    await page.getByRole('checkbox', { name: 'Beta#EUW' }).uncheck()

    const saved = page.waitForResponse((response) =>
      response.ok() && response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/recommendation-feedback')
    const refreshedLibrary = page.waitForResponse((response) =>
      response.ok() && response.request().method() === 'GET' && new URL(response.url()).pathname === '/api/recommendation-feedback')
    await page.getByLabel('Salva la nuova preferenza').getByRole('button', { name: savedLabel, exact: true }).click()
    const savedResponse = await saved
    expect(await savedResponse.request().postDataJSON()).toEqual({
      accounts: ['Alpha#EUW'], champion: 'TahmKench', role: 'TOP',
      preference: savedPreference, expected_revision: initial.revision,
    })
    latestRevision = ((await (await refreshedLibrary).json()) as RecommendationFeedbackResponseDto).revision

    const ledger = page.getByRole('region', { name: 'Registro delle preferenze dichiarate' })
    await expect(ledger.getByRole('row', { name: new RegExp(`Tahm Kench.*Corsia superiore.*Alpha#EUW.*${savedLabel}`) })).toBeVisible()
    await expect(ledger.getByRole('row', { name: /Tahm Kench.*Beta#EUW/ })).toHaveCount(0)

    const persistedLibrary = page.waitForResponse((response) =>
      response.ok() && response.request().method() === 'GET' && new URL(response.url()).pathname === '/api/recommendation-feedback')
    await page.reload({ waitUntil: 'domcontentloaded' })
    latestRevision = ((await (await persistedLibrary).json()) as RecommendationFeedbackResponseDto).revision
    const persistedLedger = page.getByRole('region', { name: 'Registro delle preferenze dichiarate' })
    await expect(persistedLedger.getByRole('row', { name: new RegExp(`Tahm Kench.*Corsia superiore.*Alpha#EUW.*${savedLabel}`) })).toBeVisible()
    await expect(persistedLedger.getByRole('row', { name: /Tahm Kench.*Beta#EUW/ })).toHaveCount(0)
  } catch (error) {
    primaryFailure = error
  } finally {
    try {
      for (const account of initial.accounts) {
        const preference = initialItems.find((item) => item.account === account)?.preference ?? 'neutral'
        const restore = await page.request.post('/api/recommendation-feedback', {
          data: { accounts: [account], champion: 'TahmKench', role: 'TOP', preference, expected_revision: latestRevision },
          timeout: 5_000,
        })
        if (!restore.ok()) {
          cleanupFailure = new Error(`Ripristino preferenza ${account} fallito: HTTP ${restore.status()}`)
          break
        }
        latestRevision = (await feedbackLibrary(page)).revision
      }
      if (cleanupFailure === undefined) {
        const restored = await feedbackLibrary(page)
        expect(restored.items.filter((item) => item.champion === 'TahmKench' && item.role === 'TOP'))
          .toEqual(initialItems)
      }
    } catch (cleanupError) {
      cleanupFailure = cleanupError
    }
  }
  if (primaryFailure !== undefined) throw primaryFailure
  if (cleanupFailure !== undefined) throw cleanupFailure
})
