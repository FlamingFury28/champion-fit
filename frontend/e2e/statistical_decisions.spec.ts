import { expect, test, type Page, type Response } from '@playwright/test'
import type { ChampionsResponseDto, FriendsResponseDto, MatchupsResponseDto, RecommendationsResponseDto } from '../src/api/types'

const percent = (value: number) => `${new Intl.NumberFormat('it-IT', { maximumFractionDigits: 1 }).format(value)}%`
const decimal = (value: number) => new Intl.NumberFormat('it-IT', { maximumFractionDigits: 1 }).format(value)

function endpointResponse(page: Page, endpoint: string, accounts?: string[]) {
  return page.waitForResponse((response) => {
    const url = new URL(response.url())
    return response.ok() && url.pathname === endpoint && (!accounts ||
      JSON.stringify(url.searchParams.getAll('account').sort()) === JSON.stringify([...accounts].sort()))
  })
}

async function refreshWithResponse(page: Page, path: string, endpoint: string) {
  const matchesEndpoint = (response: Response) => response.ok() && new URL(response.url()).pathname === endpoint
  const initialResponse = page.waitForResponse(matchesEndpoint)
  await page.goto(path)
  const initial = await initialResponse
  await initial.finished()
  await initial.body()
  const responseSnapshot = page.waitForResponse(matchesEndpoint).then(async (response) => {
    await response.finished()
    return { url: response.url(), body: await response.json() as unknown }
  })
  await page.reload()
  return responseSnapshot
}

async function chooseDataView(page: Page, name: 'Barre' | 'Elenco') {
  const controls = page.locator('.scope-bar__display-controls')
  if (await controls.getAttribute('open') === null) await controls.locator('summary').click()
  await controls.getByRole('button', { name: 'Vista dati', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Visualizzazione dei dati', exact: true })
  await dialog.getByRole('radio', { name: new RegExp(`^${name}\\b`) }).check()
  await dialog.getByRole('button', { name: 'Chiudi visualizzazione dati', exact: true }).click()
}

async function chooseAccounts(page: Page, accounts: string[], endpoint: string): Promise<Response> {
  const returnTo = new URL(page.url())
  await page.goto('/app/profile')
  for (const name of ['Alpha#EUW', 'Beta#EUW']) {
    const account = page.locator('.selected-account-list').getByRole('button', { name: new RegExp(name) })
    const selected = await account.getAttribute('aria-pressed') === 'true'
    if (selected !== accounts.includes(name)) await account.click()
  }
  const response = endpointResponse(page, endpoint, accounts)
  await page.goto(`${returnTo.pathname}${returnTo.search}`)
  return response
}

test('@smoke piccoli campioni: intervallo incerto distinto dal risultato osservato', async ({ page }) => {
  const response = await refreshWithResponse(page, '/app/fit?section=choices&queue=all&days=all', '/api/recommendations')
  const recommendations = response.body as RecommendationsResponseDto
  expect(recommendations.known.length).toBeGreaterThan(0)
  for (const recommendation of recommendations.known) {
    expect(recommendation.games).toBeLessThan(20)
    expect(recommendation.performance).not.toBeNull()
    expect(recommendation.performance!.supported).toBe(false)
    expect(recommendation.performance!.interval_low).toBeLessThanOrEqual(recommendation.performance!.win_rate!)
    expect(recommendation.performance!.interval_high).toBeGreaterThanOrEqual(recommendation.performance!.win_rate!)
  }
  const ahri = recommendations.known.find((item) => item.champion === 'Ahri' && item.role === 'MIDDLE')!
  expect(ahri).toBeDefined()
  expect(ahri.performance!.wins).toBe(3)
  expect(ahri.performance!.losses).toBe(1)
  expect(ahri.performance!.win_rate).toBeCloseTo((100 * (2 / 3 + 1)) / 2, 5)
  expect(ahri.performance!.interval_low).toBeLessThan(ahri.performance!.win_rate!)
  expect(ahri.performance!.interval_high).toBeGreaterThan(ahri.performance!.win_rate!)
  await expect(page.getByRole('heading', { name: 'Gusti e risultati' })).toBeVisible()
  await expect(page.locator('.recommendation-card').getByText('Già giocato', { exact: true })).toHaveCount(recommendations.known.length)
  const card = page.locator('.recommendation-card').filter({ has: page.getByText('Ahri', { exact: true }) }).first()
  await card.getByRole('link', { name: 'Apri la scheda' }).click()
  const sheet = page.getByRole('dialog', { name: 'Scheda di Ahri' })
  await expect(sheet.getByText(/3 vittorie e 1 sconfitta in 4 osservazioni account-partita, da 4 partite uniche/)).toBeVisible()
  await expect(sheet.getByText(`${percent(ahri.performance!.interval_low!)}–${percent(ahri.performance!.interval_high!)}`, { exact: true })).toBeVisible()
  await expect(sheet.getByText(/con 4 partite il confronto dei risultati resta instabile/)).toBeVisible()
})

test('nessuno dei pochi risultati della fixture diventa scelta, stop forte o primo ban', async ({ page }) => {
  const champions = (await refreshWithResponse(page, '/app/fit?section=best&role=ALL&queue=all&days=all', '/api/champions')).body as ChampionsResponseDto
  expect(champions.items.length).toBeGreaterThan(0)
  expect(champions.items.every((item) => !item.historical_supported && item.classification !== 'supported')).toBe(true)
  const ranking = page.getByRole('region', { name: 'Classifica del rendimento storico' })
  await expect(ranking.getByText('Vantaggio storico supportato', { exact: true })).toHaveCount(0)

  const blacklist = await (await page.request.get('/api/blacklist?queue=all&days=all')).json() as { items: Array<{ tier: string }> }
  expect(blacklist.items.filter((item: { tier: string }) => item.tier === 'strong')).toEqual([])

  // TOP contains Garen's actual loss against Annie: a negative signal exists,
  // so an empty directional list cannot make the no-ban assertion vacuous.
  const matchups = (await refreshWithResponse(page, '/app/fit?section=matchups&relation=enemies&role=TOP', '/api/matchups')).body as MatchupsResponseDto
  const matchupItems = [...matchups.loses_to, ...matchups.beats]
  expect(matchups.loses_to.length).toBeGreaterThan(0)
  expect(matchupItems.every((item) => !item.actionable && item.reliability !== 'reliable')).toBe(true)
  await expect(page.getByText('Nessun consiglio solido su chi bannare')).toBeVisible()
  await expect(page.getByText('#1 ban consigliato', { exact: true })).toHaveCount(0)
  await expect(page.getByText('vantaggio supportato', { exact: true })).toHaveCount(0)
})

test('la matrice e i friends mostrano intervalli percentuali anche quando lo storico grezzo è alto', async ({ page }) => {
  const champions = (await refreshWithResponse(page, '/app/fit?section=best&role=ALL&queue=all&days=all', '/api/champions')).body as ChampionsResponseDto
  const ahri = champions.items.find((item) => item.champion === 'Ahri' && item.role === 'MIDDLE')!
  expect(ahri.record_kind).toBe('account')
  expect(ahri.actionable).toBe(false)
  expect(ahri.credible_lower_90).toBeGreaterThan(1)
  expect(ahri.credible_lower_90).toBeLessThan(50)
  expect(ahri.credible_upper_90).toBeGreaterThan(50)
  expect(ahri.credible_upper_90).toBeLessThan(100)
  const ranking = page.getByRole('region', { name: 'Campioni ordinati per rendimento stimato' }).getByRole('table')
  const ahriRow = ranking.getByRole('row').filter({ has: page.getByRole('link', { name: /Ahri/ }) })
  await expect(ahriRow).toContainText(percent(ahri.posterior_win_rate!))
  await expect(ahriRow).toContainText(`${decimal(ahri.credible_lower_90!)}%–${decimal(ahri.credible_upper_90!)}%`)
  await expect(ahriRow).toContainText('Positivo da verificare')

  const friends = (await refreshWithResponse(page, '/app/team/friends?min_games=1&role=MIDDLE', '/api/friends')).body as FriendsResponseDto
  await chooseDataView(page, 'Elenco')
  expect(friends.items.length).toBeGreaterThan(0)
  const friendRows = page.getByRole('region', { name: 'Classifica dei compagni di squadra' }).locator('tbody tr')
  await expect(friendRows).toHaveCount(friends.items.length)
  for (const [index, friend] of friends.items.entries()) {
    expect(friend.actionable).toBe(false)
    expect(friend.credible_lower_90).toBeLessThanOrEqual(50)
    expect(friend.credible_upper_90).toBeGreaterThanOrEqual(50)
    const friendRow = friendRows.nth(index)
    await expect(friendRow.getByRole('rowheader')).toContainText(friend.friend)
    expect(friend.mixed_role_context).not.toBe(true)
    const expectedSignal = friend.missing_role_baselines?.length ? 'Riferimento incompleto' : 'Campione ridotto'
    if (friend.missing_role_baselines?.length) expect(friend.decision_reason).toMatch(/Manca un riferimento/)
    else expect(friend.shared_games).toBeLessThan(20)
    await expect(friendRow).toContainText(expectedSignal)
    await expect(friendRow).toContainText(percent(friend.friend_win_rate))
    await expect(friendRow).toContainText(percent(friend.posterior_win_rate))
    await expect(friendRow).toContainText(`${percent(friend.credible_lower_90)}–${percent(friend.credible_upper_90)}`)
  }
  await expect(page.getByText('Affidabile', { exact: true })).toHaveCount(0)
})

test('il cambio account e il filtro ruolo ricalcolano il campione senza confermare i pochi game', async ({ page }) => {
  await refreshWithResponse(page, '/app/fit?section=choices&queue=all&days=all', '/api/recommendations')
  const recommendations = await (await chooseAccounts(page, ['Alpha#EUW'], '/api/recommendations')).json() as RecommendationsResponseDto
  const ahri = recommendations.known.find((item) => item.champion === 'Ahri')!
  expect(ahri.performance?.games).toBe(3)
  expect(ahri.performance?.supported).toBe(false)
  expect(ahri.performance?.win_rate).toBeCloseTo(100 * 2 / 3, 1)
  await expect(page.locator('#main-content .skeleton')).toHaveCount(0)
  const filteredResponse = endpointResponse(page, '/api/recommendations', ['Alpha#EUW'])
  await page.getByRole('combobox', { name: 'Ruolo', exact: true }).selectOption('MIDDLE')
  const filteredRequest = new URL((await filteredResponse).url())
  expect(filteredRequest.searchParams.get('role')).toBe('MIDDLE')
  await expect(page).toHaveURL(/role=MIDDLE/)
  const filtered = page.locator('.recommendation-card')
  await expect(filtered).not.toHaveCount(0)
  expect(await filtered.locator('.answer-ranking__identity small').allTextContents()).toEqual(expect.arrayContaining(['Centrale']))
  expect((await filtered.locator('.answer-ranking__identity small').allTextContents()).every((role) => role === 'Centrale')).toBe(true)
  const reloaded = endpointResponse(page, '/api/recommendations', ['Alpha#EUW'])
  await page.reload()
  const afterReload = await (await reloaded).json() as RecommendationsResponseDto
  expect(afterReload.known.find((item) => item.champion === 'Ahri')?.performance?.games).toBe(3)
  await expect(page.getByText(/3 partite uniche e 3 osservazioni su 1 account attivi/)).toBeVisible()
  await expect(page.getByText(/con 3 partite il confronto dei risultati resta instabile/)).toBeVisible()
})

test('il companion restringe la stima a una partita e resta persistente al refresh', async ({ page }) => {
  await page.goto('/app/profile')
  const accounts = page.locator('.selected-account-list')
  await accounts.getByRole('button', { name: /Alpha#EUW/ }).click()
  await page.getByLabel('Nome profilo', { exact: true }).fill('Beta companion E2E')
  await page.getByRole('button', { name: 'Salva', exact: true }).click()
  await expect(page.getByText('Profilo salvato', { exact: true })).toBeVisible()
  await accounts.getByRole('button', { name: /Alpha#EUW/ }).click()
  await accounts.getByRole('button', { name: /Beta#EUW/ }).click()
  await page.getByRole('combobox', { name: 'Profilo dei compagni', exact: true }).selectOption('Beta companion E2E')
  await page.getByRole('button', { name: 'Solo insieme', exact: true }).click()
  await page.getByRole('button', { name: 'Applica filtro', exact: true }).click()
  const filteredResponse = await refreshWithResponse(page, '/app/fit?section=choices&role=MIDDLE&queue=all&days=all', '/api/recommendations')
  const request = new URL(filteredResponse.url)
  expect(request.searchParams.getAll('account')).toEqual(['Alpha#EUW'])
  expect(request.searchParams.getAll('companion_account')).toEqual(['Beta#EUW'])
  const recommendations = filteredResponse.body as RecommendationsResponseDto
  expect(recommendations.coverage.games).toBe(1)
  const observedAhri = recommendations.known.find((item) => item.champion === 'Ahri')!
  expect(observedAhri.performance?.games).toBe(1)
  expect(observedAhri.performance?.wins).toBe(1)
  expect(observedAhri.performance?.win_rate).toBe(100)
  expect(observedAhri.performance?.interval_low).toBeLessThan(50)
  expect(observedAhri.performance?.interval_high).toBeGreaterThan(50)
  expect(observedAhri.performance?.supported).toBe(false)
  const choice = page.locator('.recommendation-card').filter({ has: page.getByText('Ahri', { exact: true }) }).first()
  await expect(choice).toContainText('Già giocato')
  await expect(choice).toContainText('con 1 partita il confronto dei risultati resta instabile')

  const matrixResponse = await refreshWithResponse(page, '/app/fit?section=best&role=MIDDLE&queue=all&days=all', '/api/champions')
  const matrixUrl = new URL(matrixResponse.url)
  expect(matrixUrl.searchParams.get('companion_mode')).toBe('only')
  expect(matrixUrl.searchParams.getAll('companion_account')).toEqual(['Beta#EUW'])
  const matrix = matrixResponse.body as ChampionsResponseDto
  expect(matrix.items).toHaveLength(1)
  const ahri = matrix.items[0]!
  expect(ahri.champion).toBe('Ahri')
  expect(ahri.games_observed).toBe(1)
  expect(ahri.raw_win_rate).toBe(100)
  expect(ahri.posterior_win_rate).toBeLessThan(100)
  expect(ahri.credible_lower_90).toBeLessThan(50)
  expect(ahri.credible_upper_90).toBeGreaterThan(50)
  expect(ahri.actionable).toBe(false)
  const row = page.getByRole('region', { name: 'Campioni ordinati per rendimento stimato' }).getByRole('table')
    .getByRole('row').filter({ has: page.getByRole('link', { name: /Ahri/ }) })
  await expect(row).toContainText('Positivo da verificare')
  await expect(row).toContainText(`${decimal(ahri.credible_lower_90)}%–${decimal(ahri.credible_upper_90)}%`)
})
