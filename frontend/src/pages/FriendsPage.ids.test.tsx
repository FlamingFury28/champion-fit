import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FriendGroupDto, FriendGroupMutationResponseDto, FriendsResponseDto } from '../api/types'
import { FriendsPage } from './FriendsPage'

vi.mock('../app/scope', () => ({ useScope: () => ({ scope: { accounts: ['Alpha#EUW'], companion: null }, scopeReady: true }) }))
vi.mock('../components/toast', () => ({ useToast: () => ({ notify: vi.fn() }) }))

const idCases: Array<{ id: FriendGroupDto['id']; rawId: string; label: string }> = [
  { id: 1, rawId: '1', label: 'numero ordinario' },
  { id: '9007199254740992', rawId: '"9007199254740992"', label: 'primo ID alto' },
  { id: '9007199254740993', rawId: '"9007199254740993"', label: 'ID alto adiacente' },
  { id: '9223372036854775807', rawId: '"9223372036854775807"', label: 'massimo SQL64' },
]
const clients: QueryClient[] = []

function setup(groups: Array<{ rawId: string; name: string }>) {
  // Construct the exact wire JSON: no high identifier ever passes through a JS number.
  const raw = `{"items":[],"manual_groups":[${groups.map(({ rawId, name }) => `{"id":${rawId},"name":${JSON.stringify(name)},"aliases":["Friend#EUW"]}`).join(',')}],"summary":{"tracked_accounts":1,"matches_with_participants":0,"friends_found":0,"min_shared_games":5,"accounts":["Alpha#EUW"]}}`
  const requests: Array<{ method: string; path: string; body: unknown }> = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://localhost').pathname
    if (!init?.method || init.method === 'GET') {
      if (path !== '/api/friends') throw new Error(`Unexpected GET: ${path}`)
      return new Response(raw, { headers: { 'Content-Type': 'application/json' } })
    }
    requests.push({ method: init.method, path, body: init.body ? JSON.parse(String(init.body)) : null })
    const resourceId = path.split('/')[3]!
    const result: FriendGroupMutationResponseDto = { ok: true, id: resourceId === '1' ? 1 : resourceId }
    if (init.method === 'PATCH') result.name = JSON.parse(String(init.body)).name
    if (init.method === 'POST') result.added_aliases = JSON.parse(String(init.body)).aliases
    return Response.json(result)
  }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } })
  clients.push(client)
  render(<QueryClientProvider client={client}><MemoryRouter><FriendsPage /></MemoryRouter></QueryClientProvider>)
  return { client, requests, user: userEvent.setup() }
}

afterEach(() => {
  cleanup()
  clients.splice(0).forEach((client) => client.clear())
  vi.unstubAllGlobals()
})

describe.each(idCases)('ID del gruppo: $label', ({ id, rawId }) => {
  it.each(['rename', 'add-aliases', 'delete-alias', 'delete-group'] as const)('mantiene l’identificatore esatto per %s', async (action) => {
    const { client, requests, user } = setup([{ rawId, name: 'Gruppo da modificare' }])
    await screen.findByRole('button', { name: 'Rinomina Gruppo da modificare' })
    const cached = client.getQueriesData<FriendsResponseDto>({ queryKey: ['api', 'friends'] })[0]?.[1]
    expect(cached?.manual_groups[0]?.id).toBe(id)

    let expectedMethod: string
    let expectedSuffix = ''
    let expectedBody: unknown = null
    if (action === 'rename') {
      await user.click(screen.getByRole('button', { name: 'Rinomina Gruppo da modificare' }))
      const dialog = screen.getByRole('dialog', { name: 'Rinomina gruppo di nomi' })
      await user.clear(within(dialog).getByLabelText('Nuovo nome'))
      await user.type(within(dialog).getByLabelText('Nuovo nome'), 'Nome aggiornato')
      await user.click(within(dialog).getByRole('button', { name: 'Salva nome' }))
      expectedMethod = 'PATCH'
      expectedBody = { name: 'Nome aggiornato' }
    } else if (action === 'add-aliases') {
      await user.click(screen.getByRole('button', { name: 'Aggiungi persone a Gruppo da modificare' }))
      const dialog = screen.getByRole('dialog', { name: 'Aggiungi persone a Gruppo da modificare' })
      await user.type(within(dialog).getByLabelText('Riot ID'), 'Altro#EUW')
      await user.click(within(dialog).getByRole('button', { name: 'Aggiungi al gruppo' }))
      expectedMethod = 'POST'
      expectedSuffix = '/aliases'
      expectedBody = { aliases: ['Altro#EUW'] }
    } else {
      await user.click(screen.getByRole('button', { name: action === 'delete-alias' ? 'Rimuovi alias Friend#EUW' : 'Elimina Gruppo da modificare' }))
      const dialog = screen.getByRole('dialog', { name: action === 'delete-alias' ? 'Rimuovere questo alias?' : 'Rimuovere questo gruppo?' })
      await user.click(within(dialog).getByRole('button', { name: 'Conferma rimozione' }))
      expectedMethod = 'DELETE'
      expectedSuffix = action === 'delete-alias' ? '/aliases/Friend%23EUW' : ''
    }

    await waitFor(() => expect(requests).toEqual([{ method: expectedMethod, path: `/api/friend-groups/${id}${expectedSuffix}`, body: expectedBody }]))
    await waitFor(() => expect(client.getMutationCache().getAll().every((mutation) => mutation.state.status === 'success')).toBe(true))
  })
})

it('distingue due gruppi con ID alti adiacenti e modifica soltanto quello scelto', async () => {
  const { client, requests, user } = setup([
    { rawId: '"9007199254740992"', name: 'Primo gruppo' },
    { rawId: '"9007199254740993"', name: 'Secondo gruppo' },
  ])
  await screen.findByRole('button', { name: 'Rinomina Secondo gruppo' })
  const groups = client.getQueriesData<FriendsResponseDto>({ queryKey: ['api', 'friends'] })[0]?.[1]?.manual_groups
  expect(groups?.map((group) => group.id)).toEqual(['9007199254740992', '9007199254740993'])
  expect(screen.getByRole('button', { name: 'Rinomina Primo gruppo' })).toBeVisible()
  await user.click(screen.getByRole('button', { name: 'Elimina Secondo gruppo' }))
  await user.click(within(screen.getByRole('dialog', { name: 'Rimuovere questo gruppo?' })).getByRole('button', { name: 'Conferma rimozione' }))
  await waitFor(() => expect(requests).toEqual([{ method: 'DELETE', path: '/api/friend-groups/9007199254740993', body: null }]))
  await waitFor(() => expect(client.getMutationCache().getAll().every((mutation) => mutation.state.status === 'success')).toBe(true))
})
