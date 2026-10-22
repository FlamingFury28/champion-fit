import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider, useRouteError } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { queryKeys } from '../api/queries'
import type { AccountDto } from '../api/types'
import { AlgorithmSettingsProvider, RECOMMENDED_ALGORITHM_SETTINGS } from '../app/algorithm-settings'
import { tagLabel } from '../app/labels'
import { PROFILE_ACCOUNTS_KEY, ScopeProvider } from '../app/scope'
import { discoveryRecommendation, recommendationsFixture } from '../test/recommendations-fixture'
import { ScoutPage } from './ScoutPage'

const disposables: (() => void)[] = []

function RouteFailure() {
  const error = useRouteError()
  return <output data-testid="scout-route-error">{error instanceof Error ? error.message : String(error)}</output>
}

function setup(raw: string, key: 'tag' | 'category' = 'tag') {
  const requests: URL[] = []
  const writes: string[] = []
  const warnings: string[] = []
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { warnings.push(args.map(String).join(' ')) })
  const data = recommendationsFixture({
    known: [],
    discover: [
      discoveryRecommendation({
        source_champions: [{ champion: 'Ahri', name: 'Ahri', games: 1, similarity: .75, matched_tags: ['mage'] }],
      }),
      discoveryRecommendation({
        champion: 'Malphite', name: 'Malphite', icon_url: '/malphite.png',
        source_champions: [{ champion: 'Leona', name: 'Leona', games: 1, similarity: .75, matched_tags: ['tank'] }],
      }),
    ],
    trial_plan: { budget: 2, items: [
      { champion: 'Orianna', role: 'MIDDLE', games: 1, reason: 'Proposta sintetica mago.' },
      { champion: 'Malphite', role: 'MIDDLE', games: 1, reason: 'Proposta sintetica difensore.' },
    ] },
  })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    requests.push(url)
    if ((init?.method ?? 'GET') !== 'GET') {
      writes.push(init!.method!)
      throw new Error('Unexpected write')
    }
    if (url.pathname !== '/api/recommendations') throw new Error(`Unexpected endpoint: ${url.pathname}`)
    return Response.json(data)
  }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: 0 } } })
  const account: AccountDto = { account: 'Alpha#EUW', aliases: [], raw_games: 1, eligible_games: 1, analyzed_games: 1,
    wins: 1, games: 1, first_game: null, last_game: null }
  client.setQueryData(queryKeys.accounts, { items: [account] })
  client.setQueryData(queryKeys.algorithmSettings, {
    revision: 4, fingerprint: 'owned-scout-tags', settings: structuredClone(RECOMMENDED_ALGORITHM_SETTINGS),
    defaults: structuredClone(RECOMMENDED_ALGORITHM_SETTINGS), history: [], schema: [],
  })
  const params = new URLSearchParams({
    section: 'training', training: 'discover', role: 'MIDDLE', queue: '420', days: 'all',
    search: ' ', minSimilarity: '0', budget: '1000', account: 'Alpha#EUW',
  })
  params.set(key, raw)
  const originalSearch = `?${params}`
  const router = createMemoryRouter([{ path: '/app/fit', element: <ScoutPage embedded />, errorElement: <RouteFailure /> }], {
    initialEntries: [`/app/fit${originalSearch}`],
  })
  disposables.push(() => { router.dispose(); client.clear() })
  render(<QueryClientProvider client={client}><AlgorithmSettingsProvider><ScopeProvider>
    <RouterProvider router={router} />
  </ScopeProvider></AlgorithmSettingsProvider></QueryClientProvider>)
  return { client, router, requests, writes, warnings, params, originalSearch, user: userEvent.setup() }
}

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem(PROFILE_ACCOUNTS_KEY, JSON.stringify(['Alpha#EUW']))
})

afterEach(() => {
  cleanup()
  disposables.splice(0).forEach((dispose) => dispose())
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('etichette di caratteristiche non presenti nel dizionario', () => {
  it.each([
    { raw: '__proto__', expected: '  proto  ' },
    { raw: 'CoNsTrUcToR', expected: 'CoNsTrUcToR' },
    { raw: ' MAGE ', expected: 'Mago' },
  ])('restituisce una stringa per $raw', ({ raw, expected }) => {
    const label = tagLabel(raw)
    expect(typeof label).toBe('string')
    expect(label).toBe(expected)
  })
})

describe('ScoutPage con caratteristica conservata nel link', () => {
  it.each([
    { raw: '__proto__', key: 'tag' as const, label: 'proto', initialMatch: false },
    { raw: 'class:__proto__', key: 'category' as const, label: 'proto', initialMatch: false },
    { raw: 'CoNsTrUcToR', key: 'tag' as const, label: 'CoNsTrUcToR', initialMatch: false },
    { raw: 'mage', key: 'tag' as const, label: 'Mago', initialMatch: true },
    { raw: 'unknown_tag', key: 'tag' as const, label: 'unknown tag', initialMatch: false },
  ])('mostra $raw e recupera con una caratteristica valida senza cambiare il contesto', async ({ raw, key, label, initialMatch }) => {
    const state = setup(raw, key)
    expect(screen.queryByTestId('scout-route-error')).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Scelte vicine ai tuoi gusti' })).toBeVisible()
    const select = screen.getByRole('combobox', { name: 'Caratteristica' })
    expect(select).toHaveValue(raw)
    expect(within(select).getByRole('option', { selected: true }).textContent?.trim()).toBe(label)
    expect(state.router.state.location.search).toBe(state.originalSearch)
    expect(state.warnings).toEqual([])
    await waitFor(() => expect(state.client.isFetching()).toBe(0))
    expect(state.requests).toHaveLength(1)
    if (initialMatch) expect(screen.getByText('Orianna')).toBeVisible()
    else expect(screen.getByText('Nessuna scoperta per questi filtri')).toBeVisible()
    const query = state.client.getQueryCache().find({ queryKey: ['api', 'recommendations'], exact: false })
    expect(query?.state.status).toBe('success')
    const initialKey = query?.queryKey

    const nextTag = initialMatch ? 'tank' : 'mage'
    const expectedChampion = initialMatch ? 'Malphite' : 'Orianna'
    await state.user.selectOptions(select, nextTag)
    await state.user.tab()

    expect(await screen.findByText(expectedChampion)).toBeVisible()
    expect(screen.getByText('1 proposte')).toBeVisible()
    expect(select).toHaveValue(nextTag)
    const current = new URLSearchParams(state.router.state.location.search)
    expect(current.get('tag')).toBe(nextTag)
    expect(current.has('category')).toBe(false)
    for (const [name, value] of state.params) {
      if (name !== 'tag' && name !== 'category') expect(current.get(name)).toBe(value)
    }
    const destination = new URL(screen.getByRole('link', { name: 'Apri la scheda' }).getAttribute('href')!, 'http://localhost')
    expect(destination.searchParams.get('detail')).toBe(expectedChampion)
    expect(destination.searchParams.get('tag')).toBe(nextTag)
    expect(destination.searchParams.get('queue')).toBe('420')
    expect(destination.searchParams.get('days')).toBe('all')
    expect(state.client.getQueryCache().findAll({ queryKey: ['api', 'recommendations'] })).toHaveLength(1)
    expect(state.client.getQueryCache().find({ queryKey: ['api', 'recommendations'], exact: false })?.queryKey).toEqual(initialKey)
    expect(state.requests).toHaveLength(1)
    const request = state.requests[0]!
    expect(request.searchParams.getAll('account')).toEqual(['Alpha#EUW'])
    expect(request.searchParams.get('algorithm_revision')).toBe('4')
    expect(request.searchParams.get('role')).toBe('MIDDLE')
    expect(request.searchParams.get('queue')).toBe('420')
    expect(request.searchParams.get('days')).toBe('all')
    expect(request.searchParams.has('tag')).toBe(false)
    expect(request.searchParams.has('category')).toBe(false)
    expect(state.writes).toEqual([])
    expect(state.warnings).toEqual([])
  })
})
