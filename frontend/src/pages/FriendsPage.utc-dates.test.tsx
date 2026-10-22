import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FriendDto, FriendsResponseDto } from '../api/types'
import { dataViewStore } from '../app/data-view'
import { FriendsPage } from './FriendsPage'

vi.mock('../app/scope', () => ({ useScope: () => ({ scope: { accounts: ['Alpha#EUW'], companion: null }, scopeReady: true }) }))
vi.mock('../components/toast', () => ({ useToast: () => ({ notify: vi.fn() }) }))

const clients: QueryClient[] = []
// Shape and UTC extrema from the isolated server reproduction.
const friend: FriendDto = {
  friend_key: 'night-friend', friend: 'NightFriend#EUW', shared_games: 2, accounts_played_with: 1,
  first_game: '2026-09-24T23:30:00.000000+00:00', last_game: '2026-09-24T23:30:00.000000+00:00',
  friend_win_rate: 100, posterior_win_rate: 60, credible_lower_90: 34.5, credible_upper_90: 83.1,
  personal_effective_sample_size: 2, actionable: false, baseline_win_rate: 55.6, reliability: 'exploratory',
}

function setup() {
  const requests: URL[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    if ((init?.method ?? 'GET') !== 'GET' || url.pathname !== '/api/friends') throw new Error('Unexpected request')
    requests.push(url)
    // Both server cutoffs use the canonical UTC date, not the viewer's local day.
    const items = ['games_from', 'last_game_from'].some((key) => (url.searchParams.get(key) ?? '') > friend.last_game.slice(0, 10)) ? [] : [friend]
    const payload: FriendsResponseDto = { items, manual_groups: [], summary: {
      tracked_accounts: 1, matches_with_participants: 2, friends_found: items.length, min_shared_games: 1, accounts: ['Alpha#EUW'],
    } }
    return Response.json(payload)
  }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  clients.push(client)
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/app/team/friends?min_games=1&queue=420&last_game_from=2026-09-24']}><FriendsPage /></MemoryRouter></QueryClientProvider>)
  return { requests }
}

beforeEach(() => {
  vi.stubEnv('TZ', 'Europe/Rome')
  localStorage.clear()
  dataViewStore.dispose()
})

afterEach(() => {
  cleanup()
  clients.splice(0).forEach((client) => client.clear())
  dataViewStore.dispose()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('giorni UTC dei compagni', () => {
  it.each(['games_from', 'last_game_from'] as const)('allinea ultima data e cutoff %s senza trasformare il giorno a Roma', async (parameter) => {
    const { requests } = setup()
    const row = await screen.findByRole('row', { name: /NightFriend#EUW/ })
    expect(within(row).getAllByRole('cell').at(-1)).toHaveTextContent('24/09/2026')
    expect(row).not.toHaveTextContent('25/09/2026')
    expect(screen.getByText('Date mostrate e filtri temporali in UTC.')).toBeVisible()
    expect(screen.getByLabelText('Conta le partite dal')).toHaveAccessibleDescription('Date mostrate e filtri temporali in UTC.')
    expect(screen.getByLabelText('Ultima partita dal')).toHaveAccessibleDescription('Date mostrate e filtri temporali in UTC.')

    const input = screen.getByLabelText(parameter === 'games_from' ? 'Conta le partite dal' : 'Ultima partita dal')
    fireEvent.change(input, { target: { value: '2026-09-25' } })
    await screen.findByText('Nessun risultato per questi filtri')
    await waitFor(() => expect(requests).toHaveLength(2))
    expect(requests[1]!.searchParams.get(parameter)).toBe('2026-09-25')
    expect(input).toHaveValue('2026-09-25')
    expect(screen.queryByRole('row', { name: /NightFriend#EUW/ })).not.toBeInTheDocument()
  })

  it('mantiene lo stesso giorno UTC anche nel sottotitolo di schede, barre e mappa', async () => {
    setup()
    await screen.findByRole('row', { name: /NightFriend#EUW/ })
    act(() => dataViewStore.setView('cards'))
    expect(screen.getByText(/ultima partita 24\/09\/2026/)).toBeVisible()
    expect(screen.queryByText(/ultima partita 25\/09\/2026/)).not.toBeInTheDocument()
    for (const view of ['bars', 'scatter'] as const) {
      act(() => dataViewStore.setView(view))
      expect(screen.getByRole('button', { name: /NightFriend#EUW.*ultima partita 24\/09\/2026/ })).toBeVisible()
      expect(screen.queryByRole('button', { name: /ultima partita 25\/09\/2026/ })).not.toBeInTheDocument()
    }
  })
})
