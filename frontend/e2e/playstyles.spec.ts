import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import type { PlaystylesResponse } from '../src/api/playstyles'
import { RECOMMENDED_ALGORITHM_SETTINGS } from '../src/app/algorithm-settings'

const DATA_VIEW_STORAGE_KEY = 'champion-fit:data-view:v2'

async function chooseDataView(page: Page, name: 'Schede' | 'Radar') {
  const controls = page.locator('.scope-bar__display-controls')
  if (await controls.getAttribute('open') === null) await controls.locator('summary').click()
  await page.getByRole('button', { name: 'Vista dati', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Visualizzazione dei dati', exact: true })
  const radio = dialog.getByRole('radio', { name: new RegExp(`^${name}\\b`) })
  await radio.check()
  await expect(radio).toBeChecked()
  await dialog.getByRole('button', { name: 'Chiudi visualizzazione dati', exact: true }).click()
}

function response(accounts = ['Alpha#EUW', 'Beta#EUW'], queue = '420', role = 'MIDDLE'): PlaystylesResponse {
  const label = queue === '440' ? 'Maghi flex' : 'Maghi'
  const definition = { id: 'class:mage', label, kind: 'class', criteria: 'Champion che infliggono principalmente danni magici.', roles: ['MIDDLE'], sources: ['https://www.leagueoflegends.com/it-it/champions/'] }
  const comparison = { wins: { median: 6.5, q1: 5.8, q3: 7.2, n: 16 }, losses: { median: 5.9, q1: 5, q3: 6.5, n: 10 }, accounts: accounts.length, excluded_accounts: [] }
  return {
    version: 'fixture-v1', catalog: { version: 'fixture-v1', source_version: '16.13.1', sources: [{ name: 'Catalogo champion', url: 'https://www.leagueoflegends.com/it-it/champions/' }], categories: [definition] },
    filters: { role, queue, days: '180' }, options: { roles: ['MIDDLE', 'TOP', 'JUNGLE'], queues: [{ id: '420', label: 'Classificata singola' }, { id: '440', label: 'Classificata flex' }], pairs: [{ role: 'MIDDLE', queue: '420', games: 30 }] },
    summary: { unique_games: 30, observations: 40, accounts: accounts.length, classified_games: 28, unclassified_games: 2, metrics_games: 26, supported_categories: 0 },
    categories: [{ ...definition, games: 22, observations: 26, wins: 16, losses: 10, mean: 61.4, lower_90: 43.5, upper_90: 75, baseline_mean: 50, baseline_lower_90: 34, baseline_upper_90: 66, lift: 11.4, baseline_games: 8, supported: false, status: 'Da confermare', reasons: ['Il confronto non supera la soglia corretta per tutte le categorie.'], account_count: accounts.length, comparable_accounts: accounts.length, missing_accounts: [], missing_baseline_accounts: [], support_per_account: Object.fromEntries(accounts.map((account) => [account, { games: 13, baseline_games: 4 }])), prior_share: .38, threshold: 99.8214, family_size: 14, composition: [{ champion: 'Ahri', name: 'Ahri', games: 22, wins: 16, losses: 10 }], sensitivity: { champion: 'Ahri', games: 0, supported: false, lift: null, depends_on_champion: true } }],
    behavior: [{ id: 'farm', label: 'Farm', unit: 'CS/min', raw: comparison, percentiles: { wins: null, losses: null, accounts: 0, excluded_accounts: accounts } }, ...['Visione', 'Partecipazione', 'Danni alle torri'].map((label, index) => ({ id: `axis-${index}`, label, unit: index === 1 ? '%' : index === 2 ? 'danni/min' : '/min', raw: comparison, percentiles: { ...comparison, wins: { median: 65, q1: 45, q3: 80, n: 16 }, losses: { median: 48, q1: 30, q3: 60, n: 10 } } }))],
    suggestions: { category_id: 'class:mage', exploratory: true, played: [{ champion: 'Ahri', name: 'Ahri', games: 22, wins: 16, losses: 10, mean: 61.4, lower_90: 43.5, upper_90: 75 }], untried: [{ champion: 'Orianna', name: 'Orianna', similarity: .75, label: 'Ipotesi da provare', roles: ['MIDDLE'] }] },
    notes: ['Associazioni descrittive: le metriche finali non dimostrano un effetto causale.'],
  }
}

async function mockPlaystyles(page: Page, slowFlex = false) {
  await page.addInitScript(() => {
    if (!localStorage.getItem('champion-fit-profile-accounts')) {
      localStorage.setItem('champion-fit-profile-accounts', JSON.stringify(['Alpha#EUW', 'Beta#EUW']))
    }
  })
  await page.route('**/api/playstyles?**', async (route) => {
    const params = new URL(route.request().url()).searchParams
    const queue = params.get('queue') || '420'
    if (slowFlex && queue === '440') await new Promise((resolve) => setTimeout(resolve, 350))
    const payload = response(params.getAll('account'), queue, params.get('role') || 'MIDDLE')
    const days = params.get('days')
    payload.filters.days = days === '90' || days === '365' || days === 'all' ? days : '180'
    await route.fulfill({ json: payload })
  })
  await page.route('**/api/playstyle-evidence?**', async (route) => {
    const params = new URL(route.request().url()).searchParams
    const pageNumber = Number(params.get('page') || 1)
    const accounts = params.getAll('account')
    await route.fulfill({ json: {
      category_id: 'class:mage', page: pageNumber, page_size: 20, total: 22,
      matches: Array.from({ length: pageNumber === 1 ? 20 : 2 }, (_, index) => ({ account: accounts[index % accounts.length], match_id: `STYLE-${(pageNumber - 1) * 20 + index + 1}`, champion: 'Ahri', role: params.get('role'), queue: params.get('queue'), date: '2026-08-01T12:00:00Z', win: index % 2, note: 'Fixture di supporto', duration_minutes: 29 })),
    } })
  })
  await page.goto('/app/matches?section=style')
  // Full refresh verifies the new artifact, not a previous app module.
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Maghi', exact: true })).toBeVisible()
}

test('@smoke stili: categorie, fonti, dati osservati e ipotesi distinte', async ({ page }, testInfo) => {
  await mockPlaystyles(page)
  const expectedCategory = response().categories[0]
  if (!expectedCategory) throw new Error('Expected a playstyle category in the fixture')
  const expectedReason = expectedCategory.reasons[0]
  if (!expectedReason) throw new Error('Expected a playstyle explanation in the fixture')
  await page.getByRole('combobox', { name: 'Ruolo degli stili', exact: true }).selectOption('MIDDLE')
  await expect(page.getByLabel('Ruolo degli stili')).toHaveValue('MIDDLE')
  await expect(page.getByLabel('Modalità degli stili')).toHaveValue('420')
  await expect(page.getByRole('heading', { name: 'Come si presentano le tue vittorie?' })).toBeVisible()
  const suggestionLink = page.getByRole('link', { name: 'Vedi i campioni da provare' })
  const suggestionHref = await suggestionLink.getAttribute('href')
  const suggestionUrl = new URL(suggestionHref!, 'http://champion-fit.local')
  expect(suggestionUrl.pathname).toBe('/app/fit')
  expect(suggestionUrl.searchParams.get('section')).toBe('training')
  expect(suggestionUrl.searchParams.get('category')).toBe('class:mage')
  await page.getByText('Criteri e fonti del catalogo', { exact: true }).click()
  await expect(page.getByText(/Ruoli compatibili:/)).toBeVisible()
  await page.getByRole('button', { name: 'Perché Maghi?', exact: true }).click()
  await expect(page.getByText(/Il risultato dipende da questo campione/)).toBeVisible()
  await expect(page.getByText(expectedReason, { exact: true })).toBeVisible()
  await expect(page.getByText(new RegExp(`Confronto corretto per una famiglia di ${expectedCategory.family_size} categorie`))).toBeVisible()
  await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); window.scrollTo(0, 0) })
  await page.screenshot({ path: testInfo.outputPath('playstyles-desktop.png'), fullPage: true })

  await suggestionLink.click()
  await expect(page.getByRole('heading', { name: 'Scelte vicine ai tuoi gusti', exact: true })).toBeVisible()
  await expect(page.getByLabel('Caratteristica')).toHaveValue('class:mage')
  const hypothesis = page.locator('.observed-recommendation').filter({ hasText: 'LeBlanc' }).first()
  await expect(hypothesis.getByText('Da scoprire', { exact: true })).toBeVisible()
  await expect(hypothesis.getByText('Affinità di catalogo', { exact: true })).toBeVisible()
  await expect(hypothesis.getByText('Nessuna partita con questo campione nel perimetro selezionato', { exact: true })).toBeVisible()
  await expect(hypothesis.getByText(/Intervallo binomiale/)).toHaveCount(0)
})

test('prove paginate conservano category, account, ruolo e coda', async ({ page }) => {
  await mockPlaystyles(page)
  await page.getByRole('combobox', { name: 'Ruolo degli stili', exact: true }).selectOption('MIDDLE')
  await expect(page.getByLabel('Ruolo degli stili')).toHaveValue('MIDDLE')
  await page.getByRole('button', { name: 'Perché Maghi?', exact: true }).click()
  await page.getByRole('button', { name: 'Mostra le partite · Maghi', exact: true }).click()
  const region = page.getByRole('region', { name: 'Partite a supporto di Maghi', exact: true })
  await expect(region.locator('tbody tr')).toHaveCount(20)
  const requested = page.waitForRequest((request) => request.url().includes('/api/playstyle-evidence') && new URL(request.url()).searchParams.get('page') === '2')
  await page.getByRole('button', { name: 'Successiva', exact: true }).click()
  const params = new URL((await requested).url()).searchParams
  expect(params.get('category')).toBe('class:mage')
  expect(params.get('role')).toBe('MIDDLE')
  expect(params.get('queue')).toBe('420')
  expect(params.getAll('account')).toEqual(['Alpha#EUW', 'Beta#EUW'])
  await expect(region.locator('tbody tr')).toHaveCount(2)
  await expect(region.getByText('STYLE-21', { exact: true })).toBeVisible()
  await expect(region.getByText('STYLE-1', { exact: true })).toHaveCount(0)
})

test('cambi rapidi coda e account non mostrano dati del vecchio perimetro', async ({ page }) => {
  await mockPlaystyles(page, true)
  await page.getByRole('combobox', { name: 'Modalità degli stili', exact: true }).selectOption('440')
  await expect(page.getByRole('heading', { name: 'Maghi', exact: true })).toHaveCount(0)
  await expect(page.getByLabel('Modalità degli stili')).toHaveValue('440')
  await page.getByRole('combobox', { name: 'Periodo degli stili', exact: true }).selectOption('90')
  await expect(page.getByRole('heading', { name: 'Maghi flex', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Perché Maghi flex?', exact: true }).click()
  await page.getByRole('button', { name: 'Mostra le partite · Maghi flex', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Partite a supporto di Maghi flex', exact: true })).toBeVisible()
  await page.goto('/app/profile')
  await page.getByRole('button', { name: /Beta#EUW/ }).click()
  await page.goto('/app/matches?section=style&queue=440&days=90&role=MIDDLE')
  await expect(page.getByRole('region', { name: 'Partite a supporto di Maghi flex', exact: true })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Maghi flex', exact: true })).toBeVisible()
  await expect(page.getByLabel('Modalità degli stili')).toHaveValue('440')
  await page.getByRole('button', { name: 'Perché Maghi flex?', exact: true }).click()
  await page.getByRole('button', { name: 'Mostra le partite · Maghi flex', exact: true }).click()
  const final = page.getByRole('region', { name: 'Partite a supporto di Maghi flex', exact: true })
  await expect(final.getByText('Beta#EUW', { exact: true })).toHaveCount(0)
  await expect(final.getByText('Alpha#EUW', { exact: true }).first()).toBeVisible()
})

test('ricerca locale non ricalcola la famiglia; mobile senza overflow', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await mockPlaystyles(page)
  const calls: string[] = []
  page.on('request', (request) => { if (request.url().includes('/api/playstyles?')) calls.push(request.url()) })
  await page.getByLabel('Cerca categoria').fill('assente')
  await expect(page.getByRole('heading', { name: 'Nessuna categoria disponibile' })).toBeVisible()
  await page.getByRole('combobox', { name: 'Ordina categorie', exact: true }).selectOption('games')
  expect(calls).toHaveLength(0)
  await page.getByLabel('Cerca categoria').clear()
  await page.getByRole('button', { name: 'Perché Maghi?', exact: true }).click()
  const audit = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()
  expect(audit.violations.filter((item) => ['critical', 'serious'].includes(item.impact ?? ''))).toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); window.scrollTo(0, 0) })
  await page.screenshot({ path: testInfo.outputPath('playstyles-mobile.png'), fullPage: true })
})

test('radar usa solo tre assi comuni, persiste e le azioni funzionano dalle schede', async ({ page }) => {
  await mockPlaystyles(page)

  const archetypes = page.locator('[data-explorer-id="playstyle-archetypes"]')
  await chooseDataView(page, 'Schede')
  await expect(archetypes).toHaveAttribute('data-view', 'cards')
  await expect(archetypes.locator('.data-explorer__switch')).toHaveCount(0)
  await archetypes.getByRole('button', { name: 'Perché Maghi?', exact: true }).click()
  await archetypes.getByRole('button', { name: 'Mostra le partite · Maghi', exact: true }).click()
  await expect(archetypes.getByRole('region', { name: 'Partite a supporto di Maghi', exact: true })).toBeVisible()

  const behavior = page.locator('.behavior-views')
  await expect(behavior.getByRole('button', { name: /^(Dettagli|Radar)$/ })).toHaveCount(0)
  await chooseDataView(page, 'Radar')
  await expect(behavior.locator('[data-view="radar"]')).toBeVisible()
  await expect(behavior.getByRole('img', { name: /Visione, Partecipazione, Danni alle torri/ })).toBeVisible()
  await expect(behavior.getByText('Esclusi dal radar: Farm.', { exact: false })).toBeVisible()
  await expect(behavior.getByRole('rowheader', { name: 'Farm', exact: true })).toHaveCount(0)
  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), DATA_VIEW_STORAGE_KEY)).toBe(JSON.stringify({ view: 'radar' }))

  await page.reload()
  await expect(page.locator('.behavior-views [data-view="radar"]')).toBeVisible()
})

test('radar resta disabilitato sotto il minimo di tre assi validi', async ({ page }) => {
  await page.route('**/api/playstyles?**', async (route) => {
    const params = new URL(route.request().url()).searchParams
    const payload = response(params.getAll('account'), params.get('queue') || '420', params.get('role') || 'MIDDLE')
    payload.behavior = payload.behavior.slice(0, 3)
    await route.fulfill({ json: payload })
  })
  await page.addInitScript(() => {
    localStorage.setItem('champion-fit-profile-accounts', JSON.stringify(['Alpha#EUW', 'Beta#EUW']))
    localStorage.setItem('champion-fit:data-view:v2', JSON.stringify({ view: 'radar' }))
  })
  await page.goto('/app/matches?section=style')
  await page.reload()

  const behavior = page.locator('.behavior-views')
  await expect(behavior.getByRole('button', { name: /^(Dettagli|Radar)$/ })).toHaveCount(0)
  await expect(behavior.locator('[data-view="details"]')).toBeVisible()
  await expect(behavior.getByText(/2 di 3 in questo contesto/)).toBeVisible()
  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), DATA_VIEW_STORAGE_KEY)).toBe(JSON.stringify({ view: 'radar' }))
})

test('@smoke tutto lo storico resta esplicito dopo refresh e nei collegamenti agli approfondimenti', async ({ page }) => {
  await page.route('**/api/algorithm-settings', (route) => route.fulfill({ json: {
    revision: 1, fingerprint: 'playstyles-period-fixture',
    settings: RECOMMENDED_ALGORITHM_SETTINGS, defaults: RECOMMENDED_ALGORITHM_SETTINGS,
    schema: [], history: [],
  } }))
  await mockPlaystyles(page)
  const period = page.getByRole('combobox', { name: 'Periodo degli stili', exact: true })
  await expect(period).toHaveValue('180')
  await period.selectOption('90')
  await expect(page.locator('.playstyles-auto')).toContainText('ultimi 90 giorni')

  const allHistory = page.waitForRequest((request) => {
    const url = new URL(request.url())
    return url.pathname === '/api/playstyles' && url.searchParams.get('days') === 'all'
  })
  await period.selectOption('all')
  await allHistory
  await expect(page).toHaveURL(/days=all/)
  await expect(period).toHaveValue('all')
  await expect(page.locator('.playstyles-auto')).toContainText('tutto lo storico')

  await page.reload()
  await expect(period).toHaveValue('all')
  await expect(page.locator('.playstyles-auto')).toContainText('tutto lo storico')
  const suggestions = page.getByRole('link', { name: 'Vedi i campioni da provare' })
  expect(new URL((await suggestions.getAttribute('href'))!, page.url()).searchParams.get('days')).toBe('all')

  await page.getByRole('button', { name: 'Perché Maghi?', exact: true }).click()
  const evidence = page.waitForRequest((request) => {
    const url = new URL(request.url())
    return url.pathname === '/api/playstyle-evidence' && url.searchParams.get('days') === 'all'
  })
  await page.getByRole('button', { name: 'Mostra le partite · Maghi', exact: true }).click()
  await evidence
  await expect(page.getByRole('region', { name: 'Partite a supporto di Maghi', exact: true })).toBeVisible()
})

test('smoke API reale della fixture: catalogo e assenza metriche restano leggibili', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('champion-fit-profile-accounts', JSON.stringify(['Alpha#EUW', 'Beta#EUW'])))
  await page.goto('/app/matches?section=style&days=all')
  const loaded = page.waitForResponse((response) => response.url().includes('/api/playstyles?') && response.ok())
  await page.reload()
  const payload = await (await loaded).json() as PlaystylesResponse
  expect(payload.catalog.categories).toHaveLength(14)
  await expect(page.getByRole('heading', { name: 'Con quali categorie vinci?' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Come si presentano le tue vittorie?' })).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)
})
