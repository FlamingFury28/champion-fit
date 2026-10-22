import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, expect, it, vi } from 'vitest'
import { recommendationsFixture, observedRecommendation } from '../test/recommendations-fixture'
import { ChampionsHubPage } from './ChampionsHubPage'

vi.mock('../app/scope', () => ({ useScope: () => ({ scope: { accounts: ['Alpha#EUW'], companion: null }, scopeReady: true }) }))

function LocationProbe() {
  const location = useLocation()
  return <output data-testid="context-url">{location.search}</output>
}

function setup(url: string) {
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const parsed = new URL(String(input), 'http://localhost')
    const context = { role: 'MIDDLE', queue: parsed.searchParams.get('queue') ?? '420', days: parsed.searchParams.get('days') ?? '180' }
    const item = { champion: 'Ahri', role: 'MIDDLE', icon_url: '/ahri.png', unique_games: 4,
      posterior_win_rate: 56.2, credible_lower_90: 42, credible_upper_90: 68, credible_mass: .9,
      posterior_lift_pp: 6.2, classification: 'promising', account_coverage: 1, account_count: 1,
      allocation_games: 400, account_allocations: [{ account: 'Alpha#EUW', games: 400 }] }
    const data = parsed.pathname === '/api/recommendations'
      ? recommendationsFixture({ candidate: observedRecommendation(), context: { ...context, accounts: ['Alpha#EUW'], suspended_accounts: [], unresolved_accounts: [] } })
      : { items: [item], context, model: { validated: false, message: 'Modello sintetico.' },
          budget_total: 400, budget_assigned: 400, budget_unassigned: 0 }
    return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } })
  })
  vi.stubGlobal('fetch', fetch)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[url]}><ChampionsHubPage /><LocationProbe /></MemoryRouter></QueryClientProvider>)
  return { fetch, user: userEvent.setup() }
}

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it.each([
  ['best', '', '420', '180'], ['tournament', '', '420', '180'],
  ['best', '&queue=440&days=90', '440', '90'], ['tournament', '&queue=440&days=90', '440', '90'],
])('keeps resolved context and returns to the same list from %s%s', async (section, filters, queue, days) => {
  const original = `?section=${section}${filters}`
  const { fetch, user } = setup(`/app/fit${original}`)
  const link = await screen.findByRole('link', { name: /Ahri/ })
  await user.click(link)
  const dialog = await screen.findByRole('dialog')
  await within(dialog).findByText(/Ahri fa già parte delle tue scelte/)
  const detailCall = fetch.mock.calls.find(([input]) => String(input).includes('/api/recommendations'))!
  const detailParams = new URL(String(detailCall[0]), 'http://localhost').searchParams
  expect(detailParams.get('queue')).toBe(queue)
  expect(detailParams.get('days')).toBe(days)
  await user.click(within(dialog).getByRole('button', { name: 'Chiudi' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  expect(screen.getByTestId('context-url')).toHaveTextContent(original)
  expect(screen.getByLabelText('Modalità')).toHaveValue(filters ? '440' : '')
  expect(screen.getByLabelText('Periodo')).toHaveValue(filters ? '90' : '')
})

it('restores a bookmarked sheet on reload and closes it without changing automatic list filters', async () => {
  const { fetch, user } = setup('/app/fit?section=best&detail=Ahri&detailRole=MIDDLE&detailQueue=420&detailDays=180')
  const dialog = await screen.findByRole('dialog')
  await within(dialog).findByText(/Ahri fa già parte delle tue scelte/)
  const detailCall = fetch.mock.calls.find(([input]) => String(input).includes('/api/recommendations'))!
  const params = new URL(String(detailCall[0]), 'http://localhost').searchParams
  expect(params.get('queue')).toBe('420')
  expect(params.get('days')).toBe('180')
  await user.click(within(dialog).getByRole('button', { name: 'Chiudi' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  expect(screen.getByTestId('context-url')).toHaveTextContent('?section=best')
  expect(screen.getByTestId('context-url')).not.toHaveTextContent('detail')
})
