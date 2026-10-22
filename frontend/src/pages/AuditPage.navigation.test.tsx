import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider, useSearchParams } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { queryKeys } from '../api/queries'
import type { AnnotationResponseDto, AnnotationUpsertInput, MatchDto } from '../api/types'
import { AlgorithmSettingsPage } from './AlgorithmSettingsPage'
import { AuditPage } from './AuditPage'

const scope = { accounts: ['Alpha#EUW'], companion: null }
vi.mock('../app/scope', () => ({ useScope: () => ({ scope, scopeReady: true }) }))
vi.mock('../components/toast', () => ({ useToast: () => ({ notify: vi.fn() }) }))

const match: MatchDto = {
  id: 1, account: 'Alpha#EUW', match_id: 'SYNTHETIC-NAVIGATION', date: '2026-10-01T12:00:00Z',
  patch: '16.1', queue: '420', champion: 'Ahri', role: 'MIDDLE', identity_resolution: 'test',
  duration_minutes: 30, win: 0, explicit_afk: 0, suspected_quasi_afk: 0, early_surrender: 0,
  anomaly_flags: 'none', match_quality_score: 1, loss_attribution_weight: 1,
  win_evidence_weight: 0, reason: 'Synthetic navigation fixture', icon_url: '', annotation_invincible: 0,
  annotation_carryable_loss: 0, annotation_afk_player: 0, annotation_griefer: 0,
  annotation_team_collapse: 0, annotation_manual_label: '', annotation_note: '', annotation_confidence: 1,
}
const original: AnnotationResponseDto = {
  revision: 'revision-1', item: {
    match_id: match.match_id, note: 'Nota originale', manual_label: '', confidence: 1,
    invincible: 0, carryable_loss: 0, afk_player: 0, griefer: 0, team_collapse: 0, updated_at: 'revision-1',
  },
}

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function AuditHost() {
  const [params] = useSearchParams()
  return params.get('section') === 'style' ? <h1>Stile della fixture</h1> : <AuditPage embedded />
}

const clients: QueryClient[] = []
const routers: ReturnType<typeof createMemoryRouter>[] = []
function setup({ previous = '/app/overview', post }: { previous?: string; post?: Promise<Response> } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } })
  clients.push(client)
  for (const flag of ['all', 'loss']) client.setQueryData(queryKeys.matches(scope, flag), { items: [match] })
  client.setQueryData(queryKeys.annotation(match.match_id), original)
  const posts: AnnotationUpsertInput[] = []
  vi.stubGlobal('fetch', vi.fn((input, init) => {
    if (init?.method === 'POST') {
      posts.push(JSON.parse(String(init.body)))
      if (!post) throw new Error('Unexpected write in navigation-only fixture')
      return post
    }
    const path = new URL(String(input), 'http://localhost').pathname
    return Promise.resolve(response(path === '/api/annotations' ? original : { items: [match] }))
  }))
  const router = createMemoryRouter([
    { path: '/app/matches', element: <AuditHost /> },
    { path: '/app/overview', element: <h1>Riepilogo della fixture</h1> },
    { path: '/app/settings/algorithms', element: <AlgorithmSettingsPage /> },
  ], { initialEntries: [previous, '/app/matches?section=history'], initialIndex: 1 })
  routers.push(router)
  render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>)
  return { client, router, posts, user: userEvent.setup() }
}

async function openAnnotation(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /^Apri annotazione:/ }))
  return screen.findByRole('textbox', { name: 'Nota' })
}

function unloadPrevented() {
  const event = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(event)
  return event.defaultPrevented
}

afterEach(() => {
  cleanup()
  routers.splice(0).forEach((router) => router.dispose())
  clients.splice(0).forEach((client) => client.clear())
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('navigazione con annotazione aperta', () => {
  it.each(['Indietro', 'altra route', 'sezione stile'] as const)('protegge la bozza per %s e mantiene lo stesso nodo al rifiuto', async (kind) => {
    const { user, router, posts } = setup({ previous: kind === 'sezione stile' ? '/app/matches?section=style' : '/app/overview' })
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const note = await openAnnotation(user)
    await user.clear(note)
    await user.type(note, 'Bozza personale da conservare')
    const navigate = () => kind === 'altra route' ? router.navigate('/app/overview') : router.navigate(-1)

    await act(async () => { await navigate() })

    expect(confirm).toHaveBeenCalledOnce()
    expect(confirm).toHaveBeenCalledWith('Chiudere senza salvare le modifiche all’annotazione?')
    expect(router.state.location.pathname + router.state.location.search).toBe('/app/matches?section=history')
    expect(screen.getByRole('textbox', { name: 'Nota' })).toBe(note)
    expect(note).toHaveValue('Bozza personale da conservare')
    expect(posts).toEqual([])

    confirm.mockReturnValue(true)
    await act(async () => { await navigate() })
    expect(await screen.findByRole('heading', { name: kind === 'sezione stile' ? 'Stile della fixture' : 'Riepilogo della fixture' })).toBeVisible()
    expect(screen.queryByRole('textbox', { name: 'Nota' })).not.toBeInTheDocument()
    expect(confirm).toHaveBeenCalledTimes(2)
  })

  it('consente flag e hash che mantengono Audit e non duplica la conferma di chiusura', async () => {
    const { user, router } = setup()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const note = await openAnnotation(user)
    expect(unloadPrevented()).toBe(false)
    await user.type(note, ' · bozza')
    expect(unloadPrevented()).toBe(true)

    await act(async () => { await router.navigate('/app/matches?section=history&flag=loss#match-history') })
    await act(async () => { await router.navigate('/app/matches?section=history&flag=loss#match-trend') })
    expect(screen.getByRole('textbox', { name: 'Nota' })).toBe(note)
    expect(note).toHaveValue('Nota originale · bozza')
    expect(confirm).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Chiudi' }))
    expect(confirm).toHaveBeenCalledOnce()
    expect(note).toBeInTheDocument()
    confirm.mockReturnValue(true)
    await user.click(screen.getByRole('button', { name: 'Chiudi' }))
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('textbox', { name: 'Nota' })).not.toBeInTheDocument()
    expect(unloadPrevented()).toBe(false)
  })

  it.each(['successo', 'errore'] as const)('blocca Indietro e unload durante POST pulito senza riprendere la navigazione al %s', async (outcome) => {
    const pending = deferred<Response>()
    const { user, router, posts } = setup({ post: pending.promise })
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const note = await openAnnotation(user)
    expect(unloadPrevented()).toBe(false)
    await user.click(screen.getByRole('button', { name: 'Salva annotazione' }))
    await waitFor(() => expect(posts).toHaveLength(1))
    expect(note).toBeDisabled()
    expect(unloadPrevented()).toBe(true)

    await act(async () => { await router.navigate(-1) })
    expect(router.state.location.pathname).toBe('/app/matches')
    expect(screen.getByRole('textbox', { name: 'Nota' })).toBe(note)
    expect(confirm).not.toHaveBeenCalled()
    await act(async () => {
      pending.resolve(outcome === 'successo'
        ? response({ ok: true, match_id: match.match_id, revision: 'revision-2' })
        : response({ error: 'Salvataggio temporaneamente non disponibile.' }, 503))
      await pending.promise
    })
    if (outcome === 'successo') await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Nota' })).not.toBeInTheDocument())
    else await waitFor(() => expect(note).toBeEnabled())
    expect(router.state.location.pathname).toBe('/app/matches')
    expect(confirm).not.toHaveBeenCalled()
    expect(unloadPrevented()).toBe(false)

    await act(async () => { await router.navigate(-1) })
    expect(await screen.findByRole('heading', { name: 'Riepilogo della fixture' })).toBeVisible()
    expect(confirm).not.toHaveBeenCalled()
  })

  it('scarta il tentativo pendente anche se il POST termina nello stesso turno', async () => {
    const pending = deferred<Response>()
    const { user, router, posts } = setup({ post: pending.promise })
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    await openAnnotation(user)
    await user.click(screen.getByRole('button', { name: 'Salva annotazione' }))
    await waitFor(() => expect(posts).toHaveLength(1))

    await act(async () => {
      await router.navigate(-1)
      pending.resolve(response({ ok: true, match_id: match.match_id, revision: 'revision-2' }))
      await pending.promise
    })
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Nota' })).not.toBeInTheDocument())
    expect(router.state.location.pathname).toBe('/app/matches')
    expect(confirm).not.toHaveBeenCalled()
  })

  it('rilascia il blocker prima di montare quello della pagina algoritmi', async () => {
    const { user, router } = setup()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const warn = vi.spyOn(console, 'warn')
    const note = await openAnnotation(user)
    await user.type(note, ' · bozza')
    await act(async () => { await router.navigate('/app/settings/algorithms') })
    expect(await screen.findByRole('heading', { name: 'Impossibile caricare le impostazioni algoritmiche' })).toBeVisible()
    await act(async () => { await router.navigate('/app/overview') })
    expect(await screen.findByRole('heading', { name: 'Riepilogo della fixture' })).toBeVisible()
    expect(confirm).toHaveBeenCalledOnce()
    expect(warn.mock.calls.flat().join(' ')).not.toContain('only supports one blocker')
    expect(unloadPrevented()).toBe(false)
  })
})
