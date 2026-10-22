import { expect, test } from '@playwright/test'
import type { RecommendationFeedbackInputDto, RecommendationFeedbackResponseDto } from '../src/api/types'

test('preferenze: recupera la selezione dopo il ritiro di un account @smoke', async ({ page }) => {
  let phase: 'initial' | 'restricted' | 'saved' = 'initial'
  const submissions: RecommendationFeedbackInputDto[] = []
  await page.route('https://ddragon.leagueoflegends.com/**', (route) => route.abort())
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.route('**/api/**', async (route) => {
    if (route.request().method() === 'GET') await route.fallback()
    else await route.abort()
  })
  await page.route('**/api/recommendation-feedback**', async (route) => {
    if (route.request().method() === 'POST') {
      submissions.push(route.request().postDataJSON() as RecommendationFeedbackInputDto)
      if (submissions.length === 1) {
        phase = 'restricted'
        await route.fulfill({ status: 409, json: { error: 'Feedback revision conflict' } })
      } else {
        phase = 'saved'
        await route.fulfill({ json: { ok: true, revision: 6, items: [] } })
      }
      return
    }
    const accounts = phase === 'initial' ? ['Alpha#EUW', 'Beta#EUW'] : ['Beta#EUW']
    const library: RecommendationFeedbackResponseDto = {
      revision: phase === 'initial' ? 4 : phase === 'restricted' ? 5 : 6,
      accounts, suspended_accounts: phase === 'initial' ? [] : ['Alpha#EUW'], unresolved_accounts: [],
      catalog_version: 'browser-account-recovery',
      options: [{ champion: 'Ahri', name: 'Ahri', roles: ['MIDDLE'],
        roles_by_account: Object.fromEntries(accounts.map((account) => [account, ['MIDDLE']])),
        classified: true, icon_url: null }],
      items: phase === 'saved' ? [{ account: 'Beta#EUW', champion: 'Ahri', role: 'MIDDLE',
        preference: 'like', updated_at: '2026-10-17T12:00:00Z' }] : [],
    }
    await route.fulfill({ json: library })
  })

  await page.goto('/app/fit?section=choices&queue=all&days=all')
  await page.reload()
  const editor = page.getByRole('region', { name: 'Dichiara cosa ti piace', exact: true })
  await editor.getByRole('combobox', { name: 'Campione della preferenza', exact: true }).selectOption('Ahri')
  await editor.getByText('Account · 2/2 selezionati', { exact: true }).click()
  await editor.getByRole('checkbox', { name: 'Beta#EUW', exact: true }).uncheck()
  const like = editor.getByRole('button', { name: 'Mi piace', exact: true })
  await like.click()
  await expect.poll(() => submissions.length).toBe(1)
  expect(submissions[0]).toMatchObject({ accounts: ['Alpha#EUW'], expected_revision: 4 })

  await expect(editor.getByText('Account · 0/1 selezionati', { exact: true })).toBeVisible()
  await expect(like).toBeDisabled()
  const beta = editor.getByRole('checkbox', { name: 'Beta#EUW', exact: true })
  if (!await beta.isVisible()) await editor.getByText('Account · 0/1 selezionati', { exact: true }).click()
  await expect(beta).not.toBeChecked()
  await beta.check()
  await editor.getByRole('combobox', { name: 'Ruolo della preferenza', exact: true }).selectOption('MIDDLE')
  await expect(like).toBeEnabled()
  expect(submissions).toHaveLength(1)
  await like.click()
  await expect.poll(() => submissions.length).toBe(2)
  expect(submissions[1]).toEqual({ accounts: ['Beta#EUW'], champion: 'Ahri', role: 'MIDDLE',
    preference: 'like', expected_revision: 5 })
  await expect(editor.getByText('Preferenza salvata.', { exact: true })).toBeVisible()
})
