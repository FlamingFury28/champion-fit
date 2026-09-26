import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { discoveryRecommendation, observedRecommendation, recommendationsFixture } from '../test/recommendations-fixture'
import { ChampionDetailPage } from './ChampionDetailPage'

vi.mock('../app/scope', () => ({ useScope: () => ({ scope: { accounts: ['Alpha#EUW'], companion: null }, scopeReady: true }) }))
function response(data: unknown) { return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } }) }
function setup(candidate = observedRecommendation(), context = '') {
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    void input
    void init
    return response(recommendationsFixture({ candidate, known: candidate.kind === 'familiar' ? [candidate] : [], discover: candidate.kind === 'discovery' ? [candidate] : [] }))
  })
  vi.stubGlobal('fetch', fetch)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[`/app/fit?section=choices&detail=${candidate.champion}&detailRole=${candidate.role}${context}`]}><ChampionDetailPage champion={candidate.champion} embedded /></MemoryRouter></QueryClientProvider>)
  return fetch
}
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('ChampionDetailPage nuovo motore', () => {
  it('mostra le varianti per ruolo senza aggregarne metriche o feedback quando il filtro è globale', async () => {
    const middle = observedRecommendation()
    const top = observedRecommendation({ role: 'TOP' })
    top.performance = { ...top.performance!, games: 2, observations: 2, wins: 0, losses: 2, win_rate: 0 }
    const fetch = vi.fn(async (input: RequestInfo | URL) => { void input; return response(recommendationsFixture({
      context: { accounts: ['Alpha#EUW'], role: 'ALL', queue: '420', days: 'all' },
      candidate: null,
      candidates: [middle, top],
      known: [],
      discover: [],
    })) })
    vi.stubGlobal('fetch', fetch)
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/app/fit?section=choices&detail=Ahri']}><ChampionDetailPage champion="Ahri" embedded /></MemoryRouter></QueryClientProvider>)

    expect(await screen.findByRole('heading', { name: 'Corsia centrale' })).toBeVisible()
    expect(screen.getByRole('heading', { name: 'Corsia superiore' })).toBeVisible()
    expect(screen.getByLabelText('Ruolo della scheda')).toHaveValue('')
    expect(screen.getByRole('option', { name: 'Tutti i ruoli · nessun filtro' })).toBeVisible()
    expect(screen.getByText('1 · 1–0')).toBeVisible()
    expect(screen.getByText('2 · 0–2')).toBeVisible()
    expect(screen.getAllByRole('button', { name: 'Mi piace' })).toHaveLength(2)
    expect(new URL(String(fetch.mock.calls[0]?.[0]), 'http://localhost').searchParams.has('role')).toBe(false)
  })

  it('mostra risultati grezzi anche con una sola partita e usa solo recommendations', async () => {
    const fetch = setup()
    expect(await screen.findByText(/Ahri fa già parte delle tue scelte/)).toBeVisible()
    expect(screen.getByText('1 · 1–0')).toBeVisible()
    expect(screen.getByText(/Nessun prior e nessun minimo di 20 partite/i)).toBeVisible()
    expect(screen.getByText(/Non ci sono ancora altre scelte confrontabili/i)).toBeVisible()
    expect(fetch.mock.calls.every((call) => String(call[0]).includes('/api/recommendations'))).toBe(true)
  })

  it('mantiene coda e periodo della lista nella richiesta di dettaglio', async () => {
    const fetch = setup(observedRecommendation(), '&queue=440&days=90')
    await screen.findByText(/Ahri fa già parte delle tue scelte/)
    const params = new URL(String(fetch.mock.calls[0]?.[0]), 'http://localhost').searchParams
    expect(params.get('queue')).toBe('440')
    expect(params.get('days')).toBe('90')
  })

  it('presenta una scoperta come affinità senza inventare risultati personali', async () => {
    setup(discoveryRecommendation())
    expect(await screen.findByText(/Orianna è una scoperta vicina ai tuoi gusti/)).toBeVisible()
    expect(screen.getAllByText('75%').length).toBeGreaterThan(0)
    expect(screen.getByText(/Non è una probabilità di vittoria personale/i)).toBeVisible()
    expect(screen.getByText(/Nessuna partita con questo campione/i)).toBeVisible()
    expect(screen.queryByText(/vittorie stimate/i)).not.toBeInTheDocument()
  })

  it('distingue una preferenza dichiarata senza partite da un campione già giocato', async () => {
    setup(observedRecommendation({ games: 0, performance: null, feedback: 'like' }))
    expect(await screen.findByText(/Ahri è una preferenza dichiarata/)).toBeVisible()
    expect(screen.getAllByText('Preferenza dichiarata').length).toBeGreaterThan(0)
    expect(screen.queryByText('Già giocato')).not.toBeInTheDocument()
  })

  it('non trasforma una similarità assente in zero percento', async () => {
    setup(discoveryRecommendation({ similarity: null }))
    expect(await screen.findByText(/Orianna è una scoperta da valutare/)).toBeVisible()
    expect(screen.getAllByText(/Affinità non stimata/i).length).toBeGreaterThan(0)
    expect(screen.queryByText('0%')).not.toBeInTheDocument()
  })

  it('separa le medie con coperture diverse dal confronto sugli stessi account', async () => {
    const candidate = observedRecommendation({ account_count: 3, selected_account_count: 4 })
    candidate.performance = {
      ...candidate.performance!, games: 5, observations: 8, wins: 5, losses: 3, win_rate: 67.6,
      baseline_games: 20, baseline_win_rate: 52.8, baseline_low: 40, baseline_high: 65,
      lift_pp: 0.8, comparable_accounts: ['Alpha#EUW', 'Beta#EUW'],
    }
    setup(candidate)
    expect(await screen.findAllByText(/Media degli account esposti/)).not.toHaveLength(0)
    expect(screen.getAllByText(/Differenza negli account confrontabili \(2\)/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/2\/3 account esposti/).length).toBeGreaterThan(0)
    expect(screen.getAllByText('+0,8 pp').length).toBeGreaterThan(0)
    expect(screen.getByText(/non sottrae le due medie complessive/i)).toBeVisible()
  })
})
