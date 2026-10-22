import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { queryKeys } from '../api/queries'
import type { AlgorithmSettings, AlgorithmSettingsResponseDto } from '../api/types'
import { AlgorithmSettingsProvider, getSetting, RECOMMENDED_ALGORITHM_SETTINGS, setSetting } from '../app/algorithm-settings'
import { AlgorithmSettingsPage } from './AlgorithmSettingsPage'

const { notify, scope } = vi.hoisted(() => ({
  notify: vi.fn(), scope: { accounts: ['Synthetic#EUW'], companion: null },
}))
vi.mock('../app/scope', () => ({ useScope: () => ({ scope, scopeReady: true }) }))
vi.mock('../components/toast', () => ({ useToast: () => ({ notify }) }))

const clients: QueryClient[] = []
function settingsResponse(revision: number): AlgorithmSettingsResponseDto {
  let settings = structuredClone(RECOMMENDED_ALGORITHM_SETTINGS)
  if (revision > 1) {
    settings = setSetting(settings, 'attribution.loss_weights', [0.5, 0.5, 0.5, 0.5, 0.5, 0.5])
    settings = setSetting(settings, 'recommendations.period', { value: 90, unit: 'games' })
  }
  return {
    revision, fingerprint: `synthetic-${revision}`, settings, defaults: structuredClone(RECOMMENDED_ALGORITHM_SETTINGS), history: [],
    schema: [
      { path: 'recommendations.period', label: 'Periodo delle prove', description: 'Finestra sintetica.', type: 'period', group: 'Raccomandazioni', min: 0, max: 100000 },
      { path: 'recommendations.trial_budget', label: 'Budget delle prove', description: 'Budget sintetico.', type: 'integer', group: 'Raccomandazioni', min: 1, max: 10 },
      { path: 'attribution.loss_weights', label: 'Pesi delle sconfitte', description: 'Pesi sintetici.', type: 'number[]', group: 'Attribuzione' },
    ],
  }
}

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } })
  clients.push(client)
  client.setQueryData(queryKeys.algorithmSettings, settingsResponse(1))
  const refreshes: { resolve: (response: Response) => void }[] = []
  const writes: { body: { expected_revision: number; settings: AlgorithmSettings }; reject: (error: Error) => void }[] = []
  const previews: { expected_revision: number; settings: AlgorithmSettings }[] = []
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://localhost').pathname
    if (path === '/api/algorithm-settings/preview') {
      previews.push(JSON.parse(String(init?.body)))
      return Promise.resolve(Response.json({ base_revision: 1, proposed_fingerprint: 'synthetic-preview', changed_paths: [], comparisons: [], sensitivity: [], context: {}, notes: [] }))
    }
    if (init?.method === 'PUT') {
      return new Promise<Response>((_resolve, reject) => writes.push({ body: JSON.parse(String(init.body)), reject }))
    }
    return new Promise<Response>((resolve) => refreshes.push({ resolve }))
  }))
  const router = createMemoryRouter([{ path: '/', element: <AlgorithmSettingsPage /> }])
  render(<QueryClientProvider client={client}><AlgorithmSettingsProvider><RouterProvider router={router} /></AlgorithmSettingsProvider></QueryClientProvider>)
  return { client, user: userEvent.setup(), refreshes, writes, previews }
}

afterEach(() => {
  cleanup()
  clients.splice(0).forEach((client) => client.clear())
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  notify.mockClear()
})

describe('recupero delle impostazioni con bozze locali', () => {
  it('tratta il buffer incompleto come bozza e blocca gli invii del vecchio valore anche con altri campi modificati', async () => {
    const { user, writes, previews } = setup()
    const budget = screen.getByRole('spinbutton', { name: 'Budget delle prove' })
    await user.clear(budget)
    await user.type(budget, '4')
    await user.click(screen.getByText('Attribuzione', { exact: true }))
    const weights = screen.getByRole('textbox', { name: 'Pesi delle sconfitte' })
    await user.clear(weights)
    await user.type(weights, '0.25, -')
    expect(screen.getByText('Bozza non applicata', { exact: true })).toBeVisible()
    const unload = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(unload)
    expect(unload.defaultPrevented).toBe(true)
    await user.click(screen.getByRole('button', { name: 'Applica impostazioni' }))
    await user.click(screen.getByRole('button', { name: 'Calcola anteprima' }))
    expect(writes).toEqual([])
    expect(previews).toEqual([])
    expect(weights).toHaveValue('0.25, -')
    expect(screen.getByRole('button', { name: 'Applica impostazioni' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Calcola anteprima' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Ripristina attive' }))
    expect(screen.getByRole('textbox', { name: 'Pesi delle sconfitte' })).toHaveValue('1, 1, 1, 1, 1, 1')
    expect(budget).toHaveValue(3)
    expect(screen.queryByText('Bozza non applicata', { exact: true })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Applica impostazioni' })).toBeDisabled()
  })

  it('mantiene nodo e buffer array incompleto dopo GET fallito e recupero remoto, conservando la base CAS', async () => {
    const { client, user, refreshes, writes } = setup()
    await user.click(screen.getByText('Attribuzione', { exact: true }))
    const input = screen.getByRole('textbox', { name: 'Pesi delle sconfitte' })
    await user.clear(input)
    await user.type(input, '0.25, -')
    expect(screen.getByText('Bozza non applicata', { exact: true })).toBeVisible()
    expect(screen.getByRole('status')).toHaveTextContent('Conferma i valori modificati con Invio')
    let refresh!: Promise<unknown>
    act(() => { refresh = client.refetchQueries({ queryKey: queryKeys.algorithmSettings }) })
    await waitFor(() => expect(refreshes).toHaveLength(1))
    await act(async () => { refreshes[0]!.resolve(Response.json({ error: 'Configurazione non disponibile' }, { status: 503 })); await refresh })
    await screen.findByRole('alert')
    expect(screen.getByRole('textbox', { name: 'Pesi delle sconfitte' })).toBe(input)
    expect(input).toHaveValue('0.25, -')
    expect(input).toBeEnabled()
    expect(screen.getByRole('alert')).toHaveTextContent('Revisione 1')
    expect(screen.getByRole('button', { name: 'Applica impostazioni' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Calcola anteprima' })).toBeDisabled()

    await user.click(screen.getByRole('button', { name: 'Riprova' }))
    await waitFor(() => expect(refreshes).toHaveLength(2))
    expect(screen.getByRole('textbox', { name: 'Pesi delle sconfitte' })).toBe(input)
    expect(screen.getByRole('button', { name: 'Applica impostazioni' })).toBeDisabled()
    await user.clear(input)
    await user.type(input, '0.25, 1, -')
    await act(async () => refreshes[1]!.resolve(Response.json(settingsResponse(2))))
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
    expect(screen.getByRole('textbox', { name: 'Pesi delle sconfitte' })).toBe(input)
    expect(input).toHaveValue('0.25, 1, -')
    expect(notify).not.toHaveBeenCalled()
    await user.clear(input)
    await user.type(input, '0.25, 1')
    await user.tab()
    await user.click(screen.getByRole('button', { name: 'Applica impostazioni' }))
    await waitFor(() => expect(writes).toHaveLength(1))
    expect(writes[0]!.body.expected_revision).toBe(1)
    expect(getSetting(writes[0]!.body.settings, 'attribution.loss_weights')).toEqual([0.25, 1])
    await act(async () => writes[0]!.reject(new TypeError('Response lost')))
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Pesi delle sconfitte' })).toBeEnabled())
    expect(screen.getByRole('textbox', { name: 'Pesi delle sconfitte' })).toHaveValue('0.25, 1')
    expect(notify).not.toHaveBeenCalledWith('Impostazioni applicate', expect.anything())
  })

  it('conserva un periodo vuoto e la sua unità originale quando il retry restituisce valori diversi', async () => {
    const { client, user, refreshes, previews } = setup()
    const input = screen.getByRole('spinbutton', { name: 'Periodo delle prove' })
    await user.clear(input)
    let refresh!: Promise<unknown>
    act(() => { refresh = client.refetchQueries({ queryKey: queryKeys.algorithmSettings }) })
    await waitFor(() => expect(refreshes).toHaveLength(1))
    await act(async () => { refreshes[0]!.resolve(Response.json({ error: 'Offline' }, { status: 503 })); await refresh })
    await screen.findByRole('alert')
    expect(screen.getByRole('spinbutton', { name: 'Periodo delle prove' })).toBe(input)
    expect(input).toHaveValue(null)
    await user.click(screen.getByRole('button', { name: 'Riprova' }))
    await waitFor(() => expect(refreshes).toHaveLength(2))
    await act(async () => refreshes[1]!.resolve(Response.json(settingsResponse(2))))
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
    expect(screen.getByRole('spinbutton', { name: 'Periodo delle prove' })).toBe(input)
    expect(input).toHaveValue(null)
    expect(screen.getByRole('combobox', { name: 'Unità del periodo' })).toHaveValue('days')
    await user.type(input, '21')
    await user.click(screen.getByRole('button', { name: 'Calcola anteprima' }))
    await waitFor(() => expect(previews).toHaveLength(1))
    expect(previews[0]).toMatchObject({ expected_revision: 1, settings: { recommendations: { period: { value: 21, unit: 'days' } } } })
  })
})
