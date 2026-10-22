import { expect, test, type Page, type Route } from '@playwright/test'
import type { RecommendationFeedbackInputDto, RecommendationFeedbackResponseDto } from '../src/api/types'

const submittedTarget = 'Mi piace · Wukong · Corsia superiore · Alpha#EUW'
const firstInput: RecommendationFeedbackInputDto = {
  accounts: ['Alpha#EUW'], champion: 'MonkeyKing', role: 'TOP', preference: 'like', expected_revision: 4,
}
const nextInput: RecommendationFeedbackInputDto = {
  accounts: ['Beta#EUW'], champion: 'Zed', role: 'MIDDLE', preference: 'dislike', expected_revision: 5,
}

function ledger(revision: number, items: RecommendationFeedbackResponseDto['items'] = []): RecommendationFeedbackResponseDto {
  return {
    revision, accounts: ['Alpha#EUW', 'Beta#EUW'], suspended_accounts: [], unresolved_accounts: [],
    items, catalog_version: 'synthetic-preference-recovery',
    options: [
      { champion: 'MonkeyKing', name: 'Wukong', roles: ['TOP'], roles_by_account: { 'Alpha#EUW': ['TOP'], 'Beta#EUW': ['TOP'] }, icon_url: null, classified: true },
      { champion: 'Zed', name: 'Zed', roles: ['MIDDLE'], roles_by_account: { 'Alpha#EUW': ['MIDDLE'], 'Beta#EUW': ['MIDDLE'] }, icon_url: null, classified: true },
    ],
  }
}

function gate() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
}

async function mockFeedback(page: Page, answer: (route: Route, method: string) => Promise<void>) {
  const posts: RecommendationFeedbackInputDto[] = []
  const gets: string[][] = []
  const otherWrites: string[] = []
  await page.route('https://ddragon.leagueoflegends.com/**', (route) => route.abort())
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.addInitScript(() => {
    localStorage.setItem('champion-fit-profile-accounts', JSON.stringify(['Alpha#EUW', 'Beta#EUW']))
  })
  await page.route('**/api/**', async (route) => {
    if (route.request().method() === 'GET') await route.fallback()
    else {
      otherWrites.push(new URL(route.request().url()).pathname)
      await route.abort()
    }
  })
  await page.route('**/api/recommendation-feedback*', async (route) => {
    const method = route.request().method()
    if (method === 'GET') gets.push(new URL(route.request().url()).searchParams.getAll('account'))
    else if (method === 'POST') posts.push(route.request().postDataJSON() as RecommendationFeedbackInputDto)
    else throw new Error(`Unexpected preference method: ${method}`)
    await answer(route, method)
  })
  return { posts, gets, otherWrites }
}

async function openSubmittedDraft(page: Page) {
  const editor = page.getByRole('region', { name: 'Dichiara cosa ti piace', exact: true })
  const search = editor.getByRole('textbox', { name: 'Cerca nel catalogo', exact: true })
  await page.goto('/app/fit?section=choices')
  await expect(search).toBeVisible()
  await page.reload()
  await expect(search).toBeVisible()
  await search.fill('Wukong')
  await editor.getByRole('combobox', { name: 'Campione della preferenza', exact: true }).selectOption('MonkeyKing')
  await editor.getByText('Account · 2/2 selezionati', { exact: true }).click()
  await editor.getByRole('checkbox', { name: 'Beta#EUW', exact: true }).uncheck()
  const original = await search.elementHandle()
  if (!original) throw new Error('Preference search input was not mounted')

  return {
    editor, original,
    changeDraft: async () => {
      await search.fill('Zed')
      await editor.getByRole('combobox', { name: 'Campione della preferenza', exact: true }).selectOption('Zed')
      await editor.getByRole('checkbox', { name: 'Beta#EUW', exact: true }).check()
      await editor.getByRole('checkbox', { name: 'Alpha#EUW', exact: true }).uncheck()
    },
    expectNextDraft: async () => {
      await expect(search).toHaveValue('Zed')
      await expect(editor.getByRole('combobox', { name: 'Campione della preferenza', exact: true })).toHaveValue('Zed')
      await expect(editor.getByRole('combobox', { name: 'Ruolo della preferenza', exact: true })).toHaveValue('MIDDLE')
      await expect(editor.getByRole('checkbox', { name: 'Alpha#EUW', exact: true })).not.toBeChecked()
      await expect(editor.getByRole('checkbox', { name: 'Beta#EUW', exact: true })).toBeChecked()
      expect(await search.evaluate((element, previous) => element === previous, original)).toBe(true)
    },
  }
}

for (const status of [200, 503, 'incomplete'] as const) {
  test(`preferenze: recupero della bozza dopo risposta tardiva ${status} @smoke`, async ({ page }) => {
    const pending = gate()
    let revision = 4
    let items: RecommendationFeedbackResponseDto['items'] = status === 'incomplete'
      ? [{ account: 'Beta#EUW', champion: 'Zed', role: 'MIDDLE', preference: 'dislike', updated_at: '2026-10-17T12:00:00Z' }] : []
    const requests = await mockFeedback(page, async (route, method) => {
      if (method === 'GET') { await route.fulfill({ json: ledger(revision, items) }); return }
      await pending.promise
      if (status === 'incomplete') {
        await route.fulfill({ json: requests.posts.length === 1 ? {} : { ok: true, revision, items } })
        return
      }
      if (status === 200) {
        revision = 5
        items = [{ account: 'Alpha#EUW', champion: 'MonkeyKing', role: 'TOP', preference: 'like', updated_at: '2026-10-17T12:00:00Z' }]
        await route.fulfill({ json: { ok: true, revision, items } })
      } else await route.fulfill({ status, json: { error: 'Servizio sintetico indisponibile.' } })
    })
    let draft: Awaited<ReturnType<typeof openSubmittedDraft>> | undefined
    try {
      draft = await openSubmittedDraft(page)
      const readsBeforePost = requests.gets.length
      await draft.editor.getByRole('button', { name: 'Mi piace', exact: true }).click()
      await expect.poll(() => requests.posts).toEqual([firstInput])
      await expect(draft.editor.getByRole('button', { name: 'Mi piace', exact: true })).toBeDisabled()
      await draft.changeDraft()
      await draft.expectNextDraft()
      const pendingNotice = draft.editor.getByRole('status').filter({ hasText: 'Salvataggio della preferenza' })
      await expect(pendingNotice).toContainText(submittedTarget)
      await expect(pendingNotice).not.toContainText('Zed')
      await expect(pendingNotice).not.toContainText('Beta#EUW')

      pending.release()
      const notice = status === 200
        ? draft.editor.getByRole('status').filter({ hasText: 'Preferenza salvata.' })
        : draft.editor.getByRole('alert').filter({ hasText: status === 'incomplete' ? 'L’esito della richiesta non è confermato' : 'Servizio sintetico indisponibile.' })
      await expect(notice).toBeVisible()
      await expect(notice).toContainText(submittedTarget)
      await expect(notice).not.toContainText('MonkeyKing')
      await expect(notice).not.toContainText('Zed')
      await expect(notice).not.toContainText('Beta#EUW')
      await draft.expectNextDraft()
      await expect(draft.editor.getByRole('button', { name: 'Non fa per me', exact: true })).toBeEnabled()
      if (status !== 200) await expect(draft.editor.getByText('Preferenza salvata.', { exact: true })).toHaveCount(0)
      expect(requests.posts).toEqual([firstInput])
      expect(readsBeforePost).toBeGreaterThanOrEqual(2)
      expect(requests.gets).toHaveLength(readsBeforePost + (status === 200 ? 1 : 0))
      expect(requests.gets.every((accounts) => JSON.stringify(accounts) === JSON.stringify(['Alpha#EUW', 'Beta#EUW']))).toBe(true)
      if (status === 'incomplete') {
        await draft.editor.getByRole('button', { name: 'Non fa per me', exact: true }).click()
        const saved = draft.editor.getByRole('status').filter({ hasText: 'Preferenza salvata.' })
        await expect(saved).toContainText('Zed')
        await expect(saved).toContainText('Beta#EUW')
        await draft.expectNextDraft()
        expect(requests.posts).toEqual([firstInput, { ...nextInput, expected_revision: 4 }])
        expect(requests.gets).toHaveLength(readsBeforePost + 1)
      }
      expect(requests.otherWrites).toEqual([])
    } finally { pending.release(); await draft?.original.dispose() }
  })
}

test('preferenze: recupero dopo 409 richiede GET riuscito e revisione aggiornata prima del nuovo giudizio @smoke', async ({ page }) => {
  const rejectedPost = gate()
  const firstRefresh = gate()
  let phase: 'initial' | 'failed' | 'stale' | 'updated' | 'saved' = 'initial'
  let posted = 0
  const requests = await mockFeedback(page, async (route, method) => {
    if (method === 'GET') {
      if (phase === 'failed') {
        await firstRefresh.promise
        await route.fulfill({ status: 503, json: { error: 'Registro sintetico non disponibile.' } })
      } else await route.fulfill({ json: ledger(phase === 'saved' ? 6 : phase === 'updated' ? 5 : 4) })
      return
    }
    posted += 1
    if (posted === 1) {
      await rejectedPost.promise
      phase = 'failed'
      await route.fulfill({ status: 409, json: { error: 'revision conflict' } })
    } else {
      phase = 'saved'
      await route.fulfill({ json: { ok: true, revision: 6, items: [] } })
    }
  })
  let draft: Awaited<ReturnType<typeof openSubmittedDraft>> | undefined
  try {
    draft = await openSubmittedDraft(page)
    await draft.editor.getByRole('button', { name: 'Mi piace', exact: true }).click()
    await expect.poll(() => requests.posts).toEqual([firstInput])
    await draft.changeDraft()
    rejectedPost.release()
    await expect(draft.editor.getByRole('button', { name: 'Ricarico preferenze…', exact: true })).toBeDisabled()
    await expect(draft.editor.getByRole('status')).toContainText('Sto ricaricando il registro corrente')
    await expect(draft.editor.getByRole('status')).toContainText(submittedTarget)
    await expect(draft.editor.getByText(/Ho ricaricato il registro corrente/)).toHaveCount(0)
    await draft.expectNextDraft()

    firstRefresh.release()
    const retry = draft.editor.getByRole('button', { name: 'Ricarica preferenze', exact: true })
    await expect(retry).toBeEnabled()
    const failed = draft.editor.getByRole('alert').filter({ hasText: 'Non riesco ad aggiornare il registro corrente' })
    await expect(failed).toContainText(submittedTarget)
    await expect(draft.editor.getByText(/Ho ricaricato il registro corrente/)).toHaveCount(0)
    await draft.expectNextDraft()
    expect(requests.posts).toEqual([firstInput])

    phase = 'stale'
    const beforeStaleGet = requests.gets.length
    await retry.click()
    await expect.poll(() => requests.gets.length).toBe(beforeStaleGet + 1)
    await expect(draft.editor.getByRole('alert').filter({ hasText: 'Il registro corrente non è ancora aggiornato' })).toBeVisible()
    await expect(retry).toBeEnabled()
    await expect(draft.editor.getByRole('button', { name: 'Mi piace', exact: true })).toHaveCount(0)
    await expect(draft.editor.getByRole('button', { name: 'Non fa per me', exact: true })).toHaveCount(0)
    await draft.expectNextDraft()
    expect(requests.posts).toEqual([firstInput])

    phase = 'updated'
    const beforeUpdatedGet = requests.gets.length
    await retry.click()
    await expect.poll(() => requests.gets.length).toBe(beforeUpdatedGet + 1)
    await expect(draft.editor.getByRole('button', { name: 'Non fa per me', exact: true })).toBeEnabled()
    await expect(draft.editor.getByRole('alert')).toContainText('Ho ricaricato il registro corrente')
    await draft.expectNextDraft()
    expect(requests.posts).toEqual([firstInput])

    await draft.editor.getByRole('button', { name: 'Non fa per me', exact: true }).click()
    await expect.poll(() => requests.posts).toEqual([firstInput, nextInput])
    const saved = draft.editor.getByRole('status').filter({ hasText: 'Preferenza salvata.' })
    await expect(saved).toContainText('Non fa per me · Zed · Corsia centrale · Beta#EUW')
    await expect(saved).not.toContainText('Alpha#EUW')
    await draft.expectNextDraft()
    expect(requests.gets.every((accounts) => JSON.stringify(accounts) === JSON.stringify(['Alpha#EUW', 'Beta#EUW']))).toBe(true)
    expect(requests.otherWrites).toEqual([])
  } finally { rejectedPost.release(); firstRefresh.release(); await draft?.original.dispose() }
})
