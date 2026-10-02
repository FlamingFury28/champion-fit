import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RecommendationsResponseDto } from '../api/types'
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

function renderScout(url: string, overrides: Partial<RecommendationsResponseDto> = {}) {
  const discovery = discoveryRecommendation({
    source_champions: [{ champion: 'Ahri', name: 'Ahri', games: 1, similarity: 0.75, matched_tags: ['class:assassin', 'style:duel'] }],
  })
  vi.stubGlobal('fetch', vi.fn(async () => response(recommendationsFixture({ known: [], discover: [discovery], ...overrides }))))
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

  it('esclude account sospesi e non risolti dai destinatari delle preferenze', async () => {
    renderScout('/app/fit?section=training', {
      context: {
        accounts: ['Alpha#EUW', 'Suspended#EUW', 'Unknown#EUW'],
        role: 'MIDDLE', queue: '420', days: 'all',
        suspended_accounts: ['Suspended#EUW'], unresolved_accounts: ['Unknown#EUW'],
      },
      coverage: {
        selected_accounts: ['Alpha#EUW', 'Suspended#EUW', 'Unknown#EUW'],
        active_accounts: ['Alpha#EUW'],
        missing_accounts: ['Suspended#EUW', 'Unknown#EUW'],
        games: 1, observations: 1,
      },
    })
    const card = (await screen.findByText('Orianna')).closest<HTMLElement>('.recommendation-card')!
    expect(within(card).getByText('Si applica a Alpha#EUW.')).toBeVisible()
    expect(within(card).queryByText(/Suspended#EUW/)).not.toBeInTheDocument()
    expect(within(card).queryByText(/Unknown#EUW/)).not.toBeInTheDocument()
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
