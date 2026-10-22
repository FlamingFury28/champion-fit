import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FriendsResponseDto } from '../api/types'
import { FriendsPage } from './FriendsPage'

vi.mock('../app/scope', () => ({ useScope: () => ({ scope: { accounts: ['Alpha#EUW'], companion: null }, scopeReady: true }) }))
vi.mock('../components/toast', () => ({ useToast: () => ({ notify: vi.fn() }) }))

const clients: QueryClient[] = []
const payload: FriendsResponseDto = {
  items: [], manual_groups: [],
  summary: { tracked_accounts: 1, matches_with_participants: 2, friends_found: 0, min_shared_games: 1, accounts: ['Alpha#EUW'] },
}

function setup(search: string) {
  const requests: URL[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    if ((init?.method ?? 'GET') !== 'GET' || url.pathname !== '/api/friends') throw new Error('Unexpected request')
    requests.push(url)
    return Response.json(payload)
  }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  clients.push(client)
  const router = createMemoryRouter([{ path: '*', element: <FriendsPage /> }], {
    initialEntries: [`/app/team/friends?min_games=1&queue=420&${search}`],
  })
  render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>)
  return { requests, client, router, user: userEvent.setup() }
}

afterEach(() => {
  cleanup()
  clients.splice(0).forEach((client) => client.clear())
  vi.unstubAllGlobals()
})

describe('calendari dei compagni', () => {
  it.each([
    ['games_from', '20260101', 'Conta le partite dal'],
    ['last_game_from', '2026-W01-4', 'Ultima partita dal'],
  ])('mostra %s canonico e lo mantiene nella richiesta dopo un altro filtro', async (parameter, raw, label) => {
    const { requests, router, user } = setup(`${parameter}=${raw}`)
    await screen.findByText('Nessun risultato per questi filtri')
    const input = screen.getByLabelText(label)
    expect(input).toHaveValue('2026-01-01')
    expect(requests[0]!.searchParams.get(parameter)).toBe('2026-01-01')
    // Reading an alternate ISO representation must not rewrite the URL.
    expect(new URLSearchParams(router.state.location.search).get(parameter)).toBe(raw)

    await user.selectOptions(screen.getByLabelText('Modalità del confronto'), 'all')
    await waitFor(() => expect(requests).toHaveLength(2))
    expect(requests[1]!.searchParams.get(parameter)).toBe('2026-01-01')
    expect(screen.getByLabelText(label)).toBe(input)
  })

  it('riusa la stessa cache per date equivalenti e invia la modifica del calendario', async () => {
    const { requests, router, client } = setup('games_from=20260101&last_game_from=2026W014')
    await screen.findByText('Nessun risultato per questi filtri')
    await act(() => router.navigate('/app/team/friends?min_games=1&queue=420&games_from=2026-01-01&last_game_from=2026-W01-4'))
    expect(requests).toHaveLength(1)
    expect(client.getQueriesData({ queryKey: ['api', 'friends'] })).toHaveLength(1)
    expect(screen.getByLabelText('Conta le partite dal')).toHaveValue('2026-01-01')
    expect(screen.getByLabelText('Ultima partita dal')).toHaveValue('2026-01-01')

    fireEvent.change(screen.getByLabelText('Conta le partite dal'), { target: { value: '2026-02-01' } })
    await waitFor(() => expect(requests).toHaveLength(2))
    expect(requests[1]!.searchParams.get('games_from')).toBe('2026-02-01')
    expect(requests[1]!.searchParams.get('last_game_from')).toBe('2026-01-01')
  })

  it('ignora date invalide in entrambi i filtri senza applicare rollover o riscrivere la URL', async () => {
    const { requests, router } = setup('games_from=2026-02-30&last_game_from=2021-W53-1')
    await screen.findByText('Nessun risultato per questi filtri')
    expect(screen.getByLabelText('Conta le partite dal')).toHaveValue('')
    expect(screen.getByLabelText('Ultima partita dal')).toHaveValue('')
    expect(requests[0]!.searchParams.has('games_from')).toBe(false)
    expect(requests[0]!.searchParams.has('last_game_from')).toBe(false)
    expect(new URLSearchParams(router.state.location.search).get('games_from')).toBe('2026-02-30')
    expect(new URLSearchParams(router.state.location.search).get('last_game_from')).toBe('2021-W53-1')
  })

  it('conserva lo stesso dialogo, i campi e la bozza quando cambiano i filtri nella URL', async () => {
    const { requests, router, user } = setup('games_from=20260101')
    await screen.findByText('Nessun risultato per questi filtri')
    const calendar = screen.getByLabelText('Conta le partite dal')
    await user.click(screen.getByRole('button', { name: 'Nuovo gruppo' }))
    const dialog = screen.getByRole('dialog', { name: 'Crea gruppo di nomi' })
    const name = within(dialog).getByLabelText('Nome gruppo')
    const aliases = within(dialog).getByLabelText('Alias, separati da virgola')
    await user.type(name, 'Gruppo ancora in bozza')
    await user.type(aliases, 'Compagno#EUW, Altro#EUW')

    // Same-page history/context changes can occur while a modal is open.
    await act(() => router.navigate('/app/team/friends?min_games=1&queue=all&games_from=2026-W01-4&last_game_from=2026W015'))
    await waitFor(() => expect(requests).toHaveLength(2))
    expect(screen.getByRole('dialog', { name: 'Crea gruppo di nomi' })).toBe(dialog)
    expect(within(dialog).getByLabelText('Nome gruppo')).toBe(name)
    expect(within(dialog).getByLabelText('Alias, separati da virgola')).toBe(aliases)
    expect(name).toHaveValue('Gruppo ancora in bozza')
    expect(aliases).toHaveValue('Compagno#EUW, Altro#EUW')
    expect(calendar).toHaveValue('2026-01-01')
    expect(requests[1]!.searchParams.get('games_from')).toBe('2026-01-01')
    expect(requests[1]!.searchParams.get('last_game_from')).toBe('2026-01-02')
  })
})
