import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { queryKeys } from '../api/queries'
import type { RecommendationFeedbackInputDto, RecommendationFeedbackResponseDto } from '../api/types'
import { FitPage } from '../pages/FitPage'
import { observedRecommendation, recommendationsFixture } from '../test/recommendations-fixture'

const { context } = vi.hoisted(() => ({ context: {
  scope: { accounts: ['Alpha#EUW', 'Beta#EUW'], companion: null }, scopeReady: true,
} }))
vi.mock('../app/scope', () => ({ useScope: () => context }))

const advice = recommendationsFixture({
  feedback_revision: 7,
  known: [observedRecommendation({ champion: 'MonkeyKing', name: 'Wukong', role: 'TOP' })],
  coverage: { selected_accounts: ['Alpha#EUW', 'Beta#EUW'], active_accounts: ['Alpha#EUW', 'Beta#EUW'], missing_accounts: [], games: 1, observations: 1 },
})
const ledger: RecommendationFeedbackResponseDto = {
  revision: 7, accounts: ['Alpha#EUW', 'Beta#EUW'], suspended_accounts: [], unresolved_accounts: [], items: [],
  options: [{ champion: 'Zed', name: 'Zed', roles: ['MIDDLE'], roles_by_account: { 'Alpha#EUW': ['MIDDLE'], 'Beta#EUW': ['MIDDLE'] }, icon_url: null, classified: true }],
  catalog_version: 'synthetic',
}
const judgments = [
  { label: 'Mi piace', value: 'like' },
  { label: 'Neutro', value: 'neutral' },
  { label: 'Non fa per me', value: 'dislike' },
] as const
const clients: QueryClient[] = []
const routers: ReturnType<typeof createMemoryRouter>[] = []

function response(payload: unknown, status = 200) { return Response.json(payload, { status }) }
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
function setup(fetchImpl: typeof fetch) {
  vi.stubGlobal('fetch', vi.fn(fetchImpl))
  const client = new QueryClient({ defaultOptions: {
    queries: { retry: false, staleTime: Infinity }, mutations: { retry: false },
  } })
  clients.push(client)
  client.setQueryData(queryKeys.recommendations(context.scope, {}), advice)
  client.setQueryData(queryKeys.recommendationFeedback(context.scope), ledger)
  const router = createMemoryRouter([{ path: '*', element: <FitPage /> }], { initialEntries: ['/app/fit?section=choices'] })
  routers.push(router)
  render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>)
  const card = screen.getByText('Wukong').closest<HTMLElement>('.recommendation-card')!
  return { client, card, user: userEvent.setup() }
}
type User = ReturnType<typeof userEvent.setup>
async function selectAlpha(card: HTMLElement, user: User) {
  await user.click(within(card).getByText(/Account ·/))
  await user.click(within(card).getByRole('checkbox', { name: 'Beta#EUW' }))
}
async function changeToBeta(card: HTMLElement, user: User) {
  await user.click(within(card).getByRole('checkbox', { name: 'Alpha#EUW' }))
  await user.click(within(card).getByRole('checkbox', { name: 'Beta#EUW' }))
}
function expectBeta(card: HTMLElement, originalCheckbox: HTMLElement) {
  expect(within(card).getByRole('checkbox', { name: 'Beta#EUW' })).toBe(originalCheckbox)
  expect(originalCheckbox).toBeChecked()
  expect(within(card).getByRole('checkbox', { name: 'Alpha#EUW' })).not.toBeChecked()
}
function expectTarget(element: HTMLElement, judgment = 'Mi piace', account = 'Alpha#EUW') {
  expect(element).toHaveTextContent(`${judgment} · Wukong · Corsia superiore · ${account}`)
  expect(element).not.toHaveTextContent('MonkeyKing')
  expect(element).not.toHaveTextContent(account === 'Alpha#EUW' ? 'Beta#EUW' : 'Alpha#EUW')
}

afterEach(() => {
  cleanup()
  for (const router of routers.splice(0)) router.dispose()
  for (const client of clients.splice(0)) client.clear()
  vi.unstubAllGlobals()
})

describe('scheda suggerimento: richieste e recupero delle preferenze', () => {
  it.each([503, 200])('conserva la nuova selezione e richiede solo GET dopo409 seguito daGET%s obsoleto', async (getStatus) => {
    const rejectedPost = deferred<Response>()
    const retryRecommendations = deferred<Response>()
    const retryLedger = deferred<Response>()
    const posts: RecommendationFeedbackInputDto[] = []
    const reads: string[] = []
    let refresh = 0
    const { card, user } = setup((url, init) => {
      if (init?.method === 'POST') {
        posts.push(JSON.parse(String(init.body)))
        return posts.length === 1 ? rejectedPost.promise : Promise.resolve(response({ ok: true, revision: 9, items: [] }))
      }
      const isLedger = String(url).startsWith('/api/recommendation-feedback')
      reads.push(isLedger ? 'ledger' : 'recommendations')
      if (refresh === 1) return isLedger ? retryLedger.promise : retryRecommendations.promise
      if (refresh === 0 && getStatus === 503) return Promise.resolve(response({ error: 'Lettura non disponibile' }, 503))
      return Promise.resolve(response(isLedger ? { ...ledger, revision: refresh >= 2 ? 8 : 7 } : { ...advice, feedback_revision: refresh >= 2 ? 8 : 7 }))
    })
    await selectAlpha(card, user)
    const beta = within(card).getByRole('checkbox', { name: 'Beta#EUW' })
    await user.click(within(card).getByRole('button', { name: 'Mi piace' }))
    await waitFor(() => expect(posts).toHaveLength(1))
    await changeToBeta(card, user)
    await act(async () => { rejectedPost.resolve(response({ error: 'Conflitto di revisione' }, 409)); await rejectedPost.promise })

    const retry = await within(card).findByRole('button', { name: 'Ricarica preferenze' })
    await waitFor(() => expect(retry).toBeEnabled())
    expect(reads).toHaveLength(2)
    const conflict = within(card).getByRole('alert')
    expect(conflict).toHaveTextContent(getStatus === 503 ? 'Non riesco ad aggiornare' : 'non è ancora aggiornata')
    expect(conflict).not.toHaveTextContent('Ho ricaricato')
    expectTarget(conflict)
    expectBeta(card, beta)
    for (const judgment of judgments) expect(within(card).queryByRole('button', { name: judgment.label })).not.toBeInTheDocument()

    refresh = 1
    await user.click(retry)
    await waitFor(() => expect(reads).toHaveLength(4))
    expect(within(card).getByRole('button', { name: 'Ricarico preferenze…' })).toBeDisabled()
    expectTarget(within(card).getByRole('status'))
    expect(posts).toHaveLength(1)
    // The ledger can finish first with a newer token; the card still needs its own recommendations snapshot.
    await act(async () => { retryLedger.resolve(response({ ...ledger, revision: 8 })); await retryLedger.promise })
    expect(within(card).getByRole('button', { name: 'Ricarico preferenze…' })).toBeDisabled()
    await act(async () => { retryRecommendations.resolve(response(advice)); await retryRecommendations.promise })
    await waitFor(() => expect(within(card).getByRole('button', { name: 'Ricarica preferenze' })).toBeEnabled())
    expect(within(card).getByRole('alert')).toHaveTextContent('non è ancora aggiornata')
    expect(posts).toHaveLength(1)

    refresh = 2
    await user.click(within(card).getByRole('button', { name: 'Ricarica preferenze' }))
    await waitFor(() => expect(within(card).getByRole('button', { name: 'Non fa per me' })).toBeEnabled())
    expect(reads).toHaveLength(6)
    expectBeta(card, beta)
    expectTarget(within(card).getByRole('alert'))
    expect(posts).toHaveLength(1)
    await user.click(within(card).getByRole('button', { name: 'Non fa per me' }))
    await waitFor(() => expect(within(card).getByRole('status')).toHaveTextContent('Preferenza salvata.'))
    expectTarget(within(card).getByRole('status'), 'Non fa per me', 'Beta#EUW')
    expect(posts).toEqual([
      { accounts: ['Alpha#EUW'], champion: 'MonkeyKing', role: 'TOP', preference: 'like', expected_revision: 7 },
      { accounts: ['Beta#EUW'], champion: 'MonkeyKing', role: 'TOP', preference: 'dislike', expected_revision: 8 },
    ])
  })

  it.each(judgments)('protegge anche il giudizio $label dalla revisione rifiutata', async (judgment) => {
    const posts: RecommendationFeedbackInputDto[] = []
    const { card, user } = setup((url, init) => {
      if (init?.method === 'POST') { posts.push(JSON.parse(String(init.body))); return Promise.resolve(response({ error: 'Conflitto' }, 409)) }
      return Promise.resolve(response(String(url).startsWith('/api/recommendation-feedback') ? ledger : advice))
    })
    await user.click(within(card).getByRole('button', { name: judgment.label }))
    const retry = await within(card).findByRole('button', { name: 'Ricarica preferenze' })
    await waitFor(() => expect(retry).toBeEnabled())
    await user.click(retry)
    await waitFor(() => expect(retry).toBeEnabled())
    expect(posts).toHaveLength(1)
    expect(posts[0]?.preference).toBe(judgment.value)
    for (const action of judgments) expect(within(card).queryByRole('button', { name: action.label })).not.toBeInTheDocument()
  })

  it.each([200, 503])('attribuisce attesa ed esito tardivo%s al payload Alpha senza alterare la selezione Beta', async (status) => {
    const pending = deferred<Response>()
    const posts: RecommendationFeedbackInputDto[] = []
    let reads = 0
    const { card, user } = setup((url, init) => {
      if (init?.method === 'POST') { posts.push(JSON.parse(String(init.body))); return posts.length === 1 ? pending.promise : Promise.resolve(response({ ok: true, revision: 9, items: [] })) }
      reads += 1
      return Promise.resolve(response(String(url).startsWith('/api/recommendation-feedback') ? { ...ledger, revision: 8 } : { ...advice, feedback_revision: 8 }))
    })
    await selectAlpha(card, user)
    const beta = within(card).getByRole('checkbox', { name: 'Beta#EUW' })
    await user.click(within(card).getByRole('button', { name: 'Mi piace' }))
    await waitFor(() => expect(posts).toHaveLength(1))
    await changeToBeta(card, user)
    expectBeta(card, beta)
    expectTarget(within(card).getByRole('status'))
    for (const judgment of judgments) expect(within(card).getByRole('button', { name: judgment.label })).toBeDisabled()
    await act(async () => { pending.resolve(response(status === 200 ? { ok: true, revision: 8, items: [] } : { error: 'Salvataggio non disponibile' }, status)); await pending.promise })

    const result = await within(card).findByRole(status === 200 ? 'status' : 'alert')
    await waitFor(() => expect(result).toHaveTextContent(status === 200 ? 'Preferenza salvata.' : 'Salvataggio non disponibile'))
    expectTarget(result)
    expectBeta(card, beta)
    expect(reads).toBe(status === 200 ? 2 : 0)
    expect(posts).toHaveLength(1)
    await user.click(within(card).getByRole('button', { name: 'Neutro' }))
    await waitFor(() => expect(posts).toHaveLength(2))
    expect(posts[1]).toEqual({ accounts: ['Beta#EUW'], champion: 'MonkeyKing', role: 'TOP', preference: 'neutral', expected_revision: status === 200 ? 8 : 7 })
    await waitFor(() => expect(within(card).getByRole('status')).toHaveTextContent('Preferenza salvata.'))
    expectTarget(within(card).getByRole('status'), 'Neutro', 'Beta#EUW')
  })

  it.each([
    { recommendationsStatus: 503, recommendationsRevision: 7, ledgerStatus: 200, ready: false },
    { recommendationsStatus: 200, recommendationsRevision: 7, ledgerStatus: 200, ready: false },
    { recommendationsStatus: 200, recommendationsRevision: 8, ledgerStatus: 503, ready: true },
  ])('usa la revisione delle props quando le due query divergono: %j', async ({ recommendationsStatus, recommendationsRevision, ledgerStatus, ready }) => {
    const posts: RecommendationFeedbackInputDto[] = []
    const { card, user, client } = setup((url, init) => {
      if (init?.method === 'POST') { posts.push(JSON.parse(String(init.body))); return Promise.resolve(response({ error: 'Conflitto' }, 409)) }
      const isLedger = String(url).startsWith('/api/recommendation-feedback')
      const status = isLedger ? ledgerStatus : recommendationsStatus
      return Promise.resolve(response(status === 503 ? { error: 'Lettura non disponibile' }
        : isLedger ? { ...ledger, revision: 8 } : { ...advice, feedback_revision: recommendationsRevision }, status))
    })
    await user.click(within(card).getByRole('button', { name: 'Mi piace' }))
    await waitFor(() => expect(client.isMutating()).toBe(0))
    expect(posts).toHaveLength(1)
    if (ready) {
      expect(within(card).getByRole('button', { name: 'Mi piace' })).toBeEnabled()
      expect(within(card).getByRole('alert')).toHaveTextContent('La revisione corrente è aggiornata')
      expect(within(card).queryByRole('button', { name: 'Ricarica preferenze' })).not.toBeInTheDocument()
    } else {
      expect(within(card).getByRole('button', { name: 'Ricarica preferenze' })).toBeEnabled()
      expect(within(card).getByRole('alert')).not.toHaveTextContent('La revisione corrente è aggiornata')
    }
  })

  it('attende entrambi i GET quando la revisione della scheda arriva prima del registro', async () => {
    const pendingLedger = deferred<Response>()
    const posts: RecommendationFeedbackInputDto[] = []
    let reads = 0
    const { card, user } = setup((url, init) => {
      if (init?.method === 'POST') { posts.push(JSON.parse(String(init.body))); return Promise.resolve(response({ error: 'Conflitto' }, 409)) }
      reads += 1
      return String(url).startsWith('/api/recommendation-feedback') ? pendingLedger.promise : Promise.resolve(response({ ...advice, feedback_revision: 8 }))
    })
    await selectAlpha(card, user)
    await user.click(within(card).getByRole('button', { name: 'Mi piace' }))
    await waitFor(() => expect(reads).toBe(2))
    await waitFor(() => expect(within(card).getByRole('button', { name: 'Neutro' })).toBeDisabled())
    expectTarget(within(card).getByRole('status'))
    await changeToBeta(card, user)
    await user.click(within(card).getByRole('button', { name: 'Neutro' }))
    expect(posts).toHaveLength(1)

    await act(async () => { pendingLedger.resolve(response({ error: 'Registro non disponibile' }, 503)); await pendingLedger.promise })
    await waitFor(() => expect(within(card).getByRole('button', { name: 'Neutro' })).toBeEnabled())
    expect(within(card).getByRole('alert')).toHaveTextContent('La revisione corrente è aggiornata')
    expectTarget(within(card).getByRole('alert'))
    expect(within(card).getByRole('checkbox', { name: 'Beta#EUW' })).toBeChecked()
    expect(posts).toHaveLength(1)
  })

  it('non invia giudizi concorrenti quando si attivano più azioni prima del render pending', async () => {
    const pending = deferred<Response>()
    const posts: RecommendationFeedbackInputDto[] = []
    const { card } = setup((_url, init) => {
      posts.push(JSON.parse(String(init?.body)))
      return pending.promise
    })
    act(() => {
      for (const judgment of judgments) within(card).getByRole('button', { name: judgment.label }).click()
    })
    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0]?.preference).toBe('like')
    await act(async () => { pending.resolve(response({ error: 'Servizio non disponibile' }, 503)); await pending.promise })
    expect(await within(card).findByRole('alert')).toHaveTextContent('Servizio non disponibile')
    expect(posts).toHaveLength(1)
  })
})
