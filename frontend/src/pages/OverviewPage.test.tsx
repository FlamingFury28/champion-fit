import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScopeSnapshot } from '../api/client'
import { OVERVIEW_FILTERS_KEY } from '../app/overview-filters'
import { PLAN_BUDGET_KEY } from '../app/remembered-plan-budget'
import { OverviewPage } from './OverviewPage'

const state = vi.hoisted(() => ({ scope: { accounts: ['Alpha#EUW'], companion: null } as ScopeSnapshot, scopeReady: true }))
vi.mock('../app/scope', () => ({ useScope: () => state }))

const context = { accounts: ['Alpha#EUW'], role: 'MIDDLE', queue: '440', days: '90', unique_games: 42 }
const model = { status: 'exploratory', validated: false, model_version: 'test', message: 'Validazione temporale ancora da completare.' }
const candidate = (champion: string, supported = false) => ({
  champion, role: 'MIDDLE', icon_url: '', unique_games: 12, posterior_win_rate: 56.2,
  credible_lower_90: 40 as number | null, credible_upper_90: 70 as number | null, credible_mass: .8,
  historical_supported: supported, classification: supported ? 'supported' : 'promising',
})
const champions = () => ({ items: [candidate('Ahri'), candidate('Lux'), candidate('Annie'), candidate('Zed')], context, model })
const trainingPlan = () => ({
  budget_total: 400, budget_assigned: 350, budget_unassigned: 50, context, model,
  items: [
    { champion: 'Lux', role: 'MIDDLE', allocation_games: 100 },
    { champion: 'Ahri', role: 'MIDDLE', allocation_games: 250 },
    { champion: 'Annie', role: 'MIDDLE', allocation_games: 0 },
  ],
})
let rankingPayload = champions()
let planPayload = trainingPlan()
let failRanking = false
let failPlan = false
let holdBeta = false
let syncDate: string | null = '2026-10-22T12:45:00+00:00'
let failSync = false
const clients: QueryClient[] = []

function setup() {
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname === '/api/sync-status') return failSync
      ? Response.json({ error: 'Indisponibile' }, { status: 503 })
      : Response.json({ last_completed_at: syncDate, sync_active: false, last_checkpoint_at: '2026-10-23T10:00:00Z' })
    if (holdBeta && url.searchParams.get('account') === 'Beta#EUW') return new Promise<Response>(() => {})
    const isRanking = url.pathname === '/api/champions'
    if (isRanking ? failRanking : failPlan) return Response.json({ error: 'Indisponibile' }, { status: 503 })
    return Response.json(isRanking ? rankingPayload : planPayload)
  })
  vi.stubGlobal('fetch', fetch)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  const tree = () => <QueryClientProvider client={client}><MemoryRouter><OverviewPage /></MemoryRouter></QueryClientProvider>
  const rendered = render(tree())
  return { fetch, rerender: () => rendered.rerender(tree()) }
}

beforeEach(() => {
  localStorage.removeItem(OVERVIEW_FILTERS_KEY)
  localStorage.removeItem(PLAN_BUDGET_KEY)
  state.scope = { accounts: ['Alpha#EUW'], companion: null }
  state.scopeReady = true
  rankingPayload = champions()
  planPayload = trainingPlan()
  failRanking = failPlan = holdBeta = false
  syncDate = '2026-10-22T12:45:00+00:00'
  failSync = false
})
afterEach(() => { cleanup(); clients.splice(0).forEach((client) => client.clear()); vi.unstubAllGlobals() })

describe('Riepilogo personale', () => {
  it('mostra tre candidati reali, incertezza e piano parziale senza dichiarare un vincitore', async () => {
    setup()
    expect(await screen.findByRole('heading', { name: 'La scelta è ancora aperta.' })).toBeVisible()
    const list = screen.getByRole('list', { name: 'Campioni da confrontare' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(3)
    expect(within(list).queryByText('Zed')).not.toBeInTheDocument()
    expect(within(list).getAllByText('56,2%')).toHaveLength(3)
    expect(within(list).getAllByText('Intervallo 80%: 40%–70%')).toHaveLength(3)
    expect(screen.getByText(/La prima posizione non dimostra/)).toBeVisible()
    const plan = screen.getByRole('list', { name: 'Anteprima delle partite assegnate' })
    expect(within(plan).getAllByRole('listitem')[0]).toHaveTextContent('AhriCentrale250 partite')
    expect(within(plan).queryByText('Annie')).not.toBeInTheDocument()
    expect(screen.getByText('50 partite ancora da assegnare.')).toBeVisible()
    expect(screen.getByText('Analisi esplorativa')).toBeVisible()
    const updated = screen.getByText(/Ultimo aggiornamento dati:/)
    expect(updated.querySelector('time')).toHaveAttribute('dateTime', '2026-10-22T12:45:00.000Z')
    expect(updated).toHaveTextContent(new Date(syncDate!).toLocaleString('it-IT', { dateStyle: 'medium', timeStyle: 'short' }))
  })

  it('trasporta il contesto risolto al confronto, alla scheda e al piano', async () => {
    state.scope.companion = { accounts: ['Friend#EUW'], mode: 'only', name: 'Duo', profileAccounts: ['Alpha#EUW'] }
    const { fetch } = setup()
    await screen.findByRole('list', { name: 'Campioni da confrontare' })
    for (const label of ['Confronta i campioni', 'Apri il piano', 'Apri la scheda di Ahri, Corsia centrale']) {
      const url = new URL(screen.getByRole('link', { name: label }).getAttribute('href')!, 'http://localhost')
      expect(url.searchParams.get('role')).toBe('MIDDLE')
      expect(url.searchParams.get('queue')).toBe('440')
      expect(url.searchParams.get('days')).toBe('90')
      if (label === 'Apri il piano') expect(url.searchParams.get('budget')).toBe('400')
    }
    expect(screen.getByText('Solo con Duo')).toBeVisible()
    expect(within(screen.getByRole('region', { name: 'Dati del riepilogo' })).getByText('42')).toBeVisible()
    expect(fetch).toHaveBeenCalledTimes(3)
    for (const [input] of fetch.mock.calls.filter(([input]) => !String(input).includes('/api/sync-status'))) {
      const url = new URL(String(input), 'http://localhost')
      expect(url.searchParams.get('account')).toBe('Alpha#EUW')
      expect(url.searchParams.get('companion_account')).toBe('Friend#EUW')
      expect(url.searchParams.get('companion_mode')).toBe('only')
    }
  })

  it('non riusa il riepilogo o il piano dell’account precedente durante il caricamento', async () => {
    const view = setup()
    await screen.findByRole('list', { name: 'Campioni da confrontare' })
    await screen.findByRole('list', { name: 'Anteprima delle partite assegnate' })
    holdBeta = true
    state.scope = { accounts: ['Beta#EUW'], companion: null }
    view.rerender()
    expect(screen.queryByText('Ahri')).not.toBeInTheDocument()
    expect(screen.queryByText('42')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Caricamento del riepilogo dei campioni')).toBeVisible()
    expect(screen.getByLabelText('Calcolo dell’anteprima del piano')).toBeVisible()
    await waitFor(() => expect(view.fetch.mock.calls.filter(([input]) => String(input).includes('Beta'))).toHaveLength(2))
  })

  it('mantiene il confronto utilizzabile quando il piano fallisce e consente di riprovare', async () => {
    failPlan = true
    failSync = true
    setup()
    await screen.findByRole('heading', { name: 'Piano non disponibile' })
    expect(screen.getByRole('list', { name: 'Campioni da confrontare' })).toBeVisible()
    expect(await screen.findByText('Ultimo aggiornamento dati: non disponibile')).toBeVisible()
    failPlan = false
    await userEvent.click(screen.getByRole('button', { name: /Riprova/i }))
    expect(await screen.findByRole('list', { name: 'Anteprima delle partite assegnate' })).toBeVisible()
  })

  it('mantiene il piano leggibile se il rendimento non è disponibile', async () => {
    failRanking = true
    setup()
    expect(await screen.findByRole('heading', { name: 'Riepilogo dei campioni non disponibile' })).toBeVisible()
    expect(await screen.findByRole('list', { name: 'Anteprima delle partite assegnate' })).toBeVisible()
    expect(screen.queryByRole('heading', { name: 'La scelta è ancora aperta.' })).not.toBeInTheDocument()
  })

  it('descrive il contesto vuoto senza inventare risultati né partite assegnate', async () => {
    syncDate = null
    rankingPayload.items = []
    planPayload.items = []
    planPayload.budget_assigned = 0
    planPayload.budget_unassigned = 400
    setup()
    expect(await screen.findByRole('heading', { name: 'Nessun campione nel contesto attuale' })).toBeVisible()
    expect(screen.getByText('400 partite ancora da assegnare.')).toBeVisible()
    expect(screen.queryByRole('list', { name: 'Campioni da confrontare' })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Confronta i campioni' })).toBeVisible()
    expect(screen.getByText('Ultimo aggiornamento dati: non disponibile')).toBeVisible()
    expect(screen.getByText(/Ultimo aggiornamento dati:/).querySelector('time')).toBeNull()
  })

  it('distingue il supporto storico dalla validazione e lascia mancanti gli intervalli assenti', async () => {
    rankingPayload.items[0] = { ...candidate('Ahri', true), credible_lower_90: null, credible_upper_90: null }
    setup()
    expect(await screen.findByRole('heading', { name: 'Lo storico offre segnali da approfondire.' })).toBeVisible()
    expect(screen.getByText('Vantaggio storico supportato')).toBeVisible()
    expect(screen.getByText('Analisi esplorativa')).toBeVisible()
    expect(screen.getByText('Intervallo 80%: non disponibile')).toBeVisible()
    expect(screen.queryByText('Validazione temporale superata')).not.toBeInTheDocument()
  })

  it('con un solo campione non suggerisce un confronto già concluso', async () => {
    rankingPayload.items = [candidate('Ahri')]
    setup()
    expect(await screen.findByRole('heading', { name: 'Un primo punto di partenza.' })).toBeVisible()
    expect(screen.getByText(/Servono altri candidati per un confronto/)).toBeVisible()
  })
})
