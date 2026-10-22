import { expect, test, type Page } from '@playwright/test'
import type { AnnotationResponseDto, AnnotationUpsertInput, MatchDto } from '../src/api/types'

const originalNote = 'Nota originale della fixture'
const match: MatchDto = {
  id: 1, account: 'Alpha#EUW', match_id: 'ANNOTATION-NAVIGATION',
  date: '2026-10-01T20:00:00Z', patch: '16.13', queue: 'RANKED_SOLO_5x5',
  champion: 'Ahri', role: 'MIDDLE', identity_resolution: 'puuid',
  duration_minutes: 30, win: 0, explicit_afk: 0, suspected_quasi_afk: 0,
  early_surrender: 0, anomaly_flags: '', match_quality_score: 1,
  loss_attribution_weight: 1, win_evidence_weight: 0, reason: 'Partita sintetica per la navigazione.',
  icon_url: '', annotation_invincible: 0, annotation_carryable_loss: 0,
  annotation_afk_player: 0, annotation_griefer: 0, annotation_team_collapse: 0,
  annotation_manual_label: '', annotation_note: '', annotation_confidence: 1,
}
const annotation: AnnotationResponseDto = { revision: 'navigation-revision-1', item: {
  match_id: match.match_id, invincible: 0, carryable_loss: 0, afk_player: 0, griefer: 0,
  team_collapse: 0, manual_label: '', note: originalNote, confidence: 1, updated_at: 'navigation-revision-1',
} }

async function mockAnnotations(page: Page, pendingPost?: Promise<void>) {
  const posts: AnnotationUpsertInput[] = []
  const unexpectedWrites: string[] = []
  await page.route('https://ddragon.leagueoflegends.com/**', (route) => route.abort())
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.route('**/api/**', (route) => {
    if (route.request().method() === 'GET') return route.fallback()
    unexpectedWrites.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`)
    return route.abort()
  })
  await page.route('**/api/matches?**', (route) => route.fulfill({ json: { items: [match] } }))
  await page.route('**/api/annotations*', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: annotation })
      return
    }
    expect(route.request().method()).toBe('POST')
    posts.push(route.request().postDataJSON() as AnnotationUpsertInput)
    if (pendingPost) await pendingPost
    await route.fulfill({ status: 503, json: { error: 'Salvataggio sintetico non disponibile' } })
  })
  return { posts, unexpectedWrites }
}

async function overviewAfterFullRefresh(page: Page) {
  await page.goto('/app/overview')
  await expect(page.getByRole('heading', { level: 1, name: 'Riepilogo', exact: true })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('heading', { level: 1, name: 'Riepilogo', exact: true })).toBeVisible()
  const link = page.getByRole('link', { name: 'Le mie partite', exact: true })
  if (!await link.isVisible()) await page.getByRole('button', { name: 'Apri il menu', exact: true }).click()
  await link.click()
  await expect(page.getByRole('button', { name: /^Apri annotazione:/ })).toBeVisible()
}

async function openAnnotation(page: Page) {
  await page.getByRole('button', { name: /^Apri annotazione:/ }).click()
  const drawer = page.getByRole('dialog', { name: 'Annotazione della partita', exact: true })
  await expect(drawer.getByRole('textbox', { name: 'Nota', exact: true })).toHaveValue(originalNote)
  return drawer
}

async function beforeUnloadPrevented(page: Page) {
  return page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(event)
    return event.defaultPrevented
  })
}

async function answerBack(page: Page, accept: boolean) {
  const nextDialog = page.waitForEvent('dialog')
  const back = page.goBack()
  const dialog = await nextDialog
  expect(dialog.type()).toBe('confirm')
  expect(dialog.message()).toBe('Chiudere senza salvare le modifiche all’annotazione?')
  if (accept) await dialog.accept()
  else await dialog.dismiss()
  await back
}

test('annotazioni: Indietro conserva la bozza finché l’uscita non viene confermata @smoke', async ({ page }) => {
  const { posts, unexpectedWrites } = await mockAnnotations(page)
  await overviewAfterFullRefresh(page)
  const drawer = await openAnnotation(page)
  const note = drawer.getByRole('textbox', { name: 'Nota', exact: true })
  expect(await beforeUnloadPrevented(page)).toBe(false)
  await note.fill('Bozza da conservare durante Indietro')
  const originalInput = await note.elementHandle()
  expect(await beforeUnloadPrevented(page)).toBe(true)
  await answerBack(page, false)
  await expect(page).toHaveURL(/\/app\/matches(?:\?.*)?$/)
  await expect(note).toHaveValue('Bozza da conservare durante Indietro')
  expect(await note.evaluate((element, original) => element === original, originalInput)).toBe(true)
  await answerBack(page, true)
  await expect(page).toHaveURL(/\/app\/overview$/)
  await expect(drawer).toBeHidden()
  expect(await beforeUnloadPrevented(page)).toBe(false)
  expect(posts).toEqual([])
  expect(unexpectedWrites).toEqual([])
})

test('annotazioni: il cambio sezione verso Stile richiede consenso e conserva lo stesso editor al rifiuto @smoke', async ({ page }) => {
  const { posts, unexpectedWrites } = await mockAnnotations(page)
  await page.goto('/app/matches?section=style')
  const style = page.getByRole('heading', { name: 'Quali stili funzionano per te?', exact: true })
  await expect(style).toBeVisible()
  await page.reload()
  await expect(style).toBeVisible()
  await page.getByRole('link', { name: 'Andamento e partite', exact: true }).click()
  await expect(page).toHaveURL(/section=history/)
  const drawer = await openAnnotation(page)
  const note = drawer.getByRole('textbox', { name: 'Nota', exact: true })
  await note.fill('Bozza da conservare tra le sezioni')
  const originalInput = await note.elementHandle()
  // Browser history changes the section while the modal correctly keeps background links inert.
  await answerBack(page, false)
  await expect(page).toHaveURL(/section=history/)
  await expect(note).toHaveValue('Bozza da conservare tra le sezioni')
  expect(await note.evaluate((element, original) => element === original, originalInput)).toBe(true)
  expect(await beforeUnloadPrevented(page)).toBe(true)
  await answerBack(page, true)
  await expect(page).toHaveURL(/section=style/)
  await expect(style).toBeVisible()
  await expect(drawer).toBeHidden()
  expect(await beforeUnloadPrevented(page)).toBe(false)
  expect(posts).toEqual([])
  expect(unexpectedWrites).toEqual([])
})

test('annotazioni: POST pulito pendente blocca Indietro senza dialoghi e l’errore libera l’uscita @smoke', async ({ page }) => {
  let releasePost!: () => void
  const pendingPost = new Promise<void>((resolve) => { releasePost = resolve })
  const { posts, unexpectedWrites } = await mockAnnotations(page, pendingPost)
  const dialogs: string[] = []
  page.on('dialog', async (dialog) => { dialogs.push(`${dialog.type()}: ${dialog.message()}`); await dialog.dismiss() })
  try {
    await overviewAfterFullRefresh(page)
    const drawer = await openAnnotation(page)
    const note = drawer.getByRole('textbox', { name: 'Nota', exact: true })
    expect(await beforeUnloadPrevented(page)).toBe(false)
    await drawer.getByRole('button', { name: 'Salva annotazione', exact: true }).click()
    await expect.poll(() => posts.length).toBe(1)
    await expect(note).toBeDisabled()
    expect(await beforeUnloadPrevented(page)).toBe(true)
    await page.goBack()
    await expect(page).toHaveURL(/\/app\/matches(?:\?.*)?$/)
    await expect(note).toHaveValue(originalNote)
    await expect(note).toBeDisabled()
    expect(dialogs).toEqual([])

    releasePost()
    await expect(drawer.getByRole('button', { name: 'Salva annotazione', exact: true })).toBeEnabled()
    await expect(drawer.locator('.mutation-status')).toContainText('Salvataggio sintetico non disponibile')
    await expect(page).toHaveURL(/\/app\/matches(?:\?.*)?$/)
    await expect(note).toHaveValue(originalNote)
    expect(await beforeUnloadPrevented(page)).toBe(false)
    await expect(page.getByText('Annotazione salvata', { exact: true })).toHaveCount(0)
    await page.goBack()
    await expect(page).toHaveURL(/\/app\/overview$/)
    await expect(drawer).toBeHidden()
    expect(dialogs).toEqual([])
    expect(posts).toEqual([expect.objectContaining({ expected_revision: 'navigation-revision-1', note: originalNote })])
    expect(unexpectedWrites).toEqual([])
  } finally {
    releasePost()
  }
})


test('motivi importati: il testo resta leggibile e la partita conserva la propria annotazione @smoke', async ({ page }) => {
  test.setTimeout(60_000)
  const matchResponses: { url: URL; original: MatchDto; displayed: MatchDto; items: number }[] = []
  const annotationResponses: { url: URL; body: AnnotationResponseDto }[] = []
  const unexpectedWrites: string[] = []
  const pageErrors: string[] = []
  const reactWarnings: string[] = []
  let importedReason = '__proto__'
  page.on('pageerror', (error) => pageErrors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error' && /React child|Functions are not valid|Objects are not valid/.test(message.text())) reactWarnings.push(message.text())
  })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.route('https://ddragon.leagueoflegends.com/**', (route) => route.abort())
  await page.route('**/api/**', (route) => {
    if (route.request().method() === 'GET') return route.fallback()
    unexpectedWrites.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`)
    return route.abort()
  })
  await page.route('**/api/matches?**', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    const response = await route.fetch()
    expect(response.status()).toBe(200)
    const body = await response.json() as { items: MatchDto[] }
    const originalBody = structuredClone(body)
    const index = body.items.findIndex((item) => item.annotation_note !== '')
    if (index < 0) throw new Error('La fixture reale deve contenere una partita con annotazione già salvata.')
    const original = structuredClone(body.items[index]!)
    // Emulate only a supported imported reason. Separate public-ingest/HTTP
    // evidence proves this string can reach the page; no producer is assumed
    // to generate it. Every other field comes from the real fixture response.
    body.items[index] = { ...original, reason: importedReason }
    expect(body).toEqual({ ...originalBody,
      items: originalBody.items.map((item, itemIndex) => itemIndex === index ? { ...item, reason: importedReason } : item),
    })
    matchResponses.push({ url: new URL(route.request().url()), original, displayed: body.items[index]!, items: body.items.length })
    await route.fulfill({ response, json: body })
  })
  await page.route('**/api/annotations?**', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    const response = await route.fetch()
    expect(response.status()).toBe(200)
    const body = await response.json() as AnnotationResponseDto
    annotationResponses.push({ url: new URL(route.request().url()), body })
    await route.fulfill({ response, json: body })
  })
  await page.addInitScript(() => localStorage.setItem('champion-fit-profile-accounts', JSON.stringify(['Alpha#EUW', 'Beta#EUW'])))
  const params = new URLSearchParams({ section: 'history', flag: 'all', days: 'all' })

  for (const reason of ['__proto__', 'constructor']) {
    importedReason = reason
    const beforeGoto = matchResponses.length
    await page.goto(`/app/matches?${params}`)
    await expect.poll(() => matchResponses.length).toBe(beforeGoto + 1)
    const row = page.getByRole('button', { name: /^Apri annotazione:/ }).filter({ has: page.locator('p').filter({ hasText: new RegExp(`^${reason}$`) }) })
    const expectReadable = async () => {
      const latest = matchResponses.at(-1)!
      await expect(page.getByRole('heading', { level: 1, name: 'Le mie partite', exact: true })).toBeVisible()
      await expect(row).toHaveCount(1)
      await expect(row.locator('p')).toHaveText(reason)
      await expect(row).toContainText(latest.original.account)
      await expect(row).toContainText(latest.original.champion)
      await expect(page.getByRole('button', { name: /^Apri annotazione:/ })).toHaveCount(latest.items)
      expect(latest.url.searchParams.getAll('account')).toEqual(['Alpha#EUW', 'Beta#EUW'])
      expect(latest.url.searchParams.get('flag')).toBe('all')
      expect(latest.url.searchParams.get('queue')).toBe('all')
      expect(latest.url.searchParams.get('days')).toBe('all')
      expect({ ...latest.displayed, reason: latest.original.reason }).toEqual(latest.original)
      expect(Object.fromEntries(new URL(page.url()).searchParams)).toEqual(Object.fromEntries(params))
      await expect(page.getByRole('alert')).toHaveCount(0)
    }
    await expectReadable()
    const beforeReload = matchResponses.length
    await page.reload()
    await expect.poll(() => matchResponses.length).toBe(beforeReload + 1)
    await expectReadable()

    const selected = matchResponses.at(-1)!.original
    const beforeAnnotation = annotationResponses.length
    await row.click()
    const drawer = page.getByRole('dialog', { name: 'Annotazione della partita', exact: true })
    await expect.poll(() => annotationResponses.length).toBe(beforeAnnotation + 1)
    const annotationReply = annotationResponses.at(-1)!
    const saved = annotationReply.body.item
    if (!saved) throw new Error('La partita selezionata deve avere la propria annotazione reale.')
    expect(annotationReply.url.searchParams.get('match_id')).toBe(selected.match_id)
    expect(saved.match_id).toBe(selected.match_id)
    expect(saved.note).toBe(selected.annotation_note)
    expect(annotationReply.body.revision).toBe(saved.updated_at)
    await expect(drawer.getByText(selected.match_id, { exact: true })).toBeVisible()
    await expect(drawer.getByRole('textbox', { name: 'Nota', exact: true })).toHaveValue(saved.note)
    await expect(drawer.getByRole('textbox', { name: 'Etichetta manuale', exact: true })).toHaveValue(saved.manual_label)
    await expect(drawer.getByRole('slider', { name: 'Sicurezza dell’annotazione', exact: true })).toHaveValue(String(saved.confidence))
    for (const [key, label] of [
      ['invincible', 'Partita impossibile da vincere'], ['carryable_loss', 'Sconfitta recuperabile'],
      ['afk_player', 'Giocatore inattivo (AFK) in squadra'], ['griefer', 'Giocatore che sabota'],
      ['team_collapse', 'Crollo della squadra'],
    ] as const) await expect(drawer.getByRole('checkbox', { name: label, exact: true })).toBeChecked({ checked: Boolean(saved[key]) })
    await drawer.getByRole('button', { name: 'Annulla', exact: true }).click()
    await expect(drawer).toHaveCount(0)
    await expectReadable()
  }
  expect(unexpectedWrites).toEqual([])
  expect(pageErrors).toEqual([])
  expect(reactWarnings).toEqual([])
})


test('anomalie importate: il motivo di ripiego resta leggibile e conserva l’annotazione reale @smoke', async ({ page }) => {
  test.setTimeout(60_000)
  const matchResponses: { url: URL; original: MatchDto; displayed: MatchDto; items: number }[] = []
  const annotationResponses: { url: URL; body: AnnotationResponseDto }[] = []
  const unexpectedWrites: string[] = []
  const pageErrors: string[] = []
  const reactWarnings: string[] = []
  const dialogs: string[] = []
  let importedFlag = 'constructor'
  page.on('pageerror', (error) => pageErrors.push(error.message))
  page.on('console', (message) => {
    if (['error', 'warning'].includes(message.type()) && /React child|Functions are not valid|Objects are not valid/.test(message.text())) reactWarnings.push(message.text())
  })
  page.on('dialog', async (dialog) => { dialogs.push(dialog.message()); await dialog.dismiss() })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.route('https://ddragon.leagueoflegends.com/**', (route) => route.abort())
  await page.route('**/api/**', (route) => {
    if (route.request().method() === 'GET') return route.fallback()
    unexpectedWrites.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`)
    return route.abort()
  })
  await page.route('**/api/matches?**', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    const response = await route.fetch()
    expect(response.status()).toBe(200)
    const body = await response.json() as { items: MatchDto[] }
    const originalBody = structuredClone(body)
    const index = body.items.findIndex((item) => item.annotation_note !== '')
    if (index < 0) throw new Error('La fixture reale deve contenere una partita con annotazione già salvata.')
    const original = structuredClone(body.items[index]!)
    // These two imported text fields are supported by separate ingest/HTTP
    // evidence. Preserve every other field and the complete real response;
    // current Riot/model generators are not assumed to emit these strings.
    body.items[index] = { ...original, reason: '', anomaly_flags: importedFlag }
    expect(body).toEqual({ ...originalBody,
      items: originalBody.items.map((item, itemIndex) => itemIndex === index ? { ...item, reason: '', anomaly_flags: importedFlag } : item),
    })
    matchResponses.push({ url: new URL(route.request().url()), original, displayed: body.items[index]!, items: body.items.length })
    await route.fulfill({ response, json: body })
  })
  await page.route('**/api/annotations?**', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    const response = await route.fetch()
    expect(response.status()).toBe(200)
    const body = await response.json() as AnnotationResponseDto
    annotationResponses.push({ url: new URL(route.request().url()), body })
    await route.fulfill({ response, json: body })
  })
  const accounts = ['Alpha#EUW', 'Beta#EUW']
  await page.addInitScript((selected) => localStorage.setItem('champion-fit-profile-accounts', JSON.stringify(selected)), accounts)
  const params = new URLSearchParams({ section: 'history', flag: 'all', queue: 'all', days: 'all' })

  for (const [flag, readable] of [['constructor', 'constructor'], ['__proto__', 'proto']] as const) {
    importedFlag = flag
    const beforeGoto = matchResponses.length
    await page.goto(`/app/matches?${params}`)
    await expect.poll(() => matchResponses.length).toBe(beforeGoto + 1)
    await expect(page.getByRole('heading', { level: 1, name: 'Le mie partite', exact: true })).toBeVisible()
    const beforeReload = matchResponses.length
    await page.reload()
    await expect.poll(() => matchResponses.length).toBe(beforeReload + 1)
    const row = page.getByRole('button', { name: /^Apri annotazione:/ }).filter({ has: page.locator('p').filter({ hasText: readable }) })
    const expectReadable = async () => {
      const latest = matchResponses.at(-1)!
      await expect(page.getByRole('heading', { level: 1, name: 'Le mie partite', exact: true })).toBeVisible()
      await expect(row).toHaveCount(1)
      // Existing unknown-flag policy replaces underscores with spaces; the
      // DOM text assertion normalizes surrounding whitespace for __proto__.
      await expect(row.locator('p')).toHaveText(readable)
      await expect(row).toHaveAttribute('aria-label', new RegExp(`Motivo:\\s*${readable}\\s*\\.`))
      const accessible = await row.getAttribute('aria-label')
      expect(accessible).toContain(readable)
      expect(accessible).not.toMatch(/function Object|\[object Object\]|native code|__proto__/)
      await expect(row).toContainText(latest.original.account)
      await expect(row).toContainText(latest.original.champion)
      await expect(page.getByRole('button', { name: /^Apri annotazione:/ })).toHaveCount(latest.items)
      expect(latest.url.searchParams.getAll('account')).toEqual(accounts)
      expect(latest.url.searchParams.get('flag')).toBe('all')
      expect(latest.url.searchParams.get('queue')).toBe('all')
      expect(latest.url.searchParams.get('days')).toBe('all')
      expect(latest.displayed.reason).toBe('')
      expect(latest.displayed.anomaly_flags).toBe(flag)
      expect({ ...latest.displayed, reason: latest.original.reason, anomaly_flags: latest.original.anomaly_flags }).toEqual(latest.original)
      expect([...new URL(page.url()).searchParams]).toEqual([...params])
      expect(await page.evaluate(() => JSON.parse(localStorage.getItem('champion-fit-profile-accounts') ?? 'null'))).toEqual(accounts)
      await expect(page.getByRole('alert')).toHaveCount(0)
    }
    await expectReadable()

    const selected = matchResponses.at(-1)!.original
    const beforeAnnotation = annotationResponses.length
    await row.click()
    const drawer = page.getByRole('dialog', { name: 'Annotazione della partita', exact: true })
    await expect.poll(() => annotationResponses.length).toBe(beforeAnnotation + 1)
    const annotationReply = annotationResponses.at(-1)!
    const saved = annotationReply.body.item
    if (!saved) throw new Error('La partita selezionata deve avere la propria annotazione reale.')
    expect(annotationReply.url.searchParams.get('match_id')).toBe(selected.match_id)
    expect(saved.match_id).toBe(selected.match_id)
    expect(saved.note).toBe(selected.annotation_note)
    expect(saved.manual_label).toBe(selected.annotation_manual_label)
    expect(saved.confidence).toBe(selected.annotation_confidence)
    expect(annotationReply.body.revision).toBeTruthy()
    expect(annotationReply.body.revision).toBe(saved.updated_at)
    await expect(drawer.getByText(selected.match_id, { exact: true })).toBeVisible()
    await expect(drawer.getByRole('textbox', { name: 'Nota', exact: true })).toHaveValue(saved.note)
    await expect(drawer.getByRole('textbox', { name: 'Etichetta manuale', exact: true })).toHaveValue(saved.manual_label)
    await expect(drawer.getByRole('slider', { name: 'Sicurezza dell’annotazione', exact: true })).toHaveValue(String(saved.confidence))
    for (const [key, label] of [
      ['invincible', 'Partita impossibile da vincere'], ['carryable_loss', 'Sconfitta recuperabile'],
      ['afk_player', 'Giocatore inattivo (AFK) in squadra'], ['griefer', 'Giocatore che sabota'],
      ['team_collapse', 'Crollo della squadra'],
    ] as const) {
      expect(saved[key]).toBe(selected[`annotation_${key}`])
      await expect(drawer.getByRole('checkbox', { name: label, exact: true })).toBeChecked({ checked: Boolean(saved[key]) })
    }
    await drawer.getByRole('button', { name: 'Annulla', exact: true }).click()
    await expect(drawer).toHaveCount(0)
    await expectReadable()
  }
  expect(unexpectedWrites).toEqual([])
  expect(pageErrors).toEqual([])
  expect(reactWarnings).toEqual([])
  expect(dialogs).toEqual([])
})


test('messaggi API: un errore sconosciuto resta leggibile e Riprova recupera i dati nello stesso contesto @smoke', async ({ page }) => {
  test.setTimeout(60_000)
  const matchRequests: { url: URL; status: number; error: string | null }[] = []
  const recovered: { url: URL; body: { items: MatchDto[] } }[] = []
  const unexpectedWrites: string[] = []
  const pageErrors: string[] = []
  const reactWarnings: string[] = []
  const dialogs: string[] = []
  let errorMessage = 'constructor'
  let recover = false
  page.on('pageerror', (error) => pageErrors.push(error.message))
  page.on('console', (message) => {
    if (['error', 'warning'].includes(message.type()) && /React child|Functions are not valid|Objects are not valid/.test(message.text())) reactWarnings.push(message.text())
  })
  page.on('dialog', async (dialog) => { dialogs.push(dialog.message()); await dialog.dismiss() })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.route('https://ddragon.leagueoflegends.com/**', (route) => route.abort())
  await page.route('**/api/**', (route) => {
    if (route.request().method() === 'GET') return route.fallback()
    unexpectedWrites.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`)
    return route.abort()
  })
  await page.route('**/api/matches?**', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    const url = new URL(route.request().url())
    if (!recover) {
      // Exercise an accepted client error envelope. This does not claim that
      // the current first-party server naturally emits either message.
      matchRequests.push({ url, status: 400, error: errorMessage })
      await route.fulfill({ status: 400, json: { error: errorMessage } })
      return
    }
    const response = await route.fetch()
    expect(response.status()).toBe(200)
    const body = await response.json() as { items: MatchDto[] }
    expect(body.items.length).toBeGreaterThan(0)
    matchRequests.push({ url, status: response.status(), error: null })
    recovered.push({ url, body })
    // Recovery keeps the complete actual response, including every row and
    // all scope/revision/context fields. No result data is emulated.
    await route.fulfill({ response, json: body })
  })
  const accounts = ['Alpha#EUW', 'Beta#EUW']
  await page.addInitScript((selected) => localStorage.setItem('champion-fit-profile-accounts', JSON.stringify(selected)), accounts)
  const rawSearch = '?section=history&flag=all&queue=all&days=all&search=Owned%20error%2Fcontext'
  const assertContext = async (url: URL) => {
    expect(url.searchParams.getAll('account')).toEqual(accounts)
    expect(url.searchParams.get('queue')).toBe('all')
    expect(url.searchParams.get('days')).toBe('all')
    expect(url.searchParams.get('role')).toBe('ALL')
    expect(url.searchParams.get('flag')).toBe('all')
    expect(url.searchParams.get('limit')).toBe('24')
    expect(url.searchParams.get('algorithm_revision')).toMatch(/^\d+$/)
    expect(new URL(page.url()).search).toBe(rawSearch)
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('champion-fit-profile-accounts') ?? 'null'))).toEqual(accounts)
  }

  for (const message of ['constructor', '__proto__']) {
    errorMessage = message
    recover = false
    const beforeGoto = matchRequests.length
    await page.goto(`/app/matches${rawSearch}`)
    const alert = page.getByRole('alert')
    await expect(alert).toBeVisible()
    // A settled 400 appears after exactly one attempt; no timing sleep is
    // needed to distinguish it from an automatically retried request.
    expect(matchRequests).toHaveLength(beforeGoto + 1)
    expect(matchRequests.at(-1)).toEqual({ url: expect.any(URL), status: 400, error: message })
    await page.reload()
    await expect(alert).toBeVisible()
    expect(matchRequests).toHaveLength(beforeGoto + 2)
    await expect(page.getByRole('heading', { level: 1, name: 'Le mie partite', exact: true })).toBeVisible()
    await expect(alert.getByRole('heading', { name: 'Impossibile caricare i dati', exact: true })).toBeVisible()
    await expect(alert.locator('p')).toHaveText(message)
    await expect(alert).not.toContainText(/function Object|\[object Object\]|native code/)
    await expect(page.getByRole('button', { name: /^Apri annotazione:/ })).toHaveCount(0)
    await assertContext(matchRequests.at(-1)!.url)
    expect(matchRequests.slice(beforeGoto).map(({ status, error }) => [status, error])).toEqual([
      [400, message], [400, message],
    ])

    const failedUrl = matchRequests.at(-1)!.url
    const beforeRecovery = recovered.length
    recover = true
    await alert.getByRole('button', { name: 'Riprova', exact: true }).click()
    await expect.poll(() => recovered.length).toBe(beforeRecovery + 1)
    const success = recovered.at(-1)!
    await expect(alert).toHaveCount(0)
    const rows = page.getByRole('button', { name: /^Apri annotazione:/ })
    await expect(rows).toHaveCount(success.body.items.length)
    await expect(rows.first()).toContainText(success.body.items[0]!.champion)
    await expect(rows.first()).toContainText(success.body.items[0]!.account)
    expect(matchRequests).toHaveLength(beforeGoto + 3)
    expect(matchRequests.at(-1)).toEqual({ url: success.url, status: 200, error: null })
    expect(success.url.href).toBe(failedUrl.href)
    await assertContext(success.url)
  }
  expect(matchRequests.map(({ status }) => status)).toEqual([400, 400, 200, 400, 400, 200])
  expect(recovered).toHaveLength(2)
  expect(unexpectedWrites).toEqual([])
  expect(pageErrors).toEqual([])
  expect(reactWarnings).toEqual([])
  expect(dialogs).toEqual([])
})


test('motivi lunghi: il testo importato resta leggibile senza scorrimento orizzontale @smoke', async ({ page }) => {
  test.setTimeout(90_000)
  const longReason = 'L'.repeat(1000)
  const matches: { url: URL; original: MatchDto; displayed: MatchDto; items: number }[] = []
  const annotations: { url: URL; body: AnnotationResponseDto }[] = []
  const writes: string[] = []
  const errors: string[] = []
  const dialogs: string[] = []
  let reason = 'Imported normalized match'
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('dialog', async (dialog) => { dialogs.push(dialog.message()); await dialog.dismiss() })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.route('https://ddragon.leagueoflegends.com/**', (route) => route.abort())
  await page.route('**/api/**', (route) => {
    if (route.request().method() === 'GET') return route.fallback()
    writes.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`)
    return route.abort()
  })
  await page.route('**/api/matches?**', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    const response = await route.fetch()
    expect(response.status()).toBe(200)
    const body = await response.json() as { items: MatchDto[] }
    const original = structuredClone(body)
    const index = body.items.findIndex((item) => item.annotation_note !== '' && item.annotation_manual_label !== '')
    if (index < 0) throw new Error('La fixture deve contenere una partita con nota ed etichetta reali già salvate.')
    // Separate public-ingest/HTTP evidence establishes this supported imported
    // token. Change only reason and retain every other real DTO/body field.
    body.items[index] = { ...body.items[index]!, reason }
    expect(body).toEqual({ ...original,
      items: original.items.map((item, position) => position === index ? { ...item, reason } : item),
    })
    matches.push({ url: new URL(route.request().url()), original: original.items[index]!, displayed: body.items[index]!, items: body.items.length })
    await route.fulfill({ response, json: body })
  })
  await page.route('**/api/annotations?**', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    const response = await route.fetch()
    expect(response.status()).toBe(200)
    const body = await response.json() as AnnotationResponseDto
    annotations.push({ url: new URL(route.request().url()), body })
    await route.fulfill({ response, json: body })
  })
  const accounts = ['Alpha#EUW', 'Beta#EUW']
  await page.addInitScript((selected) => localStorage.setItem('champion-fit-profile-accounts', JSON.stringify(selected)), accounts)
  const rawSearch = '?section=history&flag=all&queue=all&days=all&search=Owned%20responsive%2Fcontext'

  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 })
    for (const long of [false, true]) {
      reason = long ? longReason : 'Imported normalized match'
      const expected = long ? longReason : 'Partita importata da dati normalizzati.'
      const contextLabel = `${width}px/${long ? 'long' : 'normal'}`
      const beforeGoto = matches.length
      await page.goto(`/app/matches${rawSearch}`)
      await expect(page.getByRole('heading', { level: 1, name: 'Le mie partite', exact: true })).toBeVisible()
      await expect.poll(() => matches.length).toBe(beforeGoto + 1)
      await page.reload()
      await expect(page.getByRole('heading', { level: 1, name: 'Le mie partite', exact: true })).toBeVisible()
      await expect.poll(() => matches.length).toBe(beforeGoto + 2)
      const row = page.locator('.audit-list article > button').filter({ has: page.locator('p').filter({ hasText: expected }) })
      await expect(row).toHaveCount(1)
      await expect(row.locator('p')).toHaveText(expected)
      expect(await row.locator('p').textContent()).toBe(expected)
      expect(await row.getAttribute('aria-label')).toContain(`Motivo: ${expected}.`)
      await row.scrollIntoViewIfNeeded()
      await page.evaluate(async () => {
        await document.fonts.ready
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      })
      const geometry = await row.locator('p').evaluate((paragraph) => {
        const box = paragraph.getBoundingClientRect()
        const range = document.createRange()
        range.selectNodeContents(paragraph)
        const text = range.getBoundingClientRect()
        return {
          documentClient: document.documentElement.clientWidth, documentScroll: document.documentElement.scrollWidth,
          bodyClient: document.body.clientWidth, bodyScroll: document.body.scrollWidth,
          paragraphClient: paragraph.clientWidth, paragraphScroll: paragraph.scrollWidth,
          paragraphLeft: box.left, paragraphRight: box.right, textLeft: text.left, textRight: text.right,
        }
      })
      // Soft geometry assertions preserve the causal six-case matrix on the
      // old CSS and still exercise all three real annotation reads below.
      expect.soft(geometry.documentScroll, `${contextLabel}: document width`).toBeLessThanOrEqual(geometry.documentClient + 1)
      expect.soft(geometry.bodyScroll, `${contextLabel}: body width`).toBeLessThanOrEqual(geometry.bodyClient + 1)
      expect.soft(geometry.paragraphScroll, `${contextLabel}: paragraph width`).toBeLessThanOrEqual(geometry.paragraphClient + 1)
      expect.soft(geometry.textLeft, `${contextLabel}: text left edge`).toBeGreaterThanOrEqual(geometry.paragraphLeft - 1)
      expect.soft(geometry.textRight, `${contextLabel}: text right edge`).toBeLessThanOrEqual(geometry.paragraphRight + 1)
      expect.soft(geometry.textRight, `${contextLabel}: viewport right edge`).toBeLessThanOrEqual(geometry.documentClient + 1)

      const reply = matches.at(-1)!
      expect(reply.url.searchParams.getAll('account')).toEqual(accounts)
      expect(reply.url.searchParams.get('queue')).toBe('all')
      expect(reply.url.searchParams.get('days')).toBe('all')
      expect(reply.url.searchParams.get('flag')).toBe('all')
      expect({ ...reply.displayed, reason: reply.original.reason }).toEqual(reply.original)
      expect(new URL(page.url()).search).toBe(rawSearch)
      expect(await page.evaluate(() => JSON.parse(localStorage.getItem('champion-fit-profile-accounts') ?? 'null'))).toEqual(accounts)
      await expect(page.getByRole('alert')).toHaveCount(0)
      if (long) {
        const beforeAnnotation = annotations.length
        await row.click({ position: { x: 20, y: 20 } })
        const drawer = page.getByRole('dialog', { name: 'Annotazione della partita', exact: true })
        await expect.poll(() => annotations.length).toBe(beforeAnnotation + 1)
        const annotationReply = annotations.at(-1)!
        const saved = annotationReply.body.item
        if (!saved) throw new Error('La partita selezionata deve avere la propria annotazione reale.')
        expect(annotationReply.url.searchParams.get('match_id')).toBe(reply.original.match_id)
        expect(saved.match_id).toBe(reply.original.match_id)
        expect(saved.note).toBe(reply.original.annotation_note)
        expect(saved.manual_label).toBe(reply.original.annotation_manual_label)
        expect(saved.confidence).toBe(reply.original.annotation_confidence)
        expect(annotationReply.body.revision).toBe(saved.updated_at)
        await expect(drawer.getByRole('textbox', { name: 'Nota', exact: true })).toHaveValue(saved.note)
        await expect(drawer.getByRole('textbox', { name: 'Etichetta manuale', exact: true })).toHaveValue(saved.manual_label)
        await expect(drawer.getByRole('slider', { name: 'Sicurezza dell’annotazione', exact: true })).toHaveValue(String(saved.confidence))
        for (const [key, label] of [
          ['invincible', 'Partita impossibile da vincere'], ['carryable_loss', 'Sconfitta recuperabile'],
          ['afk_player', 'Giocatore inattivo (AFK) in squadra'], ['griefer', 'Giocatore che sabota'],
          ['team_collapse', 'Crollo della squadra'],
        ] as const) await expect(drawer.getByRole('checkbox', { name: label, exact: true })).toBeChecked({ checked: Boolean(saved[key]) })
        await drawer.getByRole('button', { name: 'Annulla', exact: true }).click()
        await expect(drawer).toHaveCount(0)
        expect(new URL(page.url()).search).toBe(rawSearch)
      }
    }
  }
  expect(matches).toHaveLength(12)
  expect(annotations).toHaveLength(3)
  expect(writes).toEqual([])
  expect(errors).toEqual([])
  expect(dialogs).toEqual([])
})

test('identificatori GET: errore leggibile e recupero del profilo salvato @smoke', async ({ page }, testInfo) => {
  test.setTimeout(60_000)
  const origin = new URL(String(testInfo.project.use.baseURL)).origin
  const badAccount = 'Bad\u0000#EUW'
  const badAccounts = ['Alpha#EUW', badAccount]
  const validAccounts = ['Alpha#EUW', 'Beta#EUW']
  const accountError = 'Il filtro account contiene un carattere non valido'
  const writes: string[] = [], errors: string[] = [], dialogs: string[] = [], externalAborted: string[] = []
  const replies: Array<{ path: string; status: number; body: Record<string, unknown> }> = []
  const pending: Array<Promise<void>> = []
  const stages: Array<Record<string, unknown>> = []
  const directGETs: Array<Record<string, unknown>> = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('dialog', async (dialog) => { dialogs.push(dialog.message()); await dialog.dismiss() })
  page.on('response', (response) => {
    const url = new URL(response.url())
    if (url.origin === origin && ['/api/matches', '/api/profile', '/api/annotations'].includes(url.pathname)) {
      pending.push(response.json().then((body) => { replies.push({ path: url.pathname + url.search, status: response.status(), body }) }))
    }
  })
  // Requests and response bodies use the owned fixture server unchanged.
  await page.route('**/*', (route) => {
    const request = route.request(), url = new URL(request.url())
    if (url.origin !== origin) { externalAborted.push(url.href); return route.abort() }
    if (request.method() !== 'GET') { writes.push(`${request.method()} ${url.pathname}`); return route.abort() }
    return route.fallback()
  })
  await page.addInitScript(({ badAccounts, validAccounts }) => {
    // Seed only the initial saved state; later full reloads must retain UI recovery.
    if (localStorage.getItem('champion-fit-profile-accounts') === null) {
      localStorage.setItem('champion-fit-profile-accounts', JSON.stringify(badAccounts))
      localStorage.setItem('champion-fit-profile-groups', JSON.stringify({ 'Profilo valido GET': validAccounts }))
    }
  }, { badAccounts, validAccounts })
  const scopedReplies = () => replies.filter((reply) => ['/api/matches', '/api/profile'].includes(new URL(reply.path, origin).pathname))
  try {
    for (const refresh of ['goto', 'reload'] as const) {
      const before = scopedReplies().length
      if (refresh === 'goto') await page.goto('/app/matches?section=history&flag=all')
      else await page.reload()
      await expect(page.getByRole('heading', { level: 1, name: 'Le mie partite', exact: true })).toBeVisible()
      await expect.poll(() => scopedReplies().length).toBe(before + 2)
      const current = scopedReplies().slice(before)
      const statuses = Object.fromEntries(current.map((reply) => [new URL(reply.path, origin).pathname, reply.status]))
      expect.soft(statuses, `${refresh}: the saved NUL account must fail before SQL`).toEqual({ '/api/matches': 400, '/api/profile': 400 })
      // Observe the received state first, so the BEFORE200 run can continue to recovery.
      if (current.some((reply) => reply.status === 400)) await expect(page.getByRole('alert').first()).toBeVisible()
      else await expect(page.locator('.audit-list article').first()).toBeVisible()
      const visibleErrors = await page.getByText(accountError, { exact: true }).count()
      expect.soft(visibleErrors, `${refresh}: show the actionable API error`).toBeGreaterThan(0)
      for (const reply of current) expect(new URL(reply.path, origin).searchParams.getAll('account')).toEqual(badAccounts)
      expect(await page.evaluate(() => JSON.parse(localStorage.getItem('champion-fit-profile-accounts') ?? 'null'))).toEqual(badAccounts)
      stages.push({ refresh, saved_accounts: badAccounts, statuses, visible_account_errors: visibleErrors, replies: current })
    }
    await page.getByRole('link', { name: /Apri Dati usati|^Dati$/ }).click()
    await expect(page.getByRole('heading', { level: 1, name: 'Dati usati', exact: true })).toBeVisible()
    await page.getByRole('button', { name: /^Profilo valido GET/ }).click()
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('champion-fit-profile-accounts') ?? 'null'))).toEqual(validAccounts)
    const beforeRecovery = scopedReplies().length
    const matchesLink = page.getByRole('link', { name: 'Le mie partite', exact: true })
    if (!await matchesLink.isVisible()) await page.getByRole('button', { name: 'Apri il menu', exact: true }).click()
    await matchesLink.click()
    await expect(page.getByRole('heading', { level: 1, name: 'Le mie partite', exact: true })).toBeVisible()
    await expect.poll(() => scopedReplies().length).toBe(beforeRecovery + 2)
    await expect(page.locator('.audit-list article').first()).toBeVisible()
    await expect(page.getByRole('alert')).toHaveCount(0)
    const beforeReload = scopedReplies().length
    await page.reload()
    await expect(page.getByRole('heading', { level: 1, name: 'Le mie partite', exact: true })).toBeVisible()
    await expect.poll(() => scopedReplies().length).toBe(beforeReload + 2)
    await expect(page.locator('.audit-list article').first()).toBeVisible()
    await expect(page.getByRole('alert')).toHaveCount(0)
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('champion-fit-profile-accounts') ?? 'null'))).toEqual(validAccounts)
    const recovered = scopedReplies().slice(beforeRecovery)
    for (const reply of recovered) {
      expect(reply.status).toBe(200)
      expect(new URL(reply.path, origin).searchParams.getAll('account')).toEqual(validAccounts)
    }
    stages.push({ stage: 'UI profile recovery and full reload', saved_accounts: validAccounts, replies: recovered })
    const matchesReply = [...recovered].reverse().find((reply) => new URL(reply.path, origin).pathname === '/api/matches')!
    const items = matchesReply.body.items as MatchDto[]
    const index = items.findIndex((item) => item.annotation_note !== '' && item.annotation_manual_label !== '')
    expect(index).toBeGreaterThanOrEqual(0)
    const selected = items[index]!
    const annotationResponse = page.waitForResponse((response) => {
      const url = new URL(response.url())
      return url.origin === origin && url.pathname === '/api/annotations' && url.searchParams.get('match_id') === selected.match_id
    })
    await page.locator('.audit-list article > button').nth(index).click()
    const received = await annotationResponse
    expect(received.status()).toBe(200)
    const annotationBody = await received.json() as AnnotationResponseDto
    const saved = annotationBody.item
    if (!saved) throw new Error('The real selected fixture match must have a saved annotation.')
    expect(saved.match_id).toBe(selected.match_id)
    expect(saved.note).toBe(selected.annotation_note)
    expect(saved.manual_label).toBe(selected.annotation_manual_label)
    expect(annotationBody.revision).toBe(saved.updated_at)
    const drawer = page.getByRole('dialog', { name: 'Annotazione della partita', exact: true })
    await expect(drawer.getByRole('textbox', { name: 'Nota', exact: true })).toHaveValue(saved.note)
    await expect(drawer.getByRole('textbox', { name: 'Etichetta manuale', exact: true })).toHaveValue(saved.manual_label)
    await drawer.getByRole('button', { name: 'Annulla', exact: true }).click()
    await expect(drawer).toHaveCount(0)
    // This is a deliberately malformed GET identifier, not a naturally imported ID.
    const invalidURL = new URL('/api/annotations', origin)
    invalidURL.searchParams.set('match_id', selected.match_id + '\u0000')
    const invalid = await page.request.get(invalidURL.href)
    const invalidBody = await invalid.json() as Record<string, unknown>
    directGETs.push({ path: invalidURL.pathname + invalidURL.search, status: invalid.status(), body: invalidBody, synthetic_malformed_identifier: true })
    expect.soft({ status: invalid.status(), body: invalidBody }, 'NUL match_id GET must be rejected consistently').toEqual({ status: 400, body: { error: 'Identificativo della partita non valido' } })
    const validURL = new URL('/api/annotations', origin)
    validURL.searchParams.set('match_id', selected.match_id)
    const valid = await page.request.get(validURL.href)
    const validBody = await valid.json() as AnnotationResponseDto
    directGETs.push({ path: validURL.pathname + validURL.search, status: valid.status(), body: validBody })
    expect(valid.status()).toBe(200)
    expect(validBody).toEqual(annotationBody)
    expect(writes).toEqual([])
    expect(errors).toEqual([])
    expect(dialogs).toEqual([])
  } finally {
    await Promise.all(pending)
    await testInfo.attach('get-text-nul-cases.json', { body: Buffer.from(JSON.stringify({ stages, directGETs, replies, writes, errors, dialogs,
      external_assets_aborted: externalAborted.length, API_payload_emulation: false }, null, 2)), contentType: 'application/json' })
  }
})
