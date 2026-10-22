import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider, useRouteError } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { queryKeys } from '../api/queries'
import type { AlgorithmPreviewResponseDto, AlgorithmSettings, AlgorithmSettingsResponseDto } from '../api/types'
import { AlgorithmSettingsProvider, getSetting, RECOMMENDED_ALGORITHM_SETTINGS, setSetting, useAlgorithmSettings } from '../app/algorithm-settings'
import { AlgorithmSettingsPage } from './AlgorithmSettingsPage'

const { notify } = vi.hoisted(() => ({ notify: vi.fn() }))
vi.mock('../app/scope', () => ({ useScope: () => ({ scope: { accounts: ['Synthetic#EUW'], companion: null }, scopeReady: true }) }))
vi.mock('../components/toast', () => ({ useToast: () => ({ notify }) }))

const initial: AlgorithmSettingsResponseDto = {
  revision: 1, fingerprint: 'synthetic-current-1',
  settings: setSetting(RECOMMENDED_ALGORITHM_SETTINGS, 'recommendations.trial_budget', 6),
  defaults: structuredClone(RECOMMENDED_ALGORITHM_SETTINGS), history: [],
  schema: [{ path: 'recommendations.trial_budget', label: 'Budget delle prove', description: 'Budget sintetico.', type: 'integer', group: 'Raccomandazioni', min: 1, max: 10 }],
}
const previewResponse: AlgorithmPreviewResponseDto = {
  base_revision: 1, proposed_fingerprint: 'synthetic-preview', changed_paths: ['recommendations.trial_budget'],
  comparisons: [], sensitivity: [], context: {}, notes: [],
}
const invalidResponse = 'La risposta del server non è valida o completa. L’esito della richiesta non è confermato.'
const clients: QueryClient[] = []
const routers: ReturnType<typeof createMemoryRouter>[] = []
const routeErrors: Error[] = []

function RouteFailure() {
  const error = useRouteError() as Error
  routeErrors.push(error)
  return <p role="alert">Errore di rendering sintetico: {error.message}</p>
}
function ProviderProbe() {
  const active = useAlgorithmSettings()
  return <output data-testid="provider-budget">{String(getSetting(active.settings, 'recommendations.trial_budget'))}</output>
}
function setup(fetchImpl: typeof fetch, seed = true) {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.stubGlobal('fetch', vi.fn(fetchImpl))
  const client = new QueryClient({ defaultOptions: {
    queries: { retry: false, staleTime: Infinity }, mutations: { retry: false },
  } })
  clients.push(client)
  if (seed) client.setQueryData(queryKeys.algorithmSettings, initial)
  const router = createMemoryRouter([{ path: '*', element: <AlgorithmSettingsPage />, errorElement: <RouteFailure /> }])
  routers.push(router)
  render(<QueryClientProvider client={client}><AlgorithmSettingsProvider>
    <ProviderProbe /><RouterProvider router={router} />
  </AlgorithmSettingsProvider></QueryClientProvider>)
  return { client, user: userEvent.setup() }
}
async function editBudget(user: ReturnType<typeof userEvent.setup>) {
  const input = screen.getByRole('spinbutton', { name: 'Budget delle prove' })
  await user.clear(input)
  await user.type(input, '4')
  return input
}
function expectPreserved(client: QueryClient, input: HTMLElement) {
  expect(screen.getByRole('spinbutton', { name: 'Budget delle prove' })).toBe(input)
  expect(input).toHaveValue(4)
  expect(input).toBeEnabled()
  expect(client.getQueryData(queryKeys.algorithmSettings)).toEqual(initial)
  expect(screen.getByTestId('provider-budget')).toHaveTextContent('6')
  expect(screen.getByText('Bozza non applicata', { exact: true })).toBeVisible()
  expect(routeErrors).toEqual([])
  expect(notify).not.toHaveBeenCalledWith('Impostazioni applicate', expect.anything())
  const unload = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(unload)
  expect(unload.defaultPrevented).toBe(true)
}

afterEach(() => {
  cleanup()
  for (const router of routers.splice(0)) router.dispose()
  for (const client of clients.splice(0)) client.clear()
  routeErrors.splice(0)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  notify.mockClear()
})

describe('impostazioni: risposte incomplete e recupero esplicito', () => {
  it.each([
    { label: 'vuoto', payload: {} },
    { label: 'con sola revisione', payload: { revision: 2 } },
    { label: 'con sola revisione e cronologia', payload: { revision: 2, history: [] } },
    { label: 'con revisione invariata', payload: { ...initial, settings: setSetting(initial.settings, 'recommendations.trial_budget', 4) } },
  ])('rifiuta PUT200 $label senza alterare bozza, revisione o provider', async ({ payload }) => {
    const writes: { expected_revision: number; settings: AlgorithmSettings }[] = []
    const reads: string[] = []
    const { client, user } = setup((url, init) => {
      if (init?.method !== 'PUT') { reads.push(String(url)); return Promise.resolve(Response.json(initial)) }
      const body = JSON.parse(String(init.body))
      writes.push(body)
      return Promise.resolve(Response.json(writes.length === 1 ? payload : { ...initial, revision: 2, fingerprint: 'saved-2', settings: body.settings }))
    })
    const input = await editBudget(user)
    await user.click(screen.getByRole('button', { name: 'Applica impostazioni' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(invalidResponse)
    expectPreserved(client, input)
    expect(writes).toHaveLength(1)
    expect(reads).toEqual([])
    expect(screen.getByRole('button', { name: 'Applica impostazioni' })).toBeEnabled()

    await user.click(screen.getByRole('button', { name: 'Applica impostazioni' }))
    await waitFor(() => expect(notify).toHaveBeenCalledWith('Impostazioni applicate', expect.objectContaining({ tone: 'success' })))
    expect(writes).toHaveLength(2)
    expect(writes[1]).toEqual(writes[0])
    expect(writes[1]?.expected_revision).toBe(1)
    expect(getSetting(writes[1]!.settings, 'recommendations.trial_budget')).toBe(4)
    expect(client.getQueryData<AlgorithmSettingsResponseDto>(queryKeys.algorithmSettings)?.revision).toBe(2)
    expect(screen.getByTestId('provider-budget')).toHaveTextContent('4')
    expect(screen.getByRole('spinbutton', { name: 'Budget delle prove' })).toHaveValue(4)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Applica impostazioni' })).toBeDisabled()
    expect(reads).toEqual([])
  })

  it.each([
    { label: 'vuota', payload: {} },
    { label: 'con confronto null', payload: { ...previewResponse, comparisons: [null] } },
    { label: 'con nome confronto non valido', payload: { ...previewResponse, comparisons: [{ algorithm: {}, before: {}, after: {} }] } },
  ])('rifiuta preview200 $label prima del rendering e permette il ricalcolo esplicito', async ({ payload }) => {
    const requests: { expected_revision: number; settings: AlgorithmSettings }[] = []
    const { client, user } = setup((_url, init) => {
      requests.push(JSON.parse(String(init?.body)))
      return Promise.resolve(Response.json(requests.length === 1 ? payload : previewResponse))
    })
    const input = await editBudget(user)
    await user.click(screen.getByRole('button', { name: 'Calcola anteprima' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(invalidResponse)
    expectPreserved(client, input)
    expect(screen.queryByText('synthetic-preview')).not.toBeInTheDocument()
    expect(requests).toHaveLength(1)

    await user.click(screen.getByRole('button', { name: 'Riprova' }))
    expect(await screen.findByText('synthetic-preview')).toBeVisible()
    expect(requests).toHaveLength(2)
    expect(requests[1]).toEqual(requests[0])
    expect(requests[1]?.expected_revision).toBe(1)
    expectPreserved(client, input)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(notify).not.toHaveBeenCalled()
  })

  it('rifiuta GET200{} di refresh conservando lo stesso input, il provider e la base originale', async () => {
    let reads = 0
    const writes: { expected_revision: number; settings: AlgorithmSettings }[] = []
    const { client, user } = setup((_url, init) => {
      if (init?.method === 'PUT') {
        const body = JSON.parse(String(init.body))
        writes.push(body)
        return Promise.resolve(Response.json({ ...initial, revision: 3, fingerprint: 'saved-3', settings: body.settings }))
      }
      reads += 1
      return Promise.resolve(Response.json(reads === 1 ? {} : { ...initial, revision: 2, fingerprint: 'current-2' }))
    })
    const input = await editBudget(user)
    await act(async () => { await client.refetchQueries({ queryKey: queryKeys.algorithmSettings }) })
    expect(await screen.findByRole('alert')).toHaveTextContent(invalidResponse)
    expectPreserved(client, input)
    expect(screen.getByRole('button', { name: 'Applica impostazioni' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Calcola anteprima' })).toBeDisabled()
    expect(writes).toEqual([])

    await user.click(screen.getByRole('button', { name: 'Riprova' }))
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
    expect(screen.getByRole('spinbutton', { name: 'Budget delle prove' })).toBe(input)
    expect(input).toHaveValue(4)
    expect(reads).toBe(2)
    await user.click(screen.getByRole('button', { name: 'Applica impostazioni' }))
    await waitFor(() => expect(notify).toHaveBeenCalledWith('Impostazioni applicate', expect.anything()))
    expect(writes[0]?.expected_revision).toBe(1)
  })

  it.each(['PUT', 'POST'])('conserva bozza e token dopo%s409 seguito daGET200{} e attende un recupero esplicito', async (method) => {
    const writes: { expected_revision: number; settings: AlgorithmSettings }[] = []
    let reads = 0
    const { client, user } = setup((_url, init) => {
      if (init?.method === method) {
        writes.push(JSON.parse(String(init.body)))
        return Promise.resolve(Response.json({ error: 'Conflitto di revisione' }, { status: 409 }))
      }
      reads += 1
      return Promise.resolve(Response.json({}))
    })
    const input = await editBudget(user)
    const action = method === 'PUT' ? 'Applica impostazioni' : 'Calcola anteprima'
    await user.click(screen.getByRole('button', { name: action }))
    await waitFor(() => expect(reads).toBe(1))
    await waitFor(() => expect(screen.getAllByRole('alert').some((alert) => alert.textContent?.includes(invalidResponse))).toBe(true))
    expectPreserved(client, input)
    expect(writes).toHaveLength(1)
    expect(writes[0]?.expected_revision).toBe(1)
    expect(screen.getByRole('button', { name: 'Applica impostazioni' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Calcola anteprima' })).toBeDisabled()
    expect(notify).not.toHaveBeenCalledWith('Le impostazioni attive sono cambiate', expect.anything())
  })

  it('accetta una nuova revisione completa con storico legacy parziale', async () => {
    const writes: unknown[] = []
    const { client, user } = setup((_url, init) => {
      const body = JSON.parse(String(init?.body))
      writes.push(body)
      return Promise.resolve(Response.json({ ...initial, revision: 2, fingerprint: 'saved-2', settings: body.settings, history: [{ revision: 1, summary: 'Storico legacy' }] }))
    })
    await editBudget(user)
    await user.click(screen.getByRole('button', { name: 'Applica impostazioni' }))
    await waitFor(() => expect(notify).toHaveBeenCalledWith('Impostazioni applicate', expect.objectContaining({ tone: 'success' })))
    expect(writes).toHaveLength(1)
    expect(client.getQueryData<AlgorithmSettingsResponseDto>(queryKeys.algorithmSettings)?.revision).toBe(2)
    expect(screen.getByTestId('provider-budget')).toHaveTextContent('4')
    expect(screen.getByText('Storico legacy · sola lettura')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Solo lettura' })).toBeDisabled()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(routeErrors).toEqual([])
  })

  it('mostra un GET iniziale incompleto come errore recuperabile senza costruire un editor fittizio', async () => {
    let reads = 0
    setup(() => Promise.resolve(Response.json(++reads === 1 ? {} : initial)), false)
    expect(await screen.findByRole('alert')).toHaveTextContent(invalidResponse)
    expect(screen.queryByRole('spinbutton', { name: 'Budget delle prove' })).not.toBeInTheDocument()
    expect(routeErrors).toEqual([])
    await userEvent.click(screen.getByRole('button', { name: 'Riprova' }))
    expect(await screen.findByRole('spinbutton', { name: 'Budget delle prove' })).toHaveValue(6)
    expect(reads).toBe(2)
  })
})
