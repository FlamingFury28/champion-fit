import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { recommendationsFixture } from '../test/recommendations-fixture'
import { FitPage } from './FitPage'

const { context } = vi.hoisted(() => ({ context: { scope: { accounts: ['Alpha#EUW'], companion: null }, scopeReady: true } }))
vi.mock('../app/scope', () => ({ useScope: () => context }))

function response(data: unknown, status = 200) { return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }) }
function renderFit(fetchImpl: typeof fetch, url = '/app/fit?section=choices') {
  vi.stubGlobal('fetch', vi.fn(fetchImpl))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return { user: userEvent.setup(), client, ...render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[url]}><FitPage /></MemoryRouter></QueryClientProvider>) }
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); context.scope.accounts = ['Alpha#EUW'] })

describe('FitPage osservazioni e preferenze', () => {
  it('parte da tutti i ruoli senza inviare un filtro e mantiene espliciti i link delle carte', async () => {
    const calls: string[] = []
    renderFit((input) => { calls.push(String(input)); return Promise.resolve(response(recommendationsFixture())) })
    expect(await screen.findByText('Ahri')).toBeVisible()
    expect(screen.getByLabelText('Ruolo')).toHaveValue('')
    expect(screen.getByRole('option', { name: 'Tutti i ruoli · nessun filtro' })).toBeVisible()
    expect(new URL(calls[0]!, 'http://localhost').searchParams.has('role')).toBe(false)
    expect(screen.getByRole('link', { name: 'Apri la scheda' })).toHaveAttribute('href', expect.stringContaining('detailRole=MIDDLE'))
  })

  it('mostra una scelta utile anche con una sola partita, senza soglia operativa', async () => {
    renderFit(() => Promise.resolve(response(recommendationsFixture())))
    expect(await screen.findByText(/1 partita unica · 1 vittoria e 0 sconfitte in 1 osservazione account-partita/)).toBeVisible()
    expect(screen.getByText(/con 1 partita il confronto dei risultati resta instabile/i)).toBeVisible()
    expect(screen.queryByText(/dati non bastano/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/prior/i)).not.toBeInTheDocument()
  })

  it('separa l’affinità di catalogo dai risultati personali', async () => {
    const { user } = renderFit(() => Promise.resolve(response(recommendationsFixture())))
    await screen.findByText('Ahri')
    await user.click(screen.getByRole('button', { name: /Da scoprire/ }))
    expect(screen.getByText('Orianna')).toBeVisible()
    expect(screen.getByText('75%')).toBeVisible()
    expect(screen.getByText(/Somiglianza di caratteristiche, non probabilità di vittoria/i)).toBeVisible()
    expect(screen.getByText(/Nessuna partita con questo campione/i)).toBeVisible()
    expect(screen.getByText(/Duello, Danno prolungato/)).toBeVisible()
    expect(screen.queryByText(/duel|sustained/)).not.toBeInTheDocument()
  })

  it('rende raggiungibile l’analisi degli stili dal percorso principale', async () => {
    renderFit(() => Promise.resolve(response(recommendationsFixture())))
    const link = await screen.findByRole('link', { name: 'Quale stile mi conviene?' })
    expect(link).toHaveAttribute('href', '/app/matches?section=style')
  })

  it('invia il feedback solo agli account spuntati e usa la revisione CAS', async () => {
    context.scope.accounts = ['Alpha#EUW', 'Beta#EUW']
    const payload = recommendationsFixture({
      coverage: { selected_accounts: ['Alpha#EUW', 'Beta#EUW'], active_accounts: ['Alpha#EUW'], missing_accounts: ['Beta#EUW'], games: 1, observations: 1 },
    })
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const { user } = renderFit((input, init) => {
      calls.push({ url: String(input), init })
      return Promise.resolve(response(init?.method === 'POST' ? { feedback_revision: 8 } : payload))
    })
    await screen.findByText('Ahri')
    await user.click(screen.getByRole('checkbox', { name: 'Beta#EUW' }))
    await user.click(screen.getByRole('button', { name: 'Mi piace' }))
    await waitFor(() => expect(calls.some((call) => call.url.includes('/api/recommendation-feedback'))).toBe(true))
    const feedbackCall = calls.find((call) => call.url.includes('/api/recommendation-feedback'))!
    expect(JSON.parse(String(feedbackCall.init?.body))).toEqual({ accounts: ['Alpha#EUW'], champion: 'Ahri', role: 'MIDDLE', preference: 'like', expected_revision: 7 })
  })

  it('non lascia visibile il consiglio precedente mentre cambia ruolo', async () => {
    const { user } = renderFit((input) => String(input).includes('role=TOP') ? new Promise<Response>(() => undefined) : Promise.resolve(response(recommendationsFixture())))
    expect(await screen.findByText('Ahri')).toBeVisible()
    await user.selectOptions(screen.getByLabelText('Ruolo'), 'TOP')
    expect(screen.queryByText('Ahri')).not.toBeInTheDocument()
    expect(screen.getByRole('status', { name: 'Caricamento dei suggerimenti' })).toBeVisible()
  })

  it('mantiene accounts vuoto quando il perimetro rappresenta tutti gli account attivi', async () => {
    context.scope.accounts = []
    const payload = recommendationsFixture({ coverage: { selected_accounts: ['Alpha#EUW', 'Beta#EUW'], active_accounts: ['Alpha#EUW', 'Beta#EUW'], missing_accounts: [], games: 2, observations: 2 } })
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const { user } = renderFit((input, init) => { calls.push({ url: String(input), init }); return Promise.resolve(response(init?.method === 'POST' ? {} : payload)) })
    await screen.findByText('Ahri')
    await user.click(screen.getByText(/Account ·/))
    expect(screen.getByText(/si applica a tutti gli account selezionati nel perimetro/i)).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Mi piace' }))
    await waitFor(() => expect(calls.some((call) => call.url.includes('/api/recommendation-feedback'))).toBe(true))
    const body = JSON.parse(String(calls.find((call) => call.url.includes('/api/recommendation-feedback'))?.init?.body))
    expect(body.accounts).toEqual([])
  })
})
