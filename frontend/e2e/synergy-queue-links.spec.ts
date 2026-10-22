import { expect, test } from '@playwright/test'
import type { SynergyResponseDto } from '../src/api/types'

test('modalita alleati nei link: le code del link mantengono il filtro e permettono il recupero @smoke', async ({ page }) => {
  test.setTimeout(60_000)
  const requests: URL[] = []
  const responses: { status: number; data?: SynergyResponseDto; error?: string }[] = []
  const unexpectedWrites: string[] = []
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.route('https://ddragon.leagueoflegends.com/**', (route) => route.abort())
  await page.route('**/api/**', (route) => {
    if (route.request().method() === 'GET') return route.fallback()
    unexpectedWrites.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`)
    return route.abort()
  })
  await page.route('**/api/synergy?**', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    requests.push(new URL(route.request().url()))
    const response = await route.fetch()
    const body: unknown = await response.json()
    responses.push({
      status: response.status(),
      ...(response.ok() ? { data: body as SynergyResponseDto } : body as { error?: string }),
    })
    await route.fulfill({ response, json: body })
  })
  await page.addInitScript(() => {
    localStorage.setItem('champion-fit-profile-accounts', JSON.stringify(['Alpha#EUW', 'Beta#EUW']))
    localStorage.setItem('champion-fit:data-view:v2', JSON.stringify({ view: 'list' }))
  })
  const control = page.getByRole('combobox', { name: 'Modalità', exact: true })
  const results = page.getByRole('region', { name: 'Risultati delle sinergie', exact: true })
  const metric = results.locator('.metric-card').filter({ has: page.getByText('Partite analizzate', { exact: true }) })
  const expectScope = () => {
    const params = new URL(page.url()).searchParams
    expect(params.get('section')).toBe('matchups')
    expect(params.get('relation')).toBe('allies')
    expect(params.get('role')).toBe('ALL')
    expect(params.get('days')).toBe('all')
    expect(params.get('champion')).toBe('ALL')
    expect(params.get('include_exploratory')).toBe('1')
    expect(params.get('min_reliability')).toBe('weak')
    expect(requests.at(-1)?.searchParams.getAll('account')).toEqual(['Alpha#EUW', 'Beta#EUW'])
    expect(requests.at(-1)?.searchParams.get('role')).toBe('ALL')
    expect(requests.at(-1)?.searchParams.get('days')).toBe('all')
    expect(requests.at(-1)?.searchParams.get('champion')).toBe('ALL')
    expect(requests.at(-1)?.searchParams.get('include_exploratory')).toBe('1')
    expect(requests.at(-1)?.searchParams.get('min_reliability')).toBe('weak')
  }
  const waitReady = async () => {
    await expect(control).toBeVisible()
    await expect(page.getByLabel('Caricamento', { exact: true })).toHaveCount(0)
    if (responses.at(-1)?.status === 400) {
      await expect(page.getByRole('alert')).toContainText('Modalità non valida')
      await expect(results).toHaveCount(0)
      await expect(metric).toHaveCount(0)
    } else {
      await expect(results).toBeVisible()
      await expect(page.getByRole('alert')).toHaveCount(0)
    }
  }
  const openLink = async (queue: string | null) => {
    const params = new URLSearchParams({
      section: 'matchups', relation: 'allies', role: 'ALL', days: 'all', champion: 'ALL',
      include_exploratory: '1', min_reliability: 'weak',
    })
    if (queue !== null) params.set('queue', queue)
    const before = responses.length
    await page.goto(`/app/fit?${params}`)
    await expect.poll(() => responses.length).toBeGreaterThan(before)
    await waitReady()
    expect(new URL(page.url()).searchParams.get('queue')).toBe(queue)
    expectScope()
    const beforeReload = responses.length
    await page.reload()
    await expect.poll(() => responses.length).toBeGreaterThan(beforeReload)
    await waitReady()
    expect(new URL(page.url()).searchParams.get('queue')).toBe(queue)
    expectScope()
  }
  const expectContext = async (queue: string, games: number) => {
    await expect.poll(() => responses.at(-1)?.status).toBe(200)
    const data = responses.at(-1)?.data
    if (!data) throw new Error('La fixture deve restituire il payload completo delle sinergie.')
    expect(data.context?.queue).toBe(queue)
    expect(data.context?.role).toBe('ALL')
    expect(data.context?.days).toBe('all')
    expect(data.context?.observations).toBe(games)
    expect(data.games).toBe(games)
    // Global coverage does not disappear when a valid queue has no matches.
    expect(data.coverage.analyzed_games).toBe(6)
    await expect(metric.locator('strong')).toHaveText('6')
    await expect(metric.locator('small')).toHaveText(`${games} con il filtro sul campione`)
    await expect(page.getByRole('alert')).toHaveCount(0)
    expectScope()
  }
  const chooseAll = async () => {
    const before = responses.length
    await control.focus()
    await control.press('Home')
    await control.press('Tab')
    await expect(control).toHaveValue('all')
    await expect(control.locator('option:checked')).toHaveText('Tutte le modalità · aggregato')
    await expect.poll(() => new URL(page.url()).searchParams.has('queue')).toBe(false)
    await expect.poll(() => requests.at(-1)?.searchParams.get('queue')).toBe('all')
    await expect.poll(() => responses.length).toBeGreaterThan(before)
    await expectContext('all', 6)
  }

  for (const raw of [null, '', 'all']) {
    await openLink(raw)
    await expect(control).toHaveValue('all')
    await expect(control.locator('option:checked')).toHaveText('Tutte le modalità · aggregato')
    expect(requests.at(-1)?.searchParams.get('queue')).toBe('all')
    await expectContext('all', 6)
  }
  await openLink('RANKED_FLEX_SR')
  await expect(control).toHaveValue('440')
  await expect(control.locator('option:checked')).toHaveText('Classificata · flessibile')
  await expect(control.locator('option[value="440"]')).toHaveCount(1)
  expect(requests.at(-1)?.searchParams.get('queue')).toBe('440')
  await expectContext('440', 2)
  await chooseAll()
  for (const queue of ['999', '00440', '450']) {
    await openLink(queue)
    await expect(control).toHaveValue(queue)
    await expect(control.locator('option:checked')).toHaveText('Modalità del link')
    await expect(control.locator('option:checked')).toHaveJSProperty('disabled', true)
    expect(requests.at(-1)?.searchParams.get('queue')).toBe(queue)
    await expectContext(queue, 0)
    await chooseAll()
  }
  for (const invalid of [
    { raw: 'unknown', wire: 'UNKNOWN' },
    { raw: '\ufeff440\ufeff', wire: '\ufeff440\ufeff' },
    { raw: '0', wire: '0' },
  ]) {
    await openLink(invalid.raw)
    expect(responses.at(-1)?.status).toBe(400)
    expect(responses.at(-1)?.error).toBe('Modalità non valida')
    expect(requests.at(-1)?.searchParams.get('queue')).toBe(invalid.wire)
    await expect(control).toHaveValue(invalid.wire)
    await expect(control.locator('option:checked')).toHaveText('Modalità del link')
    await expect(control.locator('option:checked')).toHaveJSProperty('disabled', true)
    await chooseAll()
  }
  expect(unexpectedWrites).toEqual([])
})
