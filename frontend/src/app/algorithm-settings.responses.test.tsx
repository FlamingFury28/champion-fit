import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { queryKeys } from '../api/queries'
import type { AlgorithmSettingsResponseDto } from '../api/types'
import { AlgorithmSettingsProvider, getSetting, RECOMMENDED_ALGORITHM_SETTINGS, setSetting, useAlgorithmSettings } from './algorithm-settings'

function snapshot(revision: number, budget: number): AlgorithmSettingsResponseDto {
  return {
    revision, fingerprint: `settings-${revision}`,
    settings: setSetting(RECOMMENDED_ALGORITHM_SETTINGS, 'recommendations.trial_budget', budget),
    defaults: structuredClone(RECOMMENDED_ALGORITHM_SETTINGS),
    schema: [{ path: 'recommendations.trial_budget', label: 'Budget delle prove', description: 'Partite del ciclo.', type: 'integer', group: 'Raccomandazioni', min: 1 }],
    history: [],
  }
}

function Probe() {
  const context = useAlgorithmSettings()
  return <>
    <output aria-label="Budget attivo">{String(getSetting(context.settings, 'recommendations.trial_budget'))}</output>
    <output aria-label="Revisione attiva">{context.revision ?? 'assente'}</output>
    {context.error ? <p role="alert">{context.error.message}</p> : null}
    <button onClick={() => void context.refetch()}>Riprova configurazione</button>
  </>
}

const clients: QueryClient[] = []
function setup(initial?: AlgorithmSettingsResponseDto) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  clients.push(client)
  if (initial) client.setQueryData(queryKeys.algorithmSettings, initial)
  render(<QueryClientProvider client={client}><AlgorithmSettingsProvider><Probe /></AlgorithmSettingsProvider></QueryClientProvider>)
  return { client, user: userEvent.setup() }
}

afterEach(() => {
  cleanup()
  clients.splice(0).forEach((client) => client.clear())
  vi.unstubAllGlobals()
})

describe('confine delle risposte impostazioni nel provider', () => {
  it.each([
    ['oggetto vuoto', {}],
    ['revisione senza contenuto', { revision: 2 }],
    ['configurazioni vuote', { ...snapshot(2, 8), settings: {}, defaults: {} }],
    ['cronologia non valida', { ...snapshot(2, 8), history: [null] }],
  ])('non sostituisce cache e budget attivi con %s, poi recupera una snapshot valida', async (_label, invalid) => {
    let healthy = false
    const fetch = vi.fn(async () => Response.json(healthy ? snapshot(2, 8) : invalid))
    vi.stubGlobal('fetch', fetch)
    const initial = snapshot(1, 6)
    const { client, user } = setup(initial)
    const cached = client.getQueryData(queryKeys.algorithmSettings)
    expect(screen.getByLabelText('Budget attivo')).toHaveTextContent('6')
    expect(fetch).not.toHaveBeenCalled()

    await act(async () => { await client.refetchQueries({ queryKey: queryKeys.algorithmSettings }) })
    expect(await screen.findByRole('alert')).toHaveTextContent('L’esito della richiesta non è confermato')
    expect(client.getQueryData(queryKeys.algorithmSettings)).toBe(cached)
    expect(screen.getByLabelText('Budget attivo')).toHaveTextContent('6')
    expect(screen.getByLabelText('Revisione attiva')).toHaveTextContent('1')
    expect(fetch).toHaveBeenCalledTimes(1)

    healthy = true
    await user.click(screen.getByRole('button', { name: 'Riprova configurazione' }))
    await waitFor(() => expect(screen.getByLabelText('Budget attivo')).toHaveTextContent('8'))
    expect(screen.getByLabelText('Revisione attiva')).toHaveTextContent('2')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('rifiuta una prima risposta incompleta senza inserirla in cache e permette il retry', async () => {
    let healthy = false
    const fetch = vi.fn(async () => Response.json(healthy ? snapshot(1, 6) : {}))
    vi.stubGlobal('fetch', fetch)
    const { client, user } = setup()
    expect(await screen.findByRole('alert')).toHaveTextContent('L’esito della richiesta non è confermato')
    expect(client.getQueryData(queryKeys.algorithmSettings)).toBeUndefined()
    expect(screen.getByLabelText('Revisione attiva')).toHaveTextContent('assente')
    expect(fetch).toHaveBeenCalledTimes(1)
    healthy = true
    await user.click(screen.getByRole('button', { name: 'Riprova configurazione' }))
    await waitFor(() => expect(screen.getByLabelText('Budget attivo')).toHaveTextContent('6'))
    expect(screen.getByLabelText('Revisione attiva')).toHaveTextContent('1')
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})
