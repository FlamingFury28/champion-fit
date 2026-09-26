import { expect, test } from '@playwright/test'
import type { MatchDto, SynergyResponseDto } from '../src/api/types'

test('Audit aggiorna la Synergy già in cache senza ricaricare la pagina', async ({ page }) => {
  let annotated = false
  let synergyRequests = 0
  const annotationRevision = '2026-09-08T12:00:00+00:00'
  const match: MatchDto = {
    id: 1, account: 'Alpha#EUW', match_id: 'CACHE-ANNOTATION-LOSS',
    date: '2026-09-01T20:00:00Z', patch: '16.13', queue: 'RANKED_SOLO_5x5',
    champion: 'Ahri', role: 'MIDDLE', identity_resolution: 'puuid',
    duration_minutes: 30, win: 0, explicit_afk: 0, suspected_quasi_afk: 0,
    early_surrender: 0, anomaly_flags: '', match_quality_score: 1,
    loss_attribution_weight: 1, win_evidence_weight: 0, reason: 'Loss attribuibile.',
    icon_url: '', annotation_invincible: 0, annotation_carryable_loss: 0,
    annotation_afk_player: 0, annotation_griefer: 0, annotation_team_collapse: 0,
    annotation_manual_label: '', annotation_note: '', annotation_confidence: 1,
  }

  // Keep the 30-second cache fresh throughout the test so elapsed wall time
  // cannot hide a missing invalidation. This leaves browser timers running.
  await page.clock.setFixedTime(new Date('2026-09-08T12:00:00Z'))
  await page.route('**/api/matches*', (route) => route.fulfill({
    json: { items: [{ ...match, annotation_afk_player: annotated ? 1 : 0 }] },
  }))
  await page.route('**/api/annotations*', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: annotated ? {
        item: {
          match_id: match.match_id, invincible: 0, carryable_loss: 0,
          afk_player: 1, griefer: 0, team_collapse: 0,
          manual_label: '', note: '', confidence: 1, updated_at: annotationRevision,
        },
        revision: annotationRevision,
      } : { item: null, revision: null } })
      return
    }
    expect(route.request().method()).toBe('POST')
    expect(route.request().postDataJSON()).toEqual(expect.objectContaining({
      match_id: match.match_id, afk_player: true, expected_revision: null,
    }))
    annotated = true
    await route.fulfill({ json: { ok: true, match_id: match.match_id, revision: annotationRevision } })
  })
  await page.route('**/api/synergy*', async (route) => {
    synergyRequests += 1
    const lift = annotated ? 15 : 5
    const response: SynergyResponseDto = {
      champion: 'ALL', accounts: ['Alpha#EUW', 'Beta#EUW'],
      companion_filter_active: false, min_reliability: 'weak',
      include_exploratory: false, min_games: 1, games: 24, games_with_teammates: 24,
      coverage: { raw_games: 24, eligible_games: 24, analyzed_games: 24, games_with_roster: 24, roster_coverage: 100 },
      available_champions: [{ champion: 'Ahri', games: 24, icon_url: '' }],
      better_with: [{
        champion: 'Lux', icon_url: '', games: 24, wins: 14, losses: 10, win_rate: 58.3,
        posterior_win_rate: 50 + lift, baseline_win_rate: 50,
        posterior_lift_pp: lift, relative_delta_pp: lift,
        credible_lower_90: 51, credible_upper_90: 75, direction_confidence: 95,
        direction_probability: 95, probability_meaningful_advantage: 95,
        probability_meaningful_disadvantage: 5, effective_sample_size: 24,
        personal_effective_sample_size: 24, reliability: 'reliable', actionable: true,
        prior_source: 'global', prior_games: 24,
      }],
      worse_with: [],
    }
    await route.fulfill({ json: response })
  })

  await page.goto('/app/fit?section=matchups&relation=allies')
  await page.reload()
  await expect(page.getByText('+5 pp', { exact: true })).toBeVisible()
  const cachedRequests = synergyRequests

  await page.getByRole('link', { name: 'Le mie partite', exact: true }).click()
  await page.getByRole('button', { name: /^Apri annotazione: .* con Ahri,/ }).click()
  const drawer = page.getByRole('dialog', { name: 'Annotazione della partita' })
  await drawer.getByLabel('Giocatore inattivo (AFK) in squadra', { exact: true }).check()
  await drawer.getByRole('button', { name: 'Salva annotazione' }).click()
  await expect(page.getByText('Annotazione salvata', { exact: true })).toBeVisible()
  await expect(drawer).not.toBeVisible()
  expect(annotated).toBe(true)

  // Client-side navigation must retain the QueryClient while refreshing the
  // invalidated result. Reloading here would erase the cache and miss the bug.
  await page.getByRole('link', { name: 'Campioni', exact: true }).click()
  await page.getByRole('link', { name: 'Avversari e alleati', exact: true }).click()
  await page.getByRole('link', { name: 'Campioni alleati', exact: true }).click()
  await expect(page.getByText('+15 pp', { exact: true })).toBeVisible()
  await expect(page.getByText('+5 pp', { exact: true })).toHaveCount(0)
  expect(synergyRequests).toBe(cachedRequests + 1)
})
