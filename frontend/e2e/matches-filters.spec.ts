import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import type { MatchDto, MatchesResponseDto, ProfileResponseDto } from '../src/api/types'

test.beforeEach(async ({ page }) => {
  await page.route('https://ddragon.leagueoflegends.com/**', (route) => route.abort())
  await page.emulateMedia({ reducedMotion: 'reduce' })
})

const rows = (page: Page) => page.getByRole('button', { name: /^Apri annotazione:/ })
const metric = (page: Page) => page.getByRole('region', { name: 'Riepilogo delle partite' }).locator('.metric-card').filter({ has: page.getByText('Partite', { exact: true }) }).locator('strong')
const filter = (page: Page, name: string) => page.getByRole('group', { name: 'Filtri delle partite' }).getByRole('combobox', { name, exact: true })

async function fullRefresh(page: Page, url = '/app/matches') {
  await page.goto(url)
  await expect(metric(page)).toBeVisible()
  await expect(page.locator('#main-content .skeleton')).toHaveCount(0)
  await page.reload()
  await expect(metric(page)).toBeVisible()
  await expect(page.locator('#main-content .skeleton')).toHaveCount(0)
}

test('quattro filtri aggiornano statistiche ed elenco, restano nel link e funzionano su mobile @smoke', async ({ page }, testInfo) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await fullRefresh(page)
  await expect(filter(page, 'Periodo').locator('option')).toHaveText(['Tutto lo storico', 'Ultimi 90 giorni', 'Ultimi 180 giorni', 'Ultimi 365 giorni'])
  await expect(metric(page)).toHaveText('6')
  await expect(rows(page)).toHaveCount(6)
  const state = { champion: '', role: 'ALL', queue: 'all', days: 'all' }
  for (const [name, key, value, count] of [
    ['Campione', 'champion', 'Ahri', 4], ['Ruolo', 'role', 'MIDDLE', 4],
    ['Modalità', 'queue', '420', 3], ['Periodo', 'days', '90', 3],
  ] as const) {
    state[key] = value
    const summaryResponse = page.waitForResponse((response) => {
      const url = new URL(response.url())
      return url.pathname === '/api/profile' && url.searchParams.get(key) === value
    })
    const matchesResponse = page.waitForResponse((response) => {
      const url = new URL(response.url())
      return url.pathname === '/api/matches' && url.searchParams.get(key) === value
    })
    await filter(page, name).selectOption(value)
    const responses = await Promise.all([summaryResponse, matchesResponse])
    for (const response of responses) {
      expect(response.ok()).toBe(true)
      const params = new URL(response.url()).searchParams
      for (const [field, selected] of Object.entries(state)) expect(params.get(field) ?? '').toBe(selected)
    }
    expect((await responses[0].json() as ProfileResponseDto).summary.games).toBe(count)
    expect((await responses[1].json() as MatchesResponseDto).total).toBe(count)
    await expect(metric(page)).toHaveText(String(count))
    await expect(rows(page)).toHaveCount(count)
  }
  await page.reload()
  await expect(filter(page, 'Campione')).toHaveValue('Ahri')
  await expect(filter(page, 'Ruolo')).toHaveValue('MIDDLE')
  await expect(filter(page, 'Modalità')).toHaveValue('420')
  await expect(filter(page, 'Periodo')).toHaveValue('90')
  await expect(metric(page)).toHaveText('3')
  await expect(rows(page)).toHaveCount(3)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
  await page.evaluate(() => document.fonts.ready)
  await page.screenshot({ path: testInfo.outputPath('matches-filters.png'), fullPage: true })
  const accessibility = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()
  expect(accessibility.violations.filter((item) => ['serious', 'critical'].includes(item.impact ?? ''))).toEqual([])
  await filter(page, 'Ruolo').selectOption('TOP')
  await expect(metric(page)).toHaveText('0')
  await expect(rows(page)).toHaveCount(0)
  await expect(page.getByText('Nessuna partita nei dati selezionati', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Azzera filtri' }).click()
  await expect(metric(page)).toHaveText('6')
  await expect(rows(page)).toHaveCount(6)
  expect(errors).toEqual([])
})

const match: MatchDto = {
  id: 1, account: 'Alpha#EUW', match_id: 'HISTORY-1', date: '2026-08-22T20:00:00Z',
  patch: '16.16', queue: '420', champion: 'Ahri', role: 'MIDDLE', identity_resolution: 'puuid',
  duration_minutes: 30, win: 1, explicit_afk: 0, suspected_quasi_afk: 0, early_surrender: 0,
  anomaly_flags: '', match_quality_score: 1, loss_attribution_weight: 1, win_evidence_weight: 1,
  reason: 'Partita sintetica per verificare la paginazione.', icon_url: '',
  annotation_invincible: 0, annotation_carryable_loss: 0, annotation_afk_player: 0,
  annotation_griefer: 0, annotation_team_collapse: 0, annotation_manual_label: '',
  annotation_note: '', annotation_confidence: 1,
}

async function mockHistory(page: Page, options: { failNextPage?: boolean; pendingNextPage?: Promise<void> } = {}) {
  const offsets: number[] = []
  let fail = Boolean(options.failNextPage)
  const all = Array.from({ length: 53 }, (_, index) => ({ ...match, id: index, match_id: `HISTORY-${index}` }))
  await page.route('**/api/profile?**', async (route) => {
    const response = await route.fetch()
    const body = await response.json() as ProfileResponseDto
    const empty = new URL(route.request().url()).searchParams.get('role') === 'TOP'
    await route.fulfill({ response, json: { ...body, summary: { ...body.summary, games: empty ? 0 : 53 } } })
  })
  await page.route('**/api/matches?**', async (route) => {
    const params = new URL(route.request().url()).searchParams
    const offset = Number(params.get('offset') ?? 0)
    offsets.push(offset)
    if (offset === 24) {
      if (options.pendingNextPage) await options.pendingNextPage
      if (fail) {
        fail = false
        await route.fulfill({ status: 400, json: { error: 'Errore sintetico di caricamento' } })
        return
      }
    }
    const filtered = params.get('role') === 'TOP' ? [] : all
    await route.fulfill({ json: { items: filtered.slice(offset, offset + 24), total: filtered.length, offset,
      limit: 24, next_offset: offset + 24 < filtered.length ? offset + 24 : null } })
  })
  await page.route('**/api/annotations?**', (route) => route.fulfill({ json: { item: null, revision: null } }))
  return offsets
}

test('carica 24 + 24 + 5 partite, conserva i totali e apre annotazioni oltre la prima pagina @smoke', async ({ page }) => {
  const offsets = await mockHistory(page, { failNextPage: true })
  await fullRefresh(page)
  await expect(rows(page)).toHaveCount(24)
  await expect(metric(page)).toHaveText('53')
  await page.getByRole('button', { name: 'Carica altre partite' }).click()
  await expect(page.getByRole('alert')).toContainText('Le partite già caricate sono ancora disponibili')
  await expect(rows(page)).toHaveCount(24)
  await page.getByRole('button', { name: 'Riprova a caricare altre partite' }).click()
  await expect(rows(page)).toHaveCount(48)
  await expect(metric(page)).toHaveText('53')
  await rows(page).nth(30).click()
  const drawer = page.getByRole('dialog', { name: 'Annotazione della partita' })
  await expect(drawer.getByText('HISTORY-30', { exact: true })).toBeVisible()
  await expect(drawer.getByRole('textbox', { name: 'Nota', exact: true })).toBeVisible()
  await drawer.getByRole('button', { name: 'Annulla', exact: true }).click()
  await page.getByRole('button', { name: 'Carica altre partite' }).click()
  await expect(rows(page)).toHaveCount(53)
  await expect(page.getByRole('button', { name: 'Carica altre partite' })).toHaveCount(0)
  await expect(metric(page)).toHaveText('53')
  expect(offsets.slice(-3)).toEqual([24, 24, 48])
  await filter(page, 'Ruolo').selectOption('TOP')
  await expect(rows(page)).toHaveCount(0)
  await expect(metric(page)).toHaveText('0')
  expect(offsets.at(-1)).toBe(0)
})

test('cambio filtro durante il caricamento non aggiunge partite della selezione precedente', async ({ page }) => {
  let release!: () => void
  const pendingNextPage = new Promise<void>((resolve) => { release = resolve })
  const offsets = await mockHistory(page, { pendingNextPage })
  try {
    await fullRefresh(page)
    await page.getByRole('button', { name: 'Carica altre partite' }).click()
    await expect.poll(() => offsets.at(-1)).toBe(24)
    await expect(page.getByRole('button', { name: 'Caricamento…', exact: true })).toBeDisabled()
    await filter(page, 'Ruolo').selectOption('TOP')
    await expect(rows(page)).toHaveCount(0)
    await expect(metric(page)).toHaveText('0')
    release()
    await expect(page.locator('#main-content .skeleton')).toHaveCount(0)
    await expect(rows(page)).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Carica altre partite' })).toHaveCount(0)
  } finally { release() }
})

test('barra compatta senza overflow a 320 pixel e con tema chiaro', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 })
  await page.addInitScript(() => localStorage.setItem('champion-fit:appearance:v1', JSON.stringify({ theme: 'light', accent: 'mint', density: 'compact' })))
  await fullRefresh(page)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
  await expect(filter(page, 'Campione')).toBeVisible()
  await expect(filter(page, 'Periodo')).toBeVisible()
})
