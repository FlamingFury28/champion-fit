import { expect, test } from '@playwright/test'

const routes = [
  ['/', /Hai una domanda/],
  ['/app/overview', 'Riepilogo'],
  ['/app/profile', 'Dati usati'],
  ['/app/team/friends', 'Compagni'],
  ['/app/fit', 'Campioni'],
  ['/app/fit?section=matchups&relation=enemies', 'Campioni'],
  ['/app/fit?section=matchups&relation=allies', 'Campioni'],
  ['/app/fit?section=training&training=discover', 'Campioni'],
  ['/app/fit?section=training&training=plan&n=400', 'Campioni'],
  ['/app/matches', 'Le mie partite'],
  ['/app/matches?section=style', 'Le mie partite'],
] as const

for (const [route, heading] of routes) {
  test(`deep link e reload ${route}`, async ({ page }) => {
    const response = await page.goto(route)
    expect(response?.status()).toBe(200)
    await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible()
    await page.reload()
    await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible()
  })
}

const aliases = [
  ['/app/champions?role=TOP', '/app/fit', { section: 'matchups', relation: 'enemies', role: 'TOP' }],
  ['/app/team/synergy?include_exploratory=1', '/app/fit', { section: 'matchups', relation: 'allies', include_exploratory: '1' }],
  ['/app/test-plan?n=400', '/app/fit', { section: 'training', training: 'plan', n: '400' }],
  ['/app/scout?role=MIDDLE', '/app/fit', { section: 'training', training: 'discover', role: 'MIDDLE' }],
  ['/app/review/blacklist?role=TOP', '/app/fit', { section: 'choices', decision: 'pause', role: 'TOP' }],
  ['/app/playstyles?days=all', '/app/matches', { section: 'style', days: 'all' }],
  ['/app/review/audit', '/app/matches', { section: 'history', flag: 'contaminated' }],
  ['/app/review/audit?flag=all', '/app/matches', { section: 'history', flag: 'all' }],
] as const

for (const [legacy, pathname, expectedParams] of aliases) {
  test(`alias preserva filtri ${legacy}`, async ({ page }) => {
    await page.goto(legacy)
    await expect(page).toHaveURL((url) => {
      if (url.pathname !== pathname) return false
      return Object.entries(expectedParams).every(([key, value]) => url.searchParams.get(key) === value)
    })
    await expect(page.getByRole('heading', { level: 1, name: pathname === '/app/fit' ? 'Campioni' : 'Le mie partite' })).toBeVisible()
  })
}

test('il vecchio dettaglio campione apre la scheda nel nuovo hub', async ({ page }) => {
  await page.goto('/app/champions/Ahri?role=MIDDLE')
  await expect(page).toHaveURL((url) => url.pathname === '/app/fit'
    && url.searchParams.get('detail') === 'Ahri'
    && url.searchParams.get('detailRole') === 'MIDDLE')
  await expect(page.getByRole('dialog', { name: 'Scheda di Ahri' })).toBeVisible()
  await expect(page.getByRole('dialog', { name: 'Scheda di Ahri' }).getByRole('heading', { level: 2, name: 'Ahri · Corsia centrale', exact: true })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('dialog', { name: 'Scheda di Ahri' })).toBeVisible()
})

test('404 interna per route app sconosciuta', async ({ page }) => {
  await page.goto('/app/not-a-route')
  await expect(page.getByRole('heading', { name: 'Pagina non trovata' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Torna al riepilogo' })).toBeVisible()
})

test('la landing non effettua richieste API', async ({ page }) => {
  const apiRequests: string[] = []
  page.on('request', (request) => { if (new URL(request.url()).pathname.startsWith('/api/')) apiRequests.push(request.url()) })
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  expect(apiRequests).toEqual([])
})
