import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TrainingPlanResponseDto } from '../api/types'
import { PLAN_BUDGET_KEY } from '../app/remembered-plan-budget'
import { CompetitivePlanPage } from './CompetitivePlanPage'

vi.mock('../app/scope', () => ({ useScope: () => ({
  scope: { accounts: ['Alpha#EUW', 'Beta#EUW'], companion: null, algorithmRevision: 7 },
  scopeReady: true,
}) }))

const disposables: (() => void)[] = []

function responseFor(url: URL): TrainingPlanResponseDto {
  const budget = Number(url.searchParams.get('budget'))
  if (!Number.isInteger(budget) || budget < 20 || budget > 2000) throw new Error('Invalid wire budget')
  const alphaGames = Math.floor(budget / 2)
  return {
    budget_total: budget, budget_assigned: budget, budget_default: 400, budget_unassigned: 0,
    algorithm_revision: 7,
    context: { accounts: ['Alpha#EUW', 'Beta#EUW'], role: url.searchParams.get('role'),
      queue: url.searchParams.get('queue'), days: url.searchParams.get('days') },
    items: [{ champion: 'Ahri', role: 'MIDDLE', icon_url: '', games: 6, unique_games: 6,
      reliability: 'exploratory', actionable: false, classification: 'promising', historical_supported: false,
      posterior_win_rate: 56, allocation_games: budget,
      account_allocations: [{ account: 'Alpha#EUW', games: alphaGames },
        { account: 'Beta#EUW', games: budget - alphaGames }], rationale: 'Synthetic fixed-context comparison.' }],
  }
}

function setup(initialBudget = 400) {
  const requests: URL[] = []
  const writes: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    if ((init?.method ?? 'GET') !== 'GET') {
      writes.push(init!.method!)
      throw new Error('Unexpected write')
    }
    if (url.pathname !== '/api/training-plan') throw new Error('Unexpected endpoint')
    requests.push(url)
    return Response.json(responseFor(url))
  }))
  const initialParams = new URLSearchParams({
    section: 'tournament', role: 'MIDDLE', queue: '440', days: '90', search: ' Ahri & Lux ',
    budget: String(initialBudget), n: '650', source: 'owned-budget-control',
  })
  initialParams.append('account', 'Beta#EUW')
  initialParams.append('account', 'Alpha#EUW')
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  const router = createMemoryRouter([{ path: '/app/fit', element: <CompetitivePlanPage embedded /> }], {
    initialEntries: [`/app/fit?${initialParams}`],
  })
  disposables.push(() => { router.dispose(); client.clear() })
  render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>)
  return { requests, writes, client, router, initialParams, initialBudget, user: userEvent.setup(),
    input: screen.getByRole('spinbutton', { name: 'Budget partite' }) as HTMLInputElement }
}
type State = ReturnType<typeof setup>

function expectContext(state: State) {
  const params = new URLSearchParams(state.router.state.location.search)
  for (const key of new Set(state.initialParams.keys())) {
    if (key !== 'budget') expect(params.getAll(key)).toEqual(state.initialParams.getAll(key))
  }
  expect(state.router.state.location.pathname).toBe('/app/fit')
  for (const request of state.requests) {
    expect(request.searchParams.getAll('account')).toEqual(['Alpha#EUW', 'Beta#EUW'])
    expect(request.searchParams.get('algorithm_revision')).toBe('7')
    expect(request.searchParams.get('role')).toBe('MIDDLE')
    expect(request.searchParams.get('queue')).toBe('440')
    expect(request.searchParams.get('days')).toBe('90')
  }
  expect(state.writes).toEqual([])
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
}

async function enterDraft(state: State, draft: string) {
  expect(await screen.findByText('Ahri')).toBeVisible()
  expect(state.requests).toHaveLength(1)
  await state.user.click(state.input)
  // A complete browser number-input edit (as with paste/fill), including valid
  // scientific notation; an incomplete exponent is sanitized to an empty value.
  fireEvent.change(state.input, { target: { value: draft } })
  expect(state.input.value).toBe(draft === '1e' ? '' : draft)
  expect(screen.getByRole('heading', { name: `Piano da ${state.initialBudget} partite` })).toBeVisible()
  expect(state.requests).toHaveLength(1)
  expect(new URLSearchParams(state.router.state.location.search).get('budget')).toBe(String(state.initialBudget))
  expect(state.client.getQueryCache().findAll({ queryKey: ['api', 'training-plan'] })).toHaveLength(1)
  expectContext(state)
}

async function commitAndCheck(state: State, action: 'blur' | 'Enter', committed: number) {
  if (action === 'blur') await state.user.tab()
  else await state.user.keyboard('{Enter}')
  await waitFor(() => expect(state.client.isFetching()).toBe(0))
  expect(await screen.findByText('Ahri')).toBeVisible()
  expect.soft(state.requests).toHaveLength(committed === state.initialBudget ? 1 : 2)
  expect.soft(state.requests.at(-1)!.searchParams.get('budget')).toBe(String(committed))
  expect.soft(new URLSearchParams(state.router.state.location.search).get('budget')).toBe(String(committed))
  expect.soft(state.input).toHaveValue(committed)
  expect.soft(state.input.value).toBe(String(committed))
  expect.soft(screen.queryByRole('heading', { name: `Piano da ${committed} partite` })).toBeVisible()
  expect.soft(screen.getByText('Partite allocate').parentElement).toHaveTextContent(`${committed}/${committed}`)
  const queries = state.client.getQueryCache().findAll({ queryKey: ['api', 'training-plan'] })
  const budgets = queries.map((query) => (query.state.data as TrainingPlanResponseDto).budget_total)
  expect.soft(budgets).toEqual(committed === state.initialBudget ? [state.initialBudget] : [state.initialBudget, committed])
  expectContext(state)
}

afterEach(() => {
  cleanup()
  disposables.splice(0).forEach((dispose) => dispose())
  vi.unstubAllGlobals()
  localStorage.removeItem(PLAN_BUDGET_KEY)
})

describe('valore numerico della bozza del budget competitivo', () => {
  it('non sovrascrive il budget ricordato quando il campo di un link riceve solo focus e blur', async () => {
    localStorage.setItem(PLAN_BUDGET_KEY, '80')
    const state = setup(200)
    await screen.findByText('Ahri')
    await state.user.click(state.input)
    await state.user.tab()
    expect(state.input).toHaveValue(200)
    expect(localStorage.getItem(PLAN_BUDGET_KEY)).toBe('80')
    expect(state.requests).toHaveLength(1)
    expectContext(state)
  })

  it.each([
    { draft: '1e3', committed: 1000, action: 'blur' },
    { draft: '1e3', committed: 1000, action: 'Enter' },
    { draft: '1.5e3', committed: 1500, action: 'blur' },
    { draft: '1.5e3', committed: 1500, action: 'Enter' },
    { draft: '2e3', committed: 2000, action: 'blur' },
    { draft: '2e3', committed: 2000, action: 'Enter' },
  ] as const)('conferma $draft come $committed tramite $action senza richieste durante la bozza', async ({ draft, committed, action }) => {
    const state = setup()
    await enterDraft(state, draft)
    await commitAndCheck(state, action, committed)
  })

  it.each([
    { draft: '1000', committed: 1000, action: 'blur' },
    { draft: '1234.9', committed: 1234, action: 'Enter' },
    { draft: '1e21', committed: 2000, action: 'Enter' },
    { draft: '1e-3', committed: 20, action: 'blur' },
  ] as const)('conferma il valore $draft e applica il limite intero $committed', async ({ draft, committed, action }) => {
    const state = setup()
    await enterDraft(state, draft)
    await commitAndCheck(state, action, committed)
  })

  it.each([
    { draft: '', action: 'blur' },
    { draft: '1e', action: 'Enter' },
  ] as const)('mantiene il budget corrente se il numero digitato $draft non e completo', async ({ draft, action }) => {
    const state = setup(750)
    await enterDraft(state, draft)
    await commitAndCheck(state, action, 750)
  })
})
