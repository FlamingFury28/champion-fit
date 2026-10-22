import { expect, test } from '@playwright/test'
import type { SynergyResponseDto } from '../src/api/types'

test('periodo alleati nei link: gli invalidi restano distinti dallo storico e sono recuperabili @smoke', async ({ page }) => {
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
  const control = page.getByRole('combobox', { name: 'Periodo', exact: true })
  const results = page.getByRole('region', { name: 'Risultati delle sinergie', exact: true })
  const metric = results.locator('.metric-card').filter({ has: page.getByText('Partite analizzate', { exact: true }) })
  const expectScope = () => {
    const params = new URL(page.url()).searchParams
    expect(params.get('section')).toBe('matchups')
    expect(params.get('relation')).toBe('allies')
    expect(params.get('role')).toBe('ALL')
    expect(params.get('queue')).toBe('all')
    expect(params.get('champion')).toBe('ALL')
    expect(params.get('include_exploratory')).toBe('1')
    expect(params.get('min_reliability')).toBe('weak')
    expect(requests.at(-1)?.searchParams.getAll('account')).toEqual(['Alpha#EUW', 'Beta#EUW'])
    expect(requests.at(-1)?.searchParams.get('role')).toBe('ALL')
    expect(requests.at(-1)?.searchParams.get('queue')).toBe('all')
    expect(requests.at(-1)?.searchParams.get('champion')).toBe('ALL')
    expect(requests.at(-1)?.searchParams.get('include_exploratory')).toBe('1')
    expect(requests.at(-1)?.searchParams.get('min_reliability')).toBe('weak')
  }
  const waitReady = async () => {
    await expect(control).toBeVisible()
    await expect(page.getByLabel('Caricamento', { exact: true })).toHaveCount(0)
    if (responses.at(-1)?.status === 400) {
      await expect(page.getByRole('alert')).toContainText('days deve essere 90, 180, 365 oppure all')
      await expect(results).toHaveCount(0)
    } else {
      await expect(results).toBeVisible()
      await expect(page.getByRole('alert')).toHaveCount(0)
    }
  }
  const openLink = async (days: string | null) => {
    const params = new URLSearchParams({
      section: 'matchups', relation: 'allies', role: 'ALL', queue: 'all', champion: 'ALL',
      include_exploratory: '1', min_reliability: 'weak',
    })
    if (days !== null) params.set('days', days)
    const before = responses.length
    await page.goto(`/app/fit?${params}`)
    await expect.poll(() => responses.length).toBeGreaterThan(before)
    await waitReady()
    expect(new URL(page.url()).searchParams.get('days')).toBe(days)
    expectScope()
    const beforeReload = responses.length
    await page.reload()
    await expect.poll(() => responses.length).toBeGreaterThan(beforeReload)
    await waitReady()
    expect(new URL(page.url()).searchParams.get('days')).toBe(days)
    expectScope()
  }
  const expectContext = async (days: string, games?: number) => {
    await expect.poll(() => responses.at(-1)?.status).toBe(200)
    const data = responses.at(-1)?.data
    if (!data) throw new Error('La fixture deve restituire il payload completo delle sinergie.')
    expect(data.context?.days).toBe(days)
    expect(data.context?.role).toBe('ALL')
    expect(data.context?.queue).toBe('all')
    expect(data.context?.observations).toBe(data.games)
    if (games !== undefined) expect(data.games).toBe(games)
    // Coverage stays global; the detail follows the real rolling-period count.
    expect(data.coverage.analyzed_games).toBe(6)
    await expect(metric.locator('strong')).toHaveText('6')
    await expect(metric.locator('small')).toHaveText(`${data.games} con il filtro sul campione`)
    await expect(page.getByRole('alert')).toHaveCount(0)
    expectScope()
  }
  const chooseAll = async () => {
    const before = responses.length
    await control.focus()
    await control.press('Home')
    await control.press('Tab')
    await expect(control).toHaveValue('all')
    await expect(control.locator('option:checked')).toHaveText('Tutto lo storico')
    await expect.poll(() => new URL(page.url()).searchParams.has('days')).toBe(false)
    await expect.poll(() => requests.at(-1)?.searchParams.get('days')).toBe('all')
    await expect.poll(() => responses.length).toBeGreaterThan(before)
    await expectContext('all', 6)
  }

  for (const raw of [null, '', 'all']) {
    await openLink(raw)
    await expect(control).toHaveValue('all')
    await expect(control.locator('option:checked')).toHaveText('Tutto lo storico')
    expect(requests.at(-1)?.searchParams.get('days')).toBe('all')
    await expectContext('all', 6)
  }
  await openLink('90')
  await expect(control).toHaveValue('90')
  await expect(control.locator('option:checked')).toHaveText('Ultimi 90 giorni')
  expect(requests.at(-1)?.searchParams.get('days')).toBe('90')
  await expectContext('90')
  await chooseAll()
  for (const invalid of ['unknown', '0', '\ufeffall\ufeff']) {
    await openLink(invalid)
    expect(responses.at(-1)?.status).toBe(400)
    expect(responses.at(-1)?.error).toBe('days deve essere 90, 180, 365 oppure all')
    expect(requests.at(-1)?.searchParams.get('days')).toBe(invalid)
    await expect(control).toHaveValue(invalid)
    await expect(control.locator('option:checked')).toHaveText('Periodo del link')
    await expect(control.locator('option:checked')).toHaveJSProperty('disabled', true)
    await chooseAll()
  }
  expect(unexpectedWrites).toEqual([])
})
