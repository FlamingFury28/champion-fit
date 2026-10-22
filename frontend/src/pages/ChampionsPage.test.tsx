import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, expect, it, vi } from 'vitest'
import { ChampionsPage } from './ChampionsPage'

vi.mock('../app/scope', () => ({ useScope: () => ({
  scope: { accounts: ['Alpha#EUW'], companion: null }, scopeReady: true, availableAccounts: [],
}) }))

function LocationProbe() {
  return <output data-testid="matchup-url">{useLocation().search}</output>
}

function response(input: RequestInfo | URL, champion = 'Ahri') {
  const params = new URL(String(input), 'http://localhost').searchParams
  return new Response(JSON.stringify({
    champion: 'ALL', role: params.get('role'), games: 4, wins: 2, win_rate: 50,
    games_with_opponents: 4, available_champions: [{ champion, games: 4 }],
    loses_to: [], beats: [],
    context: { role: params.get('role'), queue: params.get('queue'), days: params.get('days') },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

function failure() {
  return new Response(JSON.stringify({ error: 'Confronti temporaneamente non disponibili.' }), {
    status: 503, headers: { 'Content-Type': 'application/json' },
  })
}

function setup(fetcher: typeof fetch) {
  vi.stubGlobal('fetch', vi.fn(fetcher))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/app/fit?section=matchups&relation=enemies&queue=420&days=90']}><ChampionsPage /><LocationProbe /></MemoryRouter></QueryClientProvider>)
  return userEvent.setup()
}

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('keeps context filters available during the first request without inventing an effective context', () => {
  setup(() => new Promise(() => undefined))
  expect(screen.getByLabelText('Ruolo')).toBeEnabled()
  expect(screen.getByLabelText('Modalità')).toHaveValue('420')
  expect(screen.getByLabelText('Periodo')).toHaveValue('90')
  expect(screen.getByLabelText('Che campione vuoi giocare?')).toBeDisabled()
  expect(screen.queryByText(/Contesto effettivo:/)).not.toBeInTheDocument()
})

it('recovers from an initial failure by changing filters and preserves unrelated URL parameters', async () => {
  const user = setup(async (input) => new URL(String(input), 'http://localhost').searchParams.get('queue') === '420'
    ? failure() : response(input))
  await screen.findByRole('alert')
  expect(screen.getByLabelText('Che campione vuoi giocare?')).toBeDisabled()
  await user.selectOptions(screen.getByLabelText('Modalità'), '440')
  await screen.findByRole('option', { name: 'Ahri · 4 partite' })
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  expect(screen.getByLabelText('Modalità')).toHaveValue('440')
  expect(screen.getByLabelText('Periodo')).toHaveValue('90')
  expect(screen.getByTestId('matchup-url')).toHaveTextContent('section=matchups&relation=enemies&queue=440&days=90')
})

it.each(['480', '700'])('can select supported queue %s and sends it to the matchup analysis', async (queue) => {
  const user = setup(async (input) => response(input))
  await screen.findByRole('option', { name: 'Ahri · 4 partite' })
  await user.selectOptions(screen.getByLabelText('Modalità'), queue)
  await waitFor(() => expect(fetch).toHaveBeenLastCalledWith(
    expect.stringContaining(`queue=${queue}`), expect.anything(),
  ))
  expect(screen.getByLabelText('Modalità')).toHaveValue(queue)
  expect(screen.getByTestId('matchup-url')).toHaveTextContent(`queue=${queue}`)
})

it('keeps mounted filters after a failed context change and clears the previous champion choices', async () => {
  let rejectRole!: (response: Response) => void
  const delayedFailure = new Promise<Response>((resolve) => { rejectRole = resolve })
  const user = setup(async (input) => {
    const role = new URL(String(input), 'http://localhost').searchParams.get('role')
    return role === 'TOP' ? delayedFailure : response(input, role === 'MIDDLE' ? 'Lux' : 'Ahri')
  })
  await screen.findByRole('option', { name: 'Ahri · 4 partite' })
  const role = screen.getByLabelText('Ruolo')
  await user.selectOptions(role, 'TOP')
  expect(screen.getByLabelText('Ruolo')).toBe(role)
  expect(role).toHaveValue('TOP')
  expect(screen.getByLabelText('Che campione vuoi giocare?')).toBeDisabled()
  expect(screen.queryByRole('option', { name: 'Ahri · 4 partite' })).not.toBeInTheDocument()
  rejectRole(failure())
  await screen.findByRole('alert')
  expect(screen.getByLabelText('Ruolo')).toBe(role)
  expect(screen.queryByRole('heading', { name: 'Nessun consiglio solido su chi bannare' })).not.toBeInTheDocument()
  await user.selectOptions(role, 'MIDDLE')
  await waitFor(() => expect(screen.getByLabelText('Che campione vuoi giocare?')).toBeEnabled())
  expect(within(screen.getByLabelText('Che campione vuoi giocare?')).getByRole('option', { name: 'Lux · 4 partite' })).toBeInTheDocument()
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})
