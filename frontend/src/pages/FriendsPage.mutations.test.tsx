import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FriendsPage } from './FriendsPage'

const mocks = vi.hoisted(() => ({ post: vi.fn(), patch: vi.fn(), notify: vi.fn() }))
vi.mock('../api/client', async (original) => ({ ...await original<typeof import('../api/client')>(), postJson: mocks.post, patchJson: mocks.patch }))
vi.mock('../app/scope', () => ({ useScope: () => ({ scope: { accounts: ['Alpha#EUW'] }, scopeReady: true }) }))
vi.mock('../components/toast', () => ({ useToast: () => ({ notify: mocks.notify }) }))
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

function deferred() {
  let resolve!: (result: { ok: boolean; id: number; name: string }) => void
  let reject!: (error: Error) => void
  const promise = new Promise<{ ok: boolean; id: number; name: string }>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function renderFriends() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  render(<QueryClientProvider client={client}><MemoryRouter><FriendsPage /></MemoryRouter></QueryClientProvider>)
}

beforeEach(() => { mocks.post.mockReset(); mocks.patch.mockReset(); mocks.notify.mockReset() })
afterEach(cleanup)

describe('risposte tardive dei gruppi', () => {
  it('conserva una nuova bozza quando si completa una creazione annullata', async () => {
    const pending = deferred()
    mocks.post.mockReturnValueOnce(pending.promise)
    const user = userEvent.setup()
    renderFriends()
    await user.click(screen.getByRole('button', { name: 'Nuovo gruppo' }))
    let dialog = screen.getByRole('dialog', { name: 'Crea gruppo di nomi' })
    await user.type(within(dialog).getByLabelText('Nome gruppo'), 'Gruppo A')
    await user.type(within(dialog).getByLabelText('Alias, separati da virgola'), 'A#EUW')
    await user.click(within(dialog).getByRole('button', { name: 'Crea gruppo' }))
    expect(within(dialog).getByLabelText('Nome gruppo')).toBeDisabled()
    await user.click(within(dialog).getByRole('button', { name: 'Annulla' }))
    await user.click(screen.getByRole('button', { name: 'Nuovo gruppo' }))
    dialog = screen.getByRole('dialog', { name: 'Crea gruppo di nomi' })
    await user.clear(within(dialog).getByLabelText('Nome gruppo'))
    await user.type(within(dialog).getByLabelText('Nome gruppo'), 'Gruppo B')
    await user.clear(within(dialog).getByLabelText('Alias, separati da virgola'))
    await user.type(within(dialog).getByLabelText('Alias, separati da virgola'), 'B#EUW')
    await act(async () => { pending.resolve({ ok: true, id: 2, name: 'Gruppo A' }); await pending.promise })
    await waitFor(() => expect(mocks.notify).toHaveBeenCalledWith('Gruppo creato', expect.any(Object)))
    expect(dialog).toBeVisible()
    expect(within(dialog).getByLabelText('Nome gruppo')).toHaveValue('Gruppo B')
    expect(within(dialog).getByLabelText('Alias, separati da virgola')).toHaveValue('B#EUW')
  })

  it('una creazione precedente non chiude un nuovo modulo di rinomina', async () => {
    const pending = deferred()
    mocks.post.mockReturnValueOnce(pending.promise)
    const user = userEvent.setup()
    renderFriends()
    await screen.findByRole('button', { name: 'Rinomina Esistente' })
    await user.click(screen.getByRole('button', { name: 'Nuovo gruppo' }))
    const create = screen.getByRole('dialog', { name: 'Crea gruppo di nomi' })
    await user.type(within(create).getByLabelText('Nome gruppo'), 'Gruppo A')
    await user.type(within(create).getByLabelText('Alias, separati da virgola'), 'A#EUW')
    await user.click(within(create).getByRole('button', { name: 'Crea gruppo' }))
    await user.click(within(create).getByRole('button', { name: 'Annulla' }))
    await user.click(screen.getByRole('button', { name: 'Rinomina Esistente' }))
    const rename = screen.getByRole('dialog', { name: 'Rinomina gruppo di nomi' })
    await user.clear(within(rename).getByLabelText('Nuovo nome'))
    await user.type(within(rename).getByLabelText('Nuovo nome'), 'Nuova bozza')
    await act(async () => { pending.resolve({ ok: true, id: 2, name: 'Gruppo A' }); await pending.promise })
    await waitFor(() => expect(mocks.notify).toHaveBeenCalled())
    expect(rename).toBeVisible()
    expect(within(rename).getByLabelText('Nuovo nome')).toHaveValue('Nuova bozza')
    expect(within(rename).getByRole('button', { name: 'Salva nome' })).toBeEnabled()
  })

  it('un errore precedente non compare nel nuovo modulo', async () => {
    const pending = deferred()
    mocks.post.mockReturnValueOnce(pending.promise)
    const user = userEvent.setup()
    renderFriends()
    await user.click(screen.getByRole('button', { name: 'Nuovo gruppo' }))
    const create = screen.getByRole('dialog', { name: 'Crea gruppo di nomi' })
    await user.type(within(create).getByLabelText('Nome gruppo'), 'Gruppo A')
    await user.type(within(create).getByLabelText('Alias, separati da virgola'), 'A#EUW')
    await user.click(within(create).getByRole('button', { name: 'Crea gruppo' }))
    await user.click(within(create).getByRole('button', { name: 'Annulla' }))
    await user.click(screen.getByRole('button', { name: 'Nuovo gruppo' }))
    await act(async () => { pending.reject(new Error('Errore della richiesta A')) })
    await waitFor(() => expect(mocks.notify).toHaveBeenCalledWith('Modifica non riuscita', expect.any(Object)))
    expect(screen.getByRole('dialog', { name: 'Crea gruppo di nomi' })).toBeVisible()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
