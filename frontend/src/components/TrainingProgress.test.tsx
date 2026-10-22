import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, expect, it, vi } from 'vitest'
import type { TrainingPlanResponseDto } from '../api/types'
import { TrainingProgress } from './TrainingProgress'

const fingerprint = 'a'.repeat(64)
const id = '11111111-1111-4111-8111-111111111111'
const key = 'champion-fit:followed-plan:v1'
const counts = { planned: 20, completed: 1, remaining: 19, extra: 0 }
const progress = { id, fingerprint, started_at: '2026-10-22T10:00:00Z', budget_total: 20,
  ...counts, queue: '420', accounts: ['Alpha#EUW'], companions: [], companion_mode: '',
  unavailable_accounts: [], companion_unavailable: false,
  items: [{ champion: 'Ahri', role: 'MIDDLE', ...counts, accounts: [{ account: 'Alpha#EUW', ...counts }] }],
}
const plan: TrainingPlanResponseDto = { plan_fingerprint: fingerprint, budget_total: 20, budget_assigned: 20,
  budget_default: 400, algorithm_revision: 1, context: {}, items: [] }

function Location() { return <output aria-label="Test URL">{useLocation().search}</output> }
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/app/fit?section=tournament']}>
    <TrainingProgress plan={plan} scope={{ accounts: ['Alpha#EUW'], companion: null }} filters={{ budget: 20, role: 'MIDDLE' }} ready refreshPreview={vi.fn()} /><Location />
  </MemoryRouter></QueryClientProvider>)
  return client
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear() })

it('salva solo dopo la scelta esplicita, ricorda il piano e ricalcola da letture locali', async () => {
  const fetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
    const chosenId = init.method === 'POST' ? JSON.parse(String(init.body)).id : new URL(_url, 'http://test').searchParams.get('id')
    return Promise.resolve(Response.json({ ...progress, id: chosenId }))
  })
  vi.stubGlobal('fetch', fetch)
  const client = mount()
  expect(fetch).not.toHaveBeenCalled()
  await userEvent.click(screen.getByRole('button', { name: 'Segui questo piano' }))
  expect(await screen.findByText('1/20 completate · 19 rimanenti')).toBeVisible()
  expect(screen.getByRole('heading', { name: 'Prossima partita: Ahri · Corsia centrale' })).toBeVisible()
  expect(screen.getByText('Più partite rimanenti nel piano: 19. Account: Alpha#EUW (19 da completare).')).toBeVisible()
  const chosenId = localStorage.getItem(key)!
  expect(chosenId).toHaveLength(36)
  expect(screen.getByLabelText('Test URL')).toHaveTextContent(`tracked_plan=${chosenId}`)
  await client.invalidateQueries({ queryKey: ['api', 'training-progress'] })
  await waitFor(() => expect(fetch.mock.calls.length).toBeGreaterThan(1))
  expect(fetch.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1)
  expect(screen.getByText(/Nessuna sincronizzazione Riot automatica/)).toBeVisible()
})

it('un acknowledgement incompleto non attiva il piano; il retry usa lo stesso identificativo', async () => {
  const bodies: { id: string }[] = []
  vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body))
    bodies.push(body)
    return Promise.resolve(Response.json(bodies.length === 1 ? { ok: true } : { ...progress, id: body.id }))
  }))
  mount()
  await userEvent.click(screen.getByRole('button', { name: 'Segui questo piano' }))
  expect(await screen.findByText('Piano non confermato')).toBeVisible()
  expect(localStorage.getItem(key)).toBeNull()
  expect(screen.queryByText('Piano seguito')).not.toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: 'Segui questo piano' }))
  expect(await screen.findByText('Piano seguito')).toBeVisible()
  expect(bodies[0]?.id).toBe(bodies[1]?.id)
})

it('riprende il piano salvato e interrompe soltanto su richiesta senza cancellare lo storico', async () => {
  localStorage.setItem(key, id)
  const fetch = vi.fn().mockResolvedValue(Response.json(progress))
  vi.stubGlobal('fetch', fetch)
  mount()
  expect(await screen.findByText('1/20 completate · 19 rimanenti')).toBeVisible()
  await userEvent.click(screen.getByRole('button', { name: 'Smetti di seguire' }))
  expect(screen.getByRole('button', { name: 'Segui questo piano' })).toBeVisible()
  expect(localStorage.getItem(key)).toBe('')
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(fetch.mock.calls[0]?.[1].method ?? 'GET').toBe('GET')
})

it('mantiene un link recuperabile anche se il browser blocca il salvataggio delle preferenze', async () => {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
  vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, init: RequestInit) => Promise.resolve(Response.json({ ...progress, id: JSON.parse(String(init.body)).id }))))
  mount()
  await userEvent.click(screen.getByRole('button', { name: 'Segui questo piano' }))
  expect(await screen.findByText(/Il browser non può ricordare il piano/)).toBeVisible()
  expect(screen.getByLabelText('Test URL')).toHaveTextContent('tracked_plan=')
})

it.each([{ unavailable_accounts: ['Alpha#EUW'] }, { companion_unavailable: true }])('non consiglia un campione con conteggi incompleti: %j', async (extra) => {
  localStorage.setItem(key, id)
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ ...progress, ...extra })))
  mount()
  expect(await screen.findByText('Suggerimento sospeso finché i conteggi non sono completi.')).toBeVisible()
  expect(screen.queryByRole('heading', { name: /Prossima partita:/ })).not.toBeInTheDocument()
})

it('sospende un consiglio precedente durante il refresh e quando la lettura fallisce', async () => {
  localStorage.setItem(key, id)
  let resolveRefresh!: (response: Response) => void
  const fetch = vi.fn().mockResolvedValueOnce(Response.json(progress))
    .mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveRefresh = resolve }))
  vi.stubGlobal('fetch', fetch)
  const client = mount()
  expect(await screen.findByRole('heading', { name: /Prossima partita: Ahri/ })).toBeVisible()
  let refresh!: Promise<void>
  act(() => { refresh = client.invalidateQueries({ queryKey: ['api', 'training-progress'] }) })
  expect(await screen.findByText('Aggiorno il suggerimento…')).toBeVisible()
  expect(screen.queryByRole('heading', { name: /Prossima partita:/ })).not.toBeInTheDocument()
  await act(async () => { resolveRefresh(Response.json({ error: 'Offline' }, { status: 503 })); await refresh })
  expect(await screen.findByText('Suggerimento sospeso: aggiorna l’avanzamento.')).toBeVisible()
  expect(screen.getByText('1/20 completate · 19 rimanenti')).toBeVisible()
  expect(screen.queryByRole('heading', { name: /Prossima partita:/ })).not.toBeInTheDocument()
})

it('passa allo stato completato dopo l’aggiornamento senza proporre altre partite', async () => {
  localStorage.setItem(key, id)
  const done = { planned: 20, completed: 20, remaining: 0, extra: 3 }
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json(progress)).mockResolvedValueOnce(Response.json({
    ...progress, ...done, items: [{ ...progress.items[0], ...done, accounts: [{ account: 'Alpha#EUW', ...done }] }],
  })))
  const client = mount()
  expect(await screen.findByRole('heading', { name: /Prossima partita: Ahri/ })).toBeVisible()
  await act(async () => { await client.invalidateQueries({ queryKey: ['api', 'training-progress'] }) })
  expect(await screen.findByText('Piano completato: nessuna partita da suggerire.')).toBeVisible()
  expect(screen.queryByRole('heading', { name: /Prossima partita:/ })).not.toBeInTheDocument()
})
