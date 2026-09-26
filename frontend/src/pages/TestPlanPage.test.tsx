import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { recommendationsFixture } from '../test/recommendations-fixture'
import { TestPlanPage } from './TestPlanPage'

vi.mock('../app/scope', () => ({ useScope: () => ({ scope: { accounts: ['Alpha#EUW'], companion: null }, scopeReady: true }) }))
function response(data: unknown) { return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } }) }
function renderPlan(data = recommendationsFixture(), url = '/app/fit?section=training&training=plan') {
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    void input
    void init
    return response(data)
  })
  vi.stubGlobal('fetch', fetch)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[url]}><TestPlanPage embedded /></MemoryRouter></QueryClientProvider>)
  return fetch
}
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('piano breve delle raccomandazioni', () => {
  it('propone tre candidati con una partita ciascuno senza budget storico', async () => {
    renderPlan()
    expect(await screen.findByText('Orianna')).toBeVisible()
    expect(screen.getByText('Syndra')).toBeVisible()
    expect(screen.getByText('Viktor')).toBeVisible()
    expect(screen.getByText('Partite nel ciclo').parentElement).toHaveTextContent('3')
    expect(screen.getAllByText('1')).toHaveLength(4)
    expect(screen.queryByLabelText('Partite del prossimo ciclo')).not.toBeInTheDocument()
    expect(screen.queryByText(/riduzione.*incertezza/i)).not.toBeInTheDocument()
  })

  it('offre tutti i ruoli come default e invia ruolo e contesto quando sono espliciti', async () => {
    const defaultFetch = renderPlan()
    await screen.findByText('Orianna')
    expect(screen.getByLabelText('Ruolo')).toHaveValue('')
    expect(screen.getByRole('option', { name: 'Tutti i ruoli · nessun filtro' })).toBeVisible()
    expect(new URL(String(defaultFetch.mock.calls[0]?.[0]), 'http://localhost').searchParams.has('role')).toBe(false)
    cleanup()
    const fetch = renderPlan(recommendationsFixture(), '/app/fit?section=training&training=plan&role=TOP&queue=440&days=90')
    await screen.findByText('Orianna')
    const requestUrl = String(fetch.mock.calls[0]?.[0])
    expect(requestUrl).toContain('role=TOP')
    expect(requestUrl).toContain('queue=440')
    expect(requestUrl).toContain('days=90')
    expect(screen.getByRole('option', { name: 'Tutti i ruoli · nessun filtro' })).toBeVisible()
  })
})
