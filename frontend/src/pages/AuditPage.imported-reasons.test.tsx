import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider, useRouteError } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { queryKeys } from '../api/queries'
import type { AccountDto, AnnotationResponseDto, MatchDto } from '../api/types'
import { AlgorithmSettingsProvider, RECOMMENDED_ALGORITHM_SETTINGS } from '../app/algorithm-settings'
import { PROFILE_ACCOUNTS_KEY, ScopeProvider } from '../app/scope'
import { AppToastProvider } from '../components/toast'
import { AuditPage } from './AuditPage'

const account = 'Owned#EUW'
const matchId = 'REASON-OWNED-1'
const scope = { accounts: [account], companion: null, algorithmRevision: 2 }
const disposables: (() => void)[] = []

function RouteFailure() {
  const error = useRouteError()
  return <output data-testid="audit-route-error">{error instanceof Error ? error.message : String(error)}</output>
}

function setup(reason: string) {
  // Small portable copy of the public normalized-import matches contract.
  // Only reason varies; it remains original source text throughout the DTO.
  const match: MatchDto = {
    id: 1, account, match_id: matchId, date: '2026-08-22T20:00:00Z',
    date_utc: '2026-08-22T20:00:00.000000+00:00', patch: '16.16', queue: '420',
    champion: 'Ahri', role: 'MIDDLE', identity_resolution: 'external', duration_minutes: 30,
    win: 1, explicit_afk: 0, suspected_quasi_afk: 0, early_surrender: 0,
    anomaly_flags: 'none', match_quality_score: .95, loss_attribution_weight: 0,
    win_evidence_weight: .95, reason, icon_url: '/owned-ahri.png',
    annotation_invincible: 0, annotation_carryable_loss: 0, annotation_afk_player: 0,
    annotation_griefer: 0, annotation_team_collapse: 0, annotation_manual_label: '',
    annotation_note: '', annotation_confidence: 1,
  }
  const response = {
    items: [match], algorithm_revision: 2, algorithm_fingerprint: 'owned-imported-reasons',
    context: { accounts: [account], role: 'ALL', queue: 'all', days: 'all', as_of: '2026-09-24',
      observations: 1, unique_games: 1, suspended_accounts: [], companion_filter_active: false },
  }
  const originalResponse = structuredClone(response)
  const annotation: AnnotationResponseDto = { item: null, revision: null }
  const requests: { url: URL; method: string }[] = []
  const warnings: string[] = []
  for (const method of ['error', 'warn'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(' '))
    })
  }
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    const method = init?.method ?? 'GET'
    requests.push({ url, method })
    if (method !== 'GET') throw new Error(`Unexpected write: ${method} ${url.pathname}`)
    if (url.pathname === '/api/matches') return Response.json(response)
    if (url.pathname === '/api/annotations' && url.searchParams.get('match_id') === matchId) {
      return Response.json(annotation)
    }
    throw new Error(`Unexpected endpoint: ${url.pathname}`)
  }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  const available: AccountDto = {
    account, aliases: [], raw_games: 1, eligible_games: 1, analyzed_games: 1, wins: 1,
    games: 1, first_game: match.date, last_game: match.date,
  }
  client.setQueryData(queryKeys.accounts, { items: [available] })
  client.setQueryData(queryKeys.algorithmSettings, {
    revision: 2, fingerprint: 'owned-imported-reasons',
    settings: structuredClone(RECOMMENDED_ALGORITHM_SETTINGS),
    defaults: structuredClone(RECOMMENDED_ALGORITHM_SETTINGS), history: [], schema: [],
  })
  const initialUrl = '/app/matches?section=history&flag=all&queue=all&days=all&account=Owned%23EUW'
  const router = createMemoryRouter([{
    path: '/app/matches', element: <AuditPage embedded />, errorElement: <RouteFailure />,
  }], { initialEntries: [initialUrl] })
  disposables.push(() => { router.dispose(); client.clear() })
  render(<QueryClientProvider client={client}><AlgorithmSettingsProvider><ScopeProvider>
    <AppToastProvider><RouterProvider router={router} /></AppToastProvider>
  </ScopeProvider></AlgorithmSettingsProvider></QueryClientProvider>)
  return { client, router, requests, warnings, response, originalResponse, initialUrl, user: userEvent.setup() }
}

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem(PROFILE_ACCOUNTS_KEY, JSON.stringify([account]))
})

afterEach(() => {
  cleanup()
  disposables.splice(0).forEach((dispose) => dispose())
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('motivi importati nella revisione partite', () => {
  it.each([
    { reason: '__proto__', label: '__proto__' },
    { reason: 'Constructor', label: 'Constructor' },
    { reason: 'Imported normalized match', label: 'Partita importata da dati normalizzati.' },
    { reason: 'Owned_unknown_reason', label: 'Owned_unknown_reason' },
  ])('mostra $reason e permette di aprire l’annotazione senza alterare i dati', async ({ reason, label }) => {
    const state = setup(reason)
    const key = queryKeys.matches(scope, 'all')
    await waitFor(() => expect(state.client.getQueryState(key)?.status).toBe('success'))

    // The real matchesQuery/getJson round trip must keep the complete raw DTO,
    // even when React cannot yet render an inherited dictionary name.
    expect(state.client.getQueryData(key)).toEqual(state.originalResponse)
    expect(state.response).toEqual(state.originalResponse)
    expect(state.client.getQueryData<typeof state.response>(key)?.items[0]?.reason).toBe(reason)
    expect(state.client.getQueryCache().findAll({ queryKey: ['api', 'matches'] })).toHaveLength(1)
    expect(state.requests).toHaveLength(1)
    const request = state.requests[0]!
    expect(request.method).toBe('GET')
    expect(request.url.pathname).toBe('/api/matches')
    expect(request.url.searchParams.getAll('account')).toEqual([account])
    expect(request.url.searchParams.get('algorithm_revision')).toBe('2')
    for (const [name, value] of Object.entries({ queue: 'all', days: 'all', role: 'ALL', flag: 'all', limit: '24' })) {
      expect(request.url.searchParams.get(name)).toBe(value)
    }
    await waitFor(() => expect(
      screen.queryByRole('button', { name: /^Apri annotazione:/ }) ?? screen.queryByTestId('audit-route-error'),
    ).toBeInTheDocument())
    expect(screen.queryByTestId('audit-route-error')).not.toBeInTheDocument()
    const row = screen.getByRole('button', { name: /^Apri annotazione:/ })
    expect(within(row).getByText(label, { selector: 'p' })).toBeVisible()
    expect(row.getAttribute('aria-label')).toContain(`Motivo: ${label}.`)
    expect(row.getAttribute('aria-label')).not.toContain('function Object')
    expect(state.warnings).toEqual([])

    await state.user.click(row)
    const dialog = await screen.findByRole('dialog', { name: 'Annotazione della partita' })
    expect(await within(dialog).findByLabelText('Etichetta manuale')).toHaveValue('')
    expect(within(dialog).getByLabelText('Nota')).toHaveValue('')
    expect(within(dialog).getByText(matchId)).toBeVisible()
    expect(within(dialog).getByRole('button', { name: 'Salva annotazione' })).toBeEnabled()
    expect(state.client.getQueryData(queryKeys.annotation(matchId))).toEqual({ item: null, revision: null })
    expect(state.requests.map(({ url, method }) => [method, url.pathname])).toEqual([
      ['GET', '/api/matches'], ['GET', '/api/annotations'],
    ])
    expect(state.client.getQueryData(key)).toEqual(state.originalResponse)
    expect(state.response).toEqual(state.originalResponse)
    expect(state.router.state.location.pathname + state.router.state.location.search).toBe(state.initialUrl)
    expect(state.warnings).toEqual([])
  })
})
