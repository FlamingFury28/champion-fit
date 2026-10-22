import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Link, MemoryRouter, useNavigate } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CompetitivePlanPage } from './CompetitivePlanPage'

vi.mock('../app/scope', () => ({ useScope: () => ({ scope: { accounts: ['Alpha#EUW'], companion: null }, scopeReady: true }) }))

const payload = {
  budget_total: 400, budget_assigned: 400, budget_default: 400, budget_unassigned: 0,
  objective: 'expected_final_simple_regret', optimizer: 'greedy_common_random_numbers_v1',
  simulation_scenarios: 512, monte_carlo_se: 0.002, expected_regret_now: 0.12,
  expected_regret_after: 0.06, expected_regret_reduction: 0.06,
  model: { status: 'exploratory', validated: false, model_version: 'test', message: 'Piano esplorativo.' },
  context: { accounts: ['Alpha#EUW'], role: 'MIDDLE', queue: '440', days: '90' },
  items: [{ champion: 'Ahri', role: 'MIDDLE', icon_url: '/Ahri.png', games: 4, unique_games: 4,
    reliability: 'exploratory', actionable: false, classification: 'promising', historical_supported: false,
    posterior_win_rate: 56.2, posterior_lift_pp: 6.2, allocation_games: 400,
    account_allocations: [{ account: 'Alpha#EUW', games: 400 }], rationale: 'Monte Carlo.' }],
}

function HistoryControls() {
  const navigate = useNavigate()
  return <><Link to="/app/fit?section=tournament&budget=800">Apri altro budget</Link><button onClick={() => navigate(-1)}>Indietro nel test</button></>
}

function renderPage(url = '/app/fit?section=tournament&role=MIDDLE&queue=440&days=90', data = payload, historyControls = false) {
  const fetch = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } })))
  vi.stubGlobal('fetch', fetch)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[url]}><CompetitivePlanPage embedded />{historyControls ? <HistoryControls /> : null}</MemoryRouter></QueryClientProvider>)
  return fetch
}

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('piano competitivo', () => {
  it('parte da 400 partite e mostra budget, rimpianto e candidato comparator', async () => {
    renderPage()
    const allocationMetric = await screen.findByText('Partite allocate')
    expect(allocationMetric.parentElement).toHaveTextContent('400/400')
    expect(screen.getByRole('heading', { name: 'Piano da 400 partite' })).toBeVisible()
    expect(screen.getByText('Ahri')).toBeVisible()
    expect(screen.getByText(/riduzione attesa del rimpianto/i)).toBeVisible()
    expect(screen.getByText(/euristica greedy con scenari/i)).toBeVisible()
    expect(screen.getByLabelText('Budget partite')).toHaveValue(400)
  })

  it('invia il budget 400 insieme ai filtri senza promuovere il ciclo breve', async () => {
    const fetch = renderPage()
    expect(await screen.findByText('Ahri')).toBeVisible()
    const url = new URL(String(fetch.mock.calls[0]?.[0]), 'http://localhost')
    expect(url.pathname).toBe('/api/training-plan')
    expect(url.searchParams.get('budget')).toBe('400')
    expect(url.searchParams.get('role')).toBe('MIDDLE')
    expect(url.searchParams.get('queue')).toBe('440')
    expect(url.searchParams.get('days')).toBe('90')
    expect(screen.queryByText(/Piano di prove/i)).not.toBeInTheDocument()
  })

  it('permette di digitare 1000 senza richieste intermedie e salva su Enter', async () => {
    const fetch = renderPage()
    await screen.findByText('Ahri')
    let resolvePlan!: (response: Response) => void
    fetch.mockImplementationOnce(() => new Promise<Response>((resolve) => { resolvePlan = resolve }))
    const user = userEvent.setup()
    const input = screen.getByLabelText('Budget partite')
    await user.clear(input)
    expect(input).toHaveValue(null)
    await user.type(input, '1000')
    expect(input).toHaveValue(1000)
    expect(screen.getByRole('heading', { name: 'Piano da 400 partite' })).toBeVisible()
    expect(fetch.mock.calls).toHaveLength(1)
    await user.keyboard('{Enter}')
    await waitFor(() => expect(fetch.mock.calls).toHaveLength(2))
    expect(new URL(String(fetch.mock.calls[1]?.[0]), 'http://localhost').searchParams.get('budget')).toBe('1000')
    expect(input).toHaveValue(1000)
    expect(screen.getByRole('heading', { name: 'Piano da 1000 partite' })).toBeVisible()
    expect(screen.getByText('Sto calcolando il piano competitivo')).toBeVisible()
    expect(screen.queryByText('Ahri')).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Riepilogo del piano' })).not.toBeInTheDocument()
    await act(async () => resolvePlan(Response.json({
      ...payload, budget_total: 1000, budget_assigned: 1000,
      items: payload.items.map((item) => ({ ...item, allocation_games: 1000, account_allocations: [{ account: 'Alpha#EUW', games: 1000 }] })),
    })))
    expect(await screen.findByText('Ahri')).toBeVisible()
    expect(screen.getByText('Partite allocate').parentElement).toHaveTextContent('1000/1000')
    expect(screen.getByRole('heading', { name: 'Piano da 1000 partite' })).toBeVisible()
  })

  it.each([['1', 20], ['3000', 2000], ['', 400]])('limita il draft %s soltanto quando perde il focus', async (draft, committed) => {
    const fetch = renderPage()
    await screen.findByText('Ahri')
    const user = userEvent.setup()
    const input = screen.getByLabelText('Budget partite')
    await user.clear(input)
    if (draft) await user.type(input, draft)
    expect(input).toHaveValue(draft ? Number(draft) : null)
    expect(fetch.mock.calls).toHaveLength(1)
    await user.tab()
    expect(input).toHaveValue(committed)
    expect(screen.getByRole('heading', { name: `Piano da ${committed} partite` })).toBeVisible()
    await waitFor(() => expect(new URL(String(fetch.mock.calls.at(-1)?.[0]), 'http://localhost').searchParams.get('budget')).toBe(String(committed)))
  })

  it('sincronizza il draft con budget da link, ritorno indietro e indirizzo ricaricato', async () => {
    renderPage('/app/fit?section=tournament&budget=400', payload, true)
    await screen.findByText('Ahri')
    const user = userEvent.setup()
    await user.click(screen.getByRole('link', { name: 'Apri altro budget' }))
    expect(screen.getByLabelText('Budget partite')).toHaveValue(800)
    expect(screen.getByRole('heading', { name: 'Piano da 800 partite' })).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Indietro nel test' }))
    expect(screen.getByLabelText('Budget partite')).toHaveValue(400)
    expect(screen.getByRole('heading', { name: 'Piano da 400 partite' })).toBeVisible()
    cleanup()
    renderPage('/app/fit?section=tournament&budget=800')
    expect(screen.getByLabelText('Budget partite')).toHaveValue(800)
    expect(screen.getByRole('heading', { name: 'Piano da 800 partite' })).toBeVisible()
  })

  it('trasporta il contesto risolto nel link della scheda senza rendere espliciti i default lista', async () => {
    renderPage('/app/fit?section=tournament')
    const link = await screen.findByRole('link', { name: /Ahri/ })
    const target = new URL(link.getAttribute('href')!, 'http://localhost')
    expect(target.searchParams.get('detailQueue')).toBe('440')
    expect(target.searchParams.get('detailDays')).toBe('90')
    expect(target.searchParams.has('queue')).toBe(false)
    expect(target.searchParams.has('days')).toBe(false)
  })

  it('distingue il risultato vuoto dal modello esplorativo', async () => {
    renderPage(undefined, { ...payload, items: [], budget_assigned: 0, budget_unassigned: 400 })
    expect(await screen.findByText('Contesto senza candidati')).toBeVisible()
    expect(screen.getByText('Nessun candidato nel contesto selezionato')).toBeVisible()
    expect(screen.queryByText('Piano esplorativo')).not.toBeInTheDocument()
  })

  it('non dichiara un risultato vuoto durante caricamento o errore', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error('Errore sintetico'))
    vi.stubGlobal('fetch', fetch)
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/app/fit?section=tournament&budget=1000']}><CompetitivePlanPage /></MemoryRouter></QueryClientProvider>)
    expect(screen.getByRole('heading', { name: 'Piano da 1000 partite' })).toBeVisible()
    expect(screen.getByText('Sto calcolando il piano competitivo')).toBeVisible()
    expect(screen.queryByText('Nessun candidato nel contesto selezionato')).not.toBeInTheDocument()
    expect(await screen.findByText('Errore di caricamento')).toBeVisible()
    expect(screen.getByRole('heading', { name: 'Piano da 1000 partite' })).toBeVisible()
    expect(screen.getByText('Il piano competitivo non è disponibile')).toBeVisible()
    expect(screen.queryByText('Nessun candidato nel contesto selezionato')).not.toBeInTheDocument()
  })
})
