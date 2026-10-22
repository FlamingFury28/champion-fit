import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { queryKeys } from '../api/queries'
import type { AnnotationResponseDto, AnnotationUpsertInput, MatchDto } from '../api/types'
import { AuditPage } from './AuditPage'

const { context, notify } = vi.hoisted(() => ({
  context: { scope: { accounts: ['Alpha#EUW'], companion: null }, scopeReady: true },
  notify: vi.fn(),
}))
vi.mock('../app/scope', () => ({ useScope: () => context }))
vi.mock('../components/toast', () => ({ useToast: () => ({ notify }) }))

const match: MatchDto = {
  id: 1, account: 'Alpha#EUW', match_id: 'MATCH-DRAFT', date: '2026-10-01T12:00:00Z',
  patch: '16.1', queue: '420', champion: 'Ahri', role: 'MIDDLE', identity_resolution: 'test',
  duration_minutes: 30, win: 0, explicit_afk: 0, suspected_quasi_afk: 0, early_surrender: 0,
  anomaly_flags: 'none', match_quality_score: 0.95, loss_attribution_weight: 0.95,
  win_evidence_weight: 0, reason: 'test', icon_url: '', annotation_invincible: 0,
  annotation_carryable_loss: 0, annotation_afk_player: 0, annotation_griefer: 0,
  annotation_team_collapse: 0, annotation_manual_label: '', annotation_note: '', annotation_confidence: 1,
}

function annotation(note: string, revision: string, label = ''): AnnotationResponseDto {
  return { revision, item: {
    match_id: match.match_id, note, manual_label: label, confidence: 1,
    invincible: 0, carryable_loss: 0, afk_player: 0, griefer: 0, team_collapse: 0, updated_at: revision,
  } }
}

function response(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function unloadPrevented() {
  const event = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(event)
  return event.defaultPrevented
}

function setup(fetchImpl?: typeof fetch) {
  if (fetchImpl) vi.stubGlobal('fetch', vi.fn(fetchImpl))
  const client = new QueryClient({ defaultOptions: {
    queries: { retry: false, staleTime: Infinity }, mutations: { retry: false },
  } })
  client.setQueryData(queryKeys.matches(context.scope, 'all'), { items: [match] })
  client.setQueryData(queryKeys.annotation(match.match_id), annotation('Originale', 'revision-1'))
  const router = createMemoryRouter([{ path: '*', element: <AuditPage embedded /> }])
  render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>)
  return { client, user: userEvent.setup() }
}

async function openAnnotation(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /^Apri annotazione:/ }))
  return screen.findByRole('textbox', { name: 'Nota' })
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); notify.mockClear() })

describe('bozze delle annotazioni', () => {
  it('aggiorna una versione pulita dopo un refetch e chiude senza avviso di bozza', async () => {
    const { client, user } = setup()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    await openAnnotation(user)
    await act(async () => {
      client.setQueryData(queryKeys.annotation(match.match_id), annotation('Nota aggiornata', 'revision-2', 'Nuova etichetta'))
    })
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Nota' })).toHaveValue('Nota aggiornata'))
    expect(screen.getByRole('textbox', { name: 'Etichetta manuale' })).toHaveValue('Nuova etichetta')
    await user.click(screen.getByRole('button', { name: 'Chiudi' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(confirm).not.toHaveBeenCalled()
  })

  it('conserva la bozza al cambio remoto e richiede consenso prima di usare la nuova revisione', async () => {
    const posts: AnnotationUpsertInput[] = []
    const { client, user } = setup((url, init) => {
      if (init?.method === 'POST') {
        posts.push(JSON.parse(String(init.body)))
        return Promise.resolve(response({ ok: true, match_id: match.match_id, revision: 'revision-3' }))
      }
      return Promise.resolve(response(String(url).startsWith('/api/annotations')
        ? annotation('La mia bozza', 'revision-3', 'La mia etichetta') : { items: [match] }))
    })
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const note = await openAnnotation(user)
    await user.clear(note)
    await user.type(note, 'La mia bozza')
    await user.type(screen.getByRole('textbox', { name: 'Etichetta manuale' }), 'La mia etichetta')
    await act(async () => {
      client.setQueryData(queryKeys.annotation(match.match_id), annotation('Nota remota', 'revision-2', 'Etichetta remota'))
    })
    await waitFor(() => expect(screen.getByText(/prima di salvarla dovrai confrontare/)).toBeVisible())
    expect(screen.getByRole('textbox', { name: 'Nota' })).toHaveValue('La mia bozza')
    expect(screen.getByRole('textbox', { name: 'Etichetta manuale' })).toHaveValue('La mia etichetta')
    await user.click(screen.getByRole('button', { name: 'Salva annotazione' }))
    expect(posts).toHaveLength(0)
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Nota remota'))
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Etichetta remota'))
    confirm.mockReturnValue(true)
    await user.click(screen.getByRole('button', { name: 'Salva annotazione' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(posts).toEqual([expect.objectContaining({
      note: 'La mia bozza', manual_label: 'La mia etichetta', expected_revision: 'revision-2',
    })])
    expect(confirm).toHaveBeenCalledTimes(2)
  })

  it('conserva la bozza dopo POST 409 e non aggiorna la revisione del retry senza consenso', async () => {
    const posts: AnnotationUpsertInput[] = []
    const { user } = setup((url, init) => {
      if (init?.method === 'POST') {
        posts.push(JSON.parse(String(init.body)))
        return Promise.resolve(posts.length === 1
          ? response({ error: 'Conflitto di revisione' }, 409)
          : response({ ok: true, match_id: match.match_id, revision: 'revision-3' }))
      }
      return Promise.resolve(response(String(url).startsWith('/api/annotations')
        ? annotation(posts.length > 1 ? 'Bozza locale' : 'Nota remota', posts.length > 1 ? 'revision-3' : 'revision-2')
        : { items: [match] }))
    })
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const note = await openAnnotation(user)
    await user.clear(note)
    await user.type(note, 'Bozza locale')
    await user.click(screen.getByRole('button', { name: 'Salva annotazione' }))
    await waitFor(() => expect(screen.getByText(/prima di salvarla dovrai confrontare/)).toBeVisible())
    expect(screen.getByRole('textbox', { name: 'Nota' })).toHaveValue('Bozza locale')
    expect(posts[0]?.expected_revision).toBe('revision-1')
    await user.click(screen.getByRole('button', { name: 'Salva annotazione' }))
    expect(posts).toHaveLength(1)
    confirm.mockReturnValue(true)
    await user.click(screen.getByRole('button', { name: 'Salva annotazione' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(posts[1]).toEqual(expect.objectContaining({ note: 'Bozza locale', expected_revision: 'revision-2' }))
  })

  it('mantiene montata la bozza quando il refetch dopo un conflitto fallisce e permette di ricaricare', async () => {
    const posts: AnnotationUpsertInput[] = []
    let refreshes = 0
    const { user } = setup((url, init) => {
      if (init?.method === 'POST') {
        posts.push(JSON.parse(String(init.body)))
        return Promise.resolve(posts.length === 1 ? response({ error: 'revision conflict' }, 409)
          : response({ ok: true, match_id: match.match_id, revision: 'revision-3' }))
      }
      if (String(url).startsWith('/api/annotations')) {
        refreshes += 1
        return Promise.resolve(refreshes === 1 ? response({ error: 'Service unavailable' }, 503)
          : response(annotation(posts.length > 1 ? 'Bozza conservata' : 'Nuova nota remota', posts.length > 1 ? 'revision-3' : 'revision-2')))
      }
      return Promise.resolve(response({ items: [match] }))
    })
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const note = await openAnnotation(user)
    await user.clear(note)
    await user.type(note, 'Bozza conservata')
    await user.click(screen.getByRole('button', { name: 'Salva annotazione' }))
    const refreshButton = await screen.findByRole('button', { name: 'Ricarica annotazione' })
    expect(screen.getByRole('textbox', { name: 'Nota' })).toBe(note)
    expect(note).toHaveValue('Bozza conservata')
    await user.click(refreshButton)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Salva annotazione' })).toBeEnabled())
    expect(posts).toHaveLength(1)
    expect(note).toHaveValue('Bozza conservata')
    await user.click(screen.getByRole('button', { name: 'Salva annotazione' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(posts[1]?.expected_revision).toBe('revision-2')
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Nuova nota remota'))
  })

  it('richiede un nuovo confronto se la versione cambia ancora dopo un retry approvato', async () => {
    const posts: AnnotationUpsertInput[] = []
    const { user } = setup((url, init) => {
      if (init?.method === 'POST') {
        posts.push(JSON.parse(String(init.body)))
        return Promise.resolve(posts.length < 3 ? response({ error: 'revision conflict' }, 409)
          : response({ ok: true, match_id: match.match_id, revision: 'revision-4' }))
      }
      return Promise.resolve(response(String(url).startsWith('/api/annotations')
        ? annotation(`Nota remota ${posts.length}`, `revision-${posts.length + 1}`) : { items: [match] }))
    })
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const note = await openAnnotation(user)
    await user.clear(note)
    await user.type(note, 'Bozza da proteggere')
    await user.click(screen.getByRole('button', { name: 'Salva annotazione' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Salva annotazione' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: 'Salva annotazione' }))
    await waitFor(() => expect(posts).toHaveLength(2))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Salva annotazione' })).toBeEnabled())
    expect(note).toHaveValue('Bozza da proteggere')
    confirm.mockReturnValue(false)
    await user.click(screen.getByRole('button', { name: 'Salva annotazione' }))
    expect(posts).toHaveLength(2)
    expect(confirm).toHaveBeenLastCalledWith(expect.stringContaining('Nota remota 2'))
    confirm.mockReturnValue(true)
    await user.click(screen.getByRole('button', { name: 'Salva annotazione' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(posts.map((post) => post.expected_revision)).toEqual(['revision-1', 'revision-2', 'revision-3'])
  })

  it('blocca campi, doppio invio e chiusura durante POST, anche quando il modulo era pulito', async () => {
    let resolvePost!: (response: Response) => void
    const posts: AnnotationUpsertInput[] = []
    const { user } = setup((url, init) => {
      if (init?.method === 'POST') {
        posts.push(JSON.parse(String(init.body)))
        return new Promise<Response>((resolve) => { resolvePost = resolve })
      }
      return Promise.resolve(response(String(url).startsWith('/api/annotations')
        ? annotation('Originale', 'revision-2') : { items: [match] }))
    })
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const note = await openAnnotation(user)
    const form = note.closest('form')!
    act(() => { fireEvent.submit(form); fireEvent.submit(form) })
    await waitFor(() => expect(note).toBeDisabled())
    for (const control of within(screen.getByRole('dialog')).getAllByRole('checkbox')) expect(control).toBeDisabled()
    expect(screen.getByRole('textbox', { name: 'Etichetta manuale' })).toBeDisabled()
    expect(screen.getByRole('slider')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Annulla' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Salvo…' })).toBeDisabled()
    await user.type(note, ' modifica tardiva')
    expect(note).toHaveValue('Originale')
    await user.click(screen.getByRole('button', { name: 'Chiudi' }))
    await user.keyboard('{Escape}')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(confirm).not.toHaveBeenCalled()
    expect(posts).toHaveLength(1)
    await act(async () => { resolvePost(response({ ok: true, match_id: match.match_id, revision: 'revision-2' })) })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(notify).toHaveBeenCalledWith('Annotazione salvata', expect.objectContaining({ tone: 'success' }))
    expect(await openAnnotation(user)).toHaveValue('Originale')
    await user.click(screen.getByRole('button', { name: 'Chiudi' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(confirm).not.toHaveBeenCalled()
  })

  it('riabilita la bozza dopo un salvataggio fallito e protegge la chiusura con modifiche', async () => {
    const { user } = setup((_url, init) => Promise.resolve(response(
      init?.method === 'POST' ? { error: 'Service unavailable' } : annotation('Originale', 'revision-1'),
      init?.method === 'POST' ? 503 : 200,
    )))
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const note = await openAnnotation(user)
    await user.type(note, ' con bozza')
    await user.click(screen.getByRole('button', { name: 'Salva annotazione' }))
    await waitFor(() => expect(note).toBeEnabled())
    expect(note).toHaveValue('Originale con bozza')
    await user.click(screen.getByRole('button', { name: 'Annulla' }))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(confirm).toHaveBeenCalledOnce()
    confirm.mockReturnValue(true)
    await user.click(screen.getByRole('button', { name: 'Annulla' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it.each([
    ['oggetto vuoto', {}],
    ['partita diversa', { ok: true, match_id: 'OTHER-MATCH', revision: 'revision-wrong' }],
  ])('non conferma né ripete il salvataggio200 con %s e conserva la revisione del retry esplicito', async (_case, acknowledgement) => {
    const posts: AnnotationUpsertInput[] = []
    let reads = 0
    const { user } = setup((url, init) => {
      if (init?.method === 'POST') {
        posts.push(JSON.parse(String(init.body)))
        return Promise.resolve(posts.length === 1 ? response(acknowledgement) : response({ error: 'Service unavailable' }, 503))
      }
      if (!String(url).startsWith('/api/annotations')) return Promise.resolve(response({ items: [match] }))
      reads += 1
      return Promise.resolve(response(annotation('Originale', 'revision-1')))
    })
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const note = await openAnnotation(user)
    const label = screen.getByRole('textbox', { name: 'Etichetta manuale' })
    await user.clear(note)
    await user.type(note, 'Bozza non confermata')
    await user.type(label, 'Etichetta da conservare')
    await user.click(screen.getByRole('checkbox', { name: 'Giocatore inattivo (AFK) in squadra' }))
    await user.click(screen.getByRole('button', { name: 'Salva annotazione' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Salvo…' })).not.toBeInTheDocument())

    expect(screen.getByRole('textbox', { name: 'Nota' })).toBe(note)
    expect(screen.getByRole('textbox', { name: 'Etichetta manuale' })).toBe(label)
    expect(note).toHaveValue('Bozza non confermata')
    expect(label).toHaveValue('Etichetta da conservare')
    expect(screen.getByRole('checkbox', { name: 'Giocatore inattivo (AFK) in squadra' })).toBeChecked()
    expect(screen.getByText('La risposta del server non è valida o completa. L’esito della richiesta non è confermato.')).toBeVisible()
    expect(notify).not.toHaveBeenCalledWith('Annotazione salvata', expect.anything())
    expect(posts).toHaveLength(1)
    expect(reads).toBe(0)
    expect(unloadPrevented()).toBe(true)
    await user.click(screen.getByRole('button', { name: 'Chiudi' }))
    expect(confirm).toHaveBeenCalledOnce()
    expect(note).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Salva annotazione' }))
    await waitFor(() => expect(posts).toHaveLength(2))
    expect(posts[1]).toEqual(posts[0])
    expect(posts[1]?.expected_revision).toBe('revision-1')
    expect(reads).toBe(0)
  })

  it.each(['revision-1', null])('dopo409 richiede GET aggiornato per il token%s, preservando la bozza durante errore e attesa', async (initialRevision) => {
    const initial: AnnotationResponseDto = initialRevision === null
      ? { item: null, revision: null } : annotation('Originale', initialRevision)
    const pendingRefresh = deferred<Response>()
    const posts: AnnotationUpsertInput[] = []
    let reads = 0
    const { client, user } = setup((url, init) => {
      if (init?.method === 'POST') {
        posts.push(JSON.parse(String(init.body)))
        return Promise.resolve(posts.length === 1 ? response({ error: 'revision conflict' }, 409)
          : response({ ok: true, match_id: match.match_id, revision: 'revision-3' }))
      }
      if (!String(url).startsWith('/api/annotations')) return Promise.resolve(response({ items: [match] }))
      reads += 1
      if (posts.length > 1) return Promise.resolve(response(annotation(posts[1]!.note, 'revision-3')))
      if (reads === 2) return pendingRefresh.promise
      return Promise.resolve(response(reads < 4 ? initial : annotation('Nota remota da confrontare', 'revision-2', 'Etichetta remota')))
    })
    client.setQueryData(queryKeys.annotation(match.match_id), initial)
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const note = await openAnnotation(user)
    await user.clear(note)
    await user.type(note, 'Bozza locale')
    await user.click(screen.getByRole('button', { name: 'Salva annotazione' }))
    const reload = await screen.findByRole('button', { name: 'Ricarica annotazione' })
    await waitFor(() => expect(reload).toBeEnabled())
    expect(posts[0]?.expected_revision).toBe(initialRevision)
    expect(screen.getByText(/La versione corrente dell’annotazione non è ancora aggiornata/)).toBeVisible()
    expect(reads).toBe(1)
    await user.click(reload)
    await waitFor(() => expect(reads).toBe(2))
    expect(screen.getByRole('button', { name: 'Ricarico annotazione…' })).toBeDisabled()
    expect(posts).toHaveLength(1)
    await user.type(note, ' · durante il recupero')
    expect(unloadPrevented()).toBe(true)
    act(() => { fireEvent.submit(note.closest('form')!) })
    expect(posts).toHaveLength(1)
    expect(reads).toBe(2)

    await act(async () => { pendingRefresh.resolve(response({ error: 'Service unavailable' }, 503)); await pendingRefresh.promise })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Ricarica annotazione' })).toBeEnabled())
    expect(screen.getByRole('textbox', { name: 'Nota' })).toBe(note)
    expect(note).toHaveValue('Bozza locale · durante il recupero')
    expect(screen.getByText(/Non riesco ad aggiornare l’annotazione corrente/)).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Ricarica annotazione' }))
    await waitFor(() => expect(reads).toBe(3))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Ricarica annotazione' })).toBeEnabled())
    expect(posts).toHaveLength(1)
    expect(screen.getByText(/La versione corrente dell’annotazione non è ancora aggiornata/)).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Ricarica annotazione' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Salva annotazione' })).toBeEnabled())
    expect(screen.getByRole('textbox', { name: 'Nota' })).toBe(note)
    expect(note).toHaveValue('Bozza locale · durante il recupero')
    await user.click(screen.getByRole('button', { name: 'Salva annotazione' }))
    expect(posts).toHaveLength(1)
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Nota remota da confrontare'))
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Etichetta remota'))
    confirm.mockReturnValue(true)
    await user.click(screen.getByRole('button', { name: 'Salva annotazione' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(posts[1]).toEqual(expect.objectContaining({ expected_revision: 'revision-2', note: 'Bozza locale · durante il recupero' }))
  })

  it.each(['revision-1', null])('un POST pulito409 con token%s mantiene i valori inviati e richiede consenso sul token nuovo', async (initialRevision) => {
    const initial: AnnotationResponseDto = initialRevision === null
      ? { item: null, revision: null } : annotation('Originale', initialRevision)
    const initialNote = initial.item?.note ?? ''
    const posts: AnnotationUpsertInput[] = []
    let reads = 0
    const { client, user } = setup((url, init) => {
      if (init?.method === 'POST') {
        posts.push(JSON.parse(String(init.body)))
        return Promise.resolve(posts.length === 1 ? response({ error: 'revision conflict' }, 409)
          : response({ ok: true, match_id: match.match_id, revision: 'revision-3' }))
      }
      if (!String(url).startsWith('/api/annotations')) return Promise.resolve(response({ items: [match] }))
      reads += 1
      return Promise.resolve(response(reads === 1 ? initial
        : annotation('Versione remota da non assorbire', 'revision-2', 'Nuovo contesto')))
    })
    client.setQueryData(queryKeys.annotation(match.match_id), initial)
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const note = await openAnnotation(user)
    expect(unloadPrevented()).toBe(false)
    await user.click(screen.getByRole('button', { name: 'Salva annotazione' }))
    const reload = await screen.findByRole('button', { name: 'Ricarica annotazione' })
    await waitFor(() => expect(reload).toBeEnabled())
    expect(note).toHaveValue(initialNote)
    expect(unloadPrevented()).toBe(true)
    await user.click(screen.getByRole('button', { name: 'Chiudi' }))
    expect(confirm).toHaveBeenCalledWith('Chiudere senza salvare le modifiche all’annotazione?')
    expect(note).toBeInTheDocument()
    await user.click(reload)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Salva annotazione' })).toBeEnabled())
    expect(screen.getByRole('textbox', { name: 'Nota' })).toBe(note)
    expect(note).toHaveValue(initialNote)
    expect(screen.getByRole('textbox', { name: 'Etichetta manuale' })).toHaveValue('')
    expect(unloadPrevented()).toBe(true)
    await user.click(screen.getByRole('button', { name: 'Salva annotazione' }))
    expect(confirm).toHaveBeenLastCalledWith(expect.stringContaining('Versione remota da non assorbire'))
    expect(posts).toHaveLength(1)
    confirm.mockReturnValue(true)
    await user.click(screen.getByRole('button', { name: 'Salva annotazione' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(posts[0]?.expected_revision).toBe(initialRevision)
    expect(posts[1]).toEqual(expect.objectContaining({ expected_revision: 'revision-2', note: initialNote, manual_label: '' }))
    expect(unloadPrevented()).toBe(false)
  })

  it('memorizza anche la seconda revisione rifiutata e confronta di nuovo la terza versione', async () => {
    const posts: AnnotationUpsertInput[] = []
    let reads = 0
    const { user } = setup((url, init) => {
      if (init?.method === 'POST') {
        posts.push(JSON.parse(String(init.body)))
        return Promise.resolve(posts.length < 3 ? response({ error: 'revision conflict' }, 409)
          : response({ ok: true, match_id: match.match_id, revision: 'revision-4' }))
      }
      if (!String(url).startsWith('/api/annotations')) return Promise.resolve(response({ items: [match] }))
      reads += 1
      return Promise.resolve(response(annotation(`Nota remota ${reads}`, reads <= 2 ? 'revision-2' : 'revision-3')))
    })
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const note = await openAnnotation(user)
    await user.clear(note)
    await user.type(note, 'Bozza tra revisioni ripetute')
    await user.click(screen.getByRole('button', { name: 'Salva annotazione' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Salva annotazione' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: 'Salva annotazione' }))
    const reload = await screen.findByRole('button', { name: 'Ricarica annotazione' })
    await waitFor(() => expect(reload).toBeEnabled())
    expect(posts.map((post) => post.expected_revision)).toEqual(['revision-1', 'revision-2'])
    expect(screen.getByText(/La versione corrente dell’annotazione non è ancora aggiornata/)).toBeVisible()
    await user.click(reload)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Salva annotazione' })).toBeEnabled())
    expect(note).toHaveValue('Bozza tra revisioni ripetute')
    confirm.mockReturnValue(false)
    await user.click(screen.getByRole('button', { name: 'Salva annotazione' }))
    expect(posts).toHaveLength(2)
    expect(confirm).toHaveBeenLastCalledWith(expect.stringContaining('Nota remota 3'))
    confirm.mockReturnValue(true)
    await user.click(screen.getByRole('button', { name: 'Salva annotazione' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(posts.map((post) => post.expected_revision)).toEqual(['revision-1', 'revision-2', 'revision-3'])
  })
})
