import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useEffect } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemoryRouter, RouterProvider } from 'react-router'
import type { AlgorithmPreviewResponseDto, AlgorithmSettingSchemaDto, AlgorithmSettingsResponseDto } from '../api/types'
import { AlgorithmSettingsProvider, getSetting, RECOMMENDED_ALGORITHM_SETTINGS } from '../app/algorithm-settings'
import { ScopeProvider, useScope } from '../app/scope'
import { AppToastProvider } from '../components/toast'
import { AlgorithmSettingsPage, SettingControl } from './AlgorithmSettingsPage'

const lossWeights: AlgorithmSettingSchemaDto = {
  path: 'attribution.loss_weights',
  label: 'Pesi delle sconfitte',
  description: 'Un peso per ogni fascia di durata.',
  type: 'number[]',
  group: 'Attribuzione',
}

const historyPeriod: AlgorithmSettingSchemaDto = {
  path: 'history.period',
  label: 'Periodo storico',
  description: 'Limite delle partite analizzate.',
  type: 'period',
  group: 'Contesto',
  min: 0,
  max: 100000,
  options: ['days', 'games'],
}

describe('controlli impostazioni algoritmi', () => {
  it('mantiene una frazione digitabile e la applica alla perdita di focus', async () => {
    const onChange = vi.fn()
    render(<SettingControl field={lossWeights} value={[1, 1]} onChange={onChange} />)
    const input = screen.getByRole('textbox', { name: 'Pesi delle sconfitte' })
    expect(input).toHaveAttribute('aria-describedby', expect.stringContaining('description'))
    await userEvent.clear(input)
    await userEvent.type(input, '0.25, 1')
    expect(input).toHaveValue('0.25, 1')
    expect(onChange).not.toHaveBeenCalled()
    await userEvent.tab()
    expect(onChange).toHaveBeenCalledWith([0.25, 1])
  })

  it('scarta una bozza del periodo quando il reset torna a un valore precedente', async () => {
    const onChange = vi.fn()
    const { rerender } = render(
      <SettingControl resetKey={0} field={historyPeriod} value={{ value: 180, unit: 'days' }} onChange={onChange} />,
    )
    const input = screen.getByRole('spinbutton', { name: 'Periodo storico' })
    await userEvent.clear(input)
    await userEvent.type(input, '21')
    expect(input).toHaveValue(21)

    rerender(
      <SettingControl resetKey={1} field={historyPeriod} value={{ value: 90, unit: 'games' }} onChange={onChange} />,
    )
    expect(screen.getByRole('spinbutton', { name: 'Periodo storico' })).toHaveValue(90)
    expect(screen.getByRole('combobox', { name: 'Unità del periodo' })).toHaveValue('games')

    rerender(
      <SettingControl resetKey={2} field={historyPeriod} value={{ value: 180, unit: 'days' }} onChange={onChange} />,
    )
    expect(screen.getByRole('spinbutton', { name: 'Periodo storico' })).toHaveValue(180)
    expect(screen.getByRole('combobox', { name: 'Unità del periodo' })).toHaveValue('days')
  })
})

describe('anteprime coerenti con la bozza corrente', () => {
  const clients: QueryClient[] = []
  const trialBudget: AlgorithmSettingSchemaDto = {
    path: 'recommendations.trial_budget', label: 'Budget delle prove', description: 'Partite nel prossimo ciclo.',
    type: 'integer', group: 'Raccomandazioni', min: 1, max: 10,
  }
  const settingsResponse = (revision: number): AlgorithmSettingsResponseDto => ({
    revision, fingerprint: `settings-${revision}`, settings: structuredClone(RECOMMENDED_ALGORITHM_SETTINGS),
    defaults: structuredClone(RECOMMENDED_ALGORITHM_SETTINGS), schema: [trialBudget], history: [],
  })
  const previewResponse = (fingerprint: string, baseRevision = 1): AlgorithmPreviewResponseDto => ({
    base_revision: baseRevision, proposed_fingerprint: fingerprint, changed_paths: ['recommendations.trial_budget'],
    comparisons: [], sensitivity: [], context: {}, notes: [],
  })
  interface PreviewRequest {
    body: { expected_revision: number; settings: AlgorithmSettingsResponseDto['settings'] }
    signal: AbortSignal | null | undefined
    resolve: (response: Response) => void
  }
  function mountPreview() {
    localStorage.clear()
    const previews: PreviewRequest[] = []
    const saves: PreviewRequest[] = []
    const refreshes: Array<(response: Response) => void> = []
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), 'http://localhost').pathname
      if (path === '/api/accounts') return Promise.resolve(Response.json({ items: [] }))
      if (path === '/api/algorithm-settings/preview') {
        // Deliberately allow a canceled request to finish: the client must reject stale completions too.
        return new Promise<Response>((resolve) => previews.push({
          body: JSON.parse(String(init?.body)), signal: init?.signal, resolve,
        }))
      }
      if (path === '/api/algorithm-settings' && init?.method === 'PUT') {
        return new Promise<Response>((resolve) => saves.push({
          body: JSON.parse(String(init.body)), signal: init.signal, resolve,
        }))
      }
      if (path === '/api/algorithm-settings' && !init?.method) {
        return new Promise<Response>((resolve) => refreshes.push(resolve))
      }
      throw new Error(`Unexpected request: ${init?.method ?? 'GET'} ${path}`)
    }))
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
    clients.push(client)
    client.setQueryData(['api', 'algorithm-settings'], settingsResponse(1))
    let currentScope: ReturnType<typeof useScope> | undefined
    function ScopeProbe() {
      const state = useScope()
      useEffect(() => { currentScope = state }, [state])
      return null
    }
    const router = createMemoryRouter([{ path: '/app/settings/algorithms', element: <AlgorithmSettingsPage /> }], {
      initialEntries: ['/app/settings/algorithms'],
    })
    render(<QueryClientProvider client={client}><AlgorithmSettingsProvider><ScopeProvider><ScopeProbe /><AppToastProvider>
      <RouterProvider router={router} />
    </AppToastProvider></ScopeProvider></AlgorithmSettingsProvider></QueryClientProvider>)
    return { user: userEvent.setup(), previews, saves, refreshes, client, getScope: () => {
      if (!currentScope) throw new Error('Scope is not mounted')
      return currentScope
    } }
  }
  const account = (name: string, aliases: string[] = []) => ({
    account: name, aliases, raw_games: 1, eligible_games: 1, analyzed_games: 1,
    wins: 1, games: 1, first_game: null, last_game: null,
  })
  async function prepareScope(view: ReturnType<typeof mountPreview>, accounts = [account('Alpha#EUW')]) {
    await act(async () => {})
    await act(async () => { view.client.setQueryData(['api', 'accounts'], { items: accounts }) })
    await act(async () => { view.getScope().setAccounts(['Alpha#EUW']) })
  }
  async function changeBudget(user: ReturnType<typeof userEvent.setup>, value: string) {
    const input = screen.getByRole('spinbutton', { name: 'Budget delle prove' })
    await user.clear(input)
    await user.type(input, value)
    return input
  }
  afterEach(() => {
    cleanup()
    clients.splice(0).forEach((client) => client.clear())
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('blocca i campi durante il salvataggio e li riabilita dopo il successo', async () => {
    const { user, saves } = mountPreview()
    const input = await changeBudget(user, '4')
    await user.click(screen.getByRole('button', { name: 'Applica impostazioni' }))
    await waitFor(() => expect(saves).toHaveLength(1))

    expect(input).toBeDisabled()
    await user.type(input, '5')
    expect(input).toHaveValue(4)
    expect(getSetting(saves[0]!.body.settings, 'recommendations.trial_budget')).toBe(4)

    const saved = settingsResponse(2)
    saved.settings = structuredClone(saves[0]!.body.settings)
    await act(async () => saves[0]!.resolve(Response.json(saved)))
    await waitFor(() => expect(input).toBeEnabled())
    expect(input).toHaveValue(4)
    expect(screen.getByRole('button', { name: 'Applica impostazioni' })).toBeDisabled()
    await changeBudget(user, '5')
    expect(input).toHaveValue(5)
    expect(screen.getByRole('button', { name: 'Applica impostazioni' })).toBeEnabled()
  })

  it.each([503, 409])('riabilita i campi e conserva la bozza dopo un errore %s di salvataggio', async (status) => {
    const { user, saves, refreshes, client } = mountPreview()
    const input = await changeBudget(user, '4')
    await user.click(screen.getByRole('button', { name: 'Applica impostazioni' }))
    await waitFor(() => expect(saves).toHaveLength(1))
    expect(input).toBeDisabled()

    await act(async () => saves[0]!.resolve(Response.json({ error: 'Salvataggio non disponibile' }, { status })))
    if (status === 409) {
      await waitFor(() => expect(refreshes).toHaveLength(1))
      expect(input).toBeDisabled()
      await act(async () => refreshes[0]!(Response.json(settingsResponse(2))))
    }

    await waitFor(() => expect(input).toBeEnabled())
    expect(input).toHaveValue(4)
    expect(client.getQueryData(['api', 'algorithm-settings'])).toMatchObject({ revision: status === 409 ? 2 : 1 })
    expect(screen.getByRole('button', { name: 'Applica impostazioni' })).toBeEnabled()
    await changeBudget(user, '5')
    expect(input).toHaveValue(5)
  })

  it('annulla il calcolo dopo una modifica e ignora un successo vecchio mentre termina quello nuovo', async () => {
    const { user, previews } = mountPreview()
    await changeBudget(user, '4')
    await user.click(screen.getByRole('button', { name: 'Calcola anteprima' }))
    await changeBudget(user, '5')

    expect(previews[0]!.signal?.aborted).toBe(true)
    await user.click(screen.getByRole('button', { name: 'Calcola anteprima' }))
    expect(previews.map((request) => getSetting(request.body.settings, 'recommendations.trial_budget'))).toEqual([4, 5])
    await act(async () => previews[0]!.resolve(Response.json(previewResponse('preview-obsoleta'))))
    expect(screen.queryByText('preview-obsoleta')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Calcolo anteprima…' })).toBeDisabled()

    await act(async () => previews[1]!.resolve(Response.json(previewResponse('preview-corrente'))))
    expect(await screen.findByText('preview-corrente')).toBeVisible()
    expect(screen.getByRole('spinbutton', { name: 'Budget delle prove' })).toHaveValue(5)
  })

  it('ignora un conflitto arrivato dopo che il draft è stato modificato', async () => {
    const { user, previews, refreshes } = mountPreview()
    await changeBudget(user, '4')
    await user.click(screen.getByRole('button', { name: 'Calcola anteprima' }))
    const input = await changeBudget(user, '5')
    await act(async () => previews[0]!.resolve(Response.json({ error: 'revision conflict' }, { status: 409 })))

    expect(refreshes).toHaveLength(0)
    expect(input).toHaveValue(5)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Calcola anteprima' })).toBeEnabled()
  })

  it('conserva la bozza modificata durante il refresh avviato da un conflitto precedente', async () => {
    const { user, previews, refreshes } = mountPreview()
    await changeBudget(user, '4')
    await user.click(screen.getByRole('button', { name: 'Calcola anteprima' }))
    await act(async () => previews[0]!.resolve(Response.json({ error: 'revision conflict' }, { status: 409 })))
    await waitFor(() => expect(refreshes).toHaveLength(1))
    const input = await changeBudget(user, '5')
    await act(async () => refreshes[0]!(Response.json(settingsResponse(2))))

    expect(input).toHaveValue(5)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Calcola anteprima' })).toBeEnabled())
  })

  it('aggiorna la revisione di un conflitto corrente e permette di ricalcolare la stessa bozza', async () => {
    const { user, previews, refreshes } = mountPreview()
    const input = await changeBudget(user, '4')
    await user.click(screen.getByRole('button', { name: 'Calcola anteprima' }))
    await act(async () => previews[0]!.resolve(Response.json({ error: 'revision conflict' }, { status: 409 })))
    await waitFor(() => expect(refreshes).toHaveLength(1))
    await act(async () => refreshes[0]!(Response.json(settingsResponse(2))))

    expect(await screen.findByRole('alert')).toHaveTextContent('La bozza è conservata')
    expect(input).toHaveValue(4)
    await user.click(screen.getByRole('button', { name: 'Calcola anteprima' }))
    expect(previews[1]!.body.expected_revision).toBe(2)
    expect(getSetting(previews[1]!.body.settings, 'recommendations.trial_budget')).toBe(4)
    await act(async () => previews[1]!.resolve(Response.json(previewResponse('preview-ricalcolata', 2))))
    expect(await screen.findByText('preview-ricalcolata')).toBeVisible()
  })

  it.each(['durante', 'dopo'])('invalida la preview se gli account vengono riconciliati %s il calcolo, conservando la bozza', async (timing) => {
    const view = mountPreview()
    const { user, previews, client, getScope } = view
    await prepareScope(view)
    const input = await changeBudget(user, '4')
    await user.click(screen.getByRole('button', { name: 'Calcola anteprima' }))
    if (timing === 'dopo') {
      await act(async () => previews[0]!.resolve(Response.json(previewResponse('preview-alpha'))))
      expect(await screen.findByText('preview-alpha')).toBeVisible()
    }

    await act(async () => { client.setQueryData(['api', 'accounts'], { items: [account('Beta#EUW', ['Alpha#EUW'])] }) })
    await waitFor(() => expect(getScope().scope.accounts).toEqual(['Beta#EUW']))
    if (timing === 'durante') {
      expect(previews[0]!.signal?.aborted).toBe(true)
      await act(async () => previews[0]!.resolve(Response.json(previewResponse('preview-alpha'))))
    }
    expect(screen.queryByText('preview-alpha')).not.toBeInTheDocument()
    expect(input).toHaveValue(4)
    await user.click(screen.getByRole('button', { name: 'Calcola anteprima' }))
    expect(previews[1]!.body).toMatchObject({ scope: { account: ['Beta#EUW'] } })
    await act(async () => previews[1]!.resolve(Response.json(previewResponse('preview-beta'))))
    expect(await screen.findByText('preview-beta')).toBeVisible()
  })

  it('ignora un ordine equivalente degli account e dei compagni senza annullare la preview', async () => {
    const view = mountPreview()
    const { user, previews, getScope } = view
    await prepareScope(view, [account('Alpha#EUW'), account('Beta#EUW'), account('Gamma#EUW'), account('Delta#EUW')])
    await act(async () => { getScope().setAccounts(['Beta#EUW', 'Alpha#EUW']) })
    await act(async () => { getScope().setCompanion({ name: 'Duo', accounts: ['Gamma#EUW', 'Delta#EUW'], mode: 'only' }) })
    await changeBudget(user, '4')
    await user.click(screen.getByRole('button', { name: 'Calcola anteprima' }))

    await act(async () => { getScope().setAccounts(['Alpha#EUW', 'Beta#EUW']) })
    await act(async () => { getScope().setCompanion({ name: 'Duo rinominato', accounts: ['Delta#EUW', 'Gamma#EUW'], mode: 'only' }) })

    expect(previews[0]!.signal?.aborted).toBe(false)
    expect(screen.getByRole('button', { name: 'Calcolo anteprima…' })).toBeDisabled()
    await act(async () => previews[0]!.resolve(Response.json(previewResponse('preview-stesso-scope'))))
    expect(await screen.findByText('preview-stesso-scope')).toBeVisible()
  })

  it('invalida la richiesta quando cambia la modalità dei compagni e ricalcola nello scope attuale', async () => {
    const view = mountPreview()
    const { user, previews, getScope } = view
    await prepareScope(view, [account('Alpha#EUW'), account('Beta#EUW')])
    await act(async () => { getScope().setCompanion({ name: 'Duo', accounts: ['Beta#EUW'], mode: 'only' }) })
    const input = await changeBudget(user, '4')
    await user.click(screen.getByRole('button', { name: 'Calcola anteprima' }))
    await act(async () => { getScope().setCompanion({ name: 'Duo', accounts: ['Beta#EUW'], mode: 'exclude' }) })
    expect(previews[0]!.signal?.aborted).toBe(true)
    await act(async () => previews[0]!.resolve(Response.json(previewResponse('preview-solo-insieme'))))
    expect(screen.queryByText('preview-solo-insieme')).not.toBeInTheDocument()
    expect(input).toHaveValue(4)

    await user.click(screen.getByRole('button', { name: 'Calcola anteprima' }))
    expect(previews[1]!.body).toMatchObject({ scope: { account: ['Alpha#EUW'], companion_account: ['Beta#EUW'], companion_mode: 'exclude' } })
    await act(async () => previews[1]!.resolve(Response.json(previewResponse('preview-esclusione'))))
    expect(await screen.findByText('preview-esclusione')).toBeVisible()
  })
})

describe('errori iniziali della pagina Algoritmi', () => {
  const clients: QueryClient[] = []
  afterEach(() => {
    cleanup()
    clients.splice(0).forEach((client) => client.clear())
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('mostra l’errore 503 e recupera con Riprova invece di restare nello skeleton', async () => {
    let offline = true
    let settingsRequests = 0
    localStorage.clear()
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), 'http://localhost').pathname
      if (path === '/api/accounts') return Response.json({ items: [] })
      settingsRequests += 1
      return offline
        ? Response.json({ error: 'Settings offline' }, { status: 503 })
        : Response.json({ revision: 1, fingerprint: 'fixture', settings: RECOMMENDED_ALGORITHM_SETTINGS, defaults: RECOMMENDED_ALGORITHM_SETTINGS, schema: [], history: [] })
    }))
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
    clients.push(client)
    const router = createMemoryRouter([{ path: '/app/settings/algorithms', element: <AlgorithmSettingsPage /> }], {
      initialEntries: ['/app/settings/algorithms'],
    })
    render(<QueryClientProvider client={client}><AlgorithmSettingsProvider><ScopeProvider><AppToastProvider>
      <RouterProvider router={router} />
    </AppToastProvider></ScopeProvider></AlgorithmSettingsProvider></QueryClientProvider>)
    await screen.findByRole('heading', { name: 'Impossibile caricare le impostazioni algoritmiche' })
    expect(screen.getByRole('alert')).toHaveTextContent('Settings offline')
    expect(screen.queryByRole('status', { name: 'Caricamento delle impostazioni algoritmiche' })).toBeNull()
    offline = false
    await userEvent.click(screen.getByRole('button', { name: 'Riprova' }))
    await screen.findByRole('heading', { name: 'Parametri degli algoritmi' })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(settingsRequests).toBe(2)
  })
})
