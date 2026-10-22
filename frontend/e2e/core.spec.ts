import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Locator } from '@playwright/test'

test('@smoke overview risponde ed è navigabile da tastiera', async ({ page, browserName }) => {
  await page.goto('/app/overview')
  await expect(page.getByRole('heading', { level: 1, name: 'Riepilogo' })).toBeVisible()
  if (browserName !== 'webkit') {
    await page.keyboard.press('Tab')
    await expect(page.getByRole('link', { name: 'Vai al contenuto' })).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page.locator('#main-content')).toBeFocused()
  }
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()
  expect(results.violations.filter((item) => ['critical', 'serious'].includes(item.impact ?? ''))).toEqual([])
})

test('il riepilogo presenta le analisi competitive e gli accessi ai dati', async ({ page }) => {
  await page.goto('/app/overview')
  const analyses = page.locator('.overview-workspace')
  const analysisDestinations = [
    ['Confronta i campioni', 'best'],
    ['Apri il piano', 'tournament'],
  ] as const
  for (const [name, route] of analysisDestinations) {
    const link = analyses.getByRole('link', { name, exact: true })
    await expect(link).toBeVisible()
    const target = new URL((await link.getAttribute('href'))!, page.url())
    expect(target.pathname).toBe('/app/fit')
    expect(target.searchParams.get('section')).toBe(route)
  }
  const dataAccess = page
  const dataDestinations = [
    ['Dati usati', '/app/profile'],
    ['Riparti dalle tue partite Consulta gli esiti e le annotazioni nello storico.', '/app/matches'],
    ['Compagni', '/app/team/friends'],
  ] as const
  for (const [name, route] of dataDestinations) {
    await expect(dataAccess.getByRole('link', { name, exact: true })).toHaveAttribute('href', route)
  }
  await expect(page.getByRole('region', { name: 'Rendimento storico dei campioni' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Un piano per fare chiarezza.' })).toBeVisible()
})

test('errore preferenze resta isolato dalla navigazione principale', async ({ page }) => {
  await page.route('**/api/recommendations*', async (route) => route.fulfill({
    status: 503,
    contentType: 'application/json',
    body: JSON.stringify({ error: 'overview fixture offline' }),
  }))

  await page.goto('/app/fit?section=choices')
  await expect(page.getByRole('heading', { name: 'Suggerimenti non disponibili' })).toBeVisible()
  await expect(page.getByRole('alert')).toContainText('overview fixture offline')
  await expect(page.getByRole('navigation', { name: 'Navigazione principale' }).getByRole('link')).toHaveCount(5)
})

test('errore account blocca ogni query scoped e il retry riparte con account espliciti', async ({ page }) => {
  let accountsFail = true
  const scopedRequests: string[] = []
  page.on('request', (request) => {
    if (/\/api\/(overview|profile|plan|matchups|blacklist|champions|screen|friends|synergy|matches|recommendations)/.test(request.url())) {
      scopedRequests.push(request.url())
    }
  })
  await page.route('**/api/accounts', async (route) => {
    if (accountsFail) {
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'account fixture offline' }) })
    } else {
      await route.continue()
    }
  })

  await page.goto('/app/overview')
  await expect(page.getByRole('heading', { name: 'Impossibile verificare gli account' })).toBeVisible()
  expect(scopedRequests).toEqual([])

  accountsFail = false
  await page.locator('#main-content').getByRole('button', { name: 'Riprova' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Riepilogo' })).toBeVisible()
  await page.getByRole('link', { name: 'Confronta i campioni', exact: true }).click()
  await expect(page).toHaveURL(/\/app\/fit\?section=best/)
  await expect.poll(() => scopedRequests.length).toBeGreaterThan(0)
  expect(scopedRequests.every((url) => new URL(url).searchParams.getAll('account').length > 0)).toBe(true)
})

test('cambio account persistente su più viste', async ({ page }) => {
  await page.goto('/app/profile')
  const beta = page.getByRole('button', { name: /Beta#EUW/ })
  await expect(beta).toHaveAttribute('aria-pressed', 'true')
  await beta.click()
  await expect(beta).toHaveAttribute('aria-pressed', 'false')
  await expect(page.locator('.scope-bar').getByText('1 account attivi', { exact: true })).toBeVisible()
  await page.getByRole('link', { name: 'Campioni', exact: true }).click()
  await expect(page).toHaveURL(/\/app\/fit/)
  await page.reload()
  await expect(page.getByText('1 account attivi')).toBeVisible()
})

test('Fit usa query string e mostra filtri senza risultati', async ({ page }) => {
  await page.goto('/app/fit?section=choices')
  await expect(page.getByText('Contesto dei suggerimenti', { exact: true })).toBeVisible()
  await page.getByRole('combobox', { name: 'Ruolo', exact: true }).selectOption('MIDDLE')
  await page.getByLabel('Cerca', { exact: true }).fill('Ahri')
  await expect(page).toHaveURL(/role=MIDDLE/)
  await expect(page).toHaveURL(/search=Ahri/)
  await expect(page.locator('.recommendation-card')).toHaveCount(1)
  await expect(page.locator('.recommendation-card').getByText('Ahri', { exact: true })).toBeVisible()
  await page.getByLabel('Cerca', { exact: true }).fill('NonEsiste')
  await expect(page.getByRole('heading', { name: 'Nessuna scelta già giocata o dichiarata' })).toBeVisible()
})

test('una preferenza dichiarata non sostituisce i risultati osservati', async ({ page }) => {
  await page.route('**/api/recommendations?**', async (route) => {
    const response = await route.fetch()
    const body = await response.json() as { known: Array<Record<string, unknown>> }
    body.known = body.known.map((item) => ({ ...item, feedback: 'like' }))
    await route.fulfill({ response, json: body })
  })

  await page.goto('/app/fit?section=choices')
  const card = page.locator('.observed-recommendation').first()
  await expect(card.getByText('Media degli account esposti', { exact: true })).toBeVisible()
  await expect(card).toContainText(/partite uniche/)
  await expect(card).toContainText('Preferenza dichiarata')
  await expect(card).toContainText('Attuale: Mi piace.')
  await expect(card).toContainText('Modifica l’ordine dei suggerimenti, non i risultati osservati.')
})

test('un matchup esplorativo non diventa un ban consigliato', async ({ page }) => {
  await page.route('**/api/matchups*', async (route) => {
    const response = await route.fetch()
    const body = await response.json()
    body.loses_to = [{
      champion: 'Zed', icon_url: '', games: 2, wins_against: 0, losses_to: 2,
      win_rate_against: 0, positive_evidence: 0, negative_evidence: 2, effective_evidence: 2,
      effective_sample_size: 2, personal_effective_sample_size: 2, weighted_win_rate_against: 0,
      posterior_win_rate: 42, posterior_lift_pp: -6, relative_delta_pp: -6,
      baseline_win_rate: 48, credible_lower_90: 25, credible_upper_90: 60,
      probability_worse_than_baseline: 72, probability_meaningful_advantage: 10,
      probability_meaningful_disadvantage: 62, direction_confidence: 44,
      direction_probability: 72, quality_coverage: 100, recent_90d_games: 2,
      exposure_rate: 20, matchup_score: 12, reliability: 'exploratory', actionable: false,
      prior_source: 'global', prior_games: 30, recommendation: 'loses_to',
    }]
    await route.fulfill({ response, json: body })
  })

  await page.goto('/app/fit?section=matchups&relation=enemies')
  await expect(page.getByRole('heading', { name: 'Nessun consiglio solido su chi bannare' })).toBeVisible()
  await expect(page.getByText(/Osserva Zed/)).toBeVisible()
  await expect(page.getByText('#1 ban consigliato')).toHaveCount(0)
})

test('il piano applica ruolo, coda e periodo espliciti', async ({ page }) => {
  const requests: URL[] = []
  await page.route('**/api/recommendations?**', async (route) => {
    requests.push(new URL(route.request().url()))
    await route.continue()
  })

  await page.goto('/app/fit?section=training&training=plan&role=MIDDLE&queue=420&days=90')
  await expect(page.getByRole('heading', { name: /prove, una partita ciascuna$/i })).toBeVisible()
  await expect(page.locator('.filter-count')).toHaveText('Classificata · Solo/Duo · ultimi 90 giorni')
  const request = requests.find((item) => item.searchParams.get('role') === 'MIDDLE')
  expect(request?.searchParams.get('queue')).toBe('420')
  expect(request?.searchParams.get('days')).toBe('90')
})

test('quando cambia il ruolo, i confronti del filtro precedente spariscono durante il caricamento', async ({ page }) => {
  let releaseRequest: (() => void) | undefined
  await page.route('**/api/matchups?**', async (route) => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('role') === 'ALL') {
      const response = await route.fetch()
      const body = await response.json()
      Object.assign(body, { games: 0, wins: 0, win_rate: 0, games_with_opponents: 0, loses_to: [], beats: [] })
      await route.fulfill({ response, json: body })
      return
    }
    if (url.searchParams.get('role') === 'MIDDLE') {
      await new Promise<void>((resolve) => { releaseRequest = resolve })
    }
    await route.continue()
  })

  await page.goto('/app/fit?section=matchups&relation=enemies')
  await expect(page.getByRole('heading', { name: 'Nessun confronto nei dati selezionati' })).toBeVisible()
  await page.getByRole('combobox', { name: 'Ruolo', exact: true }).selectOption('MIDDLE')
  await expect(page.getByRole('heading', { name: 'Nessun confronto nei dati selezionati' })).toHaveCount(0)
  await expect(page.locator('.skeleton')).toBeVisible()

  expect(releaseRequest).toBeDefined()
  releaseRequest?.()
  await expect(page.locator('.skeleton')).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Avversari e ban' })).toBeVisible()
  await expect(page.getByText(/filtro precedente/i)).toHaveCount(0)
})
test('annotation mutation invia tutti i campi e mostra successo', async ({ page }) => {
  const originalResponse = await page.request.get('/api/annotations?match_id=EUW1-002')
  const { item: original } = await originalResponse.json()
  try {
    await page.goto('/app/matches?flag=all')
    await page.getByRole('button', { name: /^Apri annotazione: .* con Ahri,/ }).first().click()
    const drawer = page.getByRole('dialog', { name: 'Annotazione della partita' })
    await drawer.getByLabel('Partita impossibile da vincere').check()
    await drawer.getByLabel('Etichetta manuale').fill('review e2e')
    await drawer.getByLabel('Nota', { exact: true }).fill('Annotazione completa dal test.')
    const requestPromise = page.waitForRequest((request) => request.url().endsWith('/api/annotations') && request.method() === 'POST')
    await drawer.getByRole('button', { name: 'Salva annotazione' }).click()
    const request = await requestPromise
    expect(request.postDataJSON()).toEqual(expect.objectContaining({
      match_id: expect.any(String), invincible: true, carryable_loss: expect.any(Boolean), afk_player: expect.any(Boolean),
      griefer: expect.any(Boolean), team_collapse: expect.any(Boolean), manual_label: 'review e2e',
      note: 'Annotazione completa dal test.', confidence: expect.any(Number), expected_revision: null,
    }))
    await expect(page.getByText('Annotazione salvata', { exact: true })).toBeVisible()
  } finally {
    const currentResponse = await page.request.get('/api/annotations?match_id=EUW1-002')
    const { revision: currentRevision } = await currentResponse.json()
    const restored = await page.request.post('/api/annotations', {
      data: {
        match_id: original.match_id,
        invincible: Boolean(original.invincible),
        carryable_loss: Boolean(original.carryable_loss),
        afk_player: Boolean(original.afk_player),
        griefer: Boolean(original.griefer),
        team_collapse: Boolean(original.team_collapse),
        manual_label: original.manual_label,
        note: original.note,
        confidence: original.confidence,
        expected_revision: currentRevision,
      },
    })
    expect(restored.ok()).toBe(true)
  }
})

test('una bozza di annotazione richiede conferma prima della chiusura', async ({ page }) => {
  await page.route('**/api/matches*', async (route) => route.fulfill({ json: { items: [{
    account: 'Alpha#EUW', match_id: 'DRAFT-001', date: '2026-09-01T20:00:00Z', patch: '16.13', queue: '420',
    champion: 'Ahri', role: 'MIDDLE', win: 0, duration_minutes: 29, kills: 4, deaths: 6, assists: 8,
    explicit_afk: 0, suspected_quasi_afk: 0, early_surrender: 0, match_quality_score: 0.9,
    anomaly_flags: '', loss_attribution_weight: 1, win_evidence_weight: 0, reason: 'Sconfitta attribuibile.', icon_url: '',
    annotation_invincible: 0, annotation_carryable_loss: 0, annotation_afk_player: 0, annotation_griefer: 0,
    annotation_team_collapse: 0, annotation_manual_label: '', annotation_note: '', annotation_confidence: 1,
  }] } }))
  await page.route('**/api/annotations*', async (route) => route.fulfill({ json: {
    item: { match_id: 'DRAFT-001', invincible: 0, carryable_loss: 0, afk_player: 0, griefer: 0, team_collapse: 0, manual_label: '', note: '', confidence: 1, updated_at: null },
    revision: null,
  } }))
  await page.goto('/app/matches?flag=all')
  await page.getByRole('button', { name: /^Apri annotazione:/ }).first().click()
  const drawer = page.getByRole('dialog', { name: 'Annotazione della partita' })
  await drawer.getByLabel('Nota', { exact: true }).fill('Bozza non salvata')

  page.once('dialog', async (dialog) => {
    expect(dialog.message()).toContain('senza salvare')
    await dialog.dismiss()
  })
  await drawer.getByRole('button', { name: 'Annulla' }).click()
  await expect(drawer).toBeVisible()

  page.once('dialog', async (dialog) => dialog.accept())
  await drawer.getByRole('button', { name: 'Annulla' }).click()
  await expect(drawer).toBeHidden()
})

test('le impostazioni chiedono conferma di navigazione solo con una bozza', async ({ page }) => {
  await page.goto('/app/settings/algorithms')
  await page.getByRole('link', { name: 'Riepilogo', exact: true }).click()
  await expect(page).toHaveURL(/\/app\/overview/)

  await page.goto('/app/settings/algorithms')
  const recommendationLimit = page.locator('#algorithm-recommendations-limit')
  const current = Number(await recommendationLimit.inputValue())
  await recommendationLimit.fill(String(current > 1 ? current - 1 : current + 1))

  const dismissDialogPromise = page.waitForEvent('dialog')
  const blockedNavigation = page.getByRole('link', { name: 'Riepilogo', exact: true }).click()
  const dismissDialog = await dismissDialogPromise
  expect(dismissDialog.message()).toContain('bozza di impostazioni')
  await dismissDialog.dismiss()
  await blockedNavigation
  await expect(page).toHaveURL(/\/app\/settings\/algorithms/)

  const acceptDialogPromise = page.waitForEvent('dialog')
  const acceptedNavigation = page.getByRole('link', { name: 'Riepilogo', exact: true }).click()
  const acceptDialog = await acceptDialogPromise
  expect(acceptDialog.message()).toContain('bozza di impostazioni')
  await acceptDialog.accept()
  await acceptedNavigation
  await expect(page).toHaveURL(/\/app\/overview/)
})

test('CRUD friend groups senza prompt o confirm nativi', async ({ page }) => {
  await page.goto('/app/team/friends')
  await page.getByRole('button', { name: 'Nuovo gruppo' }).click()
  const create = page.getByRole('dialog', { name: 'Crea gruppo di nomi' })
  await create.getByLabel('Nome gruppo').fill('Team E2E')
  await create.getByLabel('Alias, separati da virgola').fill('E2EOne#EUW, E2ETwo#EUW')
  await create.getByRole('button', { name: 'Crea gruppo' }).click()
  await expect(page.getByText('Team E2E')).toBeVisible()
  await page.getByRole('button', { name: 'Rinomina Team E2E' }).click()
  const rename = page.getByRole('dialog', { name: 'Rinomina gruppo di nomi' })
  await rename.getByLabel('Nuovo nome').fill('Team QA')
  await rename.getByRole('button', { name: 'Salva nome' }).click()
  await expect(page.getByText('Team QA')).toBeVisible()
  await page.getByRole('button', { name: 'Elimina Team QA' }).click()
  const confirm = page.getByRole('dialog', { name: 'Rimuovere questo gruppo?' })
  await confirm.getByRole('button', { name: 'Conferma rimozione' }).click()
  await expect(page.getByText('Team QA')).toHaveCount(0)
})

test('un errore nelle raccomandazioni resta visibile e il retry riparte', async ({ page }) => {
  let requests = 0
  await page.route('**/api/recommendations?**', async (route) => {
    requests += 1
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'recommendations fixture offline' }) })
  })
  await page.goto('/app/fit?section=choices')
  await expect(page.getByRole('heading', { name: 'Suggerimenti non disponibili' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Nessuna scelta già giocata o dichiarata' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Riprova', exact: true }).click()
  await expect.poll(() => requests).toBeGreaterThan(1)
  await expect(page.getByRole('heading', { name: 'Suggerimenti non disponibili' })).toBeVisible()
})

test('scheda e scoperte mostrano il contesto prima dei dettagli', async ({ page }) => {
  await page.goto('/app/fit?section=choices&detail=Ahri&detailRole=MIDDLE')
  const championDialog = page.getByRole('dialog', { name: 'Scheda di Ahri' })
  const championAnswer = championDialog.locator('.decision-summary')
  await expect(championAnswer.getByRole('heading', { level: 2 })).toHaveText('Ahri fa già parte delle tue scelte giocate')

  await page.setViewportSize({ width: 390, height: 844 })
  await page.reload()
  await expect(championDialog.locator('.champion-artwork')).toBeHidden()
  const championAnswerBox = await championAnswer.boundingBox()
  expect(championAnswerBox).not.toBeNull()
  expect(championAnswerBox!.y).toBeLessThan(844)

  await page.goto('/app/fit?section=training&training=discover')
  const answer = page.locator('.decision-summary')
  const filters = page.locator('.filter-bar')
  await expect(answer.getByRole('heading', { name: /Potresti provare/ })).toBeVisible()
  const [answerBox, filterBox] = await Promise.all([answer.boundingBox(), filters.boundingBox()])
  expect(answerBox).not.toBeNull()
  expect(filterBox).not.toBeNull()
  expect(answerBox!.y).toBeLessThan(filterBox!.y)
  await expect(page.getByRole('link', { name: /^(Piano da \d+ prove|Vedi il piano di prove)$/ })).toBeVisible()
})

test('menu mobile, touch target e ritorno focus del drawer', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/app/overview')
  const trigger = page.getByRole('button', { name: 'Apri il menu' })
  await trigger.click()
  const drawer = page.getByRole('dialog', { name: 'Esplora Champion Fit' })
  for (const link of ['Riepilogo', 'Campioni', 'Le mie partite', 'Compagni']) {
    await expect(drawer.getByRole('link', { name: link, exact: true })).toBeVisible()
  }
  await drawer.getByRole('button', { name: 'Chiudi' }).click()
  await expect(trigger).toBeFocused()
  expect((await trigger.boundingBox())?.height).toBeGreaterThanOrEqual(44)
})

test('la prima risposta resta nel primo viewport desktop e mobile', async ({ page }) => {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport)
    await page.goto('/app/overview')
    await page.reload()
    const answer = page.getByRole('heading', { name: 'Un primo punto di partenza.' })
    await expect(answer).toBeVisible()
    const box = await answer.boundingBox()
    expect(box).not.toBeNull()
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height)
  }
})

test('Profile e Friends non allargano la pagina su mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  for (const route of ['/app/profile', '/app/team/friends?min_games=1']) {
    await page.goto(route)
    await page.reload()
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  }
  const table = page.getByRole('region', { name: 'Classifica dei compagni di squadra' })
  await expect.poll(() => table.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
  const sharedGames = table.locator('tbody td[data-label="Partite"]').first()
  await expect(sharedGames).toBeVisible()
  await expect(sharedGames).toHaveText(/^\d+$/)
  expect(await sharedGames.evaluate((cell) => getComputedStyle(cell, '::before').content)).toContain('Partite')
})

test('testo operativo e controlli principali restano leggibili al tocco', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const expectTouchTarget = async (selector: Locator) => {
    const box = await selector.boundingBox()
    const cssPixelTolerance = 0.001
    expect(box?.height).toBeGreaterThanOrEqual(44 - cssPixelTolerance)
    expect(box?.width).toBeGreaterThanOrEqual(44 - cssPixelTolerance)
  }

  await page.goto('/app/overview')
  await expectTouchTarget(page.getByRole('link', { name: 'Dati usati', exact: true }))
  await expectTouchTarget(page.getByRole('link', { name: 'Confronta i campioni', exact: true }))
  expect(await page.locator('.overview-intro').first().evaluate((node) => Number.parseFloat(getComputedStyle(node).fontSize))).toBeGreaterThanOrEqual(12)

  await page.goto('/app/fit?section=training&training=plan')
  await expectTouchTarget(page.getByRole('combobox', { name: 'Ruolo', exact: true }))

  await page.goto('/app/fit?section=training&training=discover')
  await expectTouchTarget(page.getByLabel(/Affinità minima/))

  await page.goto('/app/team/friends?min_games=1')
  await expectTouchTarget(page.getByRole('button', { name: /^Partite/ }))
  const groupAction = page.getByRole('button', { name: /^Rinomina / }).first()
  if (await groupAction.count()) await expectTouchTarget(groupAction)

  await page.goto('/app/fit?section=choices')
  await expectTouchTarget(page.getByRole('link', { name: 'Apri la scheda', exact: true }).first())
  expect(await page.locator('.recommendation-card__heading strong').first().evaluate((node) => Number.parseFloat(getComputedStyle(node).fontSize))).toBeGreaterThanOrEqual(12)

  await page.goto('/app/fit?section=training&training=discover')
  await expectTouchTarget(page.getByLabel(/Affinità minima/))

  await page.goto('/app/matches?flag=all')
  expect(await page.locator('.audit-identity small').first().evaluate((node) => Number.parseFloat(getComputedStyle(node).fontSize))).toBeGreaterThanOrEqual(10)
})

test('selezione account e scheda campione restano usabili da tastiera', async ({ page }) => {
  await page.goto('/app/profile')
  const firstAccount = page.getByRole('button', { name: /Alpha#EUW/ })
  await firstAccount.focus()
  const checked = await firstAccount.getAttribute('aria-pressed') === 'true'
  await page.keyboard.press('Space')
  await expect(firstAccount).toHaveAttribute('aria-pressed', String(!checked))
  const outlineStyle = await firstAccount.evaluate((button) => getComputedStyle(button).outlineStyle)
  expect(outlineStyle).not.toBe('none')

  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/app/fit?section=choices')
  const open = page.getByRole('link', { name: 'Apri la scheda', exact: true }).first()
  await open.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog', { name: /Scheda di/ })).toBeVisible()
})

test('il cambio route riporta in alto e sposta il focus sul contenuto', async ({ page }) => {
  await page.goto('/app/overview')
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
  await page.getByRole('link', { name: 'Confronta i campioni', exact: true }).click()
  await expect(page).toHaveURL(/\/app\/fit\?section=best/)
  await expect(page.locator('#main-content')).toBeFocused()
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0)
})

test('ban e audit spiegano il dato che cambia davvero la risposta', async ({ page }) => {
  await page.goto('/app/fit?section=matchups&relation=enemies&role=TOP&queue=440')
  await expect(page.getByText(/rispetto al tuo rendimento abituale/).first()).toBeVisible()
  await page.getByText('Perché questo segnale?').first().click()
  await expect(page.getByText(/Partite personali distinte/).first()).toBeVisible()
  await page.goto('/app/matches?flag=all')
  await page.getByRole('button', { name: /^Apri annotazione: .* con Ahri,/ }).first().click()
  const drawer = page.getByRole('dialog', { name: 'Annotazione della partita' })
  await expect(drawer.getByText('Su una sconfitta azzera il peso negativo nel calcolo.').first()).toBeVisible()
  await expect(drawer.getByText('Aggiunge contesto descrittivo; oggi non modifica il punteggio.').first()).toBeVisible()
})

test('synergy filtra per affidabilità e richiede consenso per gli esplorativi', async ({ page }) => {
  await page.goto('/app/fit?section=matchups&relation=allies')
  await expect(page.getByText('Partite raccolte')).toBeVisible()
  await page.getByRole('combobox', { name: 'Affidabilità minima', exact: true }).selectOption('indicative')
  await expect(page).toHaveURL(/min_reliability=indicative/)
  await page.getByLabel('Mostra esplorativi').click()
  await expect(page.getByLabel('Mostra esplorativi')).toBeChecked()
  await expect(page).toHaveURL(/include_exploratory=1/)
})
