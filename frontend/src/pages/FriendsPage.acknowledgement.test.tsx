import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FriendsPage } from './FriendsPage'

const { notify } = vi.hoisted(() => ({ notify: vi.fn() }))
vi.mock('../app/scope', () => ({ useScope: () => ({ scope: { accounts: ['Alpha#EUW'], companion: null }, scopeReady: true }) }))
vi.mock('../components/toast', () => ({ useToast: () => ({ notify }) }))
vi.mock('../app/algorithm-settings', async (original) => ({
  ...await original<typeof import('../app/algorithm-settings')>(),
  useAlgorithmSettings: () => ({ credibleMass: .9, isPending: false, settings: { friends: { min_shared_games: 1 }, evidence: { min_games: 20, meaningful_delta: .03 } } }),
}))
vi.mock('../api/queries', () => ({ friendsQuery: () => ({
  queryKey: ['api', 'friends'], queryFn: async () => ({ items: [],
    summary: { tracked_accounts: 1, matches_with_participants: 0, friends_found: 0, min_shared_games: 1 },
    manual_groups: [{ id: 1, name: 'Esistente', aliases: ['Friend#EUW'] }],
  }),
}) }))

type Action = 'create' | 'rename' | 'add-aliases' | 'delete-group' | 'delete-alias'
const clients: QueryClient[] = []
function setup(action: Action) {
  const writes: Array<{ method: string; path: string; body: unknown }> = []
  const acknowledgement = action === 'create' ? { ok: true, name: 'Nuova Équipe' }
    : action === 'rename' ? { ok: true, id: 1, name: 'Nome aggiornato' }
      : action === 'add-aliases' ? { ok: true, id: 1, added_aliases: ['Altro#EUW'] }
        : { ok: true, id: 1 }
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    writes.push({ method: init?.method ?? 'GET', path: String(input), body: init?.body ? JSON.parse(String(init.body)) : null })
    return Response.json(writes.length === 1 ? {} : acknowledgement)
  }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  clients.push(client)
  const invalidation = vi.spyOn(client, 'invalidateQueries')
  render(<QueryClientProvider client={client}><MemoryRouter><FriendsPage /></MemoryRouter></QueryClientProvider>)
  return { client, invalidation, writes, user: userEvent.setup() }
}

async function openAction(action: Action, user: ReturnType<typeof userEvent.setup>) {
  await screen.findByRole('button', { name: 'Rinomina Esistente' })
  const trigger = action === 'create' ? 'Nuovo gruppo' : action === 'rename' ? 'Rinomina Esistente'
    : action === 'add-aliases' ? 'Aggiungi persone a Esistente'
      : action === 'delete-alias' ? 'Rimuovi alias Friend#EUW' : 'Elimina Esistente'
  await user.click(screen.getByRole('button', { name: trigger }))
  const dialog = screen.getByRole('dialog')
  let input: HTMLElement | null = null
  let expectedValue = ''
  if (action === 'create') {
    input = within(dialog).getByLabelText('Nome gruppo')
    expectedValue = 'Nuova Équipe'
    await user.type(input, expectedValue)
    await user.type(within(dialog).getByLabelText('Alias, separati da virgola'), 'Altro#EUW')
  } else if (action === 'rename') {
    input = within(dialog).getByLabelText('Nuovo nome')
    expectedValue = 'Nome aggiornato'
    await user.clear(input)
    await user.type(input, expectedValue)
  } else if (action === 'add-aliases') {
    input = within(dialog).getByLabelText('Riot ID')
    expectedValue = 'Altro#EUW'
    await user.type(input, expectedValue)
  }
  const submitName = action === 'create' ? 'Crea gruppo' : action === 'rename' ? 'Salva nome'
    : action === 'add-aliases' ? 'Aggiungi al gruppo' : 'Conferma rimozione'
  return { dialog, input, expectedValue, submit: within(dialog).getByRole('button', { name: submitName }) }
}

afterEach(() => {
  cleanup()
  clients.splice(0).forEach((client) => client.clear())
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  notify.mockReset()
})

describe('conferme dei gruppi', () => {
  it.each(['create', 'rename', 'add-aliases', 'delete-group', 'delete-alias'] as const)('conserva il modulo per %s dopo200 incompleto e riprova solo su richiesta', async (action) => {
    const { user, client, invalidation, writes } = setup(action)
    const { dialog, input, expectedValue, submit } = await openAction(action, user)
    const before = structuredClone(client.getQueryData(['api', 'friends']))
    await user.click(submit)

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('L’esito della richiesta non è confermato')
    expect(screen.getByRole('dialog')).toBe(dialog)
    if (input) { expect(input).toBeInTheDocument(); expect(input).toHaveValue(expectedValue) }
    if (action === 'create') expect(within(dialog).getByLabelText('Alias, separati da virgola')).toHaveValue('Altro#EUW')
    expect(submit).toBeEnabled()
    expect(invalidation).not.toHaveBeenCalled()
    expect(client.getQueryData(['api', 'friends'])).toEqual(before)
    expect(notify.mock.calls.some(([, options]) => options?.tone === 'success')).toBe(false)
    expect(writes).toHaveLength(1)

    await user.click(submit)
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(writes).toHaveLength(2)
    expect(writes[1]).toEqual(writes[0])
    expect(invalidation).toHaveBeenCalledOnce()
    expect(notify.mock.calls.some(([, options]) => options?.tone === 'success')).toBe(true)
  })
})
