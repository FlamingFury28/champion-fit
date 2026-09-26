import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
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

function renderPage(url = '/app/fit?section=tournament&role=MIDDLE&queue=440&days=90') {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } }))
  vi.stubGlobal('fetch', fetch)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[url]}><CompetitivePlanPage embedded /></MemoryRouter></QueryClientProvider>)
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

  it('invia il budget 400 insieme ai filtri e mantiene il ciclo breve separato', async () => {
    const fetch = renderPage()
    expect(await screen.findByText('Ahri')).toBeVisible()
    const url = new URL(String(fetch.mock.calls[0]?.[0]), 'http://localhost')
    expect(url.pathname).toBe('/api/training-plan')
    expect(url.searchParams.get('budget')).toBe('400')
    expect(url.searchParams.get('role')).toBe('MIDDLE')
    expect(url.searchParams.get('queue')).toBe('440')
    expect(url.searchParams.get('days')).toBe('90')
    expect(screen.getByText(/Piano di prove.*continua/i)).toBeVisible()
  })
})
