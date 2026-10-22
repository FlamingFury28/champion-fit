import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ObservedRecommendationDto } from '../api/types'
import { ObservedRecommendationCard } from './ObservedRecommendationCard'
import { observedRecommendation } from '../test/recommendations-fixture'

const item: ObservedRecommendationDto = {
  champion: 'Ahri', name: 'Ahri', role: 'MIDDLE', icon_url: '', kind: 'familiar',
  preference_score: null, similarity: null, games: 1, account_count: 1,
  selected_account_count: 1, source_champions: [], reasons: [], feedback: null,
  performance: null,
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('ObservedRecommendationCard', () => {
  it('conserva la copertura frazionaria dell’intervallo binomiale', () => {
    const candidate = observedRecommendation()
    candidate.performance!.confidence = .955
    const client = new QueryClient()
    render(<QueryClientProvider client={client}><MemoryRouter><ObservedRecommendationCard item={candidate} feedbackAccounts={[]} feedbackRevision={2} showFeedback={false} /></MemoryRouter></QueryClientProvider>)
    expect(screen.getByText('Intervallo binomiale al 95,5%')).toBeVisible()
    expect(screen.queryByText('Intervallo binomiale al 96%')).not.toBeInTheDocument()
  })

  it('annuncia il fallimento del salvataggio della preferenza', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'Salvataggio non disponibile.' }), { status: 503, headers: { 'Content-Type': 'application/json' } })))
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    render(<QueryClientProvider client={client}><MemoryRouter><ObservedRecommendationCard item={item} feedbackAccounts={['Alpha#EUW']} feedbackRevision={2} /></MemoryRouter></QueryClientProvider>)

    await userEvent.click(screen.getByRole('button', { name: /Mi piace/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Salvataggio non disponibile')
  })

  it('non invalida il registro né conferma un salvataggio con risposta200 vuota', async () => {
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(Response.json({})))
    vi.stubGlobal('fetch', fetch)
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    const invalidation = vi.spyOn(client, 'invalidateQueries')
    render(<QueryClientProvider client={client}><MemoryRouter><ObservedRecommendationCard item={item} feedbackAccounts={['Alpha#EUW']} feedbackRevision={2} /></MemoryRouter></QueryClientProvider>)

    await userEvent.click(screen.getByRole('button', { name: /Mi piace/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('L’esito della richiesta non è confermato')
    await waitFor(() => expect(screen.getByRole('button', { name: /Mi piace/ })).toBeEnabled())
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(invalidation).not.toHaveBeenCalled()
    client.clear()
  })
})
