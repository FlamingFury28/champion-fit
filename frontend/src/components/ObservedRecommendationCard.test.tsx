import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ObservedRecommendationDto } from '../api/types'
import { ObservedRecommendationCard } from './ObservedRecommendationCard'

const item: ObservedRecommendationDto = {
  champion: 'Ahri', name: 'Ahri', role: 'MIDDLE', icon_url: '', kind: 'familiar',
  preference_score: null, similarity: null, games: 1, account_count: 1,
  selected_account_count: 1, source_champions: [], reasons: [], feedback: null,
  performance: null,
}

afterEach(() => vi.unstubAllGlobals())

describe('ObservedRecommendationCard', () => {
  it('annuncia il fallimento del salvataggio della preferenza', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'Salvataggio non disponibile.' }), { status: 503, headers: { 'Content-Type': 'application/json' } })))
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    render(<QueryClientProvider client={client}><MemoryRouter><ObservedRecommendationCard item={item} feedbackAccounts={['Alpha#EUW']} feedbackRevision={2} /></MemoryRouter></QueryClientProvider>)

    await userEvent.click(screen.getByRole('button', { name: /Mi piace/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Salvataggio non disponibile')
  })
})
