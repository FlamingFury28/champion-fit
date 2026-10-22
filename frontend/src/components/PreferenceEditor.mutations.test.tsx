import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { queryKeys } from '../api/queries'
import type { RecommendationFeedbackInputDto, RecommendationFeedbackResponseDto } from '../api/types'
import { PreferenceEditor } from './PreferenceEditor'

const scope = { accounts: ['Alpha#EUW', 'Beta#EUW'], companion: null }
const payload: RecommendationFeedbackResponseDto = {
  revision: 4, accounts: scope.accounts, suspended_accounts: [], unresolved_accounts: [], items: [], catalog_version: 'synthetic',
  options: [
    { champion: 'MonkeyKing', name: 'Wukong', roles: ['TOP'], roles_by_account: { 'Alpha#EUW': ['TOP'], 'Beta#EUW': ['TOP'] }, icon_url: null, classified: true },
    { champion: 'Zed', name: 'Zed', roles: ['MIDDLE'], roles_by_account: { 'Alpha#EUW': ['MIDDLE'], 'Beta#EUW': ['MIDDLE'] }, icon_url: null, classified: true },
  ],
}

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

const clients: QueryClient[] = []
function setup(fetchImpl: typeof fetch) {
  vi.stubGlobal('fetch', vi.fn(fetchImpl))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  clients.push(client)
  return { user: userEvent.setup(), client, ...render(<QueryClientProvider client={client}><PreferenceEditor scope={scope} /></QueryClientProvider>) }
}

type User = ReturnType<typeof userEvent.setup>
async function prepareSubmittedDraft(user: User) {
  const search = await screen.findByLabelText('Cerca nel catalogo')
  await user.type(search, 'Wukong')
  await user.selectOptions(screen.getByLabelText('Campione della preferenza'), 'MonkeyKing')
  await user.click(screen.getByText('Account · 2/2 selezionati'))
  await user.click(screen.getByRole('checkbox', { name: 'Beta#EUW' }))
  return search
}

async function changeToNextDraft(user: User) {
  await user.clear(screen.getByLabelText('Cerca nel catalogo'))
  await user.type(screen.getByLabelText('Cerca nel catalogo'), 'Zed')
  await user.selectOptions(screen.getByLabelText('Campione della preferenza'), 'Zed')
  await user.click(screen.getByRole('checkbox', { name: 'Beta#EUW' }))
  await user.click(screen.getByRole('checkbox', { name: 'Alpha#EUW' }))
}

function expectNextDraft(search: HTMLElement) {
  expect(screen.getByLabelText('Cerca nel catalogo')).toBe(search)
  expect(search).toHaveValue('Zed')
  expect(screen.getByLabelText('Campione della preferenza')).toHaveValue('Zed')
  expect(screen.getByLabelText('Ruolo della preferenza')).toHaveValue('MIDDLE')
  expect(screen.getByRole('checkbox', { name: 'Alpha#EUW' })).not.toBeChecked()
  expect(screen.getByRole('checkbox', { name: 'Beta#EUW' })).toBeChecked()
}

function expectSubmittedTarget(element: HTMLElement) {
  expect(element).toHaveTextContent('Wukong')
  expect(element).toHaveTextContent('Corsia superiore')
  expect(element).toHaveTextContent('Alpha#EUW')
  expect(element).not.toHaveTextContent('MonkeyKing')
  expect(element).not.toHaveTextContent('Zed')
  expect(element).not.toHaveTextContent('Beta#EUW')
}

afterEach(() => {
  cleanup()
  for (const client of clients.splice(0)) client.clear()
  vi.unstubAllGlobals()
})

describe('preferenze: bozza e richieste precedenti', () => {
  it.each([{}, { ok: false, revision: 5, items: [] }, { ok: true, revision: 3, items: [] }, { ok: true, revision: 5 }])('non conferma un acknowledgement incompleto %j e conserva la nuova bozza per il retry esplicito', async (acknowledgement) => {
    const pending = deferred<Response>()
    const posts: RecommendationFeedbackInputDto[] = []
    let gets = 0
    const { user } = setup((_input, init) => {
      if (init?.method === 'POST') {
        posts.push(JSON.parse(String(init.body)))
        return posts.length === 1 ? pending.promise : Promise.resolve(response({ ok: true, revision: 5, items: [] }))
      }
      gets += 1
      return Promise.resolve(response({ ...payload, revision: posts.length > 1 ? 5 : 4 }))
    })
    const search = await prepareSubmittedDraft(user)
    await user.click(screen.getByRole('button', { name: 'Mi piace' }))
    await waitFor(() => expect(posts).toHaveLength(1))
    await changeToNextDraft(user)
    await act(async () => { pending.resolve(response(acknowledgement)); await pending.promise })

    const error = await screen.findByRole('alert')
    expect(error).toHaveTextContent('L’esito della richiesta non è confermato')
    expectSubmittedTarget(error)
    expectNextDraft(search)
    expect(screen.queryByText('Preferenza salvata.')).not.toBeInTheDocument()
    expect(posts).toHaveLength(1)
    expect(gets).toBe(1)

    await user.click(screen.getByRole('button', { name: 'Non fa per me' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Preferenza salvata.'))
    expectNextDraft(search)
    expect(posts).toEqual([
      { accounts: ['Alpha#EUW'], champion: 'MonkeyKing', role: 'TOP', preference: 'like', expected_revision: 4 },
      { accounts: ['Beta#EUW'], champion: 'Zed', role: 'MIDDLE', preference: 'dislike', expected_revision: 4 },
    ])
  })

  it('accetta il successo esplicito di un no-op senza imporre una nuova revisione', async () => {
    const posts: RecommendationFeedbackInputDto[] = []
    const ledger = { ...payload, items: [{ account: 'Alpha#EUW', champion: 'MonkeyKing', role: 'TOP', preference: 'like' as const, updated_at: '2026-10-17T12:00:00Z' }] }
    const { user } = setup((_input, init) => {
      if (init?.method === 'POST') { posts.push(JSON.parse(String(init.body))); return Promise.resolve(response({ ok: true, revision: 4, items: ledger.items })) }
      return Promise.resolve(response(ledger))
    })
    await prepareSubmittedDraft(user)
    await user.click(screen.getByRole('button', { name: 'Mi piace' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Preferenza salvata.'))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(posts).toHaveLength(1)
  })

  it('attribuisce attesa e successo alla selezione inviata mentre la nuova bozza rimane modificabile', async () => {
    const pending = deferred<Response>()
    const posts: RecommendationFeedbackInputDto[] = []
    let revision = 4
    const { user } = setup((_input, init) => {
      if (init?.method === 'POST') { posts.push(JSON.parse(String(init.body))); return pending.promise }
      return Promise.resolve(response({ ...payload, revision }))
    })
    const search = await prepareSubmittedDraft(user)
    await user.click(screen.getByRole('button', { name: 'Mi piace' }))
    await waitFor(() => expect(posts).toHaveLength(1))
    await changeToNextDraft(user)
    expectNextDraft(search)
    expectSubmittedTarget(screen.getByRole('status'))

    revision = 5
    await act(async () => { pending.resolve(response({ ok: true, revision, items: [] })); await pending.promise })
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Preferenza salvata.'))

    expectSubmittedTarget(screen.getByRole('status'))
    expectNextDraft(search)
    expect(screen.getByRole('button', { name: 'Non fa per me' })).toBeEnabled()
    expect(posts).toEqual([{
      accounts: ['Alpha#EUW'], champion: 'MonkeyKing', role: 'TOP', preference: 'like', expected_revision: 4,
    }])
  })

  it('attribuisce un errore tardivo alla richiesta precedente senza confonderla con il nuovo campione', async () => {
    const pending = deferred<Response>()
    const posts: RecommendationFeedbackInputDto[] = []
    const { user } = setup((_input, init) => {
      if (init?.method === 'POST') { posts.push(JSON.parse(String(init.body))); return pending.promise }
      return Promise.resolve(response(payload))
    })
    const search = await prepareSubmittedDraft(user)
    await user.click(screen.getByRole('button', { name: 'Mi piace' }))
    await waitFor(() => expect(posts).toHaveLength(1))
    await changeToNextDraft(user)
    await act(async () => { pending.resolve(response({ error: 'Servizio momentaneamente indisponibile.' }, 503)); await pending.promise })

    expectSubmittedTarget(await screen.findByRole('alert'))
    expectNextDraft(search)
    expect(screen.getByRole('button', { name: 'Mi piace' })).toBeEnabled()
    expect(posts).toHaveLength(1)
  })

  it('distingue il refetch in corso, fallito e riuscito dopo409 e recupera senza reinviare la revisione rifiutata', async () => {
    const rejectedPost = deferred<Response>()
    const firstRefresh = deferred<Response>()
    const retryRefresh = deferred<Response>()
    const posts: RecommendationFeedbackInputDto[] = []
    let gets = 0
    let healthy = false
    const { user } = setup((_input, init) => {
      if (init?.method === 'POST') {
        posts.push(JSON.parse(String(init.body)))
        return posts.length === 1 ? rejectedPost.promise : Promise.resolve(response({ ok: true, revision: 6, items: [] }))
      }
      gets += 1
      if (gets === 1) return Promise.resolve(response(payload))
      if (gets === 2) return firstRefresh.promise
      if (gets === 3) return retryRefresh.promise
      return Promise.resolve(response(healthy ? { ...payload, revision: 5 } : payload))
    })
    const search = await prepareSubmittedDraft(user)
    await user.click(screen.getByRole('button', { name: 'Mi piace' }))
    await waitFor(() => expect(posts).toHaveLength(1))
    await changeToNextDraft(user)
    await act(async () => { rejectedPost.resolve(response({ error: 'revision conflict' }, 409)); await rejectedPost.promise })
    await waitFor(() => expect(gets).toBe(2))
    const refreshing = await screen.findByRole('button', { name: 'Ricarico preferenze…' })
    expect(refreshing).toBeDisabled()
    expect(screen.queryByText(/Ho ricaricato il registro corrente/)).not.toBeInTheDocument()
    expectNextDraft(search)

    await act(async () => { firstRefresh.resolve(response({ error: 'Aggiornamento non disponibile.' }, 503)); await firstRefresh.promise })
    const retry = await screen.findByRole('button', { name: 'Ricarica preferenze' })
    await waitFor(() => expect(retry).toBeEnabled())
    expect(screen.getAllByRole('alert').map((element) => element.textContent).join(' ')).not.toContain('Ho ricaricato')
    const failedWrite = screen.getAllByRole('alert').find((element) => element.textContent?.includes('Wukong'))!
    expectSubmittedTarget(failedWrite)
    expectNextDraft(search)

    await user.click(retry)
    await waitFor(() => expect(gets).toBe(3))
    expect(posts).toHaveLength(1)
    expectNextDraft(search)
    await act(async () => { retryRefresh.resolve(response({ error: 'Ancora non disponibile.' }, 503)); await retryRefresh.promise })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Ricarica preferenze' })).toBeEnabled())
    healthy = true
    await user.click(screen.getByRole('button', { name: 'Ricarica preferenze' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Non fa per me' })).toBeEnabled())
    expectNextDraft(search)
    expect(screen.getByRole('alert')).toHaveTextContent('Ho ricaricato il registro corrente')
    await user.click(screen.getByRole('button', { name: 'Non fa per me' }))

    await waitFor(() => expect(posts).toHaveLength(2))
    expect(posts[1]).toEqual({ accounts: ['Beta#EUW'], champion: 'Zed', role: 'MIDDLE', preference: 'dislike', expected_revision: 5 })
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Preferenza salvata.'))
    expect(screen.getByRole('status')).toHaveTextContent('Zed')
    expect(screen.getByRole('status')).toHaveTextContent('Beta#EUW')
    expect(screen.getByRole('status')).not.toHaveTextContent('Alpha#EUW')
  })

  it.each(['http503', 'disconnessione'] as const)('conserva nodo e bozza durante %s di un refetch e consente il retry', async (failure) => {
    let offline = false
    const { user, client } = setup(() => offline
      ? failure === 'disconnessione' ? Promise.reject(new TypeError('Failed to fetch')) : Promise.resolve(response({ error: 'Servizio non disponibile.' }, 503))
      : Promise.resolve(response(payload)))
    const search = await prepareSubmittedDraft(user)
    offline = true
    await act(async () => { await client.refetchQueries({ queryKey: queryKeys.recommendationFeedback(scope) }) })

    const retry = await screen.findByRole('button', { name: 'Riprova' })
    expect(screen.getByLabelText('Cerca nel catalogo')).toBe(search)
    expect(search).toHaveValue('Wukong')
    expect(screen.getByLabelText('Campione della preferenza')).toHaveValue('MonkeyKing')
    expect(screen.getByLabelText('Ruolo della preferenza')).toHaveValue('TOP')
    expect(screen.getByRole('checkbox', { name: 'Beta#EUW' })).not.toBeChecked()
    offline = false
    await user.click(retry)
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Riprova' })).not.toBeInTheDocument())
    expect(screen.getByLabelText('Cerca nel catalogo')).toBe(search)
    expect(search).toHaveValue('Wukong')
  })

  it('richiede una revisione aggiornata anche se il GET risponde200 e protegge il reset Neutro', async () => {
    const ledger = { ...payload, items: [{ account: 'Alpha#EUW', champion: 'MonkeyKing', role: 'TOP', preference: 'like' as const, updated_at: '2026-10-17T12:00:00Z' }] }
    const posts: RecommendationFeedbackInputDto[] = []
    let revision = 4
    const { user } = setup((_input, init) => {
      if (init?.method === 'POST') {
        posts.push(JSON.parse(String(init.body)))
        return Promise.resolve(posts.length === 1 ? response({ error: 'revision conflict' }, 409) : response({ ok: true, revision: 6, items: [] }))
      }
      return Promise.resolve(response({ ...ledger, revision }))
    })
    await prepareSubmittedDraft(user)
    await user.click(screen.getByRole('button', { name: 'Mi piace' }))
    const refresh = await screen.findByRole('button', { name: 'Ricarica preferenze' })
    await waitFor(() => expect(refresh).toBeEnabled())

    expect(screen.getByRole('button', { name: 'Imposta Neutro' })).toBeDisabled()
    expect(screen.getByRole('alert')).not.toHaveTextContent('Ho ricaricato')
    expect(posts).toHaveLength(1)
    revision = 5
    await user.click(refresh)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Imposta Neutro' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: 'Imposta Neutro' }))

    await waitFor(() => expect(posts).toHaveLength(2))
    expect(posts[1]).toEqual({ accounts: ['Alpha#EUW'], champion: 'MonkeyKing', role: 'TOP', preference: 'neutral', expected_revision: 5 })
  })

  it.each([200, 409, 503])('non trasferisce l’esito tardivo%s al nuovo account globale', async (status) => {
    const pending = deferred<Response>()
    const posts: RecommendationFeedbackInputDto[] = []
    const { user, client, rerender } = setup((input, init) => {
      if (init?.method === 'POST') { posts.push(JSON.parse(String(init.body))); return pending.promise }
      const accounts = new URL(String(input), 'http://localhost').searchParams.getAll('account')
      return Promise.resolve(response({ ...payload, accounts, revision: 5 }))
    })
    await prepareSubmittedDraft(user)
    await user.click(screen.getByRole('button', { name: 'Mi piace' }))
    await waitFor(() => expect(posts).toHaveLength(1))
    rerender(<QueryClientProvider client={client}><PreferenceEditor scope={{ accounts: ['Beta#EUW'], companion: null }} /></QueryClientProvider>)
    const search = await screen.findByLabelText('Cerca nel catalogo')
    await user.type(search, 'Zed')
    await user.selectOptions(screen.getByLabelText('Campione della preferenza'), 'Zed')
    await act(async () => { pending.resolve(response(status === 200 ? { ok: true, revision: 6, items: [] } : { error: 'Richiesta precedente fallita.' }, status)); await pending.promise })
    await waitFor(() => expect(client.isMutating()).toBe(0))

    expect(screen.getByLabelText('Cerca nel catalogo')).toBe(search)
    expect(search).toHaveValue('Zed')
    expect(screen.getByLabelText('Campione della preferenza')).toHaveValue('Zed')
    expect(screen.getByLabelText('Ruolo della preferenza')).toHaveValue('MIDDLE')
    expect(screen.getByText('Si applica a Beta#EUW.')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Mi piace' })).toBeEnabled()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(posts).toHaveLength(1)
    expect(posts[0]?.accounts).toEqual(['Alpha#EUW'])
  })
})
