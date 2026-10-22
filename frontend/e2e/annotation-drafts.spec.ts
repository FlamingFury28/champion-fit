import { expect, test, type Locator, type Page } from '@playwright/test'
import type { AnnotationResponseDto, AnnotationUpsertInput, MatchDto } from '../src/api/types'

const match: MatchDto = {
  id: 1, account: 'Alpha#EUW', match_id: 'ANNOTATION-DRAFT-LOSS',
  date: '2026-10-01T20:00:00Z', patch: '16.13', queue: 'RANKED_SOLO_5x5',
  champion: 'Ahri', role: 'MIDDLE', identity_resolution: 'puuid',
  duration_minutes: 30, win: 0, explicit_afk: 0, suspected_quasi_afk: 0,
  early_surrender: 0, anomaly_flags: '', match_quality_score: 1,
  loss_attribution_weight: 1, win_evidence_weight: 0, reason: 'Partita della fixture.',
  icon_url: '', annotation_invincible: 0, annotation_carryable_loss: 0,
  annotation_afk_player: 0, annotation_griefer: 0, annotation_team_collapse: 0,
  annotation_manual_label: '', annotation_note: '', annotation_confidence: 1,
}

function annotation(note: string, revision: string, label = '', afk = false): AnnotationResponseDto {
  return { revision, item: {
    match_id: match.match_id, invincible: 0, carryable_loss: 0,
    afk_player: afk ? 1 : 0, griefer: 0, team_collapse: 0,
    manual_label: label, note, confidence: 1, updated_at: revision,
  } }
}

async function openAnnotation(page: Page) {
  await page.goto('/app/matches?section=history')
  await page.reload()
  await page.getByRole('button', { name: /^Apri annotazione: .* con Ahri,/ }).click()
  const drawer = page.getByRole('dialog', { name: 'Annotazione della partita' })
  await expect(drawer.getByLabel('Nota', { exact: true })).toBeVisible()
  return drawer
}

async function answerReplacement(page: Page, save: Locator, accept: boolean) {
  const pendingDialog = page.waitForEvent('dialog')
  const click = save.click()
  const dialog = await pendingDialog
  const message = dialog.message()
  const type = dialog.type()
  if (accept) await dialog.accept()
  else await dialog.dismiss()
  await click
  expect(type).toBe('confirm')
  return message
}

test('una bozza sopravvive al conflitto 409 e il retry richiede confronto e consenso', async ({ page }) => {
  const posts: AnnotationUpsertInput[] = []
  let snapshot = annotation('Nota originale salvata', 'revision-1')
  let annotationReads = 0
  await page.clock.setFixedTime(new Date('2026-10-13T12:00:00Z'))
  await page.route('**/api/matches*', (route) => route.fulfill({ json: { items: [match] } }))
  await page.route('**/api/annotations*', async (route) => {
    if (route.request().method() === 'GET') {
      annotationReads += 1
      await route.fulfill({ json: snapshot })
      return
    }
    expect(route.request().method()).toBe('POST')
    const body = route.request().postDataJSON() as AnnotationUpsertInput
    posts.push(body)
    if (posts.length === 1) {
      snapshot = annotation('Nota aggiornata da un’altra scheda', 'revision-2', 'Etichetta remota', true)
      await route.fulfill({ status: 409, json: { error: 'L’annotazione è cambiata dopo il caricamento.' } })
      return
    }
    expect(body.expected_revision).toBe('revision-2')
    snapshot = annotation(body.note, 'revision-3', body.manual_label, body.afk_player)
    await route.fulfill({ json: { ok: true, match_id: match.match_id, revision: 'revision-3' } })
  })

  const drawer = await openAnnotation(page)
  const note = drawer.getByLabel('Nota', { exact: true })
  const label = drawer.getByLabel('Etichetta manuale', { exact: true })
  const save = drawer.getByRole('button', { name: 'Salva annotazione' })
  await note.fill('La mia bozza personale')
  await label.fill('Etichetta della bozza')
  await save.click()
  await expect(drawer.locator('.mutation-status')).toContainText('prima di salvarla dovrai confrontare')
  await expect(save).toBeEnabled()
  await expect(note).toHaveValue('La mia bozza personale')
  await expect(label).toHaveValue('Etichetta della bozza')
  await expect.poll(() => annotationReads).toBeGreaterThanOrEqual(2)
  expect(posts).toEqual([expect.objectContaining({
    expected_revision: 'revision-1', note: 'La mia bozza personale', manual_label: 'Etichetta della bozza',
  })])

  const rejectedMessage = await answerReplacement(page, save, false)
  expect(rejectedMessage).toContain('Nota aggiornata da un’altra scheda')
  expect(rejectedMessage).toContain('Etichetta remota')
  expect(rejectedMessage).toContain('Giocatore inattivo (AFK) in squadra')
  await expect(drawer).toBeVisible()
  await expect(note).toHaveValue('La mia bozza personale')
  expect(posts).toHaveLength(1)

  const approvedMessage = await answerReplacement(page, save, true)
  expect(approvedMessage).toBe(rejectedMessage)
  await expect(drawer).not.toBeVisible()
  await expect(page.getByText('Annotazione salvata', { exact: true })).toBeVisible()
  expect(posts).toEqual([
    expect.objectContaining({ expected_revision: 'revision-1' }),
    expect.objectContaining({
      expected_revision: 'revision-2', note: 'La mia bozza personale', manual_label: 'Etichetta della bozza',
    }),
  ])
})

test('durante il POST i campi e la chiusura restano bloccati anche per un modulo pulito', async ({ page }) => {
  const posts: AnnotationUpsertInput[] = []
  const dialogs: string[] = []
  let snapshot = annotation('Nota salvata da conservare', 'revision-1')
  let releasePost!: () => void
  const postGate = new Promise<void>((resolve) => { releasePost = resolve })
  await page.clock.setFixedTime(new Date('2026-10-13T12:00:00Z'))
  await page.route('**/api/matches*', (route) => route.fulfill({ json: { items: [match] } }))
  await page.route('**/api/annotations*', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: snapshot })
      return
    }
    expect(route.request().method()).toBe('POST')
    const body = route.request().postDataJSON() as AnnotationUpsertInput
    posts.push(body)
    await postGate
    snapshot = annotation(body.note, 'revision-2', body.manual_label, body.afk_player)
    await route.fulfill({ json: { ok: true, match_id: match.match_id, revision: 'revision-2' } })
  })
  page.on('dialog', async (dialog) => { dialogs.push(dialog.message()); await dialog.dismiss() })

  try {
    const drawer = await openAnnotation(page)
    const note = drawer.getByLabel('Nota', { exact: true })
    await expect(note).toHaveValue('Nota salvata da conservare')
    await drawer.getByRole('button', { name: 'Salva annotazione' }).click()
    await expect.poll(() => posts.length).toBe(1)
    await expect(drawer.locator('form')).toHaveAttribute('aria-busy', 'true')
    await expect(note).toBeDisabled()
    await expect(drawer.getByLabel('Etichetta manuale', { exact: true })).toBeDisabled()
    await expect(drawer.getByRole('slider')).toBeDisabled()
    const flags = drawer.getByRole('checkbox')
    await expect(flags).toHaveCount(5)
    for (const flag of await flags.all()) await expect(flag).toBeDisabled()
    await expect(drawer.getByRole('button', { name: 'Annulla' })).toBeDisabled()
    await expect(drawer.getByRole('button', { name: 'Salvo…' })).toBeDisabled()

    await drawer.getByRole('button', { name: 'Chiudi', exact: true }).click()
    await page.keyboard.press('Escape')
    await expect(drawer).toBeVisible()
    await expect(note).toHaveValue('Nota salvata da conservare')
    expect(dialogs).toEqual([])
    expect(posts).toHaveLength(1)

    releasePost()
    await expect(drawer).not.toBeVisible()
    await expect(page.getByText('Annotazione salvata', { exact: true })).toBeVisible()
    expect(posts[0]).toEqual(expect.objectContaining({
      expected_revision: 'revision-1', note: 'Nota salvata da conservare',
    }))
    await page.getByRole('button', { name: /^Apri annotazione: .* con Ahri,/ }).click()
    await expect(drawer.getByLabel('Nota', { exact: true })).toHaveValue('Nota salvata da conservare')
    await drawer.getByRole('button', { name: 'Chiudi', exact: true }).click()
    await expect(drawer).not.toBeVisible()
    expect(dialogs).toEqual([])
  } finally {
    releasePost()
  }
})
