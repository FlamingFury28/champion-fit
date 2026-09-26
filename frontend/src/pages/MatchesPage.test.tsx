import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { queryKeys } from '../api/queries'
import type { ProfileResponseDto } from '../api/types'
import { MatchesPage } from './MatchesPage'

const { context } = vi.hoisted(() => ({ context: { scope: { accounts: ['Alpha#EUW'], companion: null }, scopeReady: true } }))
vi.mock('../app/scope', () => ({ useScope: () => context }))
vi.mock('./AuditPage', () => ({ AuditPage: ({ embedded }: { embedded?: boolean }) => <section data-testid="audit">Revisione {String(embedded)}</section> }))
vi.mock('./PlaystylesPage', () => ({ PlaystylesPage: ({ embedded }: { embedded?: boolean }) => <section data-testid="styles">Stili {String(embedded)}</section> }))

const profile: ProfileResponseDto = {
  accounts: ['Alpha#EUW'],
  summary: { games: 12, wins: 7, losses: 5, win_rate: 58.3, avg_duration: 29, champions_played: 4, first_game: '2026-01-01', last_game: '2026-09-01', invincible_games: 0, carryable_losses: 0, afk_games: 0, griefer_games: 0 },
  recent: [{ date: '2026-09-01', account: 'Alpha#EUW', champion: 'Ahri', role: 'MIDDLE', win: 1, queue: '420', duration_minutes: 30, match_quality_score: .9, anomaly_flags: '' }],
  champions: [], roles: [{ role: 'MIDDLE', games: 9, wins: 6, win_rate: 66.7 }], weekdays: [], recommendations: [],
}

function LocationProbe() { return <output data-testid="location">{useLocation().search}</output> }

function renderPage(url = '/app/matches') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.profile(context.scope), profile)
  return render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[url]}><MatchesPage /><LocationProbe /></MemoryRouter></QueryClientProvider>)
}

afterEach(cleanup)

describe('hub Le mie partite', () => {
  it('usa history come sezione predefinita con un solo h1 e senza duplicare lo storico esteso', () => {
    renderPage('/app/matches?queue=420')
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
    expect(screen.getByRole('heading', { level: 1, name: 'Le mie partite' })).toBeInTheDocument()
    expect(screen.getByTestId('audit')).toHaveTextContent('Revisione true')
    expect(screen.getByRole('heading', { name: 'Andamento recente' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'I tuoi ruoli' })).toBeInTheDocument()
  })

  it('naviga allo stile conservando i parametri URL', async () => {
    renderPage('/app/matches?queue=420&days=all')
    await userEvent.click(screen.getByRole('link', { name: 'Stile di gioco' }))
    expect(screen.getByTestId('location')).toHaveTextContent('?queue=420&days=all&section=style')
    expect(screen.getByTestId('styles')).toHaveTextContent('Stili true')
    expect(screen.queryByTestId('audit')).not.toBeInTheDocument()
  })
})
