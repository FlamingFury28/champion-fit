import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../api/client'
import { queryKeys } from '../api/queries'
import type { AlgorithmSettingsResponseDto } from '../api/types'
import { AlgorithmSettingsProvider, RECOMMENDED_ALGORITHM_SETTINGS } from '../app/algorithm-settings'
import { queryClient } from '../app/query-client'
import { PROFILE_ACCOUNTS_KEY, ScopeProvider, useScope } from '../app/scope'
import { FriendsPage } from '../pages/FriendsPage'
import { ProfilePage } from '../pages/ProfilePage'
import { ScopedOutlet } from './AppShell'

vi.mock('./toast', () => ({ useToast: () => ({ notify: vi.fn() }) }))

const defaultOptions = queryClient.getDefaultOptions()
const refreshMessage = 'Non riesco ad aggiornare la configurazione. Uso l’ultima configurazione disponibile e conservo le modifiche in corso.'

function settings(revision = 1): AlgorithmSettingsResponseDto {
  return { revision, fingerprint: `settings-${revision}`, settings: RECOMMENDED_ALGORITHM_SETTINGS,
    defaults: RECOMMENDED_ALGORITHM_SETTINGS, schema: [], history: [] }
}

function offline() {
  return Response.json({ error: 'Service Unavailable' }, { status: 503 })
}

function ScopeProbe() {
  const { scope, scopeReady } = useScope()
  return <output data-testid="validated-scope">{JSON.stringify({ ready: scopeReady, revision: scope.algorithmRevision, accounts: scope.accounts })}</output>
}

function mountPage(path = '/app/profile', seededSettings = true) {
  if (seededSettings) queryClient.setQueryData(queryKeys.algorithmSettings, settings())
  queryClient.setQueryData(queryKeys.accounts, { items: [{ account: 'Alpha#EUW', aliases: [],
    raw_games: 1, eligible_games: 1, analyzed_games: 1, wins: 1, games: 1, first_game: null, last_game: null }] })
  render(<QueryClientProvider client={queryClient}><AlgorithmSettingsProvider><ScopeProvider>
    <ScopeProbe />
    <MemoryRouter initialEntries={[path]}><Routes><Route path="/app" element={<ScopedOutlet />}>
      <Route path="profile" element={<ProfilePage />} />
      <Route path="team/friends" element={<FriendsPage />} />
    </Route></Routes></MemoryRouter>
  </ScopeProvider></AlgorithmSettingsProvider></QueryClientProvider>)
  return userEvent.setup()
}

beforeEach(() => {
  queryClient.clear()
  queryClient.setDefaultOptions({ ...defaultOptions, queries: { ...defaultOptions.queries, retry: false } })
  localStorage.clear()
  localStorage.setItem(PROFILE_ACCOUNTS_KEY, JSON.stringify(['Alpha#EUW']))
})

afterEach(() => {
  cleanup()
  queryClient.clear()
  queryClient.setDefaultOptions(defaultOptions)
  localStorage.clear()
  vi.unstubAllGlobals()
})

describe('recupero delle impostazioni globali senza perdere le bozze', () => {
  it('rifiuta un payload null al refetch senza sostituire la configurazione validata', async () => {
    let recovered = false
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(recovered ? settings(2) : null)))
    const user = mountPage()
    const input = await screen.findByLabelText('Nome profilo')
    await user.type(input, 'Bozza con risposta incompleta')
    await act(async () => { await queryClient.refetchQueries({ queryKey: queryKeys.algorithmSettings }) })

    expect(await screen.findByText(refreshMessage)).toBeVisible()
    expect(screen.getByLabelText('Nome profilo')).toBe(input)
    expect(input).toHaveValue('Bozza con risposta incompleta')
    expect(queryClient.getQueryData<AlgorithmSettingsResponseDto>(queryKeys.algorithmSettings)?.revision).toBe(1)
    expect(screen.getByTestId('validated-scope')).toHaveTextContent('"ready":true,"revision":1')

    recovered = true
    await user.click(screen.getByRole('button', { name: 'Riprova aggiornamento' }))
    await waitFor(() => expect(screen.queryByText(refreshMessage)).not.toBeInTheDocument())
    expect(screen.getByLabelText('Nome profilo')).toBe(input)
    expect(input).toHaveValue('Bozza con risposta incompleta')
    expect(screen.getByTestId('validated-scope')).toHaveTextContent('"ready":true,"revision":2')
  })

  it('offre un recupero iniziale quando il server restituisce null con HTTP200', async () => {
    let recovered = false
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(recovered ? settings() : null)))
    const user = mountPage('/app/profile', false)
    expect(await screen.findByRole('alert')).toHaveTextContent('Impossibile caricare le impostazioni algoritmiche')
    expect(screen.queryByLabelText('Nome profilo')).not.toBeInTheDocument()
    expect(screen.getByTestId('validated-scope')).toHaveTextContent('"ready":false')
    recovered = true
    await user.click(screen.getByRole('button', { name: 'Riprova' }))
    expect(await screen.findByLabelText('Nome profilo')).toHaveValue('')
    expect(screen.getByTestId('validated-scope')).toHaveTextContent('"ready":true,"revision":1')
  })

  it('conserva lo stesso input durante errori, retry pendente e successivo recupero', async () => {
    let nextSettings = () => Promise.resolve(offline())
    vi.stubGlobal('fetch', vi.fn(() => nextSettings()))
    const user = mountPage()
    const input = await screen.findByLabelText('Nome profilo')
    await user.type(input, 'Sessione in preparazione')

    await act(async () => { await queryClient.refetchQueries({ queryKey: queryKeys.algorithmSettings }) })
    expect(await screen.findByText(refreshMessage)).toBeVisible()
    expect(screen.getByLabelText('Nome profilo')).toBe(input)
    expect(input).toHaveValue('Sessione in preparazione')
    expect(screen.getByTestId('validated-scope')).toHaveTextContent('"ready":true,"revision":1,"accounts":["Alpha#EUW"]')

    let finishRetry!: (response: Response) => void
    nextSettings = () => new Promise((resolve) => { finishRetry = resolve })
    await user.click(screen.getByRole('button', { name: 'Riprova aggiornamento' }))
    expect(screen.getByRole('button', { name: 'Riprovo…' })).toBeDisabled()
    await user.type(input, ' aggiornata')
    await act(async () => { finishRetry(offline()) })
    expect(await screen.findByRole('button', { name: 'Riprova aggiornamento' })).toBeEnabled()
    expect(screen.getByLabelText('Nome profilo')).toBe(input)
    expect(input).toHaveValue('Sessione in preparazione aggiornata')

    nextSettings = () => Promise.resolve(Response.json(settings(2)))
    await user.click(screen.getByRole('button', { name: 'Riprova aggiornamento' }))
    await waitFor(() => expect(screen.queryByText(refreshMessage)).not.toBeInTheDocument())
    expect(screen.getByLabelText('Nome profilo')).toBe(input)
    expect(input).toHaveValue('Sessione in preparazione aggiornata')
    expect(screen.getByTestId('validated-scope')).toHaveTextContent('"ready":true,"revision":2,"accounts":["Alpha#EUW"]')
  })

  it('preserva la bozza nel dialogo dopo un vero conflitto 409 e usa la nuova revisione al recupero', async () => {
    let serverRevision = 1
    let settingsAvailable = false
    const requests: URL[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost')
      requests.push(url)
      if (url.pathname === '/api/algorithm-settings') return settingsAvailable ? Response.json(settings(serverRevision)) : offline()
      if (url.pathname === '/api/friends') {
        if (url.searchParams.get('algorithm_revision') !== String(serverRevision)) return Response.json({ error: 'revision conflict' }, { status: 409 })
        return Response.json({ items: [], manual_groups: [], summary: { tracked_accounts: 1, matches_with_participants: 0, friends_found: 0, min_shared_games: 5 } })
      }
      throw new Error(`Unexpected request: ${url.pathname}`)
    }))
    const user = mountPage('/app/team/friends')
    await screen.findByRole('heading', { name: 'Gruppi di nomi' })
    await user.click(screen.getByRole('button', { name: 'Nuovo gruppo' }))
    const dialog = screen.getByRole('dialog', { name: 'Crea gruppo di nomi' })
    const name = within(dialog).getByLabelText('Nome gruppo')
    const aliases = within(dialog).getByLabelText('Alias, separati da virgola')
    await user.type(name, 'Squadra in preparazione')
    await user.type(aliases, 'Friend#EUW')

    serverRevision = 2
    await act(async () => { await queryClient.invalidateQueries({ queryKey: ['api', 'friends'] }) })
    await waitFor(() => expect(queryClient.getQueryState(queryKeys.algorithmSettings)?.error).toBeInstanceOf(ApiError))
    expect(queryClient.getQueryCache().findAll({ queryKey: ['api', 'friends'] })[0]?.state.error).toMatchObject({ status: 409 })
    expect(queryClient.getQueryData<AlgorithmSettingsResponseDto>(queryKeys.algorithmSettings)?.revision).toBe(1)
    expect(requests.filter((url) => url.pathname === '/api/friends').every((url) => url.searchParams.get('algorithm_revision') === '1')).toBe(true)
    expect(screen.getByRole('dialog', { name: 'Crea gruppo di nomi' })).toBe(dialog)
    expect(within(dialog).getByLabelText('Nome gruppo')).toBe(name)
    expect(name).toHaveValue('Squadra in preparazione')
    expect(aliases).toHaveValue('Friend#EUW')

    settingsAvailable = true
    await act(async () => { await queryClient.refetchQueries({ queryKey: queryKeys.algorithmSettings }) })
    await waitFor(() => expect(requests.filter((url) => url.pathname === '/api/friends').at(-1)?.searchParams.get('algorithm_revision')).toBe('2'))
    expect(screen.getByRole('dialog', { name: 'Crea gruppo di nomi' })).toBe(dialog)
    expect(name).toHaveValue('Squadra in preparazione')
    expect(aliases).toHaveValue('Friend#EUW')
    expect(screen.queryByText(refreshMessage)).not.toBeInTheDocument()
  })

  it('blocca ancora l’avvio senza una configurazione caricata e offre un retry funzionante', async () => {
    let available = false
    vi.stubGlobal('fetch', vi.fn(async () => available ? Response.json(settings()) : offline()))
    const user = mountPage('/app/profile', false)
    expect(await screen.findByRole('alert')).toHaveTextContent('Impossibile caricare le impostazioni algoritmiche')
    expect(screen.queryByLabelText('Nome profilo')).not.toBeInTheDocument()
    expect(screen.getByTestId('validated-scope')).toHaveTextContent('"ready":false')
    expect(screen.queryByText(refreshMessage)).not.toBeInTheDocument()

    available = true
    await user.click(screen.getByRole('button', { name: 'Riprova' }))
    expect(await screen.findByLabelText('Nome profilo')).toHaveValue('')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByTestId('validated-scope')).toHaveTextContent('"ready":true,"revision":1,"accounts":["Alpha#EUW"]')
  })
})
