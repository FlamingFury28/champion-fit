import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChampionPerformancePage } from './ChampionPerformancePage'

vi.mock('../app/scope', () => ({ useScope: () => ({ scope: { accounts: ['Alpha#EUW'], companion: null }, scopeReady: true }) }))

const payload = {
  items: [{
    champion: 'Ahri', role: 'MIDDLE', icon_url: '/Ahri.png', games_observed: 4, unique_games: 4,
    raw_win_rate: 75, posterior_win_rate: 56.2, credible_lower_90: 40, credible_upper_90: 70, credible_mass: 0.9,
    posterior_lift_pp: 6.2, probability_meaningful_advantage: 61, historical_supported: false,
    classification: 'promising', account_coverage: 1, account_count: 1,
  }],
  context: { accounts: ['Alpha#EUW'], role: 'MIDDLE', queue: '440', days: '90', unique_games: 4 },
  model: { status: 'exploratory', validated: false, model_version: 'test', message: 'Resta esplorativo.' },
}

function renderPage(url = '/app/fit?section=best&role=MIDDLE&queue=440&days=90') {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } }))
  vi.stubGlobal('fetch', fetch)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[url]}><ChampionPerformancePage embedded /></MemoryRouter></QueryClientProvider>)
  return fetch
}

afterEach(() => { payload.items[0]!.posterior_lift_pp = 6.2; payload.items[0]!.credible_mass = 0.9; cleanup(); vi.unstubAllGlobals() })

describe('rendimento dei campioni', () => {
  it('mostra stima, intervallo, stato esplorativo e contesto esplicito', async () => {
    renderPage()
    expect(await screen.findByText('Prima stima storica: Ahri · 56,2%')).toBeVisible()
    expect(screen.getByText('Positivo da verificare')).toBeVisible()
    expect(screen.getByText(/40%–70%/)).toBeVisible()
    expect(screen.getByText(/Account attivi: Alpha#EUW/)).toBeVisible()
    expect(screen.getByText('Analisi esplorativa')).toBeVisible()
    expect(screen.getByText(/non è una previsione di vittoria/i)).toBeVisible()
  })

  it('invia ruolo, modalità e periodo scelti dal pannello', async () => {
    const fetch = renderPage()
    expect(await screen.findByText('Ahri')).toBeVisible()
    const url = new URL(String(fetch.mock.calls[0]?.[0]), 'http://localhost')
    expect(url.searchParams.get('role')).toBe('MIDDLE')
    expect(url.searchParams.get('queue')).toBe('440')
    expect(url.searchParams.get('days')).toBe('90')
    expect(screen.getByRole('option', { name: 'Tutte le modalità' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Tutti i ruoli' })).toBeInTheDocument()
  })

  it('non mostra uno scarto arrotondato a zero con segno negativo', async () => {
    payload.items[0]!.posterior_lift_pp = -0.03
    renderPage()
    const row = await screen.findByRole('row', { name: /Ahri/ })
    expect(row).toHaveTextContent('0%')
    expect(row).not.toHaveTextContent('-0%')
  })

  it('descrive la massa effettiva restituita senza fissare il 90%', async () => {
    payload.items[0]!.credible_mass = .8
    renderPage()
    expect(await screen.findByRole('columnheader', { name: 'Intervallo 80%' })).toBeVisible()
    expect(screen.queryByRole('columnheader', { name: 'Intervallo 90%' })).not.toBeInTheDocument()
  })

  it('mantiene i default della lista e passa il contesto risolto soltanto alla scheda', async () => {
    renderPage('/app/fit?section=best')
    const link = await screen.findByRole('link', { name: /Ahri/ })
    const target = new URL(link.getAttribute('href')!, 'http://localhost')
    expect(target.searchParams.get('detailQueue')).toBe('440')
    expect(target.searchParams.get('detailDays')).toBe('90')
    expect(target.searchParams.has('queue')).toBe(false)
    expect(target.searchParams.has('days')).toBe(false)
    expect(screen.getByLabelText('Modalità')).toHaveValue('')
    expect(screen.getByLabelText('Periodo')).toHaveValue('')
  })
})
