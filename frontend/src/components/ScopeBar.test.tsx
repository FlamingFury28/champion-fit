import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PROFILE_ACCOUNTS_KEY, ScopeProvider } from '../app/scope'
import { ScopeBar } from './ScopeBar'

const clients: QueryClient[] = []
const accounts = ['Alpha#EUW', 'Beta#EUW'].map((account) => ({
  account, raw_games: 1, eligible_games: 1, analyzed_games: 1,
  wins: 1, games: 1, first_game: null, last_game: null,
}))

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  clients.push(client)
  render(<QueryClientProvider client={client}><ScopeProvider><MemoryRouter><ScopeBar /></MemoryRouter></ScopeProvider></QueryClientProvider>)
}

describe('Dati usati: perimetro degli account', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, media: '', onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn() })))
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ items: accounts })))
  })
  afterEach(() => {
    cleanup()
    clients.splice(0).forEach((client) => client.clear())
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('non chiama tutti gli account una selezione irrisolta con la stessa cardinalità del catalogo', async () => {
    localStorage.setItem(PROFILE_ACCOUNTS_KEY, JSON.stringify(['Alpha#EUW', 'Missing#EUW']))
    mount()
    await screen.findByText('2 account attivi')
    expect(screen.queryByText('Tutti gli account · 2')).toBeNull()
    expect(JSON.parse(localStorage.getItem(PROFILE_ACCOUNTS_KEY)!)).toEqual(['Alpha#EUW', 'Missing#EUW'])
    expect(screen.getByText('1 raccolte · 1 ammesse · 1 analizzate')).toBeInTheDocument()
  })

  it('riconosce tutti gli account confrontando il perimetro effettivo', async () => {
    localStorage.setItem(PROFILE_ACCOUNTS_KEY, JSON.stringify(['Beta#EUW', 'Alpha#EUW']))
    mount()
    await screen.findByText('Tutti gli account · 2')
  })
})
