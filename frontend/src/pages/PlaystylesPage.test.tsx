import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { playstyleQueryKeys, type PlaystylesResponse } from '../api/playstyles'
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

afterEach(() => { cleanup(); vi.unstubAllGlobals(); context.scope.accounts = ['Alpha#EUW'] })

function renderPage(url = '/app/playstyles', seeded = true, data = fixture()) {
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => undefined)))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } })
  if (seeded) client.setQueryData(playstyleQueryKeys.overview(context.scope, { days: '180', role: 'ALL', queue: '420', category: undefined }), data)
  const element = <QueryClientProvider client={client}><MemoryRouter initialEntries={[url]}><PlaystylesPage /></MemoryRouter></QueryClientProvider>
  const rendered = render(element)
  return { client, element, ...rendered }
}

describe('pagina stili', () => {
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

  it('preserva le scelte esplicite anche mentre il nuovo filtro non ha risposta', async () => {
    renderPage()
    await userEvent.selectOptions(screen.getByLabelText('Modalità degli stili'), '440')
    expect(screen.getByLabelText('Modalità degli stili')).toHaveValue('440')
    expect(screen.queryByRole('heading', { name: /^Maghi$/ })).not.toBeInTheDocument()
    expect(screen.getByRole('status', { name: 'Analisi degli stili per i filtri attivi' })).toBeInTheDocument()
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
