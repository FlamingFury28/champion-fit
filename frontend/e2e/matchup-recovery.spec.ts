import { expect, test, type Locator, type Page } from '@playwright/test'
import { RECOMMENDED_ALGORITHM_SETTINGS, setSetting } from '../src/app/algorithm-settings'
import type { MatchupsResponseDto, SynergyResponseDto } from '../src/api/types'

const path = '/app/fit?section=matchups&relation=enemies'
const errorMessage = 'Confronti temporaneamente non disponibili'
type MatchupReply = { status?: number; json: MatchupsResponseDto | { error: string } }

function responseFor(url: URL, champion: string): MatchupsResponseDto {
  const role = url.searchParams.get('role') ?? 'ALL'
  return {
    champion: 'ALL', role, games: 12, wins: 6, win_rate: 50,
    games_with_opponents: 12, baseline_win_rate: 50, loses_to: [], beats: [],
    available_champions: [{ champion, games: 12, icon_url: '' }],
    context: { role, queue: url.searchParams.get('queue') ?? 'all', days: url.searchParams.get('days') ?? 'all' },
  }
}

async function mockApi(page: Page, matchups: (url: URL) => MatchupReply | Promise<MatchupReply>, settings = RECOMMENDED_ALGORITHM_SETTINGS) {
  const state = { requests: [] as URL[], mutations: [] as string[] }
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (request.method() !== 'GET') {
      state.mutations.push(`${request.method()} ${url.pathname}`)
      await route.fulfill({ status: 405, json: { error: 'Unexpected mutation in read-only matchup fixture' } })
      return
    }
    if (url.pathname === '/api/accounts') {
      await route.fulfill({ json: { items: [{
        account: 'Alpha#EUW', raw_games: 12, eligible_games: 12, analyzed_games: 12,
        wins: 6, games: 12, first_game: null, last_game: null,
      }] } })
    } else if (url.pathname === '/api/algorithm-settings') {
      await route.fulfill({ json: {
        revision: 1, fingerprint: 'matchup-recovery-fixture',
        settings, defaults: RECOMMENDED_ALGORITHM_SETTINGS,
        schema: [], history: [],
      } })
    } else if (url.pathname === '/api/sync-status') {
      await route.fulfill({ json: {
        mode: 'snapshot', sync_active: false, automatic_api_calls: false,
        checkpoint_accounts: 0, last_checkpoint_at: null, last_completed_at: null, metadata: {},
      } })
    } else if (url.pathname === '/api/matchups') {
      state.requests.push(url)
      await route.fulfill(await matchups(url))
    } else {
      await route.fulfill({ status: 503, json: { error: `Unexpected fixture endpoint: ${url.pathname}` } })
    }
  })
  await page.route('https://ddragon.leagueoflegends.com/**', (route) => route.abort())
  await page.emulateMedia({ reducedMotion: 'reduce' })
  return state
}

async function fresh(page: Page, url: string, ready: Locator) {
  const syncResponse = () => page.waitForResponse((response) => new URL(response.url()).pathname === '/api/sync-status')
  const initialSync = syncResponse()
  await page.goto(url)
  await ready.waitFor()
  // Finish the initial document's bootstrap before the full refresh required by
  // AGENTS.md, including sync-status to avoid canceled fulfillments in WebKit.
  await (await initialSync).finished()
  const refreshedSync = syncResponse()
  await page.reload()
  await ready.waitFor()
  await (await refreshedSync).finished()
}

function controls(page: Page) {
  const panel = page.locator('#champion-selector')
  return {
    panel,
    role: panel.getByRole('combobox', { name: 'Ruolo', exact: true }),
    queue: panel.getByRole('combobox', { name: 'Modalità', exact: true }),
    days: panel.getByRole('combobox', { name: 'Periodo', exact: true }),
    champion: panel.getByRole('combobox', { name: 'Che campione vuoi giocare?', exact: true }),
    context: panel.locator('.context-note'),
  }
}

test('Avversari: un errore iniziale conserva i filtri e si recupera cambiando ruolo @smoke', async ({ page }, testInfo) => {
  const state = await mockApi(page, (url) => url.searchParams.get('role') === 'TOP'
    ? { status: 503, json: { error: errorMessage } }
    : { json: responseFor(url, 'Ahri') })
  await fresh(page, `${path}&role=TOP&queue=420&days=90`, page.getByRole('alert'))
  const filter = controls(page)
  await expect(page.getByRole('alert')).toContainText(errorMessage)
  await expect(filter.role).toBeEnabled()
  await expect(filter.queue).toBeEnabled()
  await expect(filter.days).toBeEnabled()
  await expect(filter.role).toHaveValue('TOP')
  await expect(filter.queue).toHaveValue('420')
  await expect(filter.days).toHaveValue('90')
  await expect(filter.champion).toBeDisabled()
  await expect(filter.champion.locator('option')).toHaveCount(1)
  await expect(filter.context).toHaveCount(0)

  await filter.role.selectOption('MIDDLE')
  await expect(filter.champion).toBeEnabled()
  await expect(filter.champion.locator('option[value="Ahri"]')).toHaveText('Ahri · 12 partite')
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(filter.context).toContainText('Corsia centrale · Classificata · Solo/Duo · ultimi 90 giorni')
  await expect(page).toHaveURL((url) => url.pathname === '/app/fit'
    && url.searchParams.get('section') === 'matchups' && url.searchParams.get('relation') === 'enemies'
    && url.searchParams.get('role') === 'MIDDLE' && url.searchParams.get('queue') === '420'
    && url.searchParams.get('days') === '90' && !url.searchParams.has('detail'))
  expect(state.requests.at(-1)?.searchParams.get('role')).toBe('MIDDLE')
  expect(state.mutations).toEqual([])
  await page.screenshot({ path: testInfo.outputPath('matchup-recovered.png'), fullPage: true })
})

test('Avversari: attesa ed errore dopo un filtro non riusano campioni vecchi e consentono il recupero', async ({ page }) => {
  let release!: () => void
  const pending = new Promise<void>((resolve) => { release = resolve })
  const state = await mockApi(page, async (url) => {
    if (url.searchParams.get('role') === 'TOP' && url.searchParams.get('queue') === 'all') {
      await pending
      return { status: 503, json: { error: errorMessage } }
    }
    const champion = url.searchParams.get('queue') === 'all' ? 'Ahri'
      : url.searchParams.get('days') === '90' ? 'Darius' : 'Garen'
    return { json: responseFor(url, champion) }
  })
  const filter = controls(page)
  try {
    await fresh(page, path, filter.context)
    await expect(filter.champion.locator('option[value="Ahri"]')).toHaveCount(1)
    await expect(filter.context).toContainText('Tutti i ruoli · Tutte le modalità · tutto lo storico')

    await filter.role.selectOption('TOP')
    await expect.poll(() => state.requests.at(-1)?.searchParams.get('role')).toBe('TOP')
    await expect(page.locator('#main-content .skeleton')).not.toHaveCount(0)
    await expect(filter.role).toBeEnabled()
    await expect(filter.queue).toBeEnabled()
    await expect(filter.days).toBeEnabled()
    await expect(filter.champion).toBeDisabled()
    await expect(filter.champion.locator('option[value="Ahri"]')).toHaveCount(0)
    await expect(filter.context).toHaveCount(0)

    release()
    await expect(page.getByRole('alert')).toContainText(errorMessage)
    await expect(filter.role).toHaveValue('TOP')
    await expect(filter.champion).toBeDisabled()
    await expect(filter.champion.locator('option')).toHaveCount(1)
    await expect(filter.context).toHaveCount(0)
    await expect(filter.queue).toBeEnabled()
    await expect(filter.days).toBeEnabled()

    await filter.queue.selectOption('480')
    await expect(page.getByRole('alert')).toHaveCount(0)
    await expect(filter.champion).toBeEnabled()
    await expect(filter.champion.locator('option[value="Garen"]')).toHaveCount(1)
    await expect(filter.champion.locator('option[value="Ahri"]')).toHaveCount(0)
    await expect(filter.context).toContainText('Corsia superiore · Partita rapida · tutto lo storico')

    await filter.days.selectOption('90')
    await expect(filter.champion.locator('option[value="Darius"]')).toHaveCount(1)
    await expect(filter.champion.locator('option[value="Garen"]')).toHaveCount(0)
    await expect(filter.context).toContainText('Corsia superiore · Partita rapida · ultimi 90 giorni')
    await filter.queue.selectOption('700')
    await expect(filter.context).toContainText('Corsia superiore · Clash · ultimi 90 giorni')
    await expect(page).toHaveURL((url) => url.pathname === '/app/fit'
      && url.searchParams.get('section') === 'matchups' && url.searchParams.get('relation') === 'enemies'
      && url.searchParams.get('role') === 'TOP' && url.searchParams.get('queue') === '700'
      && url.searchParams.get('days') === '90' && !url.searchParams.has('detail'))
    expect(state.requests.at(-1)?.searchParams.get('queue')).toBe('700')
    expect(state.requests.at(-1)?.searchParams.get('days')).toBe('90')
    expect(state.mutations).toEqual([])
  } finally {
    release()
  }
})

test('Alleati: conserva il campione richiesto con errori e risultati senza corrispondenze @smoke', async ({ page }) => {
  const state = await mockApi(page, () => ({ status: 503, json: { error: 'Unexpected matchup request' } }))
  let release!: () => void
  const pending = new Promise<void>((resolve) => { release = resolve })
  await page.route('**/api/synergy?**', async (route) => {
    expect(route.request().method()).toBe('GET')
    const params = new URL(route.request().url()).searchParams
    if (params.get('champion') === 'Lux') await pending
    if (params.get('role') === 'TOP' || params.get('champion') === 'Lux') {
      await route.fulfill({ status: 503, json: { error: 'Sinergie temporaneamente non disponibili' } })
      return
    }
    const payload: SynergyResponseDto = {
      champion: params.get('champion') ?? 'ALL', accounts: ['Alpha#EUW'], companion_filter_active: false,
      min_reliability: 'weak', include_exploratory: false, min_games: 1,
      games: 4, games_with_teammates: 4,
      context: { role: params.get('role') ?? 'ALL', queue: params.get('queue') ?? 'all', days: params.get('days') ?? 'all' },
      coverage: { raw_games: 4, eligible_games: 4, analyzed_games: 4, games_with_roster: 4, roster_coverage: 100 },
      available_champions: [{ champion: 'Lux', games: 4, icon_url: '' }], worse_with: [],
      better_with: [{ champion: 'Jinx', icon_url: '', games: 4, wins: 3, losses: 1, win_rate: 75,
        posterior_win_rate: 60, baseline_win_rate: 50, posterior_lift_pp: 10, relative_delta_pp: 10,
        credible_lower_90: 40, credible_upper_90: 80, direction_confidence: 80, direction_probability: 80,
        probability_meaningful_advantage: 80, probability_meaningful_disadvantage: 5,
        effective_sample_size: 4, personal_effective_sample_size: 4, reliability: 'reliable', actionable: true,
        prior_source: 'global', prior_games: 0, meaningful_delta: .07 }],
    }
    await route.fulfill({ json: payload })
  })
  const champion = page.getByRole('combobox', { name: 'Campione giocato', exact: true })
  try {
    await fresh(page, '/app/fit?section=matchups&relation=allies&champion=Ahri&role=TOP&queue=420&days=90', page.getByRole('alert'))
    await expect(champion).toHaveValue('Ahri')
    await expect(champion.locator('option[value="Ahri"]')).toHaveText('Ahri')
    await expect(page.getByRole('combobox', { name: 'Modalità', exact: true }).locator('option[value="450"]')).toHaveCount(0)

    await page.getByRole('combobox', { name: 'Ruolo', exact: true }).selectOption('MIDDLE')
    await expect(page.getByRole('alert')).toHaveCount(0)
    await expect(champion).toHaveValue('Ahri')
    await expect(champion.locator('option[value="Ahri"]')).toHaveText('Ahri')
    await expect(page.getByText('Probabilità di un effetto oltre 7 punti percentuali', { exact: true })).toBeVisible()
    await champion.selectOption('ALL')
    await expect(champion.locator('option[value="Ahri"]')).toHaveCount(0)
    await expect(champion.locator('option[value="Lux"]')).toHaveText('Lux · 4 partite')

    await champion.selectOption('Lux')
    await expect(page.locator('#main-content .skeleton')).not.toHaveCount(0)
    await expect(champion).toHaveValue('Lux')
    await expect(champion.locator('option[value="Lux"]')).toHaveText('Lux')
    release()
    await expect(page.getByRole('alert')).toContainText('Sinergie temporaneamente non disponibili')
    await expect(champion).toHaveValue('Lux')
    await champion.selectOption('ALL')
    await expect(page.getByRole('alert')).toHaveCount(0)
    await expect(champion).toHaveValue('ALL')
    await expect(page.getByRole('combobox', { name: 'Periodo', exact: true })).toHaveValue('90')
    expect(state.mutations).toEqual([])
  } finally {
    release()
  }
})

test('Affidabilità: soglie configurate, partite distinte ed esplorativi restano coerenti @smoke', async ({ page }) => {
  let settings = structuredClone(RECOMMENDED_ALGORITHM_SETTINGS)
  for (const [key, value] of Object.entries({ display_min_games: 5, indicative_games: 12, min_games: 40, meaningful_delta: .07 })) {
    settings = setSetting(settings, `evidence.${key}`, value)
  }
  const state = await mockApi(page, (url) => ({ json: responseFor(url, 'Ahri') }), settings)
  const requests: URL[] = []
  await page.route('**/api/synergy?**', async (route) => {
    expect(route.request().method()).toBe('GET')
    const url = new URL(route.request().url())
    requests.push(url)
    await route.fulfill({ json: {
      champion: 'ALL', accounts: ['Alpha#EUW'], companion_filter_active: false,
      min_reliability: url.searchParams.get('min_reliability'), include_exploratory: url.searchParams.get('include_exploratory') === '1',
      min_games: 1, games: 28, games_with_teammates: 28,
      context: { role: 'MIDDLE', queue: 'all', days: 'all' },
      coverage: { raw_games: 28, eligible_games: 28, analyzed_games: 28, games_with_roster: 28, roster_coverage: 100 },
      available_champions: [], worse_with: [],
      // Legacy replies may omit reliability. Weighted evidence must not replace
      // the distinct-game count used to classify these rows on the server.
      better_with: [['Ashe', 4], ['Lux', 10], ['Jinx', 14]].map(([champion, games]) => ({
        champion, games, decision_games: games, unique_games: games, icon_url: '',
        wins: 3, losses: 1, win_rate: 75, posterior_win_rate: 60, baseline_win_rate: 50,
        posterior_lift_pp: 10, relative_delta_pp: 10, credible_lower_90: 40, credible_upper_90: 80,
        direction_confidence: 80, direction_probability: 80,
        probability_meaningful_advantage: 80, probability_meaningful_disadvantage: 5,
        effective_sample_size: 30, personal_effective_sample_size: 30, actionable: false,
        prior_source: 'global', prior_games: 0,
      })),
    } })
  })
  const region = page.getByRole('region', { name: 'Risultati delle sinergie', exact: true })
  await fresh(page, '/app/fit?section=matchups&relation=allies&role=MIDDLE', region)
  const minimum = page.getByRole('combobox', { name: 'Affidabilità minima', exact: true })
  await expect(minimum.locator('option[value="weak"]')).toHaveText('Debole o migliore · almeno 5 esiti')
  await expect(minimum.locator('option[value="indicative"]')).toHaveText('Indicativa o migliore · almeno 12 esiti')
  await expect(page.getByText('meno di 5 esiti · da confermare', { exact: true })).toBeVisible()
  await expect(region.getByText('Ashe', { exact: true })).toHaveCount(0)
  await expect(region.getByText('Lux', { exact: true })).toBeVisible()
  await expect(region.getByText('Jinx', { exact: true })).toBeVisible()
  await expect(region.getByText(/14 partite osservate · 14.0 partite personali distinte · 30.0 totali a supporto/)).toBeVisible()
  await expect(region.getByText('Il campione personale è di 14 partite; la soglia minima è 40.', { exact: true })).toBeVisible()
  await minimum.selectOption('indicative')
  await expect.poll(() => requests.at(-1)?.searchParams.get('min_reliability')).toBe('indicative')
  await expect(region.getByText('Lux', { exact: true })).toHaveCount(0)
  await expect(region.getByText('Jinx', { exact: true })).toBeVisible()
  const exploratory = page.getByRole('checkbox', { name: 'Mostra esplorativi', exact: true })
  // Router state commits asynchronously; check() assumes the controlled input
  // has already committed as soon as the click action finishes.
  await exploratory.click()
  await expect(exploratory).toBeChecked()
  await expect.poll(() => requests.at(-1)?.searchParams.get('include_exploratory')).toBe('1')
  await expect(region.getByText('Ashe', { exact: true })).toBeVisible()
  await expect(region.getByText('Lux', { exact: true })).toHaveCount(0)
  await expect(region.getByRole('progressbar', { name: 'Probabilità di un effetto oltre 7 punti percentuali' })).toHaveCount(2)
  expect(state.mutations).toEqual([])
})
