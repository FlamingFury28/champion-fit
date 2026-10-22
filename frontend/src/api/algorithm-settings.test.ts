import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from './client'
import { getAlgorithmSettings, previewAlgorithmSettings, saveAlgorithmSettings } from './algorithm-settings'
import type { AlgorithmSettingsResponseDto } from './types'

// Exact JSON captured from ensure_settings/get_settings_snapshot on SQLite :memory:.
// Includes backend null bounds/options and the archived, partial revision 1.
const backendSnapshot = JSON.parse("{\"defaults\":{\"attribution\":{\"contaminated_threshold\":0.45,\"duration_bounds\":[10,15,20,23,27],\"early_surrender_multiplier\":1,\"explicit_afk_weight\":0,\"kill_deficit_multiplier\":1,\"loss_weights\":[1,1,1,1,1,1],\"negative_veto\":false,\"quasi_afk_multiplier\":1,\"surrender_multiplier\":1,\"team_collapse_multiplier\":1,\"win_long_weight\":1,\"win_short_minutes\":20,\"win_short_weight\":1},\"context\":{\"days\":180,\"queue\":\"420\"},\"evidence\":{\"credible_mass\":0.9,\"display_min_games\":3,\"family_alpha\":0.05,\"indicative_games\":8,\"meaningful_delta\":0.03,\"min_games\":20,\"prior_mean\":0.5,\"prior_strength\":8,\"recommendation_limit\":3},\"friends\":{\"min_shared_games\":5},\"matchup\":{\"limit\":12,\"recent_days\":90,\"recent_weight\":0},\"playstyle\":{\"duration_bounds\":[20,30,40],\"percentile_min_games\":10,\"suggestion_limit\":10},\"recommendations\":{\"confidence\":0.9,\"limit\":6,\"period\":{\"unit\":\"days\",\"value\":0},\"queue\":\"all\",\"trial_budget\":3},\"training\":{\"budget\":20,\"max_candidates\":3}},\"fingerprint\":\"b85033ce28650672016cf8aa407e8e69cfd96cdb559d9c835f43917aa3c9ddf4\",\"history\":[{\"created_at\":\"2026-10-17T19:48:01.494901+00:00\",\"fingerprint\":\"b85033ce28650672016cf8aa407e8e69cfd96cdb559d9c835f43917aa3c9ddf4\",\"revision\":2,\"settings\":{\"attribution\":{\"contaminated_threshold\":0.45,\"duration_bounds\":[10,15,20,23,27],\"early_surrender_multiplier\":1,\"explicit_afk_weight\":0,\"kill_deficit_multiplier\":1,\"loss_weights\":[1,1,1,1,1,1],\"negative_veto\":false,\"quasi_afk_multiplier\":1,\"surrender_multiplier\":1,\"team_collapse_multiplier\":1,\"win_long_weight\":1,\"win_short_minutes\":20,\"win_short_weight\":1},\"context\":{\"days\":180,\"queue\":\"420\"},\"evidence\":{\"credible_mass\":0.9,\"display_min_games\":3,\"family_alpha\":0.05,\"indicative_games\":8,\"meaningful_delta\":0.03,\"min_games\":20,\"prior_mean\":0.5,\"prior_strength\":8,\"recommendation_limit\":3},\"friends\":{\"min_shared_games\":5},\"matchup\":{\"limit\":12,\"recent_days\":90,\"recent_weight\":0},\"playstyle\":{\"duration_bounds\":[20,30,40],\"percentile_min_games\":10,\"suggestion_limit\":10},\"recommendations\":{\"confidence\":0.9,\"limit\":6,\"period\":{\"unit\":\"days\",\"value\":0},\"queue\":\"all\",\"trial_budget\":3},\"training\":{\"budget\":20,\"max_candidates\":3}}},{\"created_at\":\"2026-10-17T19:48:01.494901+00:00\",\"fingerprint\":\"f1a3787dfc04d7bcb2f6f27b8d915db6561d7e14403270129b551db78642300b\",\"revision\":1,\"settings\":{\"attribution\":{\"contaminated_threshold\":0.45,\"duration_bounds\":[10,15,20,23,27],\"early_surrender_multiplier\":0.55,\"explicit_afk_weight\":0,\"kill_deficit_multiplier\":0.85,\"loss_weights\":[0,0.04,0.15,0.35,0.6,0.88],\"negative_veto\":true,\"quasi_afk_multiplier\":0.35,\"surrender_multiplier\":0.85,\"team_collapse_multiplier\":0.65,\"win_long_weight\":0.95,\"win_short_minutes\":20,\"win_short_weight\":0.45},\"context\":{\"days\":\"all\",\"queue\":\"all\"},\"evidence\":{\"credible_mass\":0.9,\"display_min_games\":3,\"family_alpha\":0.05,\"indicative_games\":8,\"meaningful_delta\":0.03,\"min_games\":20,\"prior_mean\":0.5,\"prior_strength\":8,\"recommendation_limit\":3},\"friends\":{\"min_shared_games\":5},\"matchup\":{\"limit\":12,\"recent_days\":90,\"recent_weight\":0.15},\"playstyle\":{\"duration_bounds\":[20,30,40],\"percentile_min_games\":10,\"suggestion_limit\":10},\"training\":{\"budget\":400,\"max_candidates\":3}}}],\"revision\":2,\"schema\":[{\"description\":\"Probabilita centrale del prior Beta.\",\"group\":\"Evidenza\",\"label\":\"Media del prior\",\"max\":0.6,\"min\":0.4,\"options\":null,\"path\":\"evidence.prior_mean\",\"type\":\"number\"},{\"description\":\"Osservazioni equivalenti del prior Beta.\",\"group\":\"Evidenza\",\"label\":\"Forza del prior\",\"max\":50,\"min\":2,\"options\":null,\"path\":\"evidence.prior_strength\",\"type\":\"integer\"},{\"description\":\"Massa dell'intervallo credibile descrittivo.\",\"group\":\"Evidenza\",\"label\":\"Massa credibile\",\"max\":0.99,\"min\":0.8,\"options\":null,\"path\":\"evidence.credible_mass\",\"type\":\"number\"},{\"description\":\"Effetto minimo pratico come quota.\",\"group\":\"Evidenza\",\"label\":\"Differenza rilevante\",\"max\":0.15,\"min\":0.01,\"options\":null,\"path\":\"evidence.meaningful_delta\",\"type\":\"number\"},{\"description\":\"Rischio complessivo usato dal controllo della famiglia.\",\"group\":\"Evidenza\",\"label\":\"Alpha della famiglia\",\"max\":0.1,\"min\":0.001,\"options\":null,\"path\":\"evidence.family_alpha\",\"type\":\"number\"},{\"description\":\"Supporto minimo per una decisione operativa.\",\"group\":\"Evidenza\",\"label\":\"Partite minime\",\"max\":500,\"min\":20,\"options\":null,\"path\":\"evidence.min_games\",\"type\":\"integer\"},{\"description\":\"Supporto minimo per mostrare una stima.\",\"group\":\"Evidenza\",\"label\":\"Partite per visualizzare\",\"max\":500,\"min\":1,\"options\":null,\"path\":\"evidence.display_min_games\",\"type\":\"integer\"},{\"description\":\"Supporto minimo per un segnale indicativo.\",\"group\":\"Evidenza\",\"label\":\"Partite indicative\",\"max\":500,\"min\":1,\"options\":null,\"path\":\"evidence.indicative_games\",\"type\":\"integer\"},{\"description\":\"Numero massimo di raccomandazioni mostrate.\",\"group\":\"Evidenza\",\"label\":\"Limite raccomandazioni\",\"max\":40,\"min\":1,\"options\":null,\"path\":\"evidence.recommendation_limit\",\"type\":\"integer\"},{\"description\":\"Coda predefinita dell'analisi.\",\"group\":\"Contesto\",\"label\":\"Coda\",\"max\":null,\"min\":null,\"options\":[\"400\",\"420\",\"430\",\"440\",\"480\",\"490\",\"700\"],\"path\":\"context.queue\",\"type\":\"select\"},{\"description\":\"Finestra temporale predefinita in giorni.\",\"group\":\"Contesto\",\"label\":\"Periodo\",\"max\":null,\"min\":null,\"options\":[90,180,365,\"all\"],\"path\":\"context.days\",\"type\":\"select\"},{\"description\":\"Cinque soglie crescenti che definiscono sei fasce.\",\"group\":\"Attribuzione\",\"label\":\"Fasce durata\",\"max\":90,\"min\":1,\"options\":null,\"path\":\"attribution.duration_bounds\",\"type\":\"number[]\"},{\"description\":\"Sei pesi non decrescenti per fascia di durata.\",\"group\":\"Attribuzione\",\"label\":\"Pesi sconfitte\",\"max\":1,\"min\":0,\"options\":null,\"path\":\"attribution.loss_weights\",\"type\":\"number[]\"},{\"description\":\"Soglia in minuti per distinguere le vittorie brevi.\",\"group\":\"Attribuzione\",\"label\":\"Durata vittoria breve\",\"max\":90,\"min\":1,\"options\":null,\"path\":\"attribution.win_short_minutes\",\"type\":\"integer\"},{\"description\":\"Peso interpretativo delle vittorie brevi.\",\"group\":\"Attribuzione\",\"label\":\"Peso vittoria breve\",\"max\":1,\"min\":0,\"options\":null,\"path\":\"attribution.win_short_weight\",\"type\":\"number\"},{\"description\":\"Peso interpretativo delle altre vittorie.\",\"group\":\"Attribuzione\",\"label\":\"Peso vittoria lunga\",\"max\":1,\"min\":0,\"options\":null,\"path\":\"attribution.win_long_weight\",\"type\":\"number\"},{\"description\":\"Peso di una sconfitta con AFK esplicito.\",\"group\":\"Attribuzione\",\"label\":\"Peso AFK esplicito\",\"max\":1,\"min\":0,\"options\":null,\"path\":\"attribution.explicit_afk_weight\",\"type\":\"number\"},{\"description\":\"Moltiplicatore per sospetto quasi AFK.\",\"group\":\"Attribuzione\",\"label\":\"Moltiplicatore quasi AFK\",\"max\":1,\"min\":0,\"options\":null,\"path\":\"attribution.quasi_afk_multiplier\",\"type\":\"number\"},{\"description\":\"Moltiplicatore per resa precoce.\",\"group\":\"Attribuzione\",\"label\":\"Moltiplicatore resa precoce\",\"max\":1,\"min\":0,\"options\":null,\"path\":\"attribution.early_surrender_multiplier\",\"type\":\"number\"},{\"description\":\"Moltiplicatore per collasso della squadra.\",\"group\":\"Attribuzione\",\"label\":\"Moltiplicatore collasso squadra\",\"max\":1,\"min\":0,\"options\":null,\"path\":\"attribution.team_collapse_multiplier\",\"type\":\"number\"},{\"description\":\"Moltiplicatore per una resa ordinaria.\",\"group\":\"Attribuzione\",\"label\":\"Moltiplicatore resa\",\"max\":1,\"min\":0,\"options\":null,\"path\":\"attribution.surrender_multiplier\",\"type\":\"number\"},{\"description\":\"Moltiplicatore per un forte deficit di eliminazioni.\",\"group\":\"Attribuzione\",\"label\":\"Moltiplicatore deficit kill\",\"max\":1,\"min\":0,\"options\":null,\"path\":\"attribution.kill_deficit_multiplier\",\"type\":\"number\"},{\"description\":\"Soglia sotto cui l'evidenza negativa e contaminata.\",\"group\":\"Attribuzione\",\"label\":\"Soglia contaminazione\",\"max\":1,\"min\":0,\"options\":null,\"path\":\"attribution.contaminated_threshold\",\"type\":\"number\"},{\"description\":\"Richiede evidenza negativa attribuita per il segnale forte.\",\"group\":\"Attribuzione\",\"label\":\"Veto negativo\",\"max\":null,\"min\":null,\"options\":null,\"path\":\"attribution.negative_veto\",\"type\":\"boolean\"},{\"description\":\"Finestra usata per il correttivo recente.\",\"group\":\"Matchup\",\"label\":\"Giorni recenti\",\"max\":365,\"min\":7,\"options\":null,\"path\":\"matchup.recent_days\",\"type\":\"integer\"},{\"description\":\"Quota massima del correttivo recente.\",\"group\":\"Matchup\",\"label\":\"Peso recente\",\"max\":0.5,\"min\":0,\"options\":null,\"path\":\"matchup.recent_weight\",\"type\":\"number\"},{\"description\":\"Numero massimo di matchup mostrati.\",\"group\":\"Matchup\",\"label\":\"Limite matchup\",\"max\":40,\"min\":1,\"options\":null,\"path\":\"matchup.limit\",\"type\":\"integer\"},{\"description\":\"Partite minime per mostrare un compagno.\",\"group\":\"Compagni\",\"label\":\"Partite condivise minime\",\"max\":100,\"min\":1,\"options\":null,\"path\":\"friends.min_shared_games\",\"type\":\"integer\"},{\"description\":\"Campione minimo per i percentili contestuali.\",\"group\":\"Playstyle\",\"label\":\"Partite per percentile\",\"max\":100,\"min\":10,\"options\":null,\"path\":\"playstyle.percentile_min_games\",\"type\":\"integer\"},{\"description\":\"Tre soglie crescenti per il contesto di durata.\",\"group\":\"Playstyle\",\"label\":\"Fasce durata playstyle\",\"max\":90,\"min\":1,\"options\":null,\"path\":\"playstyle.duration_bounds\",\"type\":\"number[]\"},{\"description\":\"Numero massimo di suggerimenti playstyle.\",\"group\":\"Playstyle\",\"label\":\"Limite suggerimenti\",\"max\":40,\"min\":1,\"options\":null,\"path\":\"playstyle.suggestion_limit\",\"type\":\"integer\"},{\"description\":\"Numero totale di partite da allocare.\",\"group\":\"Allenamento\",\"label\":\"Budget allenamento\",\"max\":2000,\"min\":1,\"options\":null,\"path\":\"training.budget\",\"type\":\"integer\"},{\"description\":\"Numero massimo di candidati nel piano.\",\"group\":\"Allenamento\",\"label\":\"Candidati allenamento\",\"max\":12,\"min\":1,\"options\":null,\"path\":\"training.max_candidates\",\"type\":\"integer\"},{\"description\":\"Numero massimo di campioni in ciascuna lista di familiari e scoperte.\",\"group\":\"Raccomandazioni\",\"label\":\"Limite raccomandazioni\",\"max\":40,\"min\":1,\"options\":null,\"path\":\"recommendations.limit\",\"type\":\"integer\"},{\"description\":\"Massimo di partite nel ciclo breve, una per candidato familiare o da scoprire.\",\"group\":\"Raccomandazioni\",\"label\":\"Budget di prova\",\"max\":10,\"min\":1,\"options\":null,\"path\":\"recommendations.trial_budget\",\"type\":\"integer\"},{\"description\":\"0 usa tutto lo storico; altrimenti indica un numero di giorni o di partite per account.\",\"group\":\"Raccomandazioni\",\"label\":\"Periodo\",\"max\":100000,\"min\":0,\"options\":[\"days\",\"games\"],\"path\":\"recommendations.period\",\"type\":\"period\"},{\"description\":\"Code incluse nelle preferenze osservate.\",\"group\":\"Raccomandazioni\",\"label\":\"Coda\",\"max\":null,\"min\":null,\"options\":[\"all\",\"auto\",\"420\",\"440\",\"400\",\"430\",\"490\",\"480\",\"700\"],\"path\":\"recommendations.queue\",\"type\":\"select\"},{\"description\":\"Copertura degli intervalli binomiali descrittivi (0,9 = 90%). Non cambia l'ordine delle preferenze.\",\"group\":\"Raccomandazioni\",\"label\":\"Confidenza\",\"max\":0.99,\"min\":0.8,\"options\":null,\"path\":\"recommendations.confidence\",\"type\":\"number\"}],\"settings\":{\"attribution\":{\"contaminated_threshold\":0.45,\"duration_bounds\":[10,15,20,23,27],\"early_surrender_multiplier\":1,\"explicit_afk_weight\":0,\"kill_deficit_multiplier\":1,\"loss_weights\":[1,1,1,1,1,1],\"negative_veto\":false,\"quasi_afk_multiplier\":1,\"surrender_multiplier\":1,\"team_collapse_multiplier\":1,\"win_long_weight\":1,\"win_short_minutes\":20,\"win_short_weight\":1},\"context\":{\"days\":180,\"queue\":\"420\"},\"evidence\":{\"credible_mass\":0.9,\"display_min_games\":3,\"family_alpha\":0.05,\"indicative_games\":8,\"meaningful_delta\":0.03,\"min_games\":20,\"prior_mean\":0.5,\"prior_strength\":8,\"recommendation_limit\":3},\"friends\":{\"min_shared_games\":5},\"matchup\":{\"limit\":12,\"recent_days\":90,\"recent_weight\":0},\"playstyle\":{\"duration_bounds\":[20,30,40],\"percentile_min_games\":10,\"suggestion_limit\":10},\"recommendations\":{\"confidence\":0.9,\"limit\":6,\"period\":{\"unit\":\"days\",\"value\":0},\"queue\":\"all\",\"trial_budget\":3},\"training\":{\"budget\":20,\"max_candidates\":3}}}") as AlgorithmSettingsResponseDto
const invalidResponseMessage = 'La risposta del server non è valida o completa. L’esito della richiesta non è confermato.'
const input = { expected_revision: 2, settings: backendSnapshot.settings }
const previewInput = {
  ...input, scope: { account: ['Alpha#EUW'], companion_account: ['Beta#EUW'], companion_mode: 'only' },
  filters: { role: 'MIDDLE', queue: '420', days: 'all' },
}
const validPreview = {
  base_revision: 2, proposed_fingerprint: 'synthetic-preview',
  changed_paths: ['recommendations.trial_budget'],
  comparisons: [{ algorithm: 'Campioni e attribuzione', before: null, after: null }],
  sensitivity: [null, { label: 'Scenario sintetico' }], context: {}, notes: ['Anteprima senza scritture.'],
}

function snapshot(overrides: Record<string, unknown> = {}) {
  return { ...structuredClone(backendSnapshot), ...overrides }
}

function field(path: string, type = 'integer') {
  return { path, label: 'Campo sintetico', description: 'Forma del dato, senza politica numerica.', type, group: 'Raccomandazioni' }
}

function fieldSnapshot(path: string, type: string, value: unknown) {
  const result = snapshot({ schema: [field(path, type)] })
  for (const root of [result.settings, result.defaults]) {
    const keys = path.split('.')
    const last = keys.pop()
    if (!last) throw new Error('Expected a fixture path')
    let cursor = root
    for (const key of keys) {
      const child = cursor[key]
      if (!child || typeof child !== 'object' || Array.isArray(child)) throw new Error('Missing fixture path')
      cursor = child as Record<string, unknown>
    }
    cursor[last] = value
  }
  return result
}

function reply(payload: unknown, status = 200) {
  const fetchMock = vi.fn().mockResolvedValue(Response.json(payload, { status }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => vi.unstubAllGlobals())

describe('snapshot delle impostazioni algoritmiche', () => {
  it('accetta il documento reale del backend, null dello schema e storico legacy inclusi', async () => {
    const fetchMock = reply(backendSnapshot)
    await expect(getAlgorithmSettings()).resolves.toEqual(backendSnapshot)
    expect(backendSnapshot.schema).toHaveLength(38)
    expect(backendSnapshot.schema.some((item) => item.options === null)).toBe(true)
    expect(backendSnapshot.history[1]?.settings).not.toHaveProperty('recommendations')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('accetta schema vuoto per uno snapshot in sola lettura e settings storici parziali', async () => {
    const payload = snapshot({ schema: [], history: [{ revision: 1, settings: { context: { days: 'all' } } }] })
    reply(payload)
    await expect(getAlgorithmSettings()).resolves.toEqual(payload)
  })

  it('accetta opzioni etichettate e proprietà note della cronologia', async () => {
    const payload = snapshot({
      schema: [{ ...field('context.days', 'select'), options: [{ label: 'Tutto lo storico', value: 'all' }, 180] }],
      history: [{ revision: 1, fingerprint: 'historical', created_at: '2026-10-17', summary: 'Legacy', changed_paths: ['context.days'], settings: {} }],
    })
    reply(payload)
    await expect(getAlgorithmSettings()).resolves.toEqual(payload)
  })

  it('lascia i limiti numerici al server e conserva i tipi futuri gestibili come testo', async () => {
    for (const payload of [
      fieldSnapshot('recommendations.trial_budget', 'integer', 500),
      fieldSnapshot('context.queue', 'future-text', '420'),
    ]) {
      reply(payload)
      await expect(getAlgorithmSettings()).resolves.toEqual(payload)
    }
  })

  it.each([3, 4])('accetta PUT con revisione %s successiva a quella attesa', async (revision) => {
    const payload = snapshot({ revision })
    const fetchMock = reply(payload)
    await expect(saveAlgorithmSettings(input)).resolves.toEqual(payload)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith('/api/algorithm-settings', expect.objectContaining({ method: 'PUT', body: JSON.stringify(input) }))
  })

  it.each([1, 2])('rifiuta PUT con revisione %s non successiva a quella attesa', async (revision) => {
    const fetchMock = reply(snapshot({ revision }))
    await expect(saveAlgorithmSettings(input)).rejects.toEqual(new ApiError(200, invalidResponseMessage))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  describe.each(['GET', 'PUT'] as const)('decoder condiviso %s', (method) => {
    const invalidSnapshots: Array<[string, unknown]> = [
      ['oggetto vuoto', {}],
      ['sola revisione', { revision: 2 }],
      ['revisione e history', { revision: 2, history: [] }],
      ['revisione testuale', snapshot({ revision: '2' })],
      ['revisione negativa', snapshot({ revision: -1 })],
      ['revisione frazionaria', snapshot({ revision: 2.5 })],
      ['fingerprint vuoto', snapshot({ fingerprint: '  ' })],
      ['settings nulli', snapshot({ settings: null })],
      ['settings array', snapshot({ settings: [] })],
      ['settings vuoti', snapshot({ settings: {} })],
      ['defaults vuoti', snapshot({ defaults: {} })],
      ['schema non array', snapshot({ schema: {} })],
      ['campo schema nullo', snapshot({ schema: [null] })],
      ['proprietà campo non stringa', snapshot({ schema: [{ ...field('context.days'), description: {} }] })],
      ['minimo non numerico', snapshot({ schema: [{ ...field('context.days'), min: 'one' }] })],
      ['opzioni non array', snapshot({ schema: [{ ...field('context.days'), options: {} }] })],
      ['opzione nulla', snapshot({ schema: [{ ...field('context.days'), options: [null] }] })],
      ['etichetta opzione non stringa', snapshot({ schema: [{ ...field('context.days'), options: [{ label: {}, value: 1 }] }] })],
      ['valore opzione strutturato', snapshot({ schema: [{ ...field('context.days'), options: [{ label: 'Uno', value: {} }] }] })],
      ['path assente nelle settings', snapshot({ settings: { unrelated: true } })],
      ['path assente nei defaults', snapshot({ defaults: { unrelated: true } })],
      ['history non array', snapshot({ history: {} })],
      ['entry history nulla', snapshot({ history: [null] })],
      ['revisione history testuale', snapshot({ history: [{ revision: '1' }] })],
      ['data history non stringa', snapshot({ history: [{ created_at: {} }] })],
      ['percorsi history non stringa', snapshot({ history: [{ changed_paths: [42] }] })],
      ['settings storici array', snapshot({ history: [{ settings: [] }] })],
    ]
    it.each(invalidSnapshots)('rifiuta %s prima del chiamante e senza retry', async (_case, payload) => {
      const fetchMock = reply(payload)
      const request = method === 'GET' ? getAlgorithmSettings() : saveAlgorithmSettings(input)
      await expect(request).rejects.toEqual(new ApiError(200, invalidResponseMessage))
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it.each([
      ['numero nullo', 'evidence.prior_mean', 'number', null],
      ['numero testuale', 'evidence.prior_mean', 'number', '0.5'],
      ['intero frazionario', 'recommendations.trial_budget', 'integer', 3.5],
      ['boolean numerico', 'attribution.negative_veto', 'boolean', 0],
      ['array numerico non array', 'attribution.loss_weights', 'number[]', {}],
      ['array numerico misto', 'attribution.loss_weights', 'number[]', [1, 'two']],
      ['array testuale misto', 'attribution.loss_weights', 'string[]', ['one', 2]],
      ['select strutturato', 'context.days', 'select', {}],
      ['periodo nullo', 'recommendations.period', 'period', null],
      ['periodo array', 'recommendations.period', 'period', []],
      ['periodo senza unità', 'recommendations.period', 'period', { value: 10 }],
      ['periodo frazionario', 'recommendations.period', 'period', { value: 1.5, unit: 'days' }],
      ['periodo con unità sconosciuta', 'recommendations.period', 'period', { value: 10, unit: 'hours' }],
    ] satisfies Array<[string, string, string, unknown]>)('rifiuta struttura incoerente: %s', async (_case, path, type, value) => {
      const fetchMock = reply(fieldSnapshot(path, type, value))
      await expect(method === 'GET' ? getAlgorithmSettings() : saveAlgorithmSettings(input)).rejects.toEqual(new ApiError(200, invalidResponseMessage))
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })
  })
})

describe('anteprima delle impostazioni algoritmiche', () => {
  it('conserva scope, filters, segnale e before/after null senza applicare modifiche', async () => {
    const controller = new AbortController()
    const fetchMock = reply(validPreview)
    await expect(previewAlgorithmSettings(previewInput, controller.signal)).resolves.toEqual(validPreview)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith('/api/algorithm-settings/preview', expect.objectContaining({ method: 'POST', body: JSON.stringify(previewInput), signal: controller.signal }))
  })

  it.each([
    ['oggetto vuoto', {}],
    ['base assente', { ...validPreview, base_revision: undefined }],
    ['base precedente', { ...validPreview, base_revision: 1 }],
    ['base futura', { ...validPreview, base_revision: 3 }],
    ['fingerprint vuoto', { ...validPreview, proposed_fingerprint: '' }],
    ['percorsi non array', { ...validPreview, changed_paths: {} }],
    ['percorso non stringa', { ...validPreview, changed_paths: [42] }],
    ['confronti non array', { ...validPreview, comparisons: {} }],
    ['confronto nullo', { ...validPreview, comparisons: [null] }],
    ['algoritmo non stringa', { ...validPreview, comparisons: [{ algorithm: {}, before: null, after: null }] }],
    ['before assente', { ...validPreview, comparisons: [{ algorithm: 'Test', after: null }] }],
    ['after assente', { ...validPreview, comparisons: [{ algorithm: 'Test', before: null }] }],
    ['sensibilità non array', { ...validPreview, sensitivity: null }],
    ['contesto nullo', { ...validPreview, context: null }],
    ['contesto array', { ...validPreview, context: [] }],
    ['note non array', { ...validPreview, notes: {} }],
    ['nota non stringa', { ...validPreview, notes: [{}] }],
  ])('rifiuta %s prima del rendering e senza ripetere il POST', async (_case, payload) => {
    const fetchMock = reply(payload)
    await expect(previewAlgorithmSettings(previewInput)).rejects.toEqual(new ApiError(200, invalidResponseMessage))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('trasporto delle impostazioni', () => {
  it.each([
    ['GET', () => getAlgorithmSettings()],
    ['PUT', () => saveAlgorithmSettings(input)],
    ['preview', () => previewAlgorithmSettings(previewInput)],
  ] as const)('propaga409 di %s senza retry', async (_case, request) => {
    const fetchMock = reply({ error: 'Conflitto di revisione' }, 409)
    await expect(request()).rejects.toMatchObject({ name: 'ApiError', status: 409 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each(['GET', 'preview'] as const)('conserva segnale e AbortError in %s', async (method) => {
    const cancellation = new DOMException('Cancelled', 'AbortError')
    const controller = new AbortController()
    const fetchMock = vi.fn().mockRejectedValue(cancellation)
    vi.stubGlobal('fetch', fetchMock)
    await expect(method === 'GET' ? getAlgorithmSettings(controller.signal) : previewAlgorithmSettings(previewInput, controller.signal)).rejects.toBe(cancellation)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[1].signal).toBe(controller.signal)
  })
})
