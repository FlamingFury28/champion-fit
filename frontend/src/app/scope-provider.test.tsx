import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { overviewQuery } from '../api/queries'
import type { AccountDto } from '../api/types'
import {
  COMPANION_FILTER_KEY, PROFILE_ACCOUNTS_KEY, PROFILE_GROUPS_KEY,
  ScopeProvider, useScope,
} from './scope'

function account(account: string, aliases: string[] = []): AccountDto {
  return { account, aliases, raw_games: 1, eligible_games: 1, analyzed_games: 1,
    wins: 1, games: 1, first_game: null, last_game: null }
}

function ScopedConsumer() {
  const { scope, state, scopeReady } = useScope()
  const overview = useQuery({ ...overviewQuery(scope), enabled: scopeReady })
  return <><output data-testid="scope-state">{JSON.stringify(state)}</output>
    <span>{overview.isSuccess ? 'scoped response loaded' : 'waiting for scope'}</span></>
}

function mountScope() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  const result = render(<QueryClientProvider client={client}><ScopeProvider><ScopedConsumer /></ScopeProvider></QueryClientProvider>)
  return { ...result, client }
}

describe('ScopeProvider con identità Riot rinominate', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('invia subito soltanto il nuovo account con companion e migra tutte le chiavi persistite', async () => {
    localStorage.setItem(PROFILE_ACCOUNTS_KEY, JSON.stringify(['Old#EUW']))
    localStorage.setItem(PROFILE_GROUPS_KEY, JSON.stringify({ Main: ['Old#EUW'], Duo: ['OldDuo#EUW'] }))
    localStorage.setItem(COMPANION_FILTER_KEY, JSON.stringify({
      name: 'Duo', accounts: ['OldDuo#EUW'], mode: 'exclude', profile_accounts: ['Old#EUW'],
    }))
    let finishAccounts!: (response: Response) => void
    const pendingAccounts = new Promise<Response>((resolve) => { finishAccounts = resolve })
    const scopedRequests: URL[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost')
      if (url.pathname === '/api/accounts') return pendingAccounts.then((response) => response.clone())
      scopedRequests.push(url)
      return Response.json({})
    }))
    const firstMount = mountScope()
    expect(scopedRequests).toHaveLength(0)
    await act(async () => finishAccounts(Response.json({ items: [
      account('New#EUW', ['Old#EUW']), account('NewDuo#EUW', ['OldDuo#EUW']), account('Other#EUW'),
    ] })))
    await screen.findByText('scoped response loaded')
    const expectedState = {
      accounts: ['New#EUW'], profiles: { Main: ['New#EUW'], Duo: ['NewDuo#EUW'] },
      companion: { name: 'Duo', accounts: ['NewDuo#EUW'], mode: 'exclude', profileAccounts: ['New#EUW'] },
    }
    expect(JSON.parse(screen.getByTestId('scope-state').textContent ?? '')).toEqual(expectedState)
    await waitFor(() => expect(JSON.parse(localStorage.getItem(PROFILE_ACCOUNTS_KEY) ?? '')).toEqual(['New#EUW']))
    expect(JSON.parse(localStorage.getItem(PROFILE_GROUPS_KEY) ?? '')).toEqual(expectedState.profiles)
    expect(JSON.parse(localStorage.getItem(COMPANION_FILTER_KEY) ?? '')).toEqual({
      name: 'Duo', accounts: ['NewDuo#EUW'], mode: 'exclude', profile_accounts: ['New#EUW'],
    })
    expect(scopedRequests).toHaveLength(1)
    firstMount.unmount()
    firstMount.client.clear()
    const secondMount = mountScope()
    await screen.findByText('scoped response loaded')
    expect(scopedRequests).toHaveLength(2)
    for (const url of scopedRequests) {
      expect(url.pathname).toBe('/api/overview')
      expect(url.searchParams.getAll('account')).toEqual(['New#EUW'])
      expect(url.searchParams.getAll('companion_account')).toEqual(['NewDuo#EUW'])
      expect(url.searchParams.get('companion_mode')).toBe('exclude')
    }
    secondMount.unmount()
    secondMount.client.clear()
  })

  it.each(['Old#EUW', 'Missing#EUW'])('non allarga un filtro esplicito irrisolto: %s', async (selected) => {
    localStorage.setItem(PROFILE_ACCOUNTS_KEY, JSON.stringify([selected]))
    const scopedRequests: URL[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost')
      if (url.pathname === '/api/accounts') return Response.json({ items: [
        account('New#EUW', ['Old#EUW']), account('Other#EUW', ['Old#EUW']),
      ] })
      scopedRequests.push(url)
      return Response.json({})
    }))
    const mounted = mountScope()
    await screen.findByText('scoped response loaded')
    expect(scopedRequests).toHaveLength(1)
    expect(scopedRequests[0]?.searchParams.getAll('account')).toEqual([selected])
    expect(JSON.parse(localStorage.getItem(PROFILE_ACCOUNTS_KEY) ?? '')).toEqual([selected])
    mounted.unmount()
    mounted.client.clear()
  })

  it('accoglie un nuovo profilo creato in un’altra scheda senza perdere quello locale', async () => {
    localStorage.setItem(PROFILE_GROUPS_KEY, JSON.stringify({ Locale: ['Alpha#EUW'] }))
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost')
      if (url.pathname === '/api/accounts') return Response.json({ items: [account('Alpha#EUW'), account('Beta#EUW')] })
      return Response.json({})
    }))
    const mounted = mountScope()
    await screen.findByText('scoped response loaded')
    const incoming = { Locale: ['Alpha#EUW'], AltraScheda: ['Beta#EUW'] }
    localStorage.setItem(PROFILE_GROUPS_KEY, JSON.stringify(incoming))
    await act(async () => {
      window.dispatchEvent(new StorageEvent('storage', {
        key: PROFILE_GROUPS_KEY, newValue: JSON.stringify(incoming), storageArea: localStorage,
      }))
    })
    await waitFor(() => expect(JSON.parse(screen.getByTestId('scope-state').textContent ?? '')).toMatchObject({ profiles: incoming }))
    mounted.unmount()
    mounted.client.clear()
  })
})
