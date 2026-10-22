import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { playstyleQueryKeys, type PlaystyleEvidenceResponse, type PlaystylesResponse } from '../api/playstyles'
import { DATA_VIEW_STORAGE_KEY, dataViewStore } from '../app/data-view'
import { playstyleDaysFromSettings, playstyleFiltersFromParams, PlaystyleSuggestionsPanel, PlaystylesPage } from './PlaystylesPage'

const { context } = vi.hoisted(() => ({ context: { scope: { accounts: ['Alpha#EUW'], companion: null }, scopeReady: true } }))
vi.mock('../app/scope', () => ({ useScope: () => context }))

function fixture(): PlaystylesResponse {
  return {
    version: '1', catalog: { version: '1', source_version: '16.13', sources: [], categories: [{ id: 'mage', label: 'Maghi', kind: 'class', criteria: 'Danni magici', roles: ['MIDDLE'], sources: [] }] },
    filters: { role: 'ALL', queue: '420', days: '180' }, options: { roles: ['MIDDLE', 'TOP'], queues: [{ id: '420', label: 'Classificata singola' }, { id: '440', label: 'Classificata flex' }], pairs: [] },
    summary: { unique_games: 30, observations: 30, accounts: 1, classified_games: 28, unclassified_games: 2, metrics_games: 20, supported_categories: 0 },
    categories: [{ id: 'mage', label: 'Maghi', kind: 'class', criteria: 'Danni magici', roles: ['MIDDLE'], sources: [], games: 10, observations: 10, wins: 6, losses: 4, mean: 55, lower: 45, upper: 65, lower_90: 35, upper_90: 72, baseline_mean: 50, baseline_lower: 44, baseline_upper: 56, baseline_lower_90: 30, baseline_upper_90: 70, lift: 5, baseline_games: 0, supported: false, status: 'Da confermare', reasons: ['Campione limitato'], account_count: 1, comparable_accounts: 0, missing_accounts: [], missing_baseline_accounts: ['Alpha#EUW'], support_per_account: { 'Alpha#EUW': { games: 10, baseline_games: 0 } }, prior_share: .4, threshold: 99, family_size: 14, composition: [{ champion: 'Ahri', name: 'Ahri', games: 10, wins: 6, losses: 4 }], sensitivity: { champion: null, games: 0, supported: false, lift: null, depends_on_champion: false } }],
    behavior: [{ id: 'farm', label: 'Farm', unit: 'CS/min', raw: { wins: { median: 6, q1: 5, q3: 7, n: 6 }, losses: null, accounts: 0, excluded_accounts: ['Alpha#EUW'] }, percentiles: { wins: null, losses: null, accounts: 0, excluded_accounts: ['Alpha#EUW'] } }],
    suggestions: { category_id: 'mage', exploratory: true, played: [{ champion: 'Ahri', name: 'Ahri', games: 10, wins: 6, losses: 4, mean: 55, lower: 46, upper: 64, lower_90: 35, upper_90: 72 }], untried: [{ champion: 'Orianna', name: 'Orianna', similarity: .9, label: 'Ipotesi da provare', roles: ['MIDDLE'] }] }, notes: ['Le metriche finali non dimostrano un effetto causale.'],
  }
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); context.scope.accounts = ['Alpha#EUW']; dataViewStore.dispose(); localStorage.removeItem(DATA_VIEW_STORAGE_KEY) })

function renderPage(url = '/app/playstyles', seeded = true, data = fixture()) {
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => undefined)))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } })
  if (seeded) client.setQueryData(playstyleQueryKeys.overview(context.scope, { days: '180', role: 'ALL', queue: '420', category: undefined }), data)
  const element = <QueryClientProvider client={client}><MemoryRouter initialEntries={[url]}><PlaystylesPage /></MemoryRouter></QueryClientProvider>
  const rendered = render(element)
  return { client, element, ...rendered }
}

describe('pagina stili', () => {
  it.each(['list', 'cards', 'bars', 'scatter'] as const)('mantiene copertura e limiti della risposta nella vista %s', async (view) => {
    const data = fixture()
    data.categories[0]!.credible_mass = .955
    data.categories[0]!.baseline_games = 8
    act(() => dataViewStore.setView(view))
    renderPage('/app/playstyles', true, data)
    const region = screen.getByLabelText('Visualizzazioni: Archetipi dei campioni')
    expect(region).toHaveAttribute('data-view', view)
    for (const label of within(region).getAllByText(/intervallo binomiale al 95,5%/i)) expect(label).toBeVisible()
    expect(region).toHaveTextContent('45–65%')
    expect(within(region).queryByText(/intervallo binomiale al 90%/i)).not.toBeInTheDocument()
    await userEvent.click(within(region).getByRole('button', { name: 'Perché Maghi?' }))
    expect(within(region).getByText(/Riferimento osservato: 50% · intervallo binomiale al 95,5% 44–56%/)).toBeVisible()
  })

  it('normalizza il periodo globale supportato', () => {
    expect(playstyleDaysFromSettings(365)).toBe('365')
    expect(playstyleDaysFromSettings('all')).toBe('all')
    expect(playstyleDaysFromSettings('non-valido')).toBe('180')
  })

  it('usa il periodo globale solo quando l’URL non ne contiene uno esplicito', () => {
    expect(playstyleFiltersFromParams(new URLSearchParams('role=TOP'), '365')).toMatchObject({ role: 'TOP', days: '365' })
    expect(playstyleFiltersFromParams(new URLSearchParams('role=TOP&days=90'), '365')).toMatchObject({ role: 'TOP', days: '90' })
    expect(playstyleFiltersFromParams(new URLSearchParams(), '365')).toMatchObject({ role: 'ALL', days: '365' })
  })
  it('inizializza il contesto dal server e distingue ipotesi, copertura e null', async () => {
    renderPage()
    expect(screen.getByLabelText('Ruolo degli stili')).toHaveValue('ALL')
    expect(screen.getByLabelText('Modalità degli stili')).toHaveValue('420')
    expect(screen.queryByRole('heading', { name: 'Mai provati' })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Vedi i campioni da provare' })).toHaveAttribute('href', '/app/fit?section=training&queue=420&days=180&category=mage')
    expect(screen.getAllByText('Non disponibile')).toHaveLength(3)
    expect(screen.getByText('rispetto al riferimento disponibile · copertura incompleta')).toBeInTheDocument()
    expect(screen.getAllByText(/intervallo binomiale al 90% 45–65%/i).length).toBeGreaterThan(0)
    await userEvent.click(screen.getByRole('button', { name: 'Perché Maghi?' }))
    expect(screen.getByText('Sensibilità al singolo campione non stimabile con questi dati.')).toBeInTheDocument()
    expect(screen.queryByText(/Senza null/)).not.toBeInTheDocument()
    expect(screen.getByText('Riferimento non disponibile nel contesto selezionato.')).toBeInTheDocument()
    expect(screen.queryByText(/Quota media del prior/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/intervallo binomiale al 90% 35–72%/i)).not.toBeInTheDocument()
  })

  it('mostra la motivazione del tag nei dettagli del campione', async () => {
    const data = fixture()
    const reason = 'La sfera controlla lo spazio con danno ripetibile e minaccia di spostamento.'
    data.categories = data.categories.map((category) => ({ ...category,
      composition: category.composition.map((champion) => ({ ...champion, reason })),
    }))
    renderPage('/app/playstyles', true, data)
    expect(screen.queryByText(reason)).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Perché Maghi?' }))
    expect(screen.getByText(reason)).toBeInTheDocument()
    expect(screen.getByText('10 partite · 6V / 4S')).toBeInTheDocument()
  })

  it.each([
    { format: 'compact', timezone: 'UTC', raw: '20261017T003000+0200', canonical: '2026-10-16T22:30:00.000000+00:00', expected: '16/10/2026' },
    { format: 'compact', timezone: 'Europe/Rome', raw: '20261017T003000+0200', canonical: '2026-10-16T22:30:00.000000+00:00', expected: '17/10/2026' },
    { format: 'week', timezone: 'UTC', raw: '2026-W01-1T013000+0200', canonical: '2025-12-28T23:30:00.000000+00:00', expected: '28/12/2025' },
    { format: 'week', timezone: 'Europe/Rome', raw: '2026-W01-1T013000+0200', canonical: '2025-12-28T23:30:00.000000+00:00', expected: '29/12/2025' },
    { format: 'legacy senza date_utc', timezone: 'Europe/Rome', raw: '2026-10-16T23:30:00Z', canonical: undefined, expected: '17/10/2026' },
    { format: 'legacy con date_utc null', timezone: 'Europe/Rome', raw: '2026-10-16T23:30:00Z', canonical: null, expected: '17/10/2026' },
  ])('mostra una data leggibile nelle prove $format in $timezone', async ({ timezone, raw, canonical, expected }) => {
    vi.stubEnv('TZ', timezone)
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => undefined)))
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } })
    const filters = { days: 'all' as const, role: 'ALL', queue: '420', category: undefined }
    const data = fixture()
    client.setQueryData(playstyleQueryKeys.overview(context.scope, filters), { ...data, filters: { ...data.filters, days: 'all' } })
    const proof: PlaystyleEvidenceResponse = {
      category_id: 'mage', page: 1, page_size: 20, total: 1,
      matches: [{ account: 'Alpha#EUW', match_id: 'PROOF-DATE', champion: 'Ahri', role: 'MIDDLE', queue: '420', date: raw, date_utc: canonical, win: 1, note: '', duration_minutes: 30 }],
    }
    client.setQueryData(playstyleQueryKeys.evidence(context.scope, filters, 'mage', 1, 20), proof)
    render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/app/playstyles?days=all']}><PlaystylesPage /></MemoryRouter></QueryClientProvider>)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Perché Maghi?' }))
    await user.click(screen.getByRole('button', { name: 'Mostra le partite · Maghi' }))

    const table = await screen.findByRole('region', { name: 'Partite a supporto di Maghi' })
    expect(within(table).getByRole('cell', { name: expected })).toBeVisible()
    expect(table).not.toHaveTextContent(raw)
    expect(proof.matches[0]!.date).toBe(raw)
  })

  it('preserva le scelte esplicite anche mentre il nuovo filtro non ha risposta', async () => {
    renderPage()
    await userEvent.selectOptions(screen.getByLabelText('Modalità degli stili'), '440')
    expect(screen.getByLabelText('Modalità degli stili')).toHaveValue('440')
    expect(screen.queryByRole('heading', { name: /^Maghi$/ })).not.toBeInTheDocument()
    expect(screen.getByRole('status', { name: 'Analisi degli stili per i filtri attivi' })).toBeInTheDocument()
  })

  it('seleziona tutto lo storico anche quando il periodo predefinito è di 180 giorni', async () => {
    renderPage()
    expect(screen.getByLabelText('Periodo degli stili')).toHaveValue('180')

    await userEvent.selectOptions(screen.getByLabelText('Periodo degli stili'), '90')
    expect(screen.getByLabelText('Periodo degli stili')).toHaveValue('90')

    await userEvent.selectOptions(screen.getByLabelText('Periodo degli stili'), 'all')
    expect(screen.getByLabelText('Periodo degli stili')).toHaveValue('all')
    expect(fetch).toHaveBeenLastCalledWith(expect.stringContaining('days=all'), expect.anything())
    expect(screen.queryByRole('heading', { name: /^Maghi$/ })).not.toBeInTheDocument()
  })

  it('ricerca e ordinamento rimangono locali senza nuove query statistiche', async () => {
    renderPage()
    await userEvent.type(screen.getByLabelText('Cerca categoria'), 'tank')
    expect(screen.getByRole('heading', { name: 'Nessuna categoria disponibile' })).toBeInTheDocument()
    await userEvent.selectOptions(screen.getByLabelText('Ordina categorie'), 'games')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('apre direttamente Campioni da provare con categoria e contesto risolti', () => {
    renderPage()
    expect(screen.getAllByRole('link', { name: 'Esplora i campioni · Maghi' })[0]).toHaveAttribute('href', '/app/fit?section=training&queue=420&days=180&category=mage')
  })

  it('un URL esplicito senza dati conserva ruolo e coda', () => {
    renderPage('/app/playstyles?role=JUNGLE&queue=440&days=all', false)
    expect(screen.getByLabelText('Ruolo degli stili')).toHaveValue('JUNGLE')
    expect(screen.getByLabelText('Modalità degli stili')).toHaveValue('440')
    expect(screen.getByLabelText('Periodo degli stili')).toHaveValue('all')
  })

  it('sposta i suggerimenti nel pannello Campioni e apre la scheda conservando il contesto', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => undefined)))
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } })
    const filters = { days: 'all' as const, role: 'MIDDLE', queue: '420', category: 'mage' }
    const data = fixture()
    client.setQueryData(playstyleQueryKeys.overview(context.scope, filters), { ...data, filters: { ...data.filters, role: 'MIDDLE' } })
    render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/app/fit?section=training&role=MIDDLE&queue=420&days=all&category=mage']}><PlaystyleSuggestionsPanel /></MemoryRouter></QueryClientProvider>)
    expect(screen.getByRole('heading', { name: 'Già giocati' })).toBeInTheDocument()
    expect(screen.getByText('Ipotesi teorica')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Ahri' })).toHaveAttribute('href', '/app/fit?section=training&role=MIDDLE&queue=420&days=all&category=mage&detail=Ahri&detailRole=MIDDLE')
    expect(screen.getByRole('link', { name: 'Orianna' })).toHaveAttribute('href', '/app/fit?section=training&role=MIDDLE&queue=420&days=all&category=mage&detail=Orianna&detailRole=MIDDLE')
    expect(screen.getByText(/Intervallo binomiale al 90% 46–64%/)).toBeInTheDocument()
  })
})
