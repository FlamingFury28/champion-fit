import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { discoveryRecommendation, recommendationsFixture } from '../test/recommendations-fixture'
import { ScoutPage } from './ScoutPage'

vi.mock('../app/scope', () => ({ useScope: () => ({ scope: { accounts: ['Alpha#EUW'], companion: null }, scopeReady: true }) }))

function LocationProbe() {
  const location = useLocation()
  return <output aria-label="URL corrente">{location.search}</output>
}

function response(data: unknown) {
  return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

function renderScout(url: string) {
  const discovery = discoveryRecommendation({
    source_champions: [{ champion: 'Ahri', name: 'Ahri', games: 1, similarity: 0.75, matched_tags: ['class:assassin', 'style:duel'] }],
  })
  vi.stubGlobal('fetch', vi.fn(async () => response(recommendationsFixture({ known: [], discover: [discovery] }))))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const user = userEvent.setup()
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[url]}><ScoutPage embedded /><LocationProbe /></MemoryRouter></QueryClientProvider>)
  return user
}

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('ScoutPage filtro categoria dagli stili', () => {
  it('parte da tutti i ruoli senza filtro e conserva il ruolo concreto nel link', async () => {
    renderScout('/app/fit?section=training')
    expect(await screen.findByText('Orianna')).toBeVisible()
    expect(screen.getByLabelText('Ruolo')).toHaveValue('')
    expect(screen.getByRole('option', { name: 'Tutti i ruoli · nessun filtro' })).toBeVisible()
    expect(screen.getByRole('link', { name: 'Apri la scheda' })).toHaveAttribute('href', expect.stringContaining('detailRole=MIDDLE'))
  })

  it('usa category come alias iniziale di tag e la elimina quando cambia filtro', async () => {
    const user = renderScout('/app/fit?section=training&category=class%3Aassassin')
    expect(await screen.findByText('Orianna')).toBeVisible()
    const select = screen.getByLabelText('Caratteristica')
    expect(select).toHaveValue('class:assassin')
    expect(screen.getByRole('option', { name: 'Assassino' })).toBeVisible()
    await user.selectOptions(select, 'ALL')
    await waitFor(() => expect(screen.getByLabelText('URL corrente')).not.toHaveTextContent('category='))
  })

  it('mantiene visibile una categoria attiva senza corrispondenze e il reset la rimuove', async () => {
    const user = renderScout('/app/fit?section=training&category=style%3Azone')
    expect(await screen.findByText('Nessuna scoperta per questi filtri')).toBeVisible()
    expect(screen.getByLabelText('Caratteristica')).toHaveValue('style:zone')
    expect(screen.getByRole('option', { name: 'Controllo dell’area' })).toBeVisible()
    await user.click(screen.getByRole('button', { name: /Azzera ricerca e affinità/ }))
    expect(await screen.findByText('Orianna')).toBeVisible()
    expect(screen.getByLabelText('URL corrente')).not.toHaveTextContent('category=')
  })
})
