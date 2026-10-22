import { expect, test, type Locator, type Page } from '@playwright/test'
import type { AnnotationResponseDto, AnnotationUpsertInput, MatchDto } from '../src/api/types'

const match: MatchDto = {
  id: 1, account: 'Alpha#EUW', match_id: 'ANNOTATION-ACKNOWLEDGEMENT',
  date: '2026-10-01T20:00:00Z', patch: '16.13', queue: 'RANKED_SOLO_5x5',
  champion: 'Ahri', role: 'MIDDLE', identity_resolution: 'puuid',
  duration_minutes: 30, win: 0, explicit_afk: 0, suspected_quasi_afk: 0,
  early_surrender: 0, anomaly_flags: '', match_quality_score: 1,
  loss_attribution_weight: 1, win_evidence_weight: 0, reason: 'Partita sintetica per verificare il salvataggio.',
  icon_url: '', annotation_invincible: 0, annotation_carryable_loss: 0,
  annotation_afk_player: 0, annotation_griefer: 0, annotation_team_collapse: 0,
  annotation_manual_label: '', annotation_note: '', annotation_confidence: 1,
}
const unconfirmedMessage = 'La risposta del server non è valida o completa. L’esito della richiesta non è confermato.'

function annotation(note: string, revision: string | null, label = ''): AnnotationResponseDto {
  return { revision, item: revision === null ? null : {
    match_id: match.match_id, invincible: 0, carryable_loss: 0, afk_player: 0, griefer: 0,
    team_collapse: 0, manual_label: label, note, confidence: 1, updated_at: revision,
  } }
}

interface FixtureState {
  snapshot: AnnotationResponseDto
  reads: number
  posts: AnnotationUpsertInput[]
}
interface Reply { status?: number; json: unknown }

async function mockApi(page: Page, state: FixtureState, respond: (body: AnnotationUpsertInput, attempt: number) => Reply) {
  const unexpectedWrites: string[] = []
  await page.clock.setFixedTime(new Date('2026-10-17T12:00:00Z'))
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.route('https://ddragon.leagueoflegends.com/**', (route) => route.abort())
  await page.route('**/api/**', (route) => {
    if (route.request().method() === 'GET') return route.fallback()
    unexpectedWrites.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`)
    return route.abort()
  })
  await page.route('**/api/matches?**', (route) => route.request().method() === 'GET'
    ? route.fulfill({ json: { items: [match] } }) : route.fallback())
  await page.route('**/api/annotations*', async (route) => {
    if (route.request().method() === 'GET') {
      state.reads += 1
      await route.fulfill({ json: state.snapshot })
    } else if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as AnnotationUpsertInput
      state.posts.push(body)
      await route.fulfill(respond(body, state.posts.length))
    } else {
      await route.fallback()
    }
  })
  return unexpectedWrites
}

async function openAfterFullRefresh(page: Page) {
  await page.goto('/app/matches?section=history')
  const open = page.getByRole('button', { name: /^Apri annotazione:/ })
  await expect(open).toBeVisible()
  await page.reload()
  await expect(open).toBeVisible()
  await open.click()
  const drawer = page.getByRole('dialog', { name: 'Annotazione della partita', exact: true })
  await expect(drawer.getByRole('textbox', { name: 'Nota', exact: true })).toBeVisible()
  return drawer
}

async function answerReplacement(page: Page, save: Locator, accept: boolean) {
  const nextDialog = page.waitForEvent('dialog')
  const click = save.click()
  const dialog = await nextDialog
  expect(dialog.type()).toBe('confirm')
  expect(dialog.message()).toContain('Nota remota da confrontare')
  expect(dialog.message()).toContain('Etichetta remota')
  if (accept) await dialog.accept()
  else await dialog.dismiss()
  await click
}

test('annotazioni: una risposta 200 incompleta o per altra partita non conferma il salvataggio @smoke', async ({ page }) => {
  const state: FixtureState = { snapshot: annotation('Nota originale', 'revision-1'), reads: 0, posts: [] }
  const unexpectedWrites = await mockApi(page, state, (body, attempt) => {
    if (attempt === 1) return { json: {} }
    if (attempt === 2) return { json: { ok: true, match_id: 'OTHER-MATCH', revision: 'revision-2' } }
    state.snapshot = annotation(body.note, 'revision-2', body.manual_label)
    return { json: { ok: true, match_id: match.match_id, revision: 'revision-2' } }
  })
  const drawer = await openAfterFullRefresh(page)
  const note = drawer.getByRole('textbox', { name: 'Nota', exact: true })
  const label = drawer.getByRole('textbox', { name: 'Etichetta manuale', exact: true })
  await note.fill('Bozza personale non ancora confermata')
  await label.fill('Etichetta della bozza')
  const originalInput = await note.elementHandle()
  const originalLabel = await label.elementHandle()
  const initialReads = state.reads
  const save = drawer.getByRole('button', { name: 'Salva annotazione', exact: true })
  for (const attempt of [1, 2]) {
    await save.click()
    await expect.poll(() => state.posts.length).toBe(attempt)
    await expect(save).toBeEnabled()
    await expect(drawer.locator('.mutation-status')).toHaveText(unconfirmedMessage)
    await expect(drawer).toBeVisible()
    await expect(note).toHaveValue('Bozza personale non ancora confermata')
    await expect(label).toHaveValue('Etichetta della bozza')
    expect(await note.evaluate((element, original) => element === original, originalInput)).toBe(true)
    expect(await label.evaluate((element, original) => element === original, originalLabel)).toBe(true)
    await expect(page.getByText('Annotazione salvata', { exact: true })).toHaveCount(0)
    expect(state.posts).toHaveLength(attempt)
    expect(state.reads).toBe(initialReads)
    // The modal keeps background notifications outside the accessible focus area.
    // Wait for normal expiry so errors finish before checking the final success.
    await expect(page.locator('.toast-root')).toHaveCount(0)
  }
  // Only this explicit retry returns a valid acknowledgement for the selected match.
  await save.click()
  await expect(drawer).toBeHidden()
  await expect(page.locator('.toast-root').getByText('Annotazione salvata', { exact: true })).toBeVisible()
  expect(state.posts).toHaveLength(3)
  for (const body of state.posts) expect(body).toMatchObject({
    match_id: match.match_id, expected_revision: 'revision-1',
    note: 'Bozza personale non ancora confermata', manual_label: 'Etichetta della bozza',
  })
  expect(unexpectedWrites).toEqual([])
})

for (const initialRevision of ['revision-1', null]) {
  test(`annotazioni: dopo 409 la stessa revisione ${initialRevision ?? 'null'} richiede solo GET fino a un token aggiornato @smoke`, async ({ page }) => {
    const state: FixtureState = { snapshot: annotation('Nota originale', initialRevision), reads: 0, posts: [] }
    const unexpectedWrites = await mockApi(page, state, (body, attempt) => {
      if (attempt === 1) return { status: 409, json: { error: 'L’annotazione è cambiata dopo il caricamento.' } }
      state.snapshot = annotation(body.note, 'revision-3', body.manual_label)
      return { json: { ok: true, match_id: match.match_id, revision: 'revision-3' } }
    })
    const drawer = await openAfterFullRefresh(page)
    const note = drawer.getByRole('textbox', { name: 'Nota', exact: true })
    const label = drawer.getByRole('textbox', { name: 'Etichetta manuale', exact: true })
    await note.fill('Bozza protetta durante letture obsolete')
    await label.fill('Etichetta locale da proteggere')
    const originalInput = await note.elementHandle()
    const originalLabel = await label.elementHandle()
    await drawer.getByRole('button', { name: 'Salva annotazione', exact: true }).click()
    const reload = drawer.getByRole('button', { name: 'Ricarica annotazione', exact: true })
    await expect(reload).toBeEnabled()
    await expect.poll(() => state.reads).toBeGreaterThanOrEqual(2)
    await expect(drawer.locator('.mutation-status')).toContainText('La versione corrente dell’annotazione non è ancora aggiornata.')
    expect(state.posts).toHaveLength(1)
    expect(state.posts[0]!.expected_revision).toBe(initialRevision)

    const readsBefore = state.reads
    await reload.click()
    await expect.poll(() => state.reads).toBeGreaterThan(readsBefore)
    await expect(reload).toBeEnabled()
    await expect(drawer.getByRole('button', { name: 'Salva annotazione', exact: true })).toHaveCount(0)
    await expect(drawer.locator('.mutation-status')).toContainText('La versione corrente dell’annotazione non è ancora aggiornata.')
    await expect(note).toHaveValue('Bozza protetta durante letture obsolete')
    await expect(label).toHaveValue('Etichetta locale da proteggere')
    expect(state.posts).toHaveLength(1)
    expect(await note.evaluate((element, original) => element === original, originalInput)).toBe(true)
    expect(await label.evaluate((element, original) => element === original, originalLabel)).toBe(true)
    await expect(page.getByText('Annotazione salvata', { exact: true })).toHaveCount(0)

    state.snapshot = annotation('Nota remota da confrontare', 'revision-2', 'Etichetta remota')
    await reload.click()
    const save = drawer.getByRole('button', { name: 'Salva annotazione', exact: true })
    await expect(save).toBeEnabled()
    await expect(note).toHaveValue('Bozza protetta durante letture obsolete')
    await expect(label).toHaveValue('Etichetta locale da proteggere')
    expect(await note.evaluate((element, original) => element === original, originalInput)).toBe(true)
    await answerReplacement(page, save, false)
    expect(state.posts).toHaveLength(1)
    await expect(drawer).toBeVisible()
    await answerReplacement(page, save, true)
    await expect(drawer).toBeHidden()
    expect(state.posts).toEqual([
      expect.objectContaining({ expected_revision: initialRevision }),
      expect.objectContaining({ expected_revision: 'revision-2', note: 'Bozza protetta durante letture obsolete', manual_label: 'Etichetta locale da proteggere' }),
    ])
    expect(unexpectedWrites).toEqual([])
  })
}
