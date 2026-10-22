import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Component, type PropsWithChildren } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { overviewQuery } from '../api/queries'
import type { AccountDto } from '../api/types'
import { AppToastProvider } from '../components/toast'
import { ProfilePage } from '../pages/ProfilePage'
import { PROFILE_ACCOUNTS_KEY, PROFILE_GROUPS_KEY, ScopeProvider, useScope, type ProfileSaveResult } from './scope'

const clients: QueryClient[] = []
const requests: URL[] = []
const browserErrors: unknown[] = []
const profileMap = (...entries: [string, string[]][]) => Object.fromEntries(entries)

function account(name: string): AccountDto {
  return { account: name, aliases: [], raw_games: 1, eligible_games: 1, analyzed_games: 1,
    wins: 1, games: 1, first_game: null, last_game: null }
}

class ScopeBoundary extends Component<PropsWithChildren, { error: string | null }> {
  state = { error: null as string | null }
  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
  render() {
    return this.state.error ? <output data-testid="provider-error">{this.state.error}</output> : this.props.children
  }
}

function Probe({ capture }: { capture: (scope: ReturnType<typeof useScope>) => void }) {
  const scope = useScope()
  capture(scope)
  const result = useQuery({ ...overviewQuery(scope.scope), enabled: scope.scopeReady })
  return <>
    <output data-testid="profile-ready">{String(scope.scopeReady && result.isSuccess)}</output>
    <output data-testid="profile-state">{JSON.stringify(scope.state)}</output>
  </>
}

function mount() {
  let current: ReturnType<typeof useScope> | undefined
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  clients.push(client)
  const view = render(<QueryClientProvider client={client}><ScopeBoundary><ScopeProvider>
    <Probe capture={(value) => { current = value }} />
    <AppToastProvider><ProfilePage /></AppToastProvider>
  </ScopeProvider></ScopeBoundary></QueryClientProvider>)
  return {
    ...view, client, user: userEvent.setup(),
    scope: () => {
      if (!current) throw new Error('Scope context unavailable')
      return current
    },
  }
}

type Mounted = ReturnType<typeof mount>

async function ready() {
  await waitFor(() => {
    expect(screen.queryByTestId('provider-error')).not.toBeInTheDocument()
    expect(screen.getByTestId('profile-ready')).toHaveTextContent('true')
  })
  expect(browserErrors).toEqual([])
}

function storedProfiles(): Record<string, string[]> {
  return JSON.parse(localStorage.getItem(PROFILE_GROUPS_KEY) ?? '{}') as Record<string, string[]>
}

function assertProfiles(mounted: Mounted, expected: Record<string, string[]>, persisted = true) {
  const profiles = mounted.scope().state.profiles
  expect(Object.getPrototypeOf(profiles)).toBe(Object.prototype)
  expect(Object.keys(profiles).sort()).toEqual(Object.keys(expected).sort())
  for (const [name, accounts] of Object.entries(expected)) {
    expect(Object.hasOwn(profiles, name)).toBe(true)
    expect(profiles[name]).toEqual(accounts)
  }
  if (persisted) {
    const stored = storedProfiles()
    expect(Object.keys(stored).sort()).toEqual(Object.keys(expected).sort())
    for (const [name, accounts] of Object.entries(expected)) {
      expect(Object.hasOwn(stored, name)).toBe(true)
      expect(stored[name]).toEqual(accounts)
    }
  }
}

function profileButton(name: string): HTMLButtonElement {
  const button = screen.getByText(name, { selector: '.saved-profile__apply strong' }).closest('button')
  if (!(button instanceof HTMLButtonElement)) throw new Error('Saved profile has no apply button')
  return button
}

async function saveThroughPage(mounted: Mounted, name: string) {
  await mounted.user.type(screen.getByRole('textbox', { name: 'Nome profilo' }), name)
  await mounted.user.click(screen.getByRole('button', { name: 'Salva' }))
  expect(browserErrors).toEqual([])
}

async function incomingProfiles(next: Record<string, string[]>, write = (raw: string) => localStorage.setItem(PROFILE_GROUPS_KEY, raw)) {
  const oldValue = localStorage.getItem(PROFILE_GROUPS_KEY)
  const newValue = JSON.stringify(next)
  write(newValue)
  await act(async () => {
    window.dispatchEvent(new StorageEvent('storage', { key: PROFILE_GROUPS_KEY, oldValue, newValue, storageArea: localStorage }))
  })
  expect(browserErrors).toEqual([])
  expect(screen.queryByTestId('provider-error')).not.toBeInTheDocument()
}

function blockProfileWrites() {
  const nativeSetItem = Storage.prototype.setItem
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
    if (key === PROFILE_GROUPS_KEY) throw new DOMException('Synthetic profile quota', 'QuotaExceededError')
    nativeSetItem.call(this, key, value)
  })
  return (raw: string) => nativeSetItem.call(localStorage, PROFILE_GROUPS_KEY, raw)
}

const overviewRequests = () => requests.filter((url) => url.pathname === '/api/overview')

function recordBrowserError(event: ErrorEvent) {
  browserErrors.push(event.error ?? event.message)
  event.preventDefault()
}

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem(PROFILE_ACCOUNTS_KEY, JSON.stringify(['Alpha#EUW']))
  requests.length = 0
  browserErrors.length = 0
  window.addEventListener('error', recordBrowserError)
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    requests.push(url)
    if ((init?.method ?? 'GET') !== 'GET') throw new Error('Unexpected write')
    if (url.pathname === '/api/accounts') return Response.json({ items: [account('Alpha#EUW'), account('Beta#EUW'), account('Gamma#EUW')] })
    if (url.pathname === '/api/overview') return Response.json({ metadata: {}, summary: { observed_games: 1, wins: 1, win_rate: 100 }, roles: [] })
    throw new Error(`Unexpected endpoint: ${url.pathname}`)
  }))
})

afterEach(() => {
  cleanup()
  clients.splice(0).forEach((client) => client.clear())
  window.removeEventListener('error', recordBrowserError)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('nomi dei profili nel provider e nella pagina reali', () => {
  it.each(['constructor', 'toString', 'hasOwnProperty', '__proto__'])('salva, applica ed elimina il profilo %s', async (name) => {
    const mounted = mount()
    await ready()

    await saveThroughPage(mounted, name)
    await waitFor(() => assertProfiles(mounted, profileMap([name, ['Alpha#EUW']])))

    await mounted.user.click(screen.getByRole('button', { name: /^Beta#EUW/ }))
    await mounted.user.click(screen.getByRole('button', { name: /^Alpha#EUW/ }))
    await waitFor(() => expect(mounted.scope().scope.accounts).toEqual(['Beta#EUW']))
    const previousRequests = overviewRequests().length
    await mounted.user.click(profileButton(name))
    await waitFor(() => {
      expect(mounted.scope().scope.accounts).toEqual(['Alpha#EUW'])
      expect(overviewRequests().length).toBeGreaterThan(previousRequests)
    })
    expect(overviewRequests().at(-1)?.searchParams.getAll('account')).toEqual(['Alpha#EUW'])
    expect(JSON.parse(localStorage.getItem(PROFILE_ACCOUNTS_KEY)!)).toEqual(['Alpha#EUW'])

    await mounted.user.click(screen.getByRole('button', { name: `Elimina profilo ${name}` }))
    await mounted.user.click(screen.getByRole('button', { name: 'Conferma eliminazione' }))
    await waitFor(() => assertProfiles(mounted, {}))
    expect(Object.hasOwn(mounted.scope().state.profiles, name)).toBe(false)
    expect(Object.hasOwn(storedProfiles(), name)).toBe(false)
    expect(browserErrors).toEqual([])
    expect(screen.queryByTestId('provider-error')).not.toBeInTheDocument()
  })

  it('mantiene __proto__ dal bootstrap, dopo un altro salvataggio e al remount', async () => {
    const initial = profileMap(['__proto__', ['Beta#EUW']], ['Normale', ['Alpha#EUW']])
    localStorage.setItem(PROFILE_GROUPS_KEY, JSON.stringify(initial))
    const first = mount()
    await ready()
    assertProfiles(first, initial)

    await saveThroughPage(first, 'Altro')
    const expected = profileMap(...Object.entries(initial), ['Altro', ['Alpha#EUW']])
    await waitFor(() => assertProfiles(first, expected))
    first.unmount()
    first.client.clear()

    const second = mount()
    await ready()
    assertProfiles(second, expected)
    expect(second.scope().scope.accounts).toEqual(['Alpha#EUW'])
  })

  it('accoglie __proto__ da un’altra scheda, conserva i profili indipendenti e applica il nuovo scope', async () => {
    localStorage.setItem(PROFILE_GROUPS_KEY, JSON.stringify({ Locale: ['Alpha#EUW'] }))
    const mounted = mount()
    await ready()
    const incoming = profileMap(['Locale', ['Alpha#EUW']], ['__proto__', ['Beta#EUW']], ['Remoto', ['Gamma#EUW']])

    await incomingProfiles(incoming)
    await waitFor(() => assertProfiles(mounted, incoming))
    const previousRequests = overviewRequests().length
    await mounted.user.click(profileButton('__proto__'))
    await waitFor(() => {
      expect(mounted.scope().scope.accounts).toEqual(['Beta#EUW'])
      expect(overviewRequests().length).toBeGreaterThan(previousRequests)
    })
    expect(overviewRequests().at(-1)?.searchParams.getAll('account')).toEqual(['Beta#EUW'])
    await ready()
    expect(mounted.client.getQueryData(overviewQuery(mounted.scope().scope).queryKey)).toBeDefined()
    assertProfiles(mounted, incoming)
  })

  it('conserva la modifica locale non persistita in conflitto e accoglie un profilo remoto indipendente', async () => {
    const baseline = profileMap(['constructor', ['Alpha#EUW']], ['Normale', ['Alpha#EUW']])
    localStorage.setItem(PROFILE_GROUPS_KEY, JSON.stringify(baseline))
    const mounted = mount()
    await ready()
    const writeFromOtherTab = blockProfileWrites()
    let result: ProfileSaveResult | undefined
    await act(async () => { result = mounted.scope().saveProfile('constructor', ['Beta#EUW']) })
    expect(result).toEqual({ name: 'constructor', applied: true, persisted: false })
    const remote = profileMap(['constructor', ['Gamma#EUW']], ['Normale', ['Alpha#EUW']], ['Remoto', ['Gamma#EUW']])

    await incomingProfiles(remote, writeFromOtherTab)

    assertProfiles(mounted, profileMap(['constructor', ['Beta#EUW']], ['Normale', ['Alpha#EUW']], ['Remoto', ['Gamma#EUW']]), false)
    expect(storedProfiles()).toEqual(remote)
    expect(mounted.scope().storageAvailable).toBe(false)
    expect(mounted.scope().scope.accounts).toEqual(['Alpha#EUW'])
  })

  it('propaga la rimozione remota di constructor se il profilo locale non è cambiato', async () => {
    localStorage.setItem(PROFILE_GROUPS_KEY, JSON.stringify(profileMap(['constructor', ['Beta#EUW']], ['Normale', ['Alpha#EUW']])))
    const mounted = mount()
    await ready()
    const previousRequests = overviewRequests().length

    await incomingProfiles({ Normale: ['Alpha#EUW'] })

    await waitFor(() => assertProfiles(mounted, { Normale: ['Alpha#EUW'] }))
    expect(Object.hasOwn(mounted.scope().state.profiles, 'constructor')).toBe(false)
    expect(mounted.scope().scope.accounts).toEqual(['Alpha#EUW'])
    expect(overviewRequests()).toHaveLength(previousRequests)
  })

  it('conserva una cancellazione locale non persistita quando il remoto conserva la baseline', async () => {
    const baseline = profileMap(['hasOwnProperty', ['Beta#EUW']], ['Normale', ['Alpha#EUW']])
    localStorage.setItem(PROFILE_GROUPS_KEY, JSON.stringify(baseline))
    const mounted = mount()
    await ready()
    const writeFromOtherTab = blockProfileWrites()

    await act(async () => mounted.scope().deleteProfile('hasOwnProperty'))
    expect(screen.queryByTestId('provider-error')).not.toBeInTheDocument()
    await waitFor(() => assertProfiles(mounted, { Normale: ['Alpha#EUW'] }, false))
    expect(storedProfiles()).toEqual(baseline)
    await incomingProfiles(baseline, writeFromOtherTab)

    assertProfiles(mounted, { Normale: ['Alpha#EUW'] }, false)
    expect(Object.hasOwn(mounted.scope().state.profiles, 'hasOwnProperty')).toBe(false)
    expect(mounted.scope().storageAvailable).toBe(false)
    expect(mounted.scope().scope.accounts).toEqual(['Alpha#EUW'])
  })

  it('distingue un profilo legacy vuoto dalla sua rimozione senza allargare lo scope', async () => {
    const baseline = profileMap(['__proto__', []], ['Normale', ['Alpha#EUW']])
    localStorage.setItem(PROFILE_GROUPS_KEY, JSON.stringify(baseline))
    const mounted = mount()
    await ready()
    assertProfiles(mounted, baseline)
    const previousRequests = overviewRequests().length

    await mounted.user.click(profileButton('__proto__'))
    expect(mounted.scope().scope.accounts).toEqual(['Alpha#EUW'])
    let result: ProfileSaveResult | undefined
    await act(async () => { result = mounted.scope().saveProfile('__proto__', []) })
    expect(result).toEqual({ name: '__proto__', applied: false, persisted: false })
    assertProfiles(mounted, baseline)
    await incomingProfiles({ Normale: ['Alpha#EUW'] })

    assertProfiles(mounted, { Normale: ['Alpha#EUW'] })
    expect(Object.hasOwn(mounted.scope().state.profiles, '__proto__')).toBe(false)
    expect(mounted.scope().scope.accounts).toEqual(['Alpha#EUW'])
    expect(JSON.parse(localStorage.getItem(PROFILE_ACCOUNTS_KEY)!)).toEqual(['Alpha#EUW'])
    expect(overviewRequests()).toHaveLength(previousRequests)
  })
})
