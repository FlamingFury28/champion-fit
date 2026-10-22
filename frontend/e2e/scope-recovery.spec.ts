import { expect, test, type Page } from '@playwright/test'
import { RECOMMENDED_ALGORITHM_SETTINGS } from '../src/app/algorithm-settings'
import type { AccountsResponseDto, AlgorithmSettingsResponseDto, SyncStatusResponseDto } from '../src/api/types'

const ACCOUNTS_KEY = 'champion-fit-profile-accounts'
const PROFILES_KEY = 'champion-fit-profile-groups'
const accounts: AccountsResponseDto = {
  items: ['Alpha#EUW', 'Beta#EUW'].map((account) => ({
    account, raw_games: 2, eligible_games: 2, analyzed_games: 2,
    wins: 1, games: 2, first_game: null, last_game: null,
  })),
}
const settings: AlgorithmSettingsResponseDto = {
  revision: 1, fingerprint: 'scope-recovery-fixture',
  settings: RECOMMENDED_ALGORITHM_SETTINGS, defaults: RECOMMENDED_ALGORITHM_SETTINGS,
  schema: [], history: [],
}
const syncStatus: SyncStatusResponseDto = {
  mode: 'snapshot', sync_active: false, automatic_api_calls: false,
  checkpoint_accounts: 0, last_checkpoint_at: null, last_completed_at: null, metadata: {},
}

async function mockApi(page: Page) {
  const state = { settingsOffline: false, settingsRequests: 0, mutations: [] as string[] }
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    // Every API request is fulfilled locally; this suite never writes the fixture DB.
    if (!['GET', 'HEAD'].includes(request.method())) {
      state.mutations.push(`${request.method()} ${path}`)
      await route.fulfill({ status: 405, json: { error: 'Unexpected mutation in read-only scope fixture' } })
      return
    }
    if (path === '/api/accounts') await route.fulfill({ json: accounts })
    else if (path === '/api/sync-status') await route.fulfill({ json: syncStatus })
    else if (path === '/api/algorithm-settings') {
      state.settingsRequests += 1
      await route.fulfill(state.settingsOffline
        ? { status: 503, json: { error: 'Settings fixture offline' } }
        : { json: settings })
    } else await route.fulfill({ status: 503, json: { error: `Unexpected fixture endpoint: ${path}` } })
  })
  await page.route('https://ddragon.leagueoflegends.com/**', (route) => route.abort())
  return state
}

async function seedScope(page: Page, selected: readonly string[], profiles: Record<string, string[]> = {}) {
  await page.addInitScript(({ accountsKey, profilesKey, selectedAccounts, savedProfiles }) => {
    localStorage.setItem(accountsKey, JSON.stringify(selectedAccounts))
    localStorage.setItem(profilesKey, JSON.stringify(savedProfiles))
  }, { accountsKey: ACCOUNTS_KEY, profilesKey: PROFILES_KEY, selectedAccounts: selected, savedProfiles: profiles })
}

async function refreshAfterBootstrap(page: Page, path: string, heading: string) {
  const syncResponse = () => page.waitForResponse((response) => new URL(response.url()).pathname === '/api/sync-status')
  const firstSync = syncResponse()
  await page.goto(path)
  await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible()
  await expect(page.locator('#main-content .skeleton')).toHaveCount(0)
  // The independent sync request can still be pending after the scoped page is ready.
  // Finish the first document's bootstrap before the required full refresh so
  // WebKit does not report canceled fulfilled requests as access-control errors.
  expect(await (await firstSync).finished()).toBeNull()
  const refreshedSync = syncResponse()
  await page.reload()
  await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible()
  await expect(page.locator('#main-content .skeleton')).toHaveCount(0)
  expect(await (await refreshedSync).finished()).toBeNull()
}

async function freshProfile(page: Page) {
  await refreshAfterBootstrap(page, '/app/profile', 'Dati usati')
}

test('startup con localStorage negato conserva selezioni e profili nella sessione @smoke', async ({ page }) => {
  const state = await mockApi(page)
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() { throw new DOMException('Storage access denied by fixture', 'SecurityError') },
    })
  })
  await freshProfile(page)
  const alpha = page.locator('.selected-account-list').getByRole('button', { name: /Alpha#EUW/ })
  const beta = page.locator('.selected-account-list').getByRole('button', { name: /Beta#EUW/ })
  await expect(alpha).toHaveAttribute('aria-pressed', 'true')
  await expect(beta).toHaveAttribute('aria-pressed', 'true')
  await alpha.click()
  await expect(alpha).toHaveAttribute('aria-pressed', 'false')
  await expect(beta).toHaveAttribute('aria-pressed', 'true')
  await page.getByRole('textbox', { name: 'Nome profilo', exact: true }).fill('Sessione')
  await page.getByRole('button', { name: 'Salva', exact: true }).click()
  await expect(page.getByText('Profilo disponibile per questa sessione', { exact: true })).toBeVisible()
  await expect(page.getByText('Profilo salvato', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^Sessione/ })).toContainText('Beta#EUW')
  await expect(page.getByText('valido per questa sessione', { exact: true })).toBeVisible()
  expect(pageErrors).toEqual([])
  expect(state.mutations).toEqual([])
})

test('quota esaurita non dichiara salvato il profilo e il reload ripristina soltanto i dati persistiti', async ({ page }) => {
  const state = await mockApi(page)
  await page.addInitScript((accountsKey) => {
    localStorage.setItem(accountsKey, JSON.stringify(['Alpha#EUW']))
    Storage.prototype.setItem = () => { throw new DOMException('Storage quota exhausted by fixture', 'QuotaExceededError') }
  }, ACCOUNTS_KEY)
  await freshProfile(page)
  await page.getByRole('textbox', { name: 'Nome profilo', exact: true }).fill('Sessione')
  await page.getByRole('button', { name: 'Salva', exact: true }).click()
  await expect(page.getByRole('button', { name: /^Sessione/ })).toBeVisible()
  await expect(page.getByText('Profilo disponibile per questa sessione', { exact: true })).toBeVisible()
  await expect(page.getByText('Profilo salvato', { exact: true })).toHaveCount(0)
  expect(await page.evaluate((profilesKey) => localStorage.getItem(profilesKey), PROFILES_KEY)).toBeNull()
  await page.reload()
  await expect(page.getByRole('heading', { level: 1, name: 'Dati usati', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: /^Sessione/ })).toHaveCount(0)
  await expect(page.locator('.selected-account-list').getByRole('button', { name: /Alpha#EUW/ })).toHaveAttribute('aria-pressed', 'true')
  expect(state.mutations).toEqual([])
})

test('il primo errore Algoritmi 503 mostra alert e Riprova recupera le impostazioni', async ({ page }) => {
  const state = await mockApi(page)
  state.settingsOffline = true
  await refreshAfterBootstrap(page, '/app/settings/algorithms', 'Impossibile caricare le impostazioni algoritmiche')
  await expect(page.getByRole('heading', { name: 'Impossibile caricare le impostazioni algoritmiche', exact: true })).toBeVisible()
  await expect(page.getByRole('alert')).toContainText('Settings fixture offline')
  await expect(page.locator('#main-content .skeleton')).toHaveCount(0)
  const failedRequests = state.settingsRequests
  state.settingsOffline = false
  await page.getByRole('button', { name: 'Riprova', exact: true }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Parametri degli algoritmi', exact: true })).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(page.locator('#main-content .skeleton')).toHaveCount(0)
  expect(state.settingsRequests).toBe(failedRequests + 1)
  expect(state.mutations).toEqual([])
})

test('un profilo interamente sconosciuto non risulta applicato parzialmente', async ({ page }) => {
  const state = await mockApi(page)
  await seedScope(page, ['Alpha#EUW'], { Obsoleto: ['Missing#EUW'] })
  await freshProfile(page)
  await page.getByRole('button', { name: /^Obsoleto/ }).click()
  await expect(page.getByText('Profilo non applicato', { exact: true })).toBeVisible()
  await expect(page.getByText('Profilo applicato parzialmente', { exact: true })).toHaveCount(0)
  await expect(page.locator('.selected-account-list').getByRole('button', { name: /Alpha#EUW/ })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.selected-account-list').getByRole('button', { name: /Beta#EUW/ })).toHaveAttribute('aria-pressed', 'false')
  expect(await page.evaluate((accountsKey) => JSON.parse(localStorage.getItem(accountsKey) ?? 'null'), ACCOUNTS_KEY)).toEqual(['Alpha#EUW'])
  expect(state.mutations).toEqual([])
})

for (const [name, selected, label] of [
  ['una selezione irrisolta di pari cardinalità', ['Alpha#EUW', 'Missing#EUW'], '2 account attivi'],
  ['lo stesso insieme in ordine diverso', ['Beta#EUW', 'Alpha#EUW'], 'Tutti gli account · 2'],
] as const) {
  test(`ScopeBar riconosce ${name} confrontando gli account effettivi`, async ({ page }) => {
    const state = await mockApi(page)
    await seedScope(page, selected)
    await freshProfile(page)
    await expect(page.locator('.scope-bar__identity strong')).toHaveText(label)
    expect(await page.evaluate((accountsKey) => JSON.parse(localStorage.getItem(accountsKey) ?? 'null'), ACCOUNTS_KEY)).toEqual([...selected].sort())
    expect(state.mutations).toEqual([])
  })
}
