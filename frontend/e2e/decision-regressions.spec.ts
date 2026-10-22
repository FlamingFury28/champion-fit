import { expect, test, type Page } from '@playwright/test'
import { observedRecommendation, recommendationsFixture } from '../src/test/recommendations-fixture'

const model = { status: 'exploratory', validated: false, model_version: 'synthetic', message: 'Modello sintetico esplorativo.' }

function competitiveResponse(url: URL, mass = .9) {
  const budget = Number(url.searchParams.get('budget') ?? 400)
  return {
    context: { role: 'MIDDLE', queue: url.searchParams.get('queue') ?? '420', days: url.searchParams.get('days') ?? '180', unique_games: 4 },
    model,
    budget_total: budget, budget_assigned: budget, budget_unassigned: 0, budget_default: 400,
    expected_regret_reduction: .06, monte_carlo_se: .002,
    items: [{ champion: 'Ahri', role: 'MIDDLE', icon_url: '/Ahri.png', unique_games: 4,
      posterior_win_rate: 56.2, credible_lower_90: 42, credible_upper_90: 68, credible_mass: mass,
      posterior_lift_pp: 6.2, classification: 'promising', historical_supported: false,
      account_coverage: 1, account_count: 1, allocation_games: budget,
      account_allocations: [{ account: 'Alpha#EUW', games: budget }] }],
  }
}

async function installReadOnlyMocks(page: Page, options: { mass?: number; planGate?: Promise<void> } = {}) {
  const planRequests: URL[] = []
  const detailRequests: URL[] = []
  // Metadata may use the fixture server's GET endpoints. Prevent accidental
  // mutations even if a future UI change adds a write to one of these flows.
  await page.route('**/api/**', async (route) => {
    if (route.request().method() === 'GET') await route.fallback()
    else await route.abort()
  })
  await page.route('https://ddragon.leagueoflegends.com/**', (route) => route.abort())
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.route('**/api/champions?**', async (route) => {
    const url = new URL(route.request().url())
    await route.fulfill({ json: competitiveResponse(url, options.mass) })
  })
  await page.route('**/api/training-plan?**', async (route) => {
    const url = new URL(route.request().url())
    planRequests.push(url)
    if (options.planGate) await options.planGate
    await route.fulfill({ json: competitiveResponse(url, options.mass) })
  })
  await page.route('**/api/recommendations?**', async (route) => {
    const url = new URL(route.request().url())
    detailRequests.push(url)
    const fixture = recommendationsFixture()
    await route.fulfill({ json: recommendationsFixture({ candidate: observedRecommendation(), context: {
      ...fixture.context, role: url.searchParams.get('role') ?? 'ALL',
      queue: url.searchParams.get('queue') ?? 'all', days: url.searchParams.get('days') ?? 'all',
    } }) })
  })
  return { planRequests, detailRequests }
}

test('budget: digita 1000 senza ricalcoli intermedi e salva con Enter @smoke', async ({ page }, testInfo) => {
  const { planRequests } = await installReadOnlyMocks(page)
  await page.goto('/app/fit?section=tournament')
  await page.reload()
  await expect(page.locator('#main-content a[href*="detail=Ahri"]').first()).toBeVisible()
  const input = page.getByLabel('Budget partite', { exact: true })
  await expect(page.getByRole('heading', { name: 'Piano da 400 partite', exact: true })).toBeVisible()
  const requestCount = planRequests.length
  await input.fill('')
  await expect(input).toHaveValue('')
  await input.pressSequentially('1000')
  await expect(input).toHaveValue('1000')
  await expect(page.getByRole('heading', { name: 'Piano da 400 partite', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Piano da 1000 partite', exact: true })).toHaveCount(0)
  expect(planRequests).toHaveLength(requestCount)
  await input.press('Enter')
  await expect(page).toHaveURL(/budget=1000/)
  await expect.poll(() => planRequests.at(-1)?.searchParams.get('budget')).toBe('1000')
  await expect(input).toHaveValue('1000')
  await expect(page.getByText('1000/1000 partite assegnate', { exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Piano da 1000 partite', exact: true })).toBeVisible()
  await page.reload()
  await expect(input).toHaveValue('1000')
  await expect(page.getByRole('heading', { name: 'Piano da 1000 partite', exact: true })).toBeVisible()
  await expect(page.getByText('1000/1000 partite assegnate', { exact: true })).toBeVisible()
  const planTab = page.getByRole('navigation', { name: 'Sezioni campioni', exact: true }).getByRole('link', { name: 'Piano competitivo', exact: true })
  await expect(planTab).toHaveAttribute('aria-current', 'page')
  expect(new URL((await planTab.getAttribute('href'))!, page.url()).searchParams.get('budget')).toBe('1000')
  await page.evaluate(() => document.fonts.ready)
  await page.screenshot({ path: testInfo.outputPath('budget-1000.png'), fullPage: true })
})

test('budget: blur salva il numero digitato e applica i limiti soltanto al commit @smoke', async ({ page }) => {
  const { planRequests } = await installReadOnlyMocks(page)
  await page.goto('/app/fit?section=tournament')
  await page.reload()
  await expect(page.locator('#main-content a[href*="detail=Ahri"]').first()).toBeVisible()
  const input = page.getByLabel('Budget partite', { exact: true })
  for (const [draft, committed] of [['1000', '1000'], ['1', '20'], ['3000', '2000']] as const) {
    await input.fill('')
    await input.pressSequentially(draft)
    await expect(input).toHaveValue(draft)
    await input.press('Tab')
    await expect(input).toHaveValue(committed)
    await expect(page.getByRole('heading', { name: `Piano da ${committed} partite`, exact: true })).toBeVisible()
    await expect.poll(() => planRequests.at(-1)?.searchParams.get('budget')).toBe(committed)
    expect(new URL(page.url()).searchParams.get('budget')).toBe(committed)
  }
  await page.reload()
  await expect(input).toHaveValue('2000')
  await expect(page.getByRole('heading', { name: 'Piano da 2000 partite', exact: true })).toBeVisible()
})

test('il piano in attesa non dichiara assenza di candidati', async ({ page }) => {
  let release!: () => void
  const planGate = new Promise<void>((resolve) => { release = resolve })
  const { planRequests } = await installReadOnlyMocks(page, { planGate })
  try {
    await page.goto('/app/fit?section=tournament', { waitUntil: 'domcontentloaded' })
    await expect.poll(() => planRequests.length).toBeGreaterThan(0)
    await expect(page.getByRole('heading', { name: 'Sto calcolando il piano competitivo', exact: true })).toBeVisible()
    await expect(page.getByText('Nessun candidato nel contesto selezionato', { exact: true })).toHaveCount(0)
    await expect(page.getByText('Contesto senza candidati', { exact: true })).toHaveCount(0)
    release()
    await expect(page.getByRole('heading', { name: 'Anteprima: più partite su Ahri · Corsia centrale', exact: true })).toBeVisible()
  } finally {
    release()
  }
})

for (const section of ['best', 'tournament']) {
  test(`${section}: scheda, ritorno e refresh conservano contesto risolto e filtri automatici`, async ({ page }) => {
    const { detailRequests } = await installReadOnlyMocks(page)
    const path = `/app/fit?section=${section}`
    await page.goto(path)
    await page.reload()
    const openSheet = page.locator('#main-content a[href*="detail=Ahri"]').first()
    await expect(openSheet).toBeVisible()
    await expect(page.getByRole('combobox', { name: 'Modalità', exact: true })).toHaveValue('')
    await expect(page.getByRole('combobox', { name: 'Periodo', exact: true })).toHaveValue('')
    const sheet = page.getByRole('dialog', { name: 'Scheda di Ahri', exact: true })
    for (const refreshSheet of [false, true]) {
      await openSheet.click()
      await expect(sheet).toBeVisible()
      await expect(sheet.getByText(/Ahri fa già parte delle tue scelte/)).toBeVisible()
      if (refreshSheet) {
        await page.reload()
        await expect(sheet.getByText(/Ahri fa già parte delle tue scelte/)).toBeVisible()
      }
      const sheetURL = new URL(page.url())
      expect(sheetURL.searchParams.get('detailQueue')).toBe('420')
      expect(sheetURL.searchParams.get('detailDays')).toBe('180')
      expect(sheetURL.searchParams.has('queue')).toBe(false)
      expect(sheetURL.searchParams.has('days')).toBe(false)
      expect(detailRequests.at(-1)?.searchParams.get('queue')).toBe('420')
      expect(detailRequests.at(-1)?.searchParams.get('days')).toBe('180')
      await sheet.getByRole('button', { name: 'Chiudi', exact: true }).click()
      await expect(sheet).toBeHidden()
      const restoredURL = new URL(page.url())
      expect(restoredURL.search).toBe(`?section=${section}`)
      await expect(page.getByRole('combobox', { name: 'Modalità', exact: true })).toHaveValue('')
      await expect(page.getByRole('combobox', { name: 'Periodo', exact: true })).toHaveValue('')
      if (!refreshSheet) await expect(openSheet).toBeFocused()
    }
  })
}

test('l’intervallo ricevuto all’80% mantiene la propria etichetta', async ({ page }) => {
  await installReadOnlyMocks(page, { mass: .8 })
  await page.goto('/app/fit?section=best')
  await page.reload()
  await expect(page.getByRole('columnheader', { name: 'Intervallo 80%', exact: true })).toBeVisible()
  await expect(page.getByRole('columnheader', { name: 'Intervallo 90%', exact: true })).toHaveCount(0)
  await expect(page.getByRole('cell', { name: '42%–68%', exact: true })).toBeVisible()
})

test('budget numerico: conserva gli esponenti su blur e Enter @smoke', async ({ page }, testInfo) => {
  test.setTimeout(90_000)
  const { createHash } = await import('node:crypto')
  const origin = new URL(String(testInfo.project.use.baseURL)).origin
  const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
  const writes: string[] = [], errors: string[] = [], dialogs: string[] = [], externalAborted: string[] = []
  const requests: string[] = []
  const replies: Array<{ path: string; status: number; body: { budget_total: number; context: { accounts: string[]; role: string; queue: string; days: string | number } } }> = []
  const pending: Array<Promise<void>> = []
  const cases: Array<Record<string, unknown>> = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('dialog', async (dialog) => { dialogs.push(dialog.message()); await dialog.dismiss() })
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.origin === origin && url.pathname === '/api/training-plan') requests.push(url.pathname + url.search)
  })
  page.on('response', (response) => {
    const url = new URL(response.url())
    if (url.origin === origin && url.pathname === '/api/training-plan') {
      pending.push(response.json().then((body) => { replies.push({ path: url.pathname + url.search, status: response.status(), body }) }))
    }
  })
  // Keep the application replies real. Block writes and external assets only.
  await page.route('**/*', (route) => {
    const request = route.request(), url = new URL(request.url())
    if (url.origin !== origin) { externalAborted.push(url.href); return route.abort() }
    if (request.method() !== 'GET') { writes.push(`${request.method()} ${url.pathname}`); return route.abort() }
    return route.fallback()
  })
  await page.addInitScript(() => localStorage.setItem('champion-fit-profile-accounts', JSON.stringify(['Alpha#EUW', 'Beta#EUW'])))
  try {
    for (const commit of ['blur', 'Enter'] as const) {
      for (const [draft, numericValue] of [['1e3', 1000], ['1.5e3', 1500], ['2e3', 2000], ['1000', 1000]] as const) {
        await test.step(`${draft} -> ${numericValue} via ${commit}`, async () => {
          const params = new URLSearchParams({ section: 'tournament', role: 'MIDDLE', queue: '440', days: '90', search: 'Keep me [x]+&', budget: '400', n: '320' })
          params.append('trace', 'first'); params.append('trace', 'second')
          const initial = '/app/fit?' + params
          const beforeGoto = replies.length
          await page.goto(initial)
          await expect(page.getByRole('heading', { name: 'Piano da 400 partite', exact: true })).toBeVisible()
          await expect.poll(() => replies.length).toBe(beforeGoto + 1)
          await page.reload()
          await expect(page.getByRole('heading', { name: 'Piano da 400 partite', exact: true })).toBeVisible()
          await expect.poll(() => replies.length).toBe(beforeGoto + 2)
          await expect(page.getByRole('alert')).toHaveCount(0)
          const input = page.getByRole('spinbutton', { name: 'Budget partite', exact: true })
          const parent = [...new URL(page.url()).searchParams].filter(([key]) => key !== 'budget')
          const storage = await page.evaluate(() => Object.fromEntries(Object.entries(localStorage)))
          const beforeDraft = requests.length
          await input.fill(draft)
          const native = await input.evaluate((element: HTMLInputElement) => ({ value: element.value, valueAsNumber: element.valueAsNumber,
            valid: element.validity.valid, badInput: element.validity.badInput, rangeUnderflow: element.validity.rangeUnderflow,
            rangeOverflow: element.validity.rangeOverflow, stepMismatch: element.validity.stepMismatch }))
          expect(native).toEqual({ value: draft, valueAsNumber: numericValue, valid: true, badInput: false,
            rangeUnderflow: false, rangeOverflow: false, stepMismatch: false })
          await page.waitForTimeout(200)
          expect(requests).toHaveLength(beforeDraft)
          expect(new URL(page.url()).searchParams.get('budget')).toBe('400')
          await expect(page.getByRole('heading', { name: 'Piano da 400 partite', exact: true })).toBeVisible()
          const response = page.waitForResponse((candidate) => {
            const url = new URL(candidate.url())
            return url.origin === origin && url.pathname === '/api/training-plan' && url.searchParams.get('budget') !== '400'
          })
          await input.press(commit === 'blur' ? 'Tab' : 'Enter')
          expect((await response).status()).toBe(200)
          await expect.poll(() => replies.length).toBe(beforeGoto + 3)
          await Promise.all(pending)
          const current = new URL(page.url())
          const actualBudget = current.searchParams.get('budget')!
          // Wait for the observed state, then compare with the intended value.
          // Soft assertions let every exponent reach the API on the RED run.
          await expect(input).toHaveValue(actualBudget)
          const heading = page.getByRole('heading', { name: `Piano da ${actualBudget} partite`, exact: true })
          await expect(heading).toBeVisible()
          const actual = replies.at(-1)!
          const request = new URL(actual.path, origin)
          const association = { url: actualBudget, input: await input.inputValue(), heading: await heading.textContent(),
            request: request.searchParams.get('budget'), response: actual.body.budget_total }
          expect.soft(association, `${draft} via ${commit} must retain its native numeric value`).toEqual({
            url: String(numericValue), input: String(numericValue), heading: `Piano da ${numericValue} partite`, request: String(numericValue), response: numericValue,
          })
          expect([...current.searchParams].filter(([key]) => key !== 'budget')).toEqual(parent)
          expect(request.searchParams.getAll('account')).toEqual(['Alpha#EUW', 'Beta#EUW'])
          expect(actual.body.context.accounts).toEqual(['Alpha#EUW', 'Beta#EUW'])
          expect({ role: request.searchParams.get('role'), queue: request.searchParams.get('queue'), days: request.searchParams.get('days') }).toEqual({ role: 'MIDDLE', queue: '440', days: '90' })
          expect({ role: actual.body.context.role, queue: actual.body.context.queue, days: String(actual.body.context.days) }).toEqual({ role: 'MIDDLE', queue: '440', days: '90' })
          const committedStorage = { ...storage,
            'champion-fit:plan-budget:v1': actualBudget,
            'champion-fit:competitive-plan-filters:v1': JSON.stringify({ budget: actualBudget, role: 'MIDDLE', queue: '440', days: '90' }),
          }
          expect(await page.evaluate(() => Object.fromEntries(Object.entries(localStorage)))).toEqual(committedStorage)
          await page.reload()
          await expect.poll(() => replies.length).toBe(beforeGoto + 4)
          await expect(input).toHaveValue(actualBudget)
          const persisted = { url: new URL(page.url()).searchParams.get('budget'), input: await input.inputValue(), response: replies.at(-1)!.body.budget_total }
          expect.soft(persisted, `${draft} via ${commit} must persist after full reload`).toEqual({ url: String(numericValue), input: String(numericValue), response: numericValue })
          expect([...new URL(page.url()).searchParams].filter(([key]) => key !== 'budget')).toEqual(parent)
          expect(await page.evaluate(() => Object.fromEntries(Object.entries(localStorage)))).toEqual(committedStorage)
          await expect(page.getByRole('alert')).toHaveCount(0)
          cases.push({ draft, commit, numeric_value: numericValue, native, association, persisted, parent_parameters_sha256: hash(parent),
            parent_parameters_preserved: true, scope_storage_preserved: true, no_GET_during_draft: true,
            requests: requests.slice(beforeDraft - 2), response: actual, observed_numeric_value_preserved: Number(actualBudget) === numericValue })
        })
      }
    }
    expect(cases).toHaveLength(8)
    expect(writes).toEqual([])
    expect(errors).toEqual([])
    expect(dialogs).toEqual([])
  } finally {
    await Promise.all(pending)
    await testInfo.attach('budget-numerico-cases.json', { body: Buffer.from(JSON.stringify({ cases, requests, writes, errors, dialogs,
      external_assets_aborted: externalAborted.length, API_payload_emulation: false }, null, 2)), contentType: 'application/json' })
  }
})
