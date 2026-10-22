import { expect, test, type Locator, type Page } from '@playwright/test'
import type { AccountsResponseDto, RecommendationFeedbackInputDto, RecommendationFeedbackItemDto, RecommendationFeedbackResponseDto, RecommendationPreference, RecommendationsResponseDto } from '../src/api/types'
import { observedRecommendation, recommendationsFixture } from '../src/test/recommendations-fixture'

const ACCOUNTS = ['Alpha#EUW', 'Beta#EUW']
const CHOICES = '/app/fit?section=choices&role=MIDDLE&queue=all&days=all'
const alphaTarget = 'Mi piace · Ahri · Corsia centrale · Alpha#EUW'
const betaTarget = 'Mi piace · Ahri · Corsia centrale · Beta#EUW'

interface FixtureState {
  revision: number
  readsFail: boolean
  items: RecommendationFeedbackItemDto[]
  recommendationReads: number
  feedbackReads: number
  posts: RecommendationFeedbackInputDto[]
}
interface Reply { status?: number; json: unknown }

function aggregatePreference(items: RecommendationFeedbackItemDto[]): RecommendationPreference | null {
  const preferences = ACCOUNTS.map((account) => items.find((item) => item.account === account)?.preference ?? null)
  return preferences.every((preference) => preference === preferences[0]) ? preferences[0]! : null
}

function recommendations(state: FixtureState, algorithmRevision: number): RecommendationsResponseDto {
  const item = observedRecommendation({
    games: 2, account_count: 2, selected_account_count: 2, feedback: aggregatePreference(state.items),
    performance: {
      ...observedRecommendation().performance!, games: 2, observations: 2, wins: 2, losses: 0,
      interval_low: 34.2, interval_high: 100, missing_baseline_accounts: ACCOUNTS,
      per_account: Object.fromEntries(ACCOUNTS.map((account) => [account, { games: 1, wins: 1, losses: 0, win_rate: 100 }])),
    },
  })
  return recommendationsFixture({
    algorithm_revision: algorithmRevision, algorithm_fingerprint: 'synthetic-card-settings', feedback_revision: state.revision,
    context: { accounts: ACCOUNTS, role: 'MIDDLE', queue: 'all', days: 'all', suspended_accounts: [], unresolved_accounts: [] },
    coverage: { selected_accounts: ACCOUNTS, active_accounts: ACCOUNTS, missing_accounts: [], games: 2, observations: 2 },
    profile: [{ tag: 'mage', label: 'Mago', games: 2, accounts: 2, share: 1 }],
    known: [item], discover: [], trial_plan: { budget: 0, items: [] },
  })
}

function feedbackLibrary(state: FixtureState): RecommendationFeedbackResponseDto {
  return {
    revision: state.revision, accounts: ACCOUNTS, suspended_accounts: [], unresolved_accounts: [], items: state.items,
    catalog_version: 'synthetic-card-recovery',
    options: [{ champion: 'Ahri', name: 'Ahri', roles: ['MIDDLE'], roles_by_account: Object.fromEntries(ACCOUNTS.map((account) => [account, ['MIDDLE']])), icon_url: null, classified: true }],
  }
}

function save(state: FixtureState, input: RecommendationFeedbackInputDto): Reply {
  state.revision += 1
  state.items = state.items.filter((item) => !input.accounts.includes(item.account))
  const added = input.preference === 'neutral' ? [] : input.accounts.map((account) => ({
    account, champion: input.champion, role: input.role, preference: input.preference, updated_at: '2026-10-17T12:00:00Z',
  }))
  state.items.push(...added)
  return { json: { ok: true, revision: state.revision, items: added } }
}

async function mockApi(page: Page, state: FixtureState, respond: (input: RecommendationFeedbackInputDto, attempt: number) => Promise<Reply>) {
  const unexpectedWrites: string[] = []
  await page.clock.setFixedTime(new Date('2026-10-17T12:00:00Z'))
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.route('https://ddragon.leagueoflegends.com/**', (route) => route.abort())
  await page.route('**/api/**', (route) => {
    if (route.request().method() === 'GET') return route.fallback()
    unexpectedWrites.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`)
    return route.abort()
  })
  const accounts: AccountsResponseDto = { items: ACCOUNTS.map((account) => ({
    account, raw_games: 1, eligible_games: 1, analyzed_games: 1, wins: 1, games: 1,
    first_game: '2026-10-01T12:00:00Z', last_game: '2026-10-01T12:00:00Z',
  })) }
  await page.route('**/api/accounts', (route) => route.request().method() === 'GET' ? route.fulfill({ json: accounts }) : route.fallback())
  await page.route('**/api/recommendations?**', async (route) => {
    if (route.request().method() !== 'GET') { await route.fallback(); return }
    state.recommendationReads += 1
    if (state.readsFail) await route.fulfill({ status: 503, json: { error: 'Suggerimenti temporaneamente non disponibili' } })
    else {
      const revision = Number(new URL(route.request().url()).searchParams.get('algorithm_revision') ?? 1)
      await route.fulfill({ json: recommendations(state, revision) })
    }
  })
  await page.route('**/api/recommendation-feedback*', async (route) => {
    if (route.request().method() === 'GET') {
      state.feedbackReads += 1
      if (state.readsFail) await route.fulfill({ status: 503, json: { error: 'Preferenze temporaneamente non disponibili' } })
      else await route.fulfill({ json: feedbackLibrary(state) })
    } else if (route.request().method() === 'POST') {
      const input = route.request().postDataJSON() as RecommendationFeedbackInputDto
      state.posts.push(input)
      await route.fulfill(await respond(input, state.posts.length))
    } else await route.fallback()
  })
  return unexpectedWrites
}

async function openCardAfterFullRefresh(page: Page) {
  await page.goto(CHOICES)
  const card = page.locator('.answer-ranking .observed-recommendation')
  await expect(card).toHaveCount(1)
  await expect(card.getByRole('button', { name: 'Mi piace', exact: true })).toBeEnabled()
  await page.reload()
  await expect(card).toHaveCount(1)
  await expect(card.getByRole('button', { name: 'Mi piace', exact: true })).toBeEnabled()
  await card.locator('.recommendation-feedback__account-picker > summary').click()
  await card.getByRole('checkbox', { name: 'Beta#EUW', exact: true }).uncheck()
  return card
}

async function switchToBeta(card: Locator) {
  await card.getByRole('checkbox', { name: 'Beta#EUW', exact: true }).check()
  await card.getByRole('checkbox', { name: 'Alpha#EUW', exact: true }).uncheck()
  await expect(card.getByRole('checkbox', { name: 'Alpha#EUW', exact: true })).not.toBeChecked()
  await expect(card.getByRole('checkbox', { name: 'Beta#EUW', exact: true })).toBeChecked()
}

async function expectBetaSelected(card: Locator) {
  await expect(card.getByRole('checkbox', { name: 'Alpha#EUW', exact: true })).not.toBeChecked()
  await expect(card.getByRole('checkbox', { name: 'Beta#EUW', exact: true })).toBeChecked()
}

for (const failedGet of [true, false]) {
  test(`giudizio scheda: 409 e GET ${failedGet ? '503' : '200 obsoleto'} richiedono solo letture fino alla nuova revisione @smoke`, async ({ page }) => {
    const state: FixtureState = { revision: 7, readsFail: false, items: [], recommendationReads: 0, feedbackReads: 0, posts: [] }
    let release!: () => void
    const pending = new Promise<void>((resolve) => { release = resolve })
    const unexpectedWrites = await mockApi(page, state, async (input, attempt) => {
      if (attempt === 1) {
        await pending
        state.readsFail = failedGet
        return { status: 409, json: { error: 'Le preferenze sono cambiate altrove.' } }
      }
      return save(state, input)
    })
    try {
      const card = await openCardAfterFullRefresh(page)
      await card.getByRole('button', { name: 'Mi piace', exact: true }).click()
      await expect.poll(() => state.posts.length).toBe(1)
      await expect(card.getByRole('status')).toContainText(alphaTarget)
      await switchToBeta(card)
      release()
      const reload = card.getByRole('button', { name: 'Ricarica preferenze', exact: true })
      await expect(reload).toBeEnabled()
      const error = card.getByRole('alert')
      await expect(error).toContainText(failedGet
        ? 'Non riesco ad aggiornare le preferenze correnti.' : 'La revisione corrente non è ancora aggiornata.')
      await expect(error).toContainText(alphaTarget)
      await expectBetaSelected(card)
      const readsBefore = state.recommendationReads
      await reload.click()
      await expect.poll(() => state.recommendationReads).toBeGreaterThan(readsBefore)
      await expect(reload).toBeEnabled()
      expect(state.posts).toHaveLength(1)
      await expect(card.locator('.recommendation-feedback__actions').getByRole('button')).toHaveText(['Ricarica preferenze'])

      state.readsFail = false
      state.revision = 8
      await reload.click()
      const like = card.getByRole('button', { name: 'Mi piace', exact: true })
      await expect(like).toBeEnabled()
      await expect(card.getByRole('button', { name: 'Neutro', exact: true })).toBeEnabled()
      await expect(card.getByRole('button', { name: 'Non fa per me', exact: true })).toBeEnabled()
      await expectBetaSelected(card)
      expect(state.posts).toHaveLength(1)
      await like.click()
      await expect(card.getByRole('status').filter({ hasText: 'Preferenza salvata.' })).toContainText(betaTarget)
      expect(state.posts).toEqual([
        { accounts: ['Alpha#EUW'], champion: 'Ahri', role: 'MIDDLE', preference: 'like', expected_revision: 7 },
        { accounts: ['Beta#EUW'], champion: 'Ahri', role: 'MIDDLE', preference: 'like', expected_revision: 8 },
      ])
      expect(unexpectedWrites).toEqual([])
    } finally { release() }
  })
}

test('giudizio scheda: un successo tardivo resta di Alpha e conserva la nuova selezione Beta @smoke', async ({ page }) => {
  const state: FixtureState = { revision: 7, readsFail: false, items: [], recommendationReads: 0, feedbackReads: 0, posts: [] }
  let release!: () => void
  const pending = new Promise<void>((resolve) => { release = resolve })
  const unexpectedWrites = await mockApi(page, state, async (input, attempt) => {
    if (attempt === 1) await pending
    return save(state, input)
  })
  try {
    const card = await openCardAfterFullRefresh(page)
    await card.getByRole('button', { name: 'Mi piace', exact: true }).click()
    await expect.poll(() => state.posts.length).toBe(1)
    await expect(card.getByRole('status')).toContainText(alphaTarget)
    await switchToBeta(card)
    release()
    await expect(card.getByRole('status').filter({ hasText: 'Preferenza salvata.' })).toContainText(alphaTarget)
    await expectBetaSelected(card)
    expect(state.posts).toEqual([{ accounts: ['Alpha#EUW'], champion: 'Ahri', role: 'MIDDLE', preference: 'like', expected_revision: 7 }])
    await card.getByRole('button', { name: 'Mi piace', exact: true }).click()
    await expect(card.getByRole('status').filter({ hasText: 'Preferenza salvata.' })).toContainText(betaTarget)
    await expectBetaSelected(card)
    expect(state.posts).toEqual([
      { accounts: ['Alpha#EUW'], champion: 'Ahri', role: 'MIDDLE', preference: 'like', expected_revision: 7 },
      { accounts: ['Beta#EUW'], champion: 'Ahri', role: 'MIDDLE', preference: 'like', expected_revision: 8 },
    ])
    expect(state.items.map((item) => item.account).sort()).toEqual(ACCOUNTS)
    expect(unexpectedWrites).toEqual([])
  } finally { release() }
})
